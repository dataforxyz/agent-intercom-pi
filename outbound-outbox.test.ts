import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentOutboundOutbox } from "./outbound-outbox.ts";
import type { Message } from "./types.ts";

function message(id: string, text: string): Message {
  return { id, timestamp: 1, content: { text } };
}

test("durable outbox survives reload and rejects conflicting message ID reuse", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "pi-intercom-outbox-"));
  try {
    const outbox = new PersistentOutboundOutbox("sender-id", runtimeDir);
    assert.equal(outbox.enqueue("receiver-id", message("message-1", "original")), "added");
    assert.equal(outbox.enqueue("receiver-id", message("message-1", "original")), "existing");

    const reloaded = new PersistentOutboundOutbox("sender-id", runtimeDir);
    assert.deepEqual(reloaded.list().map((entry) => entry.message.id), ["message-1"]);
    assert.throws(
      () => reloaded.enqueue("receiver-id", message("message-1", "conflict")),
      /different payload/,
    );
    reloaded.remove("message-1");
    assert.deepEqual(new PersistentOutboundOutbox("sender-id", runtimeDir).list(), []);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
