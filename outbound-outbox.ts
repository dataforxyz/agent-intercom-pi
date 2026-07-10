import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { ensureIntercomRuntimeDir, getIntercomDirPath, INTERCOM_DIR_MODE, restrictIntercomRuntimeFile } from "./broker/paths.ts";
import { writeDurableJson } from "./durable-json.ts";
import type { Message } from "./types.ts";

const OUTBOX_STATE_VERSION = 1;
const MAX_OUTBOX_MESSAGES = 256;

export interface StoredOutboundMessage {
  to: string;
  message: Message;
  queuedAt: number;
}

interface OutboxState {
  version: typeof OUTBOX_STATE_VERSION;
  entries: StoredOutboundMessage[];
}

function fingerprint(entry: Pick<StoredOutboundMessage, "to" | "message">): string {
  return JSON.stringify({
    to: entry.to,
    replyTo: entry.message.replyTo,
    expectsReply: entry.message.expectsReply,
    content: entry.message.content,
  });
}

function isStoredOutboundMessage(value: unknown): value is StoredOutboundMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.to !== "string" || typeof entry.queuedAt !== "number") return false;
  if (typeof entry.message !== "object" || entry.message === null || Array.isArray(entry.message)) return false;
  const message = entry.message as Record<string, unknown>;
  return typeof message.id === "string"
    && typeof message.timestamp === "number"
    && typeof message.content === "object"
    && message.content !== null
    && typeof (message.content as Record<string, unknown>).text === "string";
}

function fileName(sessionId: string): string {
  return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

export class PersistentOutboundOutbox {
  private readonly directory: string;
  private readonly filePath: string;
  private state: OutboxState;

  constructor(sessionId: string, intercomDir: string = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    this.directory = join(intercomDir, "outbox");
    mkdirSync(this.directory, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync(this.directory, INTERCOM_DIR_MODE);
    this.filePath = join(this.directory, fileName(sessionId));
    this.state = this.load();
  }

  list(): StoredOutboundMessage[] {
    return this.state.entries.map((entry) => ({ ...entry, message: { ...entry.message, content: { ...entry.message.content } } }));
  }

  enqueue(to: string, message: Message): "added" | "existing" {
    const existing = this.state.entries.find((entry) => entry.message.id === message.id);
    if (existing) {
      if (fingerprint(existing) !== fingerprint({ to, message })) {
        throw new Error(`Message ID ${message.id} is already queued with a different payload`);
      }
      return "existing";
    }
    if (this.state.entries.length >= MAX_OUTBOX_MESSAGES) {
      throw new Error(`Durable outbox is full (${MAX_OUTBOX_MESSAGES} messages)`);
    }
    this.state.entries.push({ to, message, queuedAt: Date.now() });
    this.persist();
    return "added";
  }

  remove(messageId: string): void {
    const remaining = this.state.entries.filter((entry) => entry.message.id !== messageId);
    if (remaining.length === this.state.entries.length) return;
    this.state.entries = remaining;
    this.persist();
  }

  clear(): void {
    if (this.state.entries.length === 0) return;
    this.state.entries = [];
    this.persist();
  }

  private load(): OutboxState {
    if (!existsSync(this.filePath)) return { version: OUTBOX_STATE_VERSION, entries: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed as Record<string, unknown>;
      if (state.version !== OUTBOX_STATE_VERSION || !Array.isArray(state.entries) || !state.entries.every(isStoredOutboundMessage)) {
        throw new Error("invalid outbox state");
      }
      return { version: OUTBOX_STATE_VERSION, entries: state.entries };
    } catch {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync(this.filePath, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      return { version: OUTBOX_STATE_VERSION, entries: [] };
    }
  }

  private persist(): void {
    writeDurableJson(this.filePath, this.state);
  }
}
