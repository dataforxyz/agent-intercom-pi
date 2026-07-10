import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "fs";
import { join } from "path";
import {
  ensureIntercomRuntimeDir,
  getIntercomDirPath,
  INTERCOM_DIR_MODE,
  restrictIntercomRuntimeFile,
} from "./broker/paths.ts";
import { writeDurableJson } from "./durable-json.ts";
import type { Message, SessionInfo } from "./types.ts";

const INBOX_STATE_VERSION = 3;
const MAX_REMEMBERED_MESSAGE_KEYS = 4096;

export interface StoredInboundMessage {
  key: string;
  from: SessionInfo;
  message: Message;
  receivedAt: number;
  sequence: number;
}

interface InboxState {
  version: typeof INBOX_STATE_VERSION;
  nextSequence: number;
  entries: StoredInboundMessage[];
  pendingAsks: StoredInboundMessage[];
  seen: string[];
  fingerprints: Record<string, string>;
}

export interface EnqueueResult {
  duplicate: boolean;
  entry: StoredInboundMessage;
}

export class InboundMessageConflictError extends Error {
  constructor(readonly messageId: string) {
    super(`Conflicting payload for reused message ID "${messageId}"`);
    this.name = "InboundMessageConflictError";
  }
}

function messageKey(from: SessionInfo, message: Message): string {
  return `${from.id}\u0000${message.id}`;
}

function messageFingerprint(message: Message): string {
  return JSON.stringify({
    replyTo: message.replyTo,
    expectsReply: message.expectsReply,
    content: message.content,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredInboundMessage(value: unknown): value is StoredInboundMessage {
  if (!isObject(value) || typeof value.key !== "string" || typeof value.receivedAt !== "number" || typeof value.sequence !== "number") {
    return false;
  }
  if (!isObject(value.from) || typeof value.from.id !== "string" || typeof value.from.cwd !== "string") {
    return false;
  }
  if (!isObject(value.message) || typeof value.message.id !== "string" || !isObject(value.message.content) || typeof value.message.content.text !== "string") {
    return false;
  }
  return value.key === messageKey(value.from as unknown as SessionInfo, value.message as unknown as Message);
}

function emptyState(): InboxState {
  return { version: INBOX_STATE_VERSION, nextSequence: 1, entries: [], pendingAsks: [], seen: [], fingerprints: {} };
}

function parseState(raw: string): InboxState {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isObject(parsed)
    || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== INBOX_STATE_VERSION)
    || typeof parsed.nextSequence !== "number"
    || !Number.isSafeInteger(parsed.nextSequence)
    || parsed.nextSequence < 1
    || !Array.isArray(parsed.entries)
    || !parsed.entries.every(isStoredInboundMessage)
    || !Array.isArray(parsed.seen)
    || !parsed.seen.every((key) => typeof key === "string")
  ) {
    throw new Error("Invalid persistent inbound inbox state");
  }

  const entries = [...parsed.entries].sort((a, b) => a.sequence - b.sequence);
  const pendingAsks = parsed.version === 1
    ? entries.filter((entry) => entry.message.expectsReply)
    : parsed.pendingAsks;
  if (!Array.isArray(pendingAsks) || !pendingAsks.every(isStoredInboundMessage)) {
    throw new Error("Invalid persistent inbound pending-ask state");
  }
  const uniquePendingAsks = Array.from(new Map(pendingAsks.map((entry) => [entry.key, entry])).values())
    .sort((a, b) => a.sequence - b.sequence);
  const seen = Array.from(new Set([
    ...parsed.seen,
    ...entries.map((entry) => entry.key),
    ...uniquePendingAsks.map((entry) => entry.key),
  ]));
  const fingerprints: Record<string, string> = {};
  if (parsed.version === INBOX_STATE_VERSION) {
    if (!isObject(parsed.fingerprints) || !Object.values(parsed.fingerprints).every((value) => typeof value === "string")) {
      throw new Error("Invalid persistent inbound fingerprint state");
    }
    Object.assign(fingerprints, parsed.fingerprints);
  }
  for (const entry of [...entries, ...uniquePendingAsks]) {
    fingerprints[entry.key] = messageFingerprint(entry.message);
  }
  const nextSequence = Math.max(parsed.nextSequence, ...entries.map((entry) => entry.sequence + 1), 1);
  return { version: INBOX_STATE_VERSION, nextSequence, entries, pendingAsks: uniquePendingAsks, seen, fingerprints };
}

function sessionInboxFileName(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `${digest}.json`;
}

export class PersistentInboundInbox {
  private readonly filePath: string;
  private state: InboxState;
  private readonly seen = new Set<string>();

  constructor(sessionId: string, intercomDir: string = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    const inboxDir = join(intercomDir, "inbox");
    mkdirSync(inboxDir, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync(inboxDir, INTERCOM_DIR_MODE);
    this.filePath = join(inboxDir, sessionInboxFileName(sessionId));
    this.state = this.loadState();
    for (const key of this.state.seen) this.seen.add(key);
  }

  get size(): number {
    return this.state.entries.length;
  }

  list(): StoredInboundMessage[] {
    return this.state.entries.map((entry) => ({ ...entry }));
  }

  listPendingAsks(): StoredInboundMessage[] {
    return this.state.pendingAsks.map((entry) => ({ ...entry }));
  }

  enqueue(from: SessionInfo, message: Message, receivedAt = Date.now()): EnqueueResult {
    const key = messageKey(from, message);
    const fingerprint = messageFingerprint(message);
    const existing = this.state.entries.find((entry) => entry.key === key);
    if (existing) {
      if (messageFingerprint(existing.message) !== fingerprint) {
        throw new InboundMessageConflictError(message.id);
      }
      return { duplicate: true, entry: { ...existing } };
    }

    if (this.seen.has(key)) {
      const previousFingerprint = this.state.fingerprints[key];
      if (previousFingerprint !== undefined && previousFingerprint !== fingerprint) {
        throw new InboundMessageConflictError(message.id);
      }
      if (previousFingerprint === undefined) {
        this.state.fingerprints[key] = fingerprint;
        this.persist();
      }
      return {
        duplicate: true,
        entry: { key, from, message, receivedAt, sequence: -1 },
      };
    }

    const entry: StoredInboundMessage = {
      key,
      from,
      message,
      receivedAt,
      sequence: this.state.nextSequence,
    };
    this.state.nextSequence += 1;
    this.state.entries.push(entry);
    if (message.expectsReply) this.state.pendingAsks.push(entry);
    this.state.seen.push(key);
    this.state.fingerprints[key] = fingerprint;
    this.seen.add(key);
    this.trimSeen();
    this.persist();
    return { duplicate: false, entry: { ...entry } };
  }

  consume(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const consumed = new Set(keys);
    const remaining = this.state.entries.filter((entry) => !consumed.has(entry.key));
    if (remaining.length === this.state.entries.length) return;
    this.state.entries = remaining;
    this.trimSeen();
    this.persist();
  }

  dismissPendingAsk(messageId: string, fromSessionId?: string): void {
    const remaining = this.state.pendingAsks.filter((entry) =>
      entry.message.id !== messageId || (fromSessionId !== undefined && entry.from.id !== fromSessionId)
    );
    if (remaining.length === this.state.pendingAsks.length) return;
    this.state.pendingAsks = remaining;
    this.trimSeen();
    this.persist();
  }

  prunePendingAsks(timeoutMs: number, now = Date.now()): void {
    const remaining = this.state.pendingAsks.filter((entry) => now - entry.receivedAt <= timeoutMs);
    if (remaining.length === this.state.pendingAsks.length) return;
    this.state.pendingAsks = remaining;
    this.trimSeen();
    this.persist();
  }

  private loadState(): InboxState {
    if (!existsSync(this.filePath)) return emptyState();
    try {
      return parseState(readFileSync(this.filePath, "utf-8"));
    } catch {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync(this.filePath, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      return emptyState();
    }
  }

  private trimSeen(): void {
    if (this.state.seen.length <= MAX_REMEMBERED_MESSAGE_KEYS) return;
    const pendingKeys = new Set([
      ...this.state.entries.map((entry) => entry.key),
      ...this.state.pendingAsks.map((entry) => entry.key),
    ]);
    const retainedRecent: string[] = [];
    const recentLimit = Math.max(0, MAX_REMEMBERED_MESSAGE_KEYS - pendingKeys.size);
    for (let index = this.state.seen.length - 1; index >= 0 && retainedRecent.length < recentLimit; index -= 1) {
      const key = this.state.seen[index]!;
      if (!pendingKeys.has(key)) retainedRecent.push(key);
    }
    this.state.seen = [...pendingKeys, ...retainedRecent.reverse()];
    const retainedKeys = new Set(this.state.seen);
    for (const key of Object.keys(this.state.fingerprints)) {
      if (!retainedKeys.has(key)) delete this.state.fingerprints[key];
    }
    this.seen.clear();
    for (const key of this.state.seen) this.seen.add(key);
  }

  private persist(): void {
    writeDurableJson(this.filePath, this.state);
  }
}
