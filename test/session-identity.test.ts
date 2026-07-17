import test from "node:test";
import assert from "node:assert/strict";

import { formatSessionDisplayName, sanitizeDisplayText, sessionOriginLabel, shortestUniqueIdPrefixes } from "../ui/session-identity.ts";

test("shortest unique ID prefixes expand only as far as needed", () => {
  const prefixes = shortestUniqueIdPrefixes([
    "019f48bc-alpha",
    "019f48bc-beta",
    "abcd1234-independent",
  ]);

  assert.equal(prefixes.get("019f48bc-alpha"), "019f48bc-a");
  assert.equal(prefixes.get("019f48bc-beta"), "019f48bc-b");
  assert.equal(prefixes.get("abcd1234-independent"), "abcd");
});

test("remote provenance is visible and sanitized in session labels", () => {
  const remote = {
    id: "remote-id",
    name: "worker",
    cwd: "/tmp",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    origin: "remote" as const,
    remoteHostId: "ika\u001b[31m-dev",
  };
  assert.equal(sessionOriginLabel(remote), "remote:ika-dev");
  assert.equal(formatSessionDisplayName(remote), "worker [remote:ika-dev]");
});

test("display metadata cannot inject terminal control sequences", () => {
  assert.equal(sanitizeDisplayText("agent\x1b[31m red\x1b[0m\nnext"), "agent red next");
  assert.equal(sanitizeDisplayText("\x1b]0;owned\x07safe"), "safe");
  assert.equal(sanitizeDisplayText("\t\n", "Unnamed"), "Unnamed");
});
