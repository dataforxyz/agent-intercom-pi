import test from "node:test";
import assert from "node:assert/strict";
import { compactIntercomHandlerMessages } from "./context-compaction.ts";

test("compacts routine intercom handler receipts while preserving lookup pointers", () => {
  const receipt = {
    role: "custom",
    customType: "intercom_fork_handler",
    content: [
      "intercom fork handler complete: incoming message",
      "Handler: icfh_123",
      "Message: msg-1",
      "From: worker",
      "Exit: 0",
      "Output: /tmp/pi-intercom/stdout.log (10000 B)",
      "Errors: none (/tmp/pi-intercom/stderr.log, 0 B)",
      "",
      "Routine success with marker INTERCOM_OK.",
      `NOISY ${"x".repeat(500)}`,
      `NOISY2 ${"x".repeat(500)}`,
      `NOISY3 ${"x".repeat(500)}`,
    ].join("\n"),
  };

  const result = compactIntercomHandlerMessages([receipt]);
  const compacted = result[0] as { content: string };
  assert.match(compacted.content, /compacted for model context/);
  assert.match(compacted.content, /Handler: icfh_123/);
  assert.match(compacted.content, /Message: msg-1/);
  assert.match(compacted.content, /Output: \/tmp\/pi-intercom\/stdout\.log \(10000 B\)/);
  assert.match(compacted.content, /Errors: none/);
  assert.match(compacted.content, /INTERCOM_OK/);
  assert.doesNotMatch(compacted.content, /NOISY3/);
  assert.ok(compacted.content.length < receipt.content.length);
});

test("does not compact failed intercom handler receipts", () => {
  const failed = {
    role: "custom",
    customType: "intercom_fork_handler",
    content: "intercom fork handler failed: incoming message\nHandler: icfh_123\nExit: 1\nOutput: /tmp/out.log (10 B)\n\nFailure details stay inline.",
  };

  assert.deepEqual(compactIntercomHandlerMessages([failed]), [failed]);
});
