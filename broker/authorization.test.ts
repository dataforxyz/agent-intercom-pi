import assert from "node:assert/strict";
import test from "node:test";
import { authorizeSessionAction, visibleSessions } from "./authorization.ts";
import type { SessionInfo } from "../types.ts";

function local(id: string): SessionInfo {
  return { id, name: id, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, origin: "local" };
}

function remote(id: string, parentSessionId: string, rootSessionId = "root"): SessionInfo {
  return {
    id,
    name: id,
    cwd: "/tmp",
    model: "test",
    pid: 2,
    startedAt: 1,
    lastActivity: 1,
    origin: "remote",
    remoteHostId: "ika",
    parentSessionId,
    rootSessionId,
    generation: 1,
  };
}

const sessions = [
  local("root"),
  local("unrelated"),
  remote("manager", "root"),
  remote("child-a", "manager"),
  remote("child-b", "manager"),
];

test("phase zero discovery and communication use the same direct-parent policy", () => {
  assert.equal(authorizeSessionAction(sessions, "root", "send", "manager").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "manager", "ask", "root").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "manager", "send", "child-a").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "child-a", "reply", "manager").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "child-a", "send", "root").allowed, false);
  assert.equal(authorizeSessionAction(sessions, "child-a", "discover", "child-b").allowed, false);
  assert.equal(authorizeSessionAction(sessions, "unrelated", "discover", "manager").allowed, false);
});

test("visibility hides unauthorized sessions rather than revealing denial details", () => {
  assert.deepEqual(visibleSessions(sessions, "child-a").map((session) => session.id).sort(), ["child-a", "manager"]);
  assert.deepEqual(visibleSessions(sessions, "root").map((session) => session.id).sort(), ["manager", "root", "unrelated"]);
  assert.deepEqual(visibleSessions(sessions, "unrelated").map((session) => session.id).sort(), ["root", "unrelated"]);
});
