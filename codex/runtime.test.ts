import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexRuntimeIdentity,
  detectGitRoot,
  formatSessionList,
  resolveSessionTarget,
} from "./runtime.ts";
import type { SessionInfo } from "../types.ts";

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "session-a",
    name: "alpha",
    cwd: "/repo",
    model: "codex",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    status: "idle",
    ...overrides,
  };
}

test("buildCodexRuntimeIdentity uses explicit environment overrides", () => {
  const identity = buildCodexRuntimeIdentity({
    CODEX_INTERCOM_SESSION_ID: "codex-fixed",
    CODEX_INTERCOM_NAME: "planner",
    CODEX_INTERCOM_MODEL: "gpt-test",
    PWD: "/tmp/repo",
  }, "/ignored", 123);

  assert.equal(identity.sessionId, "codex-fixed");
  assert.equal(identity.name, "planner");
  assert.equal(identity.cwd, "/ignored");
  assert.equal(identity.model, "gpt-test");
});

test("buildCodexRuntimeIdentity creates stable-ish fallback identity from cwd and pid", () => {
  const identity = buildCodexRuntimeIdentity({ PWD: "/tmp/project" }, "/tmp/project", 42);

  assert.match(identity.sessionId, /^codex-42-[0-9a-f]{8}$/);
  assert.equal(identity.name, "codex-project-42");
});

test("resolveSessionTarget resolves exact id, name, and unique id prefix", () => {
  const sessions = [
    session({ id: "abc12345", name: "planner" }),
    session({ id: "def67890", name: "worker" }),
  ];

  assert.equal(resolveSessionTarget(sessions, "abc12345"), "abc12345");
  assert.equal(resolveSessionTarget(sessions, "worker"), "def67890");
  assert.equal(resolveSessionTarget(sessions, "def6"), "def67890");
});

test("resolveSessionTarget rejects duplicate names and ambiguous prefixes", () => {
  const sessions = [
    session({ id: "abc12345", name: "worker" }),
    session({ id: "abc19999", name: "worker" }),
  ];

  assert.throws(() => resolveSessionTarget(sessions, "worker"), /Multiple sessions named/);
  assert.throws(() => resolveSessionTarget(sessions, "abc1"), /Multiple sessions match/);
});

test("formatSessionList marks self and same cwd", () => {
  const output = formatSessionList([
    session({ id: "abc12345", name: "planner", cwd: "/repo", status: "idle" }),
  ], "abc12345", "/repo");

  assert.match(output, /planner \(abc12345\)/);
  assert.match(output, /\[self, same cwd, idle\]/);
});

test("detectGitRoot finds the current repository root", () => {
  assert.equal(detectGitRoot(process.cwd()), process.cwd());
});
