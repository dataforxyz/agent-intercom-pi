import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ASK_WAIT_MS, getAskTimeoutMs, getAskWaitMs } from "./config.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import type { Message, SessionInfo } from "./types.ts";

function createSession(id: string, name: string): SessionInfo {
  return {
    id,
    name,
    cwd: "/tmp/project",
    model: "test-model",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
  };
}

function createMessage(id: string, text: string, expectsReply = true): Message {
  return {
    id,
    timestamp: 1,
    expectsReply,
    content: { text },
  };
}

test("reply resolves from current triggered message context", () => {
  const tracker = new ReplyTracker();
  const from = createSession("planner-id", "planner");
  const message = createMessage("ask-1", "Need a decision");

  const context = tracker.recordIncomingMessage(from, message, 1000);
  tracker.queueTurnContext(context);
  tracker.beginTurn(1001);

  assert.equal(tracker.resolveReplyTarget({}, 1002).message.id, "ask-1");
  assert.equal(tracker.resolveReplyTarget({}, 1002).from.id, "planner-id");
});

test("a batch with one ask and ordinary messages has an unambiguous implicit reply", () => {
  const tracker = new ReplyTracker();
  const planner = createSession("planner-id", "planner");
  const reviewer = createSession("reviewer-id", "reviewer");
  const note = tracker.recordIncomingMessage(planner, createMessage("note-1", "FYI", false), 1000);
  const ask = tracker.recordIncomingMessage(reviewer, createMessage("ask-1", "Need a decision"), 1001);
  tracker.queueTurnContexts([note, ask]);
  tracker.beginTurn(1002);

  assert.equal(tracker.resolveReplyTarget({}, 1003).message.id, "ask-1");
});

test("multiple asks in one batch require explicit replyTo unless sender disambiguates", () => {
  const tracker = new ReplyTracker();
  const plannerAsk = tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  const reviewerAsk = tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);
  tracker.queueTurnContexts([plannerAsk, reviewerAsk]);
  tracker.beginTurn(1002);

  assert.throws(() => tracker.resolveReplyTarget({}, 1003), /Multiple asks are active/);
  assert.equal(tracker.resolveReplyTarget({ to: "reviewer" }, 1003).message.id, "ask-2");
  assert.equal(tracker.resolveReplyTarget({ replyTo: "ask-1" }, 1003).from.id, "planner-id");
});

test("multiple ordinary messages in one batch do not choose an arbitrary reply target", () => {
  const tracker = new ReplyTracker();
  const from = createSession("planner-id", "planner");
  const first = tracker.recordIncomingMessage(from, createMessage("note-1", "First", false), 1000);
  const second = tracker.recordIncomingMessage(from, createMessage("note-2", "Second", false), 1001);
  tracker.queueTurnContexts([first, second]);
  tracker.beginTurn(1002);

  assert.throws(() => tracker.resolveReplyTarget({}, 1003), /Multiple messages are active/);
});

test("reply resolves from single pending ask without current turn context", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  assert.equal(tracker.resolveReplyTarget({}, 1001).message.id, "ask-1");
});

test("reply with to resolves matching pending ask", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.equal(tracker.resolveReplyTarget({ to: "reviewer" }, 1002).message.id, "ask-2");
  assert.equal(tracker.resolveReplyTarget({ to: "planner-id" }, 1002).message.id, "ask-1");
});

test("replyTo resolves the exact pending ask", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.equal(tracker.resolveReplyTarget({ replyTo: "ask-2" }, 1002).from.id, "reviewer-id");
  assert.throws(() => tracker.resolveReplyTarget({ to: "planner", replyTo: "ask-2" }, 1002), /is not from/);
});

test("same message ID from different senders remains independently addressable", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("shared-id", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("shared-id", "Second"), 1001);

  assert.equal(tracker.listPending(1002).length, 2);
  assert.throws(() => tracker.resolveReplyTarget({ replyTo: "shared-id" }, 1002), /Multiple pending asks use message ID/);
  assert.equal(tracker.resolveReplyTarget({ replyTo: "shared-id", to: "reviewer-id" }, 1002).from.id, "reviewer-id");
  tracker.markReplied("shared-id", "reviewer-id");
  assert.deepEqual(tracker.listPending(1003).map((context) => context.from.id), ["planner-id"]);
});

test("reply errors when no context and no pending asks", () => {
  const tracker = new ReplyTracker();

  assert.throws(() => tracker.resolveReplyTarget({}, 1000), /No active intercom context to reply to/);
});

test("reply errors when multiple pending asks and no to", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.throws(() => tracker.resolveReplyTarget({}, 1002), /Multiple pending asks — specify `replyTo`/);
});

test("reply removes pending ask after successful reply", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  tracker.markReplied("ask-1");

  assert.deepEqual(tracker.listPending(1001), []);
});

test("ask timeout can be configured from environment", () => {
  const previous = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "42";
  try {
    assert.equal(getAskTimeoutMs(), 42);
    assert.throws(() => {
      process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "0";
      getAskTimeoutMs();
    }, /positive integer/);
  } finally {
    if (previous === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previous;
  }
});

test("ask blocking wait defaults to 30 seconds and can be configured separately", () => {
  const previous = process.env.PI_INTERCOM_ASK_WAIT_MS;
  delete process.env.PI_INTERCOM_ASK_WAIT_MS;
  try {
    assert.equal(DEFAULT_ASK_WAIT_MS, 30_000);
    assert.equal(getAskWaitMs(), 30_000);
    process.env.PI_INTERCOM_ASK_WAIT_MS = "42";
    assert.equal(getAskWaitMs(), 42);
    process.env.PI_INTERCOM_ASK_WAIT_MS = "0";
    assert.throws(() => getAskWaitMs(), /positive integer/);
  } finally {
    if (previous === undefined) delete process.env.PI_INTERCOM_ASK_WAIT_MS;
    else process.env.PI_INTERCOM_ASK_WAIT_MS = previous;
  }
});

test("pending asks can be explicitly dismissed without removing retryable failures", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Retryable"), 1001);

  tracker.dismissPendingAsk("ask-1");

  assert.deepEqual(tracker.listPending(1002).map((context) => context.message.id), ["ask-2"]);
});

test("pending asks can be marked deferred before a later reply", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  assert.equal(tracker.markDeferred("ask-1", 1100), true);
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);
  assert.equal(tracker.listPending(1200)[0]?.deferredAt, 1100);
  assert.equal(tracker.resolveReplyTarget({}, 1200).message.id, "ask-1");
  assert.equal(tracker.markDeferred("missing", 1200), false);
});

test("dismissing a pending ask removes queued turn context", () => {
  const tracker = new ReplyTracker();
  const context = tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);
  tracker.queueTurnContext(context);

  tracker.dismissPendingAsk("ask-1");
  tracker.beginTurn(1001);

  assert.throws(() => tracker.resolveReplyTarget({}, 1002), /No active intercom context to reply to/);
});
