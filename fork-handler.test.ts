import test from "node:test";
import assert from "node:assert/strict";
import { buildIntercomForkEventPayload, buildIntercomForkHandlerPrompt, buildIntercomForkHandlerSystemPrompt, resolveTriggerParentOnSummary, shouldAutoTriggerParent, type IntercomForkHandlerRun, type InboundForkMessageEntry } from "./fork-handler.ts";

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

test("large subagent-result payloads are compacted for fork handler prompts", () => {
  const entry = makeEntry(false);
  entry.from.id = "subagent-result";
  entry.from.name = "subagent-result";
  entry.bodyText = `subagent results\n\nRun: async-1\nStatus: completed\n\n1. worker — completed\nOutput artifact: /tmp/result.md\nSession: /tmp/session.jsonl\nSummary:\n${"detail\n".repeat(2000)}`;
  entry.message.content.text = entry.bodyText;
  const run = {
    ...makeRun(),
    inboundBodyPath: "/tmp/pi-intercom/handlers/icfh_test/inbound-message.md",
    inboundBodyBytes: Buffer.byteLength(entry.bodyText, "utf8"),
    inboundBodyCompacted: true,
  };
  const payload = buildIntercomForkEventPayload(entry, run, { cwd: "/tmp/project" } as any, { getSessionName: () => "parent" } as any) as any;
  assert.equal(payload.payload.fullBodyTextPath, run.inboundBodyPath);
  assert.match(payload.payload.bodyText, /compacted this large subagent-result message/);
  assert.match(payload.payload.bodyText, /Full inbound message: \/tmp\/pi-intercom/);
  assert.ok(payload.payload.bodyText.length < entry.bodyText.length);
  const prompt = buildIntercomForkHandlerPrompt(entry, run, JSON.stringify(payload, null, 2));
  assert.match(prompt, /Full inbound message path:/);
});

test("auto parent trigger wakes for subagent results but not routine progress", () => {
  const progress = makeEntry(false);
  progress.bodyText = "Subagent progress update. Reviewing PR now.";
  progress.message.content.text = progress.bodyText;
  assert.equal(shouldAutoTriggerParent(progress), false);

  const result = makeEntry(false);
  result.from.id = "subagent-result";
  result.from.name = "subagent-result";
  result.bodyText = "subagent results\n\nStatus: completed";
  result.message.content.text = result.bodyText;
  assert.equal(shouldAutoTriggerParent(result), true);

  const run = { ...makeRun(), triggerParentOnSummary: "auto" as const, autoTriggerParentOnSummary: true };
  assert.equal(resolveTriggerParentOnSummary(run), true);
  assert.equal(resolveTriggerParentOnSummary({ ...run, summary: "Handled; Parent trigger: false" }), false);
});

test("system prompt constrains fork handler to the intercom event capsule", () => {
  const prompt = buildIntercomForkHandlerSystemPrompt(makeRun());
  assert.match(prompt, /only task is to handle the inbound intercom event capsule/i);
  assert.match(prompt, /Do not continue unrelated inherited parent work/i);
  assert.match(prompt, /answer directly with intercom.send \+ replyTo/i);
});
