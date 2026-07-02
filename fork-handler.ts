import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildForkHandlerEnv, buildForkRunPaths, buildPiForkArgs, getForkHandlersFile, launchDetachedFork, readOptionalText, truncateText, writeJsonAtomic } from "./fork-runtime.ts";
import type { BackgroundLineage } from "./background-lineage.ts";
import type { Message, SessionInfo } from "./types.ts";

const HANDLER_MESSAGE_TYPE = "intercom_fork_handler";
const HANDLERS_FILE = getForkHandlersFile("intercom");
const HANDLER_SUMMARY_LIMIT_BYTES = 24 * 1024;
const SUBAGENT_RESULT_INLINE_LIMIT_BYTES = 8 * 1024;
const PARENT_SESSION_SNAPSHOT_FILE = "parent-session-snapshot.jsonl";
const INTERCOM_PARENT_SESSION_FILE_ENV = "PI_INTERCOM_PARENT_SESSION_FILE";
const INTERCOM_PARENT_SESSION_ID_ENV = "PI_INTERCOM_PARENT_SESSION_ID";
const INTERCOM_PARENT_SESSION_NAME_ENV = "PI_INTERCOM_PARENT_SESSION_NAME";
const INTERCOM_PARENT_INTERCOM_TARGET_ENV = "PI_INTERCOM_PARENT_INTERCOM_TARGET";

export function currentBackgroundForkDepth(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PI_BACKGROUND_FORK_DEPTH ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function maxBackgroundForkDepth(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PI_BACKGROUND_MAX_FORK_DEPTH ?? "1");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
}

export function backgroundForkDepthExceeded(env: NodeJS.ProcessEnv = process.env): boolean {
  return currentBackgroundForkDepth(env) >= maxBackgroundForkDepth(env);
}

export type InboundForkWhen = "auto" | "busy" | "always";
export type InboundForkNotify = "ack-and-summary" | "summary" | "none";
export type InboundForkTriggerParent = boolean | "auto";

export interface InboundForkHandlersConfig {
  enabled: boolean;
  when: InboundForkWhen;
  notify: InboundForkNotify;
  piCommand?: string;
  triggerParentOnSummary: InboundForkTriggerParent;
}

export interface InboundForkMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
  backgroundLineage?: BackgroundLineage;
}

export interface LaunchIntercomForkHandlerOptions {
  handlerId?: string;
  skipBackgroundRoute?: boolean;
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
  parentSessionSnapshotBytes?: number;
  parentSessionSnapshotDeletedAt?: number;
  parentSessionSnapshotCleanupError?: string;
  inboundBodyPath?: string;
  inboundBodyBytes?: number;
  inboundBodyCompacted?: boolean;
  parentSessionId?: string;
  parentSessionName?: string;
  parentIntercomTarget?: string;
  dir: string;
  eventPath: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  sessionDir: string;
  notify?: InboundForkNotify;
  triggerParentOnSummary?: InboundForkTriggerParent;
  autoTriggerParentOnSummary?: boolean;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  summary?: string;
  error?: string;
  finishSource?: "close" | "reconciled";
}

type BackgroundEventsModule = {
  BackgroundEventsStore: new (...args: never[]) => {
    routeEvent: (envelope: Record<string, unknown>, options?: Record<string, unknown>) => { disposition: string; handlerId?: string; queueId?: string };
    runReconcilerPass: (options: Record<string, unknown>) => { leaseAcquired: boolean; launchBundles?: Array<{ handlerId: string; source: string; events: Array<{ payloadPath: string }> }> };
    markHandlerRunning: (handlerId: string, input?: Record<string, unknown>) => void;
    failHandlerLaunch: (handlerId: string, options?: Record<string, unknown>) => unknown;
    completeHandler: (handlerId: string, input?: Record<string, unknown>) => string | undefined;
    close: () => void;
  };
  namespacedEventId: (source: "intercom", durableId: string) => string;
};
const DEFAULT_BACKGROUND_EVENTS_MODULE = "pi-forks/background-events";
let backgroundEventsImport: Promise<BackgroundEventsModule | undefined> | undefined;
let backgroundEventsImportSpecifier: string | undefined;

function installedPiForksBackgroundEventsModule(): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
    : path.join(os.homedir(), ".pi", "agent");
  const filePath = path.join(agentDir, "git", "github.com", "dataforxyz", "pi-forks", "src", "background-events.ts");
  return fs.existsSync(filePath) ? pathToFileURL(filePath).href : undefined;
}

let handlerRuns: IntercomForkHandlerRun[] = [];
let backgroundQueueDrainActive = false;
let backgroundQueueDrainPending = false;

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

function retainedHandlerRuns(): IntercomForkHandlerRun[] {
  const active = handlerRuns.filter((run) => run.status === "starting" || run.status === "running");
  const activeIds = new Set(active.map((run) => run.id));
  const terminal = handlerRuns.filter((run) => !activeIds.has(run.id)).slice(-200);
  return [...terminal, ...active];
}

async function saveHandlers(): Promise<void> {
  handlerRuns = retainedHandlerRuns();
  await writeJsonAtomic(HANDLERS_FILE, { runs: handlerRuns });
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function shortId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || randomBytes(3).toString("hex");
}

function makeHandlerId(message: Message): string {
  return `icfh_${Date.now().toString(36)}_${shortId(message.id)}_${randomBytes(2).toString("hex")}`;
}

export function intercomBackgroundEventId(messageId: string): string {
  return messageId.startsWith("intercom:") ? messageId : `intercom:${messageId}`;
}

function intercomParentNamespace(run: Pick<IntercomForkHandlerRun, "parentSessionId" | "parentSessionFile" | "messageId">): string {
  return run.parentSessionId ?? run.parentSessionFile ?? `intercom:${run.messageId}`;
}

function intercomWorkKey(run: Pick<IntercomForkHandlerRun, "parentSessionId" | "parentSessionFile" | "messageId">): string {
  return `intercom:${intercomParentNamespace(run)}:message:${run.messageId}`;
}

async function loadBackgroundEventsModule(): Promise<BackgroundEventsModule | undefined> {
  const specifier = process.env.PI_BACKGROUND_EVENTS_MODULE?.trim() || DEFAULT_BACKGROUND_EVENTS_MODULE;
  const fallbacks = [specifier, installedPiForksBackgroundEventsModule()].filter(Boolean) as string[];
  const cacheKey = fallbacks.join("\n");
  if (!backgroundEventsImport || backgroundEventsImportSpecifier !== cacheKey) {
    backgroundEventsImportSpecifier = cacheKey;
    backgroundEventsImport = (async () => {
      for (const candidate of fallbacks) {
        try {
          return await import(candidate) as BackgroundEventsModule;
        } catch {}
      }
      return undefined;
    })();
  }
  return backgroundEventsImport;
}

async function fileSnapshot(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const data = await fsp.readFile(filePath);
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
}

async function routeIntercomBackgroundEvent(entry: InboundForkMessageEntry, run: IntercomForkHandlerRun): Promise<{ disposition: string; handlerId?: string; queueId?: string } | undefined> {
  const module = await loadBackgroundEventsModule();
  if (!module) return undefined;
  const snapshot = await fileSnapshot(run.eventPath);
  const parentNamespace = intercomParentNamespace(run);
  const eventId = module.namespacedEventId("intercom", run.messageId);
  const workKey = intercomWorkKey(run);
  const store = new module.BackgroundEventsStore();
  try {
    return store.routeEvent({
      version: 1,
      source: "intercom",
      eventId,
      workKey,
      parentNamespace,
      parent: {
        sessionId: parentNamespace,
        ...(run.parentSessionFile ? { sessionFile: run.parentSessionFile } : {}),
        ...(run.parentSessionName ? { sessionName: run.parentSessionName } : {}),
        ...(run.parentIntercomTarget ? { intercomTarget: run.parentIntercomTarget } : {}),
        cwd: run.cwd,
      },
      createdAt: entry.message.timestamp ?? Date.now(),
      priority: entry.message.expectsReply === true ? "high" : "normal",
      payloadPath: run.eventPath,
      payloadSha256: snapshot.sha256,
      payloadBytes: snapshot.bytes,
      expectedReply: entry.message.expectsReply === true,
      needsDecision: entry.message.expectsReply === true,
      eventType: entry.message.expectsReply === true ? "ask" : "message",
      origin: {
        forkDepth: entry.backgroundLineage?.forkDepth ?? currentBackgroundForkDepth(),
        handlerId: entry.backgroundLineage?.originHandlerId ?? process.env.PI_BACKGROUND_HANDLER_ID,
        rootEventId: entry.backgroundLineage?.rootEventId ?? process.env.PI_BACKGROUND_EVENT_ID,
        rootWorkKey: entry.backgroundLineage?.rootWorkKey ?? process.env.PI_BACKGROUND_WORK_KEY,
        lineageId: entry.backgroundLineage?.lineageId ?? process.env.PI_BACKGROUND_LINEAGE_ID,
      },
    }, { handlerId: run.id });
  } finally {
    store.close();
  }
}

async function markBackgroundHandlerRunning(run: IntercomForkHandlerRun): Promise<void> {
  const module = await loadBackgroundEventsModule();
  if (!module) return;
  const store = new module.BackgroundEventsStore();
  try {
    store.markHandlerRunning(run.id, { pid: run.pid, supervisorPid: process.pid, processGroupId: run.pid });
  } finally {
    store.close();
  }
}

async function failBackgroundHandlerLaunch(handlerId: string, error: unknown): Promise<void> {
  const module = await loadBackgroundEventsModule();
  if (!module) return;
  const store = new module.BackgroundEventsStore();
  try {
    store.failHandlerLaunch(handlerId, { error: error instanceof Error ? error.message : String(error), requeue: true });
  } finally {
    store.close();
  }
}

async function completeBackgroundHandler(run: IntercomForkHandlerRun): Promise<void> {
  const module = await loadBackgroundEventsModule();
  if (!module) return;
  const store = new module.BackgroundEventsStore();
  try {
    store.completeHandler(run.id, { status: run.status === "complete" ? "complete" : "failed", summaryPath: run.stdoutPath });
  } finally {
    store.close();
  }
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

function resolveParentIntercomTarget(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
  const name = getParentSessionName(pi)?.trim();
  if (name) return name;
  const sessionId = getSessionId(ctx);
  if (!sessionId) return undefined;
  const normalized = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `subagent-chat-${normalized.slice(0, 8)}`;
}

function isSubagentResultEntry(entry: InboundForkMessageEntry): boolean {
  return entry.from.id === "subagent-result" || entry.from.name === "subagent-result";
}

function isSubagentRelayEntry(entry: InboundForkMessageEntry): boolean {
  return isSubagentResultEntry(entry) || entry.from.id === "subagent-control" || entry.from.name === "subagent-control";
}

const PARENT_TRIGGER_FALSE_PATTERN = /(?:pi-intercom:\s*)?(?:trigger[-_ ]?parent|parent[-_ ]?trigger|triggerParentOnSummary)\s*[:=]\s*(?:false|no|off|0)\b/i;
const PARENT_TRIGGER_TRUE_PATTERN = /(?:pi-intercom:\s*)?(?:trigger[-_ ]?parent|parent[-_ ]?trigger|triggerParentOnSummary)\s*[:=]\s*(?:true|yes|on|1)\b/i;

function explicitParentTrigger(text: string): boolean | undefined {
  if (PARENT_TRIGGER_FALSE_PATTERN.test(text)) return false;
  if (PARENT_TRIGGER_TRUE_PATTERN.test(text)) return true;
  return undefined;
}

const ACTIONABLE_PARENT_UPDATE_PATTERN = /\b(?:needs? (?:attention|decision|help)|blocked)\b/i;

export function shouldLaunchInboundForkHandler(entry: InboundForkMessageEntry): boolean {
  // Local subagent bridge messages are already background-work summaries/control
  // notices for this parent. Forking them creates a second fork to summarize a
  // summary, can duplicate parent-visible updates, and violates the no-fork-tree
  // intent. Deliver/queue them to the parent instead; shouldAutoTriggerParent
  // still wakes the parent when appropriate.
  if (isSubagentRelayEntry(entry)) return false;
  if (entry.message.expectsReply === true) return true;
  if (explicitParentTrigger(entry.bodyText) === true) return true;
  if (ACTIONABLE_PARENT_UPDATE_PATTERN.test(entry.bodyText)) return true;
  return false;
}

export function shouldAutoTriggerParent(entry: InboundForkMessageEntry): boolean {
  const explicit = explicitParentTrigger(entry.bodyText);
  if (explicit !== undefined) return explicit;
  if (isSubagentRelayEntry(entry)) return true;
  return shouldLaunchInboundForkHandler(entry);
}

export function resolveTriggerParentOnSummary(run: IntercomForkHandlerRun): boolean {
  if (run.triggerParentOnSummary === true) return true;
  if (run.triggerParentOnSummary === false) return false;
  const explicit = explicitParentTrigger(run.summary ?? "");
  if (explicit !== undefined) return explicit;
  return run.autoTriggerParentOnSummary === true;
}

function compactBodyForFork(entry: InboundForkMessageEntry, run: IntercomForkHandlerRun): string {
  if (!run.inboundBodyCompacted || !run.inboundBodyPath) return entry.bodyText;
  return [
    `[pi-intercom compacted this large subagent-result message for the fork handler prompt.]`,
    `Full inbound message: ${run.inboundBodyPath}`,
    `Original size: ${run.inboundBodyBytes ?? Buffer.byteLength(entry.bodyText, "utf8")} bytes`,
    "Read that file only if the summary/artifact/session paths below are not enough.",
    "",
    truncateText(entry.bodyText, SUBAGENT_RESULT_INLINE_LIMIT_BYTES),
  ].join("\n");
}

export function buildIntercomForkEventPayload(entry: InboundForkMessageEntry, run: IntercomForkHandlerRun, ctx: ExtensionContext, pi: ExtensionAPI) {
  const bodyText = compactBodyForFork(entry, run);
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
    parentIntercomTarget: run.parentIntercomTarget,
    payload: {
      messageId: entry.message.id,
      replyTo: entry.message.replyTo,
      expectsReply: entry.message.expectsReply === true,
      from: entry.from,
      bodyText,
      content: { ...entry.message.content, text: bodyText },
      ...(run.inboundBodyPath ? { fullBodyTextPath: run.inboundBodyPath, fullBodyTextBytes: run.inboundBodyBytes } : {}),
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
    run.triggerParentOnSummary === "auto"
      ? `Your final response WILL be copied into the parent transcript/context and may trigger a parent turn for asks, completed subagent results, or actionable updates.`
      : `Your final response WILL be copied into the parent transcript/context${run.triggerParentOnSummary ? " and will trigger a parent turn" : ""}.`,
    ...(run.triggerParentOnSummary === "auto" ? ["To opt out of a parent turn for a non-actionable summary, include exactly: Parent trigger: false"] : []),
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
      "Do not reply just to acknowledge receipt, startup, or routine progress.",
      `Only respond with intercom({ action: "send", to: ${JSON.stringify(senderTarget)}, message: "..." }) if you can correct course, provide requested data, or unblock something.`,
    ];
  return [
    "You are a background pi-intercom handler running in a sibling Pi session.",
    "The parent chat is busy and should stay undistracted unless a real decision is needed.",
    "This handler runs in a forked parent snapshot. Handle only the inbound intercom event capsule supplied here; use the forked transcript as context only and do not continue unrelated inherited parent work.",
    "",
    "Delegated authority:",
    "- Answer or act directly when the response is derivable from the inbound message, inherited context, repo files, local artifacts, or prior user instructions.",
    "- Escalate only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with parent work, or low confidence.",
    "- Use intercom.send for non-blocking notices. Use intercom.ask only for true blocking parent decisions.",
    "- If you create return_on watchers or subagents whose result the parent needs, route them to the inherited main/parent session; do not use parent: \"current\" unless the result is intentionally private to this ephemeral handler.",
    "- Keep any parent escalation brief and include the handler id.",
    ...parentNotificationModeLines(run).map((line) => `- ${line}`),
    "",
    ...replyGuidance,
    "",
    `Handler id: ${run.id}`,
    `Event JSON path: ${run.eventPath}`,
    ...(run.inboundBodyPath ? [`Full inbound message path: ${run.inboundBodyPath} (${run.inboundBodyBytes ?? "unknown"} bytes; prompt payload is compacted)`] : []),
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
    "You run in a forked parent snapshot; use it as context only and do not continue unrelated parent work.",
    "You have delegated authority to answer or act when safe and derivable.",
    "Escalate only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with parent work, or low confidence.",
    "For intercom asks, answer directly with intercom.send + replyTo when safe; otherwise escalate quickly.",
    "If you create return_on watchers or subagents whose result the parent needs, route them to the inherited main/parent session; do not use parent: \"current\" unless the result is intentionally private to this ephemeral handler.",
    ...parentNotificationModeLines(run),
    `Handler id: ${run.id}`,
  ].join("\n");
}

export function buildHandlerArgs(run: IntercomForkHandlerRun): string[] {
  return buildPiForkArgs({
    sessionDir: run.sessionDir,
    systemPrompt: buildIntercomForkHandlerSystemPrompt(run),
    promptPath: run.promptPath,
    forkFile: run.forkSessionFile || run.parentSessionFile,
  });
}

function fileSizeBytes(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parentSessionSnapshotPath(run: Pick<IntercomForkHandlerRun, "dir">): string {
  return path.join(run.dir, PARENT_SESSION_SNAPSHOT_FILE);
}

function isOwnedParentSessionSnapshot(run: Pick<IntercomForkHandlerRun, "dir" | "forkSessionFile">): boolean {
  if (!run.forkSessionFile) return false;
  return path.resolve(run.forkSessionFile) === path.resolve(parentSessionSnapshotPath(run));
}

export async function cleanupParentSessionSnapshot(run: IntercomForkHandlerRun): Promise<boolean> {
  if (!isOwnedParentSessionSnapshot(run)) return false;
  const snapshotPath = run.forkSessionFile!;
  try {
    await fsp.unlink(snapshotPath);
    run.parentSessionSnapshotDeletedAt = Date.now();
    delete run.parentSessionSnapshotCleanupError;
    delete run.forkSessionFile;
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      run.parentSessionSnapshotDeletedAt = Date.now();
      delete run.parentSessionSnapshotCleanupError;
      delete run.forkSessionFile;
      return true;
    }
    run.parentSessionSnapshotCleanupError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function cleanupStoredCompletedSnapshots(): Promise<boolean> {
  let changed = false;
  for (const run of handlerRuns) {
    if (run.status === "starting" || run.status === "running") continue;
    changed = await cleanupParentSessionSnapshot(run) || changed;
  }
  return changed;
}

function formatHandlerLogPath(label: "Output" | "Errors", filePath: string): string {
  const size = fileSizeBytes(filePath);
  if (size === null) return `${label}: unavailable (${filePath}, missing)`;
  if (label === "Errors" && size === 0) return `${label}: none (${filePath}, 0 B)`;
  return `${label}: ${filePath} (${size} B)`;
}

function formatSummary(run: IntercomForkHandlerRun): string {
  const status = run.status === "complete" ? "completed" : "failed";
  const output = run.summary?.trim() || run.error || "(no handler output)";
  return [
    `pi-intercom fork handler ${status}: ${run.id}`,
    `From: ${run.from}`,
    `Message: ${run.messageId}`,
    `Exit: ${run.exitCode ?? "signal " + (run.signal ?? "unknown")}`,
    formatHandlerLogPath("Output", run.stdoutPath),
    formatHandlerLogPath("Errors", run.stderrPath),
    "",
    truncateText(output, HANDLER_SUMMARY_LIMIT_BYTES),
  ].join("\n");
}

export function fallbackSummaryForEmptyHandler(run: Pick<IntercomForkHandlerRun, "from">, bodyText: string | undefined): string {
  const trimmed = bodyText?.trim();
  if (!trimmed) return "Handler exited without a final response. No handler output was captured.";
  return truncateText([
    "Handler exited without a final response; showing the original intercom message instead.",
    `From: ${run.from}`,
    "",
    trimmed,
  ].join("\n"), HANDLER_SUMMARY_LIMIT_BYTES);
}

async function readOriginalBodyText(run: IntercomForkHandlerRun): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(run.eventPath, "utf8");
    const parsed = JSON.parse(raw) as { payload?: { bodyText?: unknown; content?: { text?: unknown } } };
    return typeof parsed.payload?.bodyText === "string"
      ? parsed.payload.bodyText
      : typeof parsed.payload?.content?.text === "string"
        ? parsed.payload.content.text
        : undefined;
  } catch {
    return undefined;
  }
}

async function fillHandlerOutput(run: IntercomForkHandlerRun): Promise<{ stdout: string; stderr: string }> {
  const stdout = await readOptionalText(run.stdoutPath);
  const stderr = await readOptionalText(run.stderrPath);
  const rawSummary = stdout.trim() || stderr.trim();
  run.summary = rawSummary
    ? truncateText(rawSummary, HANDLER_SUMMARY_LIMIT_BYTES)
    : fallbackSummaryForEmptyHandler(run, await readOriginalBodyText(run));
  return { stdout, stderr };
}

export async function reconcileIntercomForkHandlers(pi?: Pick<ExtensionAPI, "appendEntry">): Promise<number> {
  await loadHandlers();
  let changed = 0;
  for (const run of handlerRuns) {
    if (run.status !== "starting" && run.status !== "running") continue;
    if (run.status === "running" && isProcessAlive(run.pid)) continue;
    const { stderr } = await fillHandlerOutput(run);
    run.endedAt = run.endedAt ?? Date.now();
    run.exitCode = run.exitCode ?? null;
    run.signal = run.signal ?? null;
    run.finishSource = "reconciled";
    if (run.status === "starting") {
      run.status = "failed";
      run.error = run.error || stderr.trim() || "handler was still starting when reconciliation found no live pid";
    } else if (stderr.trim()) {
      run.status = "failed";
      run.error = run.error || stderr.trim();
    } else {
      run.status = "complete";
    }
    await cleanupParentSessionSnapshot(run);
    changed += 1;
    try {
      pi?.appendEntry?.("intercom_fork_handler_reconciled", { id: run.id, status: run.status, pid: run.pid, endedAt: run.endedAt });
    } catch {
      // Best-effort audit trail.
    }
  }
  if (await cleanupStoredCompletedSnapshots()) changed += 1;
  if (changed > 0) await saveHandlers();
  return changed;
}

async function markHandlerFinished(pi: ExtensionAPI, ctx: ExtensionContext, config: InboundForkHandlersConfig, runId: string, code: number | null, signal: NodeJS.Signals | null, notify: InboundForkNotify, triggerParent: InboundForkTriggerParent): Promise<void> {
  await loadHandlers();
  const run = handlerRuns.find((candidate) => candidate.id === runId);
  if (!run) return;
  run.endedAt = Date.now();
  run.exitCode = code;
  run.signal = signal;
  run.finishSource = "close";
  const { stderr } = await fillHandlerOutput(run);
  run.status = code === 0 ? "complete" : "failed";
  if (code !== 0) run.error = stderr.trim() || `handler exited with ${code ?? signal ?? "unknown status"}`;
  await completeBackgroundHandler(run).catch((error) => {
    console.error("[pi-intercom] Failed to complete background event handler", error);
  });
  await kickIntercomBackgroundQueueDrain(pi, ctx, config, `handler ${run.id} finished`);
  await cleanupParentSessionSnapshot(run);
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
      { triggerTurn: triggerParent === true || resolveTriggerParentOnSummary(run) },
    );
  }
}

export async function launchIntercomForkHandler(pi: ExtensionAPI, ctx: ExtensionContext, entry: InboundForkMessageEntry, config: InboundForkHandlersConfig, options: LaunchIntercomForkHandlerOptions = {}): Promise<boolean> {
  await reconcileIntercomForkHandlers(pi);
  await loadHandlers();
  const id = options.handlerId ?? makeHandlerId(entry.message);
  const paths = buildForkRunPaths("intercom", id);
  const parentSessionFile = getSessionFile(ctx);
  const parentSessionId = getSessionId(ctx);
  const parentSessionName = getParentSessionName(pi);
  const parentIntercomTarget = resolveParentIntercomTarget(pi, ctx);
  const run: IntercomForkHandlerRun = {
    ...paths,
    eventId: intercomBackgroundEventId(entry.message.id),
    messageId: entry.message.id,
    from: entry.from.name || entry.from.id,
    status: "starting",
    cwd: ctx.cwd ?? process.cwd(),
    ...(parentSessionFile ? { parentSessionFile } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(parentSessionName ? { parentSessionName } : {}),
    ...(parentIntercomTarget ? { parentIntercomTarget } : {}),
    notify: config.notify,
    triggerParentOnSummary: config.triggerParentOnSummary,
    autoTriggerParentOnSummary: shouldAutoTriggerParent(entry),
    startedAt: Date.now(),
  };
  await fsp.mkdir(run.sessionDir, { recursive: true });
  const inboundBodyBytes = Buffer.byteLength(entry.bodyText, "utf8");
  if (isSubagentResultEntry(entry) && inboundBodyBytes > SUBAGENT_RESULT_INLINE_LIMIT_BYTES) {
    run.inboundBodyPath = path.join(run.dir, "inbound-message.md");
    run.inboundBodyBytes = inboundBodyBytes;
    run.inboundBodyCompacted = true;
    await fsp.writeFile(run.inboundBodyPath, entry.bodyText, "utf8");
  }
  const eventJson = JSON.stringify(buildIntercomForkEventPayload(entry, run, ctx, pi), null, 2);
  await fsp.writeFile(run.eventPath, `${eventJson}\n`, "utf8");
  await fsp.writeFile(run.promptPath, buildIntercomForkHandlerPrompt(entry, run, eventJson), "utf8");
  const routed = options.skipBackgroundRoute ? undefined : await routeIntercomBackgroundEvent(entry, run).catch((error) => {
    console.error("[pi-intercom] Failed to route inbound fork event through background-events", error);
    return undefined;
  });
  if (routed && routed.disposition !== "handler-starting") {
    try {
      pi.appendEntry?.("intercom_fork_handler_routed_without_launch", { id: run.id, routedHandlerId: routed.handlerId, queueId: routed.queueId, messageId: run.messageId, disposition: routed.disposition });
    } catch {
      // Best effort audit trail.
    }
    return true;
  }
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
        PI_BACKGROUND_FORK_DEPTH: String(currentBackgroundForkDepth() + 1),
        PI_BACKGROUND_MAX_FORK_DEPTH: String(maxBackgroundForkDepth()),
        PI_BACKGROUND_HANDLER_ID: run.id,
        PI_BACKGROUND_EVENT_ID: run.eventId,
        PI_BACKGROUND_WORK_KEY: intercomWorkKey(run),
        PI_BACKGROUND_LINEAGE_ID: process.env.PI_BACKGROUND_LINEAGE_ID || intercomWorkKey(run),
        ...(run.parentSessionFile ? { PI_BACKGROUND_PARENT_SESSION_FILE: run.parentSessionFile, [INTERCOM_PARENT_SESSION_FILE_ENV]: run.parentSessionFile } : {}),
        ...(run.parentSessionId ? { PI_BACKGROUND_PARENT_SESSION_ID: run.parentSessionId, [INTERCOM_PARENT_SESSION_ID_ENV]: run.parentSessionId } : {}),
        ...(run.parentIntercomTarget ? { PI_BACKGROUND_PARENT_INTERCOM_TARGET: run.parentIntercomTarget } : {}),
        ...(run.parentSessionName ? { [INTERCOM_PARENT_SESSION_NAME_ENV]: run.parentSessionName } : {}),
        ...(run.parentIntercomTarget ? { [INTERCOM_PARENT_INTERCOM_TARGET_ENV]: run.parentIntercomTarget } : {}),
      }),
      onClose: (code, signal) => {
        void (async () => {
          await markHandlerFinished(pi, ctx, config, run.id, code, signal, config.notify, config.triggerParentOnSummary);
          await kickIntercomBackgroundQueueDrain(pi, ctx, config, `handler ${run.id} finished`);
        })().catch((error) => {
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
      await failBackgroundHandlerLaunch(run.id, launch.error).catch((error) => {
        console.error("[pi-intercom] Failed to compensate background event launch failure", error);
      });
      await cleanupParentSessionSnapshot(failed);
      if (!handlerRuns.some((candidate) => candidate.id === run.id)) handlerRuns.push(failed);
      await saveHandlers();
      console.error("[pi-intercom] Failed to launch fork handler", launch.error);
      return false;
    }

    run.pid = launch.pid;
    run.status = "running";
    await markBackgroundHandlerRunning(run).catch((error) => {
      console.error("[pi-intercom] Failed to mark background event handler running", error);
    });
    await saveHandlers();
    return true;
  } catch (error) {
    run.status = "failed";
    run.endedAt = Date.now();
    run.error = error instanceof Error ? error.message : String(error);
    await failBackgroundHandlerLaunch(run.id, error).catch((compensateError) => {
      console.error("[pi-intercom] Failed to compensate background event launch exception", compensateError);
    });
    await cleanupParentSessionSnapshot(run);
    await saveHandlers();
    console.error("[pi-intercom] Failed to launch fork handler", error);
    return false;
  }
}

function entryFromBackgroundPayload(payload: any): InboundForkMessageEntry | undefined {
  const body = payload?.payload;
  if (!body?.messageId || !body?.from) return undefined;
  return {
    from: body.from,
    message: {
      id: body.messageId,
      timestamp: typeof body.timestamp === "number" ? body.timestamp : Date.now(),
      ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      ...(body.expectsReply === true ? { expectsReply: true } : {}),
      content: body.content ?? { text: body.bodyText ?? "" },
    },
    ...(body.expectsReply === true ? { replyCommand: `intercom({ action: "reply", message: "..." })` } : {}),
    bodyText: body.bodyText ?? body.content?.text ?? "",
  };
}

export async function drainIntercomBackgroundQueue(pi: ExtensionAPI, ctx: ExtensionContext, config: InboundForkHandlersConfig): Promise<number> {
  const module = await loadBackgroundEventsModule();
  if (!module) return 0;
  const store = new module.BackgroundEventsStore();
  try {
    const pass = store.runReconcilerPass({ leaseName: "intercom", ownerId: `intercom:${process.pid}`, leaseTtlMs: 30_000, dequeueLimit: 4, source: "intercom" });
    let launched = 0;
    for (const bundle of pass.launchBundles ?? []) {
      if (bundle.source !== "intercom") continue;
      const firstEvent = bundle.events[0];
      if (!firstEvent) continue;
      const payload = JSON.parse(await fsp.readFile(firstEvent.payloadPath, "utf8"));
      const entry = entryFromBackgroundPayload(payload);
      if (!entry) continue;
      if (await launchIntercomForkHandler(pi, ctx, entry, config, { handlerId: bundle.handlerId, skipBackgroundRoute: true })) launched += 1;
    }
    return launched;
  } finally {
    store.close();
  }
}

async function kickIntercomBackgroundQueueDrain(pi: ExtensionAPI, ctx: ExtensionContext, config: InboundForkHandlersConfig, reason: string): Promise<void> {
  if (backgroundQueueDrainActive) {
    backgroundQueueDrainPending = true;
    return;
  }
  backgroundQueueDrainActive = true;
  try {
    do {
      backgroundQueueDrainPending = false;
      await drainIntercomBackgroundQueue(pi, ctx, config);
    } while (backgroundQueueDrainPending);
  } catch (error) {
    console.error(`[pi-intercom] Failed to drain background queue after ${reason}:`, error);
  } finally {
    backgroundQueueDrainActive = false;
  }
}

export async function listIntercomForkHandlers(status: "running" | "complete" | "failed" | "all" = "all"): Promise<IntercomForkHandlerRun[]> {
  await reconcileIntercomForkHandlers();
  await loadHandlers();
  return handlerRuns
    .filter((run) => status === "all" || run.status === status)
    .sort((a, b) => b.startedAt - a.startedAt);
}
