import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorizeBossSender,
  bossAllowedTargets,
  bossSelfSessionError,
  filterBossSessions,
  isBossControllerReadinessControl,
  ORCHESTRATOR_READINESS_ACK,
  ORCHESTRATOR_READINESS_PROBE,
  readBossTeamScope,
  resolveBossLiveTarget,
} from "./boss-team-scope.ts";
import { formatIntercomTeam, resolveBossIntercomTeam } from "./team.ts";

const runId = "boss-00000000-0000-4000-8000-123456789abc";
const targets = {
  manager: "boss-manager-123456789abc",
  worker: "boss-worker-123456789abc",
  scout: "boss-scout-123456789abc",
  adversary: "boss-adversary-123456789abc",
} as const;
const roster = [targets.manager, targets.worker, targets.scout, targets.adversary];

function metadata(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AGENT_INTERCOM_BOSS_RUN_ID: runId,
    AGENT_INTERCOM_BOSS_ROLE: "worker",
    AGENT_INTERCOM_BOSS_CONTROLLER_TARGET: "controller-stable-session-id",
    AGENT_INTERCOM_BOSS_MANAGER_TARGET: targets.manager,
    AGENT_INTERCOM_BOSS_TEAM_TARGETS: JSON.stringify(roster),
    ...overrides,
  };
}

test("Boss target source is owner-checked, dynamic, and deny-all on mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-target-source-"));
  const directory = join(root, "intercom", "orchestrator", "boss-team-targets");
  const sourcePath = join(directory, `${runId}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const source = {
    version: "orc.boss-team-targets.v1",
    bossRunId: runId,
    controllerTarget: "controller-stable-session-id",
    managerTarget: targets.manager,
    targets: [targets.manager, "dynamic-scout-exact-target"],
    updatedAt: "2026-08-19T12:00:00.000Z",
  };
  await writeFile(sourcePath, JSON.stringify(source), { mode: 0o600 });
  const scoped = readBossTeamScope(metadata({ PI_CODING_AGENT_DIR: root, AGENT_INTERCOM_BOSS_TEAM_TARGET_SOURCE: sourcePath }));
  assert.equal(scoped.valid, true);
  if (scoped.valid) assert.deepEqual(scoped.teamTargets, source.targets);

  await chmod(sourcePath, 0o622);
  const writable = readBossTeamScope(metadata({ PI_CODING_AGENT_DIR: root, AGENT_INTERCOM_BOSS_TEAM_TARGET_SOURCE: sourcePath }));
  assert.equal(writable.valid, false);
  assert.deepEqual([...bossAllowedTargets(writable) ?? []], []);

  await chmod(sourcePath, 0o600);
  await writeFile(sourcePath, JSON.stringify({ ...source, bossRunId: "boss-00000000-0000-4000-8000-000000000000" }));
  const mismatched = readBossTeamScope(metadata({ PI_CODING_AGENT_DIR: root, AGENT_INTERCOM_BOSS_TEAM_TARGET_SOURCE: sourcePath }));
  assert.equal(mismatched.valid, false);
  assert.deepEqual([...bossAllowedTargets(mismatched) ?? []], []);
});

test("Boss metadata derives the exact canonical roster and role identity", () => {
  for (const role of ["manager", "worker", "scout", "adversary"] as const) {
    const scope = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: role }));
    assert.equal(scope.valid, true);
    if (!scope.valid) continue;
    assert.equal(scope.restricted, true);
    assert.equal(scope.managerTarget, targets.manager);
    assert.deepEqual(scope.teamTargets, roster);
    assert.equal(scope.selfTarget, targets[role]);
    assert.equal(bossSelfSessionError(scope, targets[role]), undefined);
    assert.match(bossSelfSessionError(scope, `wrong-${role}`) ?? "", /identity mismatch/);
  }
});

test("Boss role policy grants Controller access only to Manager", () => {
  for (const role of ["worker", "scout", "adversary"] as const) {
    const participant = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: role }));
    assert.deepEqual([...bossAllowedTargets(participant)!].sort(), [...roster].sort());
    assert.equal(bossAllowedTargets(participant)!.has("controller-stable-session-id"), false);
  }
  const manager = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: "manager" }));
  assert.equal(bossAllowedTargets(manager)!.has("controller-stable-session-id"), true);
});

test("Boss lower roles permit only the exact hidden Controller readiness handshake", () => {
  for (const role of ["worker", "scout", "adversary"] as const) {
    const scope = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: role }));
    assert.equal(isBossControllerReadinessControl(scope, "inbound", "controller-stable-session-id", targets[role], { type: ORCHESTRATOR_READINESS_PROBE, version: 1 }), true);
    assert.equal(isBossControllerReadinessControl(scope, "outbound", "controller-stable-session-id", targets[role], { type: ORCHESTRATOR_READINESS_ACK, version: 1 }), true);
    assert.equal(isBossControllerReadinessControl(scope, "inbound", "controller-stable-session-id", targets[role], { type: "reload-runtime.request", version: 1 }), false);
    assert.equal(isBossControllerReadinessControl(scope, "outbound", "controller-stable-session-id", targets[role], { type: ORCHESTRATOR_READINESS_PROBE, version: 1 }), false);
    assert.equal(isBossControllerReadinessControl(scope, "inbound", "wrong-controller", targets[role], { type: ORCHESTRATOR_READINESS_PROBE, version: 1 }), false);
    assert.equal(isBossControllerReadinessControl(scope, "inbound", "controller-stable-session-id", "wrong-self", { type: ORCHESTRATOR_READINESS_PROBE, version: 1 }), false);
  }
  const manager = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: "manager" }));
  assert.equal(isBossControllerReadinessControl(manager, "inbound", "controller-stable-session-id", targets.manager, { type: ORCHESTRATOR_READINESS_PROBE, version: 1 }), false);
});

test("Boss target resolution accepts exact stable IDs and rejects names and prefixes", () => {
  const sessions = [
    { id: targets.manager, name: "Manager Alias" },
    { id: targets.worker, name: "Worker Alias" },
    { id: "controller-stable-session-id", name: "Controller Alias" },
  ];
  const manager = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: "manager" }));
  assert.deepEqual(resolveBossLiveTarget(manager, "controller-stable-session-id", sessions, targets.manager), {
    allowed: true,
    targetId: "controller-stable-session-id",
  });
  for (const alias of ["Controller Alias", "controller-stable", "Manager Alias"]) {
    const denied = resolveBossLiveTarget(manager, alias, sessions, targets.manager);
    assert.equal(denied.allowed, false);
  }

  const local = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_VISIBILITY: "local" }));
  assert.deepEqual(resolveBossLiveTarget(local, targets.manager, sessions, targets.worker), {
    allowed: true,
    targetId: targets.manager,
  });
  const localName = resolveBossLiveTarget(local, "Manager Alias", sessions, targets.worker);
  assert.equal(localName.allowed, false, "local visibility broadens scope but never enables name routing");
});

test("Boss inbound authorization is symmetric and identity-bound", () => {
  const manager = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: "manager" }));
  assert.equal(authorizeBossSender(manager, "controller-stable-session-id", targets.manager).allowed, true);
  assert.equal(authorizeBossSender(manager, "unrelated-id", targets.manager).allowed, false);

  for (const role of ["worker", "scout", "adversary"] as const) {
    const scope = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: role }));
    assert.equal(authorizeBossSender(scope, targets.manager, targets[role]).allowed, true);
    const controller = authorizeBossSender(scope, "controller-stable-session-id", targets[role]);
    assert.equal(controller.allowed, false);
    if (!controller.allowed) assert.equal(controller.code, "BOSS_TEAM_SCOPE_DENIED");
    assert.equal(authorizeBossSender(scope, "unrelated-id", targets[role]).allowed, false);
    const mismatchedSelf = authorizeBossSender(scope, targets.manager, "wrong-self");
    assert.equal(mismatchedSelf.allowed, false);
    if (!mismatchedSelf.allowed) assert.equal(mismatchedSelf.code, "BOSS_TEAM_METADATA_INVALID");
  }
});

test("Boss metadata is inactive when absent and local visibility preserves broad exact-ID discovery", () => {
  assert.deepEqual(readBossTeamScope({}), { present: false, restricted: false });
  const local = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_VISIBILITY: "local" }));
  assert.equal(local.valid, true);
  assert.equal(local.restricted, false);
  assert.equal(bossAllowedTargets(local), undefined);
  assert.deepEqual(filterBossSessions(local, [{ id: targets.worker }, { id: "outside-id" }], targets.worker), [{ id: targets.worker }, { id: "outside-id" }]);
  assert.deepEqual(filterBossSessions(local, [{ id: "wrong-self" }, { id: "outside-id" }], "wrong-self"), [{ id: "wrong-self" }]);
});

test("malformed, noncanonical, or incomplete Boss metadata fails closed", () => {
  const malformed = [
    metadata({ AGENT_INTERCOM_BOSS_RUN_ID: "run-1" }),
    metadata({ AGENT_INTERCOM_BOSS_ROLE: "reviewer" }),
    metadata({ AGENT_INTERCOM_BOSS_CONTROLLER_TARGET: " controller-id" }),
    metadata({ AGENT_INTERCOM_BOSS_MANAGER_TARGET: "" }),
    metadata({ AGENT_INTERCOM_BOSS_MANAGER_TARGET: "boss-manager-wrong" }),
    metadata({ AGENT_INTERCOM_BOSS_TEAM_TARGETS: "not json" }),
    metadata({ AGENT_INTERCOM_BOSS_TEAM_TARGETS: JSON.stringify([targets.manager, targets.worker, targets.scout]) }),
    metadata({ AGENT_INTERCOM_BOSS_TEAM_TARGETS: JSON.stringify([targets.manager, targets.worker, targets.scout, "boss-adversary-wrong"]) }),
    metadata({ AGENT_INTERCOM_BOSS_VISIBILITY: "global" }),
    { AGENT_INTERCOM_BOSS_ROLE: "worker" },
  ];

  for (const env of malformed) {
    const scope = readBossTeamScope(env);
    assert.equal(scope.present, true);
    assert.equal(scope.restricted, true);
    assert.equal(scope.valid, false);
    assert.deepEqual([...bossAllowedTargets(scope)!], []);
    const resolution = resolveBossLiveTarget(scope, targets.manager, [{ id: targets.manager }], targets.worker);
    assert.equal(resolution.allowed, false);
    if (!resolution.allowed) assert.equal(resolution.code, "BOSS_TEAM_METADATA_INVALID");
    assert.deepEqual(filterBossSessions(scope, [{ id: targets.worker }, { id: targets.manager }], targets.worker), [{ id: targets.worker }]);
  }
});

test("Boss team discovery exposes only currently live canonical exact IDs, including a late adversary", () => {
  const scope = readBossTeamScope(metadata());
  const firstSessions = [
    { id: targets.worker, name: "worker" },
    { id: targets.manager, name: "manager" },
    { id: targets.scout, name: "scout" },
    { id: "outsider-id", name: targets.adversary },
  ];
  assert.deepEqual(filterBossSessions(scope, firstSessions, targets.worker).map((entry) => entry.id), [targets.worker, targets.manager, targets.scout]);

  const first = resolveBossIntercomTeam({ selfId: targets.worker, sessions: firstSessions, scope });
  assert.deepEqual(first.manager, { target: targets.manager, connected: true });
  assert.deepEqual(first.coworkers.map((entry) => entry.target), [targets.scout]);
  assert.doesNotMatch(formatIntercomTeam(first), /outsider|controller|adversary/);

  const later = resolveBossIntercomTeam({
    selfId: targets.worker,
    sessions: [...firstSessions, { id: targets.adversary, name: "late adversary" }],
    scope,
  });
  assert.deepEqual(later.coworkers.map((entry) => entry.target), [targets.scout, targets.adversary]);
});

test("Boss Manager discovery includes the exact live Controller but never an alias or unrelated session", () => {
  const scope = readBossTeamScope(metadata({ AGENT_INTERCOM_BOSS_ROLE: "manager" }));
  const team = resolveBossIntercomTeam({
    selfId: targets.manager,
    sessions: [
      { id: targets.manager },
      { id: targets.worker },
      { id: "controller-stable-session-id", name: "Controller Alias" },
      { id: "alias-session-id", name: targets.scout },
      { id: "outsider-id" },
    ],
    scope,
  });
  assert.deepEqual(team.controller, { target: "controller-stable-session-id", connected: true });
  assert.deepEqual(team.coworkers.map((entry) => entry.target), [targets.worker]);
  assert.doesNotMatch(formatIntercomTeam(team), /alias-session-id|outsider/);
});
