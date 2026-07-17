import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import { BrokerAuditLog } from "./audit.ts";

test("broker audit is append-only, private, structured, and contains no credential fields", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-audit-"));
  const path = join(root, "broker-audit.jsonl");
  try {
    const audit = new BrokerAuditLog(path, () => 1234);
    audit.record({
      event: "remote_connect",
      outcome: "allowed",
      actorId: "remote-1",
      remoteHostId: "ika",
      generation: 2,
    });
    audit.record({
      event: "remote_delivery_denied",
      outcome: "denied",
      actorId: "remote-1",
      targetId: "hidden",
      reason: "POLICY_DENIED",
    });
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      version: 1,
      timestamp: 1234,
      event: "remote_connect",
      outcome: "allowed",
      actorId: "remote-1",
      remoteHostId: "ika",
      generation: 2,
    });
    assert.equal(lines[1].reason, "POLICY_DENIED");
    assert.equal(readFileSync(path, "utf8").includes("credential"), false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
