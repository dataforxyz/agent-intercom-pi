import { randomUUID, createHash } from "crypto";
import { spawnSync } from "child_process";
import { basename } from "path";
import { cwd as processCwd } from "process";
import { IntercomClient } from "../broker/client.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import { getAskTimeoutMs, loadConfig } from "../config.ts";
import type { Attachment, Message, SessionInfo } from "../types.ts";

export interface CodexRuntimeIdentity {
  sessionId: string;
  name: string;
  cwd: string;
  model: string;
  startedAt: number;
}

export interface PendingInboundMessage {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
  read: boolean;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ReplyWaiter {
  from: string;
  replyTo: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function buildCodexRuntimeIdentity(env: NodeJS.ProcessEnv = process.env, cwd = env.PWD || processCwd(), pid = process.pid): CodexRuntimeIdentity {
  const sessionId = env.CODEX_INTERCOM_SESSION_ID?.trim()
    || env.CODEX_PEER_ID?.trim()
    || `codex-${pid}-${shortHash(cwd)}`;
  const cwdName = basename(cwd) || "workspace";
  const name = env.CODEX_INTERCOM_NAME?.trim()
    || env.CODEX_PEER_NAME?.trim()
    || `codex-${cwdName}-${pid}`;
  return {
    sessionId,
    name,
    cwd,
    model: env.CODEX_INTERCOM_MODEL?.trim() || env.CODEX_MODEL?.trim() || "codex",
    startedAt: Date.now(),
  };
}

export function formatAttachments(attachments: Attachment[] | undefined): string {
  if (!attachments?.length) return "";
  return attachments.map((attachment) => {
    if (attachment.language) {
      return `\n\n---\nAttachment: ${attachment.name}\n~~~${attachment.language}\n${attachment.content}\n~~~`;
    }
    return `\n\n---\nAttachment: ${attachment.name}\n${attachment.content}`;
  }).join("");
}

export function resolveSessionTarget(sessions: SessionInfo[], nameOrId: string): string | null {
  const byId = sessions.find((session) => session.id === nameOrId);
  if (byId) return byId.id;

  const lowerName = nameOrId.toLowerCase();
  const byName = sessions.filter((session) => session.name?.toLowerCase() === lowerName);
  if (byName.length > 1) {
    throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
  }
  if (byName[0]) return byName[0].id;

  if (nameOrId.length >= 4) {
    const byPrefix = sessions.filter((session) => session.id.startsWith(nameOrId));
    if (byPrefix.length > 1) {
      throw new Error(`Multiple sessions match the ID prefix "${nameOrId}". Use the full session ID or a unique name.`);
    }
    if (byPrefix[0]) return byPrefix[0].id;
  }

  return null;
}

export function formatSessionList(sessions: SessionInfo[], currentSessionId: string | null, currentCwd: string): string {
  if (!sessions.length) return "No intercom sessions connected.";
  return sessions.map((session) => {
    const tags = [
      session.id === currentSessionId ? "self" : undefined,
      session.cwd === currentCwd ? "same cwd" : undefined,
      session.status,
    ].filter((tag): tag is string => Boolean(tag));
    const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- ${session.name || "unnamed"} (${session.id.slice(0, 8)}) - ${session.cwd} (${session.model})${suffix}`;
  }).join("\n");
}

export function detectGitRoot(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function textResult(text: string, structuredContent?: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

export class CodexIntercomRuntime {
  private client: IntercomClient | null = null;
  private identity: CodexRuntimeIdentity;
  private unread: PendingInboundMessage[] = [];
  private unresolvedAsks = new Map<string, PendingInboundMessage>();
  private replyWaiters = new Map<string, ReplyWaiter>();

  constructor(identity: CodexRuntimeIdentity = buildCodexRuntimeIdentity()) {
    this.identity = identity;
  }

  getIdentity(): CodexRuntimeIdentity {
    return this.identity;
  }

  async connect(): Promise<IntercomClient> {
    if (this.client?.isConnected()) return this.client;
    const config = loadConfig();
    if (!config.enabled) throw new Error("Intercom disabled");
    await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    const client = new IntercomClient();
    client.on("message", (from: SessionInfo, message: Message) => {
      this.handleIncomingMessage(from, message);
    });
    client.on("disconnected", (error: Error) => {
      for (const waiter of this.replyWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      }
      this.replyWaiters.clear();
      if (this.client === client) this.client = null;
    });
    await client.connect({
      name: this.identity.name,
      cwd: this.identity.cwd,
      model: this.identity.model,
      pid: process.pid,
      startedAt: this.identity.startedAt,
      lastActivity: Date.now(),
      status: "idle",
    }, this.identity.sessionId);
    this.client = client;
    return client;
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.disconnect();
    this.client = null;
  }

  private handleIncomingMessage(from: SessionInfo, message: Message): void {
    const waiter = this.replyWaiters.get(message.replyTo ?? "");
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
      if (fromMatches) {
        this.replyWaiters.delete(waiter.replyTo);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
        return;
      }
    }

    const entry = { from, message, receivedAt: Date.now(), read: false };
    this.unread.push(entry);
    if (message.expectsReply) {
      this.unresolvedAsks.set(message.id, entry);
    }
  }

  private waitForReply(from: string, replyTo: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.replyWaiters.delete(replyTo);
        this.client?.cancelAsk(replyTo);
        reject(new Error(`No reply from "${from}" within ${Math.round(getAskTimeoutMs() / 1000)} seconds`));
      }, getAskTimeoutMs());
      this.replyWaiters.set(replyTo, { from, replyTo, resolve, reject, timeout });
    });
  }

  private async resolveTarget(to: string): Promise<string> {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }

  async whoami(): Promise<ToolResult> {
    const client = await this.connect();
    const sessionId = client.sessionId ?? this.identity.sessionId;
    return textResult(
      `session_id: ${sessionId}\nname: ${this.identity.name}\ncwd: ${this.identity.cwd}`,
      { session_id: sessionId, name: this.identity.name, cwd: this.identity.cwd, model: this.identity.model },
    );
  }

  async status(): Promise<ToolResult> {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return textResult(
      `Connected: ${client.isConnected() ? "Yes" : "No"}\nSession ID: ${client.sessionId ?? "unknown"}\nActive sessions: ${sessions.length}\nUnread messages: ${this.unread.filter((entry) => !entry.read).length}\nPending asks: ${this.unresolvedAsks.size}`,
      {
        connected: client.isConnected(),
        session_id: client.sessionId,
        active_sessions: sessions.length,
        unread_messages: this.unread.filter((entry) => !entry.read).length,
        pending_asks: this.unresolvedAsks.size,
      },
    );
  }

  async list(scope: "machine" | "directory" | "repo" = "machine", includeSelf = false): Promise<ToolResult> {
    const client = await this.connect();
    let sessions = await client.listSessions();
    if (scope === "directory") {
      sessions = sessions.filter((session) => session.cwd === this.identity.cwd);
    } else if (scope === "repo") {
      const currentRoot = detectGitRoot(this.identity.cwd);
      sessions = currentRoot
        ? sessions.filter((session) => detectGitRoot(session.cwd) === currentRoot)
        : [];
    }
    if (!includeSelf) {
      sessions = sessions.filter((session) => session.id !== client.sessionId);
    }
    return textResult(formatSessionList(sessions, client.sessionId, this.identity.cwd), { sessions });
  }

  async setSummary(summary: string): Promise<ToolResult> {
    const client = await this.connect();
    client.updatePresence({ status: summary.trim() || "idle" });
    return textResult("Summary updated.", { ok: true, summary });
  }

  async send(to: string, message: string, attachments?: Attachment[], replyTo?: string): Promise<ToolResult> {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const result = await client.send(sendTo, { text: message, attachments, replyTo });
    if (!result.delivered) {
      return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
    }
    if (replyTo) this.unresolvedAsks.delete(replyTo);
    return textResult(`Message sent to ${to}.`, { ok: true, message_id: result.id, to });
  }

  async ask(to: string, message: string, attachments?: Attachment[]): Promise<ToolResult> {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const questionId = randomUUID();
    const replyPromise = this.waitForReply(sendTo, questionId);
    try {
      const result = await client.send(sendTo, {
        messageId: questionId,
        text: message,
        attachments,
        expectsReply: true,
      });
      if (!result.delivered) {
        this.replyWaiters.get(questionId)?.reject(new Error(result.reason ?? "Session may not exist or has disconnected."));
        this.replyWaiters.delete(questionId);
        client.cancelAsk(questionId);
        return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
      }
      const reply = await replyPromise;
      const replyText = `${reply.content.text}${formatAttachments(reply.content.attachments)}`;
      return textResult(`Reply from ${to}:\n${replyText}`, { ok: true, message_id: result.id, reply });
    } catch (error) {
      client.cancelAsk(questionId);
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }
  }

  async pending(markRead = false): Promise<ToolResult> {
    const unreadMessages = this.unread.filter((entry) => !entry.read);
    if (markRead) {
      for (const entry of unreadMessages) entry.read = true;
    }
    const pendingAsks = Array.from(this.unresolvedAsks.values());
    const lines = [
      unreadMessages.length
        ? unreadMessages.map((entry) => `- ${entry.from.name || entry.from.id}: ${entry.message.content.text}${formatAttachments(entry.message.content.attachments)}`).join("\n")
        : "No unread messages.",
      pendingAsks.length
        ? `\nPending asks:\n${pendingAsks.map((entry) => `- ${entry.message.id} from ${entry.from.name || entry.from.id}: ${entry.message.content.text}`).join("\n")}`
        : "",
    ].filter(Boolean);
    return textResult(lines.join("\n"), { unread_messages: unreadMessages, pending_asks: pendingAsks });
  }

  async reply(message: string, to?: string, replyTo?: string): Promise<ToolResult> {
    let target: PendingInboundMessage | undefined;
    if (replyTo) {
      target = this.unresolvedAsks.get(replyTo);
    } else if (to) {
      const lowerTo = to.toLowerCase();
      const matches = Array.from(this.unresolvedAsks.values()).filter((entry) =>
        entry.from.id === to || entry.from.name?.toLowerCase() === lowerTo || entry.from.id.startsWith(to)
      );
      if (matches.length > 1) {
        return textResult(`Multiple pending asks match "${to}". Call intercom_pending and reply with reply_to.`, { ok: false }, true);
      }
      target = matches[0];
    } else if (this.unresolvedAsks.size === 1) {
      target = Array.from(this.unresolvedAsks.values())[0];
    }

    if (!target) {
      return textResult("No matching pending ask. Call intercom_pending to inspect unresolved asks.", { ok: false }, true);
    }

    const result = await this.send(target.from.id, message, undefined, target.message.id);
    if (!result.isError) {
      this.unresolvedAsks.delete(target.message.id);
    }
    return result;
  }
}
