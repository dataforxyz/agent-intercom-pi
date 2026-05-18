import test from "node:test";
import assert from "node:assert/strict";
import { buildIntercomForkHandlerPrompt, buildIntercomForkHandlerSystemPrompt, type IntercomForkHandlerRun, type InboundForkMessageEntry } from "./fork-handler.ts";

function makeRun(): IntercomForkHandlerRun {
  return {
    id: "icfh_test",
    eventId: "intercom_msg-1",
    messageId: "msg-1",
    from: "worker",
    status: "starting",
    cwd: "/tmp/project",
    dir: "/tmp/pi-intercom/handlers/icfh_test",
    eventPath: "/tmp/pi-intercom/handlers/icfh_test/event.json",
    promptPath: "/tmp/pi-intercom/handlers/icfh_test/prompt.md",
    stdoutPath: "/tmp/pi-intercom/handlers/icfh_test/stdout.log",
    stderrPath: "/tmp/pi-intercom/handlers/icfh_test/stderr.log",
    sessionDir: "/tmp/pi-intercom/handlers/icfh_test/sessions",
    startedAt: 1,
  };
}

function makeEntry(expectsReply: boolean): InboundForkMessageEntry {
  return {
    from: {
      id: "session-worker",
      name: "worker",
      cwd: "/tmp/project",
      model: "test-model",
      pid: 123,
      startedAt: 1,
      lastActivity: 2,
      status: "thinking",
    },
    message: {
      id: "msg-1",
      timestamp: 2,
      expectsReply,
      content: { text: expectsReply ? "Can I proceed?" : "FYI: build finished" },
    },
    replyCommand: expectsReply ? "intercom({ action: \"reply\", message: \"...\" })" : undefined,
    bodyText: expectsReply ? "Can I proceed?" : "FYI: build finished",
  };
}

test("ask fork handler prompt tells handler to answer with replyTo and delegated authority", () => {
  const prompt = buildIntercomForkHandlerPrompt(makeEntry(true), makeRun(), JSON.stringify({ type: "intercom.ask" }, null, 2));
  assert.match(prompt, /sender is blocked waiting/i);
  assert.match(prompt, /replyTo: "msg-1"/);
  assert.match(prompt, /delegated authority/i);
  assert.match(prompt, /Escalate only for destructive actions/i);
});

test("send fork handler prompt treats non-blocking messages as async summaries", () => {
  const prompt = buildIntercomForkHandlerPrompt(makeEntry(false), makeRun(), JSON.stringify({ type: "intercom.message" }, null, 2));
  assert.match(prompt, /non-blocking intercom send/i);
  assert.match(prompt, /summarize only what matters/i);
});

test("system prompt constrains fork handler to the intercom event capsule", () => {
  const prompt = buildIntercomForkHandlerSystemPrompt(makeRun());
  assert.match(prompt, /only task is to handle the inbound intercom event capsule/i);
  assert.match(prompt, /Do not continue unrelated inherited parent work/i);
  assert.match(prompt, /answer directly with intercom.send \+ replyTo/i);
});
