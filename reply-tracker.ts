import { getAskTimeoutMs } from "./config.ts";
import type { Message, SessionInfo } from "./types.ts";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
  deferredAt?: number;
}

function matchesPendingSender(context: IntercomContext, to: string): boolean {
  if (context.from.id === to) {
    return true;
  }

  return context.from.name?.toLowerCase() === to.toLowerCase();
}

function contextKey(fromSessionId: string, messageId: string): string {
  return `${fromSessionId}\u0000${messageId}`;
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[][] = [];
  private currentTurnContexts: IntercomContext[] = [];

  constructor(private readonly askTimeoutMs = getAskTimeoutMs()) {}

  recordIncomingMessage(from: SessionInfo, message: Message, receivedAt = Date.now()): IntercomContext {
    const key = contextKey(from.id, message.id);
    const existing = this.pendingAsks.get(key);
    const context = {
      from,
      message,
      receivedAt,
      ...(existing?.deferredAt === undefined ? {} : { deferredAt: existing.deferredAt }),
    };
    if (message.expectsReply) {
      this.pendingAsks.set(key, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.queueTurnContexts([context]);
  }

  queueTurnContexts(contexts: readonly IntercomContext[]): void {
    if (contexts.length > 0) {
      this.pendingTurnContexts.push([...contexts]);
    }
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContexts = this.pendingTurnContexts.shift() ?? [];
  }

  endTurn(): void {
    this.currentTurnContexts = [];
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContexts = [];
  }

  resolveReplyTarget(options: { to?: string; replyTo?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    if (options.replyTo) {
      const candidates = Array.from(this.pendingAsks.values()).filter((context) => context.message.id === options.replyTo);
      if (candidates.length === 0) {
        throw new Error(`No pending ask with message ID "${options.replyTo}"`);
      }
      const matches = options.to ? candidates.filter((context) => matchesPendingSender(context, options.to!)) : candidates;
      if (matches.length === 0) {
        throw new Error(`Pending ask "${options.replyTo}" is not from "${options.to}"`);
      }
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks use message ID "${options.replyTo}" — specify \`to\``);
      }
      return matches[0]!;
    }

    if (this.currentTurnContexts.length > 0) {
      const turnMatches = options.to
        ? this.currentTurnContexts.filter((context) => matchesPendingSender(context, options.to!))
        : this.currentTurnContexts;
      const replyableMatches = turnMatches.filter((context) => context.message.expectsReply);
      if (replyableMatches.length === 1) {
        return replyableMatches[0]!;
      }
      if (replyableMatches.length > 1) {
        throw new Error("Multiple asks are active in this intercom batch — specify `to` to select the sender");
      }
      if (turnMatches.length === 1) {
        return turnMatches[0]!;
      }
      if (turnMatches.length > 1) {
        throw new Error("Multiple messages are active in this intercom batch — specify `to` to select the sender");
      }
    }

    const pending = Array.from(this.pendingAsks.values());
    if (pending.length === 1) {
      return pending[0]!;
    }

    if (options.to) {
      const matches = pending.filter((context) => matchesPendingSender(context, options.to!));
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks from \"${options.to}\" cannot be disambiguated by sender alone`);
      }
      if (pending.length > 1) {
        throw new Error(`No pending ask from \"${options.to}\"`);
      }
    }

    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }

    throw new Error("Multiple pending asks — specify `to` using a sender from `intercom_pending`");
  }

  markReplied(replyTo: string, fromSessionId?: string): void {
    this.dismissPendingAsk(replyTo, fromSessionId);
  }

  markDeferred(replyTo: string, fromSessionIdOrDeferredAt?: string | number, deferredAt = Date.now()): boolean {
    const fromSessionId = typeof fromSessionIdOrDeferredAt === "string" ? fromSessionIdOrDeferredAt : undefined;
    const effectiveDeferredAt = typeof fromSessionIdOrDeferredAt === "number" ? fromSessionIdOrDeferredAt : deferredAt;
    let changed = false;
    for (const context of this.pendingAsks.values()) {
      if (context.message.id === replyTo && (!fromSessionId || context.from.id === fromSessionId)) {
        context.deferredAt = effectiveDeferredAt;
        changed = true;
      }
    }
    return changed;
  }

  dismissPendingAsk(replyTo: string, fromSessionId?: string): void {
    for (const [key, context] of this.pendingAsks) {
      if (context.message.id === replyTo && (!fromSessionId || context.from.id === fromSessionId)) {
        this.pendingAsks.delete(key);
      }
    }
    for (let batchIndex = this.pendingTurnContexts.length - 1; batchIndex >= 0; batchIndex -= 1) {
      const batch = this.pendingTurnContexts[batchIndex]!;
      for (let contextIndex = batch.length - 1; contextIndex >= 0; contextIndex -= 1) {
        if (
          batch[contextIndex]?.message.id === replyTo
          && (!fromSessionId || batch[contextIndex]?.from.id === fromSessionId)
        ) {
          batch.splice(contextIndex, 1);
        }
      }
      if (batch.length === 0) this.pendingTurnContexts.splice(batchIndex, 1);
    }
    this.currentTurnContexts = this.currentTurnContexts.filter((context) =>
      context.message.id !== replyTo || (fromSessionId !== undefined && context.from.id !== fromSessionId)
    );
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const context of Array.from(this.pendingAsks.values())) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.dismissPendingAsk(context.message.id, context.from.id);
      }
    }
  }
}
