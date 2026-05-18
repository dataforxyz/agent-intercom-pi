import * as fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildForkHandlerEnv, buildForkRunPaths, buildPiForkArgs, getForkHandlersFile, launchDetachedFork, readOptionalText, truncateText, writeJsonAtomic } from "./fork-runtime.ts";
import type { Message, SessionInfo } from "./types.ts";

const HANDLER_MESSAGE_TYPE = "intercom_fork_handler";
const HANDLERS_FILE = getForkHandlersFile("intercom");
const HANDLER_SUMMARY_LIMIT_BYTES = 24 * 1024;

export type InboundForkWhen = "busy" | "always";
export type InboundForkNotify = "ack-and-summary" | "summary" | "none";

export interface InboundForkHandlersConfig {
  enabled: boolean;
  when: InboundForkWhen;
  notify: InboundForkNotify;
  piCommand?: string;
  triggerParentOnSummary: boolean;
}

export interface InboundForkMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

export interface IntercomForkHandlerRun {
  id: string;
  eventId: string;
  messageId: string;
  from: string;
  status: "starting" | "running" | "complete" | "failed";
  pid?: number;
  cwd: string;
  parentSessionFile?: string;
  forkSessionFile?: string;
  parentSessionId?: string;
  parentSessionName?: string;
  dir: string;
  eventPath: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  sessionDir: string;
  notify?: InboundForkNotify;
  triggerParentOnSummary?: boolean;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  summary?: string;
  error?: string;
}

let handlerRuns: IntercomForkHandlerRun[] = [];

async function loadHandlers(): Promise<void> {
  try {
    const raw = await fsp.readFile(HANDLERS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { runs?: IntercomForkHandlerRun[] };
    handlerRuns = Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      handlerRuns = [];
      return;
    }
    throw error;
  }
}

async function saveHandlers(): Promise<void> {
  handlerRuns = handlerRuns.slice(-200);
  await writeJsonAtomic(HANDLERS_FILE, { runs: handlerRuns });
}

function shortId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || randomBytes(3).toString("hex");
}

function makeHandlerId(message: Message): string {
  return `icfh_${Date.now().toString(36)}_${shortId(message.id)}_${randomBytes(2).toString("hex")}`;
}

function getSessionFile(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as unknown as { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
  try {
    return manager.getSessionFile?.();
  } catch {
    return undefined;
  }
}

function getSessionId(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as unknown as { getSessionId?: () => string | undefined };
  try {
    return manager.getSessionId?.();
  } catch {
    return undefined;
  }
}

function getParentSessionName(pi: ExtensionAPI): string | undefined {
  try {
    return pi.getSessionName?.();
  } catch {
    return undefined;
  }
}

function buildEventPayload(entry: InboundForkMessageEntry, run: IntercomForkHandlerRun, ctx: ExtensionContext, pi: ExtensionAPI) {
  return {
    version: 1,
    type: entry.message.expectsReply ? "intercom.ask" : "intercom.message",
    id: run.eventId,
    source: "pi-intercom",
    createdAt: run.startedAt,
    cwd: ctx.cwd ?? process.cwd(),
    parentSessionFile: run.parentSessionFile,
    parentSessionId: run.parentSessionId,
    parentSessionName: run.parentSessionName,
    parentIntercomTarget: getParentSessionName(pi),
    payload: {
      messageId: entry.message.id,
      replyTo: entry.message.replyTo,
      expectsReply: entry.message.expectsReply === true,
      from: entry.from,
      bodyText: entry.bodyText,
      content: entry.message.content,
      timestamp: entry.message.timestamp,
    },
    authority: {
      mode: "delegated",
      mayAnswerWhenDerivable: true,
      escalateOn: [
        "destructive-action",
        "ambiguous-user-preference",
        "external-side-effect",
        "security-privacy-cost-risk",
        "parent-work-conflict",
        "low-confidence",
      ],
    },
  };
}

function parentNotificationModeLines(run: IntercomForkHandlerRun): string[] {
  const notify = run.notify ?? "summary";
  if (notify === "none") {
    return [
      "Parent notification mode: none",
      "Your final response is stored in handler logs only and will not be automatically posted to the parent transcript/context.",
    ];
  }
  return [
    `Parent notification mode: ${notify}`,
    `Your final response WILL be copied into the parent transcript/context${run.triggerParentOnSummary ? " and will trigger a parent turn" : ""}.`,
    ...(notify === "ack-and-summary" ? ["The parent already received a launch ack; do not repeat startup details unless relevant."] : []),
    "Keep the final response concise. If you already sent an intercom message to the parent, do not repeat its full content; just note that you escalated it.",
  ];
}

export function buildIntercomForkHandlerPrompt(entry: InboundForkMessageEntry, run: IntercomForkHandlerRun, eventJson: string): string {
  const senderTarget = entry.from.name || entry.from.id;
  const replyGuidance = entry.message.expectsReply
    ? [
      "The sender is blocked waiting for an answer.",
      `If the answer is safe and derivable, reply directly with: intercom({ action: "send", to: ${JSON.stringify(senderTarget)}, message: "...", replyTo: ${JSON.stringify(entry.message.id)} })`,
      "If you cannot safely answer, escalate to the parent with the smallest concrete question; do not do unrelated work while the sender is waiting.",
    ]
    : [
      "This is a non-blocking intercom send. Handle it asynchronously and summarize only what matters.",
      `If useful, respond with intercom({ action: "send", to: ${JSON.stringify(senderTarget)}, message: "..." }).`,
    ];
  return [
    "You are a background pi-intercom handler running in a sibling Pi session.",
    "The parent chat is busy and should stay undistracted unless a real decision is needed.",
    "Handle only the inbound intercom event capsule supplied here; do not continue unrelated inherited parent work.",
    "",
    "Delegated authority:",
    "- Answer or act directly when the response is derivable from the inbound message, inherited context, repo files, local artifacts, or prior user instructions.",
    "- Escalate only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with parent work, or low confidence.",
    "- Use intercom.send for non-blocking notices. Use intercom.ask only for true blocking parent decisions.",
    "- Keep any parent escalation brief and include the handler id.",
    ...parentNotificationModeLines(run).map((line) => `- ${line}`),
    "",
    ...replyGuidance,
    "",
    `Handler id: ${run.id}`,
    `Event JSON path: ${run.eventPath}`,
    "",
    "Intercom event payload:",
    "```json",
    eventJson,
    "```",
    "",
    "Final response: provide a concise audit summary of what you did, what you replied/escalated, and whether parent follow-up is needed.",
  ].join("\n");
}

export function buildIntercomForkHandlerSystemPrompt(run: IntercomForkHandlerRun): string {
  return [
    "You are a background pi-intercom handler in a sibling Pi process.",
    "Your only task is to handle the inbound intercom event capsule supplied in the latest user message.",
    "Do not continue unrelated inherited parent work. Treat inherited conversation as context only.",
    "You have delegated authority to answer or act when safe and derivable.",
    "Escalate only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with parent work, or low confidence.",
    "For intercom asks, answer directly with intercom.send + replyTo when safe; otherwise escalate quickly.",
    ...parentNotificationModeLines(run),
    `Handler id: ${run.id}`,
  ].join("\n");
}

function buildHandlerArgs(run: IntercomForkHandlerRun): string[] {
  return buildPiForkArgs({
    sessionDir: run.sessionDir,
    systemPrompt: buildIntercomForkHandlerSystemPrompt(run),
    promptPath: run.promptPath,
    forkFile: run.forkSessionFile || run.parentSessionFile,
  });
}

function formatAck(run: IntercomForkHandlerRun, entry: InboundForkMessageEntry): string {
  const sender = entry.from.name || entry.from.id.slice(0, 8);
  return [
    `pi-intercom received ${entry.message.expectsReply ? "an ask" : "a message"} from ${sender}.`,
    `Launched background fork handler ${run.id}${run.pid ? ` (pid ${run.pid})` : ""}.`,
    `Handler dir: ${run.dir}`,
  ].join("\n");
}

function formatSummary(run: IntercomForkHandlerRun): string {
  const status = run.status === "complete" ? "completed" : "failed";
  const output = run.summary?.trim() || run.error || "(no handler output)";
  return [
    `pi-intercom fork handler ${status}: ${run.id}`,
    `From: ${run.from}`,
    `Message: ${run.messageId}`,
    `Exit: ${run.exitCode ?? "signal " + (run.signal ?? "unknown")}`,
    `Output: ${run.stdoutPath}`,
    `Errors: ${run.stderrPath}`,
    "",
    truncateText(output, HANDLER_SUMMARY_LIMIT_BYTES),
  ].join("\n");
}

async function markHandlerFinished(pi: ExtensionAPI, runId: string, code: number | null, signal: NodeJS.Signals | null, notify: InboundForkNotify, triggerParent: boolean): Promise<void> {
  await loadHandlers();
  const run = handlerRuns.find((candidate) => candidate.id === runId);
  if (!run) return;
  run.endedAt = Date.now();
  run.exitCode = code;
  run.signal = signal;
  const stdout = await readOptionalText(run.stdoutPath);
  const stderr = await readOptionalText(run.stderrPath);
  run.summary = truncateText(stdout.trim() || stderr.trim(), HANDLER_SUMMARY_LIMIT_BYTES);
  run.status = code === 0 ? "complete" : "failed";
  if (code !== 0) run.error = stderr.trim() || `handler exited with ${code ?? signal ?? "unknown status"}`;
  await saveHandlers();
  try {
    pi.appendEntry?.("intercom_fork_handler_finished", { id: run.id, status: run.status, messageId: run.messageId, exitCode: code, signal, endedAt: run.endedAt });
  } catch {
    // Best effort audit trail.
  }
  if (notify === "summary" || notify === "ack-and-summary") {
    pi.sendMessage(
      {
        customType: HANDLER_MESSAGE_TYPE,
        content: formatSummary(run),
        display: true,
        details: { id: run.id, messageId: run.messageId, status: run.status, exitCode: code, signal },
      },
      { triggerTurn: triggerParent },
    );
  }
}

export async function launchIntercomForkHandler(pi: ExtensionAPI, ctx: ExtensionContext, entry: InboundForkMessageEntry, config: InboundForkHandlersConfig): Promise<boolean> {
  await loadHandlers();
  const id = makeHandlerId(entry.message);
  const paths = buildForkRunPaths("intercom", id);
  const run: IntercomForkHandlerRun = {
    ...paths,
    eventId: `intercom_${entry.message.id}`,
    messageId: entry.message.id,
    from: entry.from.name || entry.from.id,
    status: "starting",
    cwd: ctx.cwd ?? process.cwd(),
    ...(getSessionFile(ctx) ? { parentSessionFile: getSessionFile(ctx) } : {}),
    ...(getSessionId(ctx) ? { parentSessionId: getSessionId(ctx) } : {}),
    ...(getParentSessionName(pi) ? { parentSessionName: getParentSessionName(pi) } : {}),
    notify: config.notify,
    triggerParentOnSummary: config.triggerParentOnSummary,
    startedAt: Date.now(),
  };
  const eventJson = JSON.stringify(buildEventPayload(entry, run, ctx, pi), null, 2);
  await fsp.mkdir(run.sessionDir, { recursive: true });
  if (run.parentSessionFile) {
    const snapshotPath = `${run.dir}/parent-session-snapshot.jsonl`;
    try {
      await fsp.copyFile(run.parentSessionFile, snapshotPath);
      run.forkSessionFile = snapshotPath;
    } catch {
      // Best effort. If snapshotting fails, fall back to the original session file.
    }
  }
  await fsp.writeFile(run.eventPath, `${eventJson}\n`, "utf8");
  await fsp.writeFile(run.promptPath, buildIntercomForkHandlerPrompt(entry, run, eventJson), "utf8");
  handlerRuns.push(run);
  await saveHandlers();

  const command = config.piCommand || process.env.PI_INTERCOM_PI_BIN || "pi";
  const args = buildHandlerArgs(run);
  try {
    const launch = await launchDetachedFork({
      command,
      args,
      cwd: run.cwd,
      stdoutPath: run.stdoutPath,
      stderrPath: run.stderrPath,
      env: buildForkHandlerEnv("intercom", run.id, {
        ...process.env,
        ...(run.parentSessionFile ? { PI_INTERCOM_PARENT_SESSION_FILE: run.parentSessionFile } : {}),
      }),
      onClose: (code, signal) => {
        void markHandlerFinished(pi, run.id, code, signal, config.notify, config.triggerParentOnSummary).catch((error) => {
          console.error("[pi-intercom] Failed to finish fork handler", error);
        });
      },
    });
    if (!launch.ok) {
      await loadHandlers();
      const failed = handlerRuns.find((candidate) => candidate.id === run.id) ?? run;
      failed.status = "failed";
      failed.endedAt = Date.now();
      failed.error = launch.error instanceof Error ? launch.error.message : String(launch.error);
      if (!handlerRuns.some((candidate) => candidate.id === run.id)) handlerRuns.push(failed);
      await saveHandlers();
      console.error("[pi-intercom] Failed to launch fork handler", launch.error);
      return false;
    }

    run.pid = launch.pid;
    run.status = "running";
    await saveHandlers();
    if (config.notify === "ack-and-summary") {
      pi.sendMessage(
        {
          customType: HANDLER_MESSAGE_TYPE,
          content: formatAck(run, entry),
          display: true,
          details: { id: run.id, messageId: entry.message.id, status: "running" },
        },
        { triggerTurn: false },
      );
    }
    return true;
  } catch (error) {
    run.status = "failed";
    run.endedAt = Date.now();
    run.error = error instanceof Error ? error.message : String(error);
    await saveHandlers();
    console.error("[pi-intercom] Failed to launch fork handler", error);
    return false;
  }
}

export async function listIntercomForkHandlers(status: "running" | "complete" | "failed" | "all" = "all"): Promise<IntercomForkHandlerRun[]> {
  await loadHandlers();
  return handlerRuns
    .filter((run) => status === "all" || run.status === status)
    .sort((a, b) => b.startedAt - a.startedAt);
}
