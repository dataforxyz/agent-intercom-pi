import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getAgentDirPath } from "./broker/paths.ts";
import type { SessionInfo } from "./types.ts";

type BossSession = Pick<SessionInfo, "id">;

export const BOSS_ENV_NAMES = [
  "AGENT_INTERCOM_BOSS_RUN_ID",
  "AGENT_INTERCOM_BOSS_ROLE",
  "AGENT_INTERCOM_BOSS_CONTROLLER_TARGET",
  "AGENT_INTERCOM_BOSS_MANAGER_TARGET",
  "AGENT_INTERCOM_BOSS_TEAM_TARGETS",
  "AGENT_INTERCOM_BOSS_TEAM_TARGET_SOURCE",
  "AGENT_INTERCOM_BOSS_VISIBILITY",
] as const;

export type BossRole = "manager" | "worker" | "scout" | "adversary";
export type BossVisibility = "team-only" | "local";

export const ORCHESTRATOR_READINESS_PROBE = "agent-intercom.orchestrator/readiness-probe";
export const ORCHESTRATOR_READINESS_ACK = "agent-intercom.orchestrator/readiness-ack";

export type BossTeamScope =
  | { present: false; restricted: false }
  | {
      present: true;
      restricted: true;
      valid: false;
      error: string;
    }
  | {
      present: true;
      restricted: boolean;
      valid: true;
      runId: string;
      role: BossRole;
      controllerTarget: string;
      managerTarget: string;
      teamTargets: readonly string[];
      selfTarget: string;
      runSuffix: string;
      visibility: BossVisibility;
    };

const BOSS_RUN_ID_PATTERN = /^boss-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOSS_ROLES = ["manager", "worker", "scout", "adversary"] as const;

function exactNonEmptyString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function invalid(error: string): BossTeamScope {
  return { present: true, restricted: true, valid: false, error };
}

/**
 * Reads trusted-local Boss metadata. Any Boss key makes the contract active;
 * incomplete or malformed contracts deliberately become a deny-all scope.
 */
export function readBossTeamScope(env: NodeJS.ProcessEnv = process.env): BossTeamScope {
  if (!BOSS_ENV_NAMES.some((name) => Object.prototype.hasOwnProperty.call(env, name))) {
    return { present: false, restricted: false };
  }

  const runId = env.AGENT_INTERCOM_BOSS_RUN_ID;
  if (!exactNonEmptyString(runId) || !BOSS_RUN_ID_PATTERN.test(runId)) {
    return invalid("AGENT_INTERCOM_BOSS_RUN_ID must match boss-<lowercase UUID>");
  }
  const runSuffix = runId.slice(-12);

  const role = env.AGENT_INTERCOM_BOSS_ROLE;
  if (role !== "manager" && role !== "worker" && role !== "scout" && role !== "adversary") {
    return invalid("AGENT_INTERCOM_BOSS_ROLE must be manager, worker, scout, or adversary");
  }

  const controllerTarget = env.AGENT_INTERCOM_BOSS_CONTROLLER_TARGET;
  if (!exactNonEmptyString(controllerTarget)) {
    return invalid("AGENT_INTERCOM_BOSS_CONTROLLER_TARGET must be a non-empty exact stable session ID");
  }

  const managerTarget = env.AGENT_INTERCOM_BOSS_MANAGER_TARGET;
  if (!exactNonEmptyString(managerTarget)) {
    return invalid("AGENT_INTERCOM_BOSS_MANAGER_TARGET must be a non-empty exact stable session ID");
  }
  if (managerTarget === controllerTarget) {
    return invalid("Boss Controller and Manager targets must be distinct");
  }

  const expectedTargets = BOSS_ROLES.map((expectedRole) => `boss-${expectedRole}-${runSuffix}`);
  if (managerTarget !== expectedTargets[0]) {
    return invalid(`AGENT_INTERCOM_BOSS_MANAGER_TARGET must equal ${expectedTargets[0]}`);
  }

  let teamTargets: unknown;
  const sourcePath = env.AGENT_INTERCOM_BOSS_TEAM_TARGET_SOURCE;
  if (sourcePath !== undefined) {
    try {
      const expectedSourcePath = join(getAgentDirPath(env), "intercom", "orchestrator", "boss-team-targets", `${runId}.json`);
      if (!exactNonEmptyString(sourcePath) || sourcePath !== expectedSourcePath) throw new Error("path");
      const metadata = lstatSync(sourcePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0 || realpathSync(sourcePath) !== sourcePath) throw new Error("ownership");
      const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).sort().join("\0") !== ["bossRunId", "controllerTarget", "managerTarget", "targets", "updatedAt", "version"].sort().join("\0")
        || parsed.version !== "orc.boss-team-targets.v1" || parsed.bossRunId !== runId || parsed.controllerTarget !== controllerTarget || parsed.managerTarget !== managerTarget
        || !exactNonEmptyString(parsed.updatedAt) || !Number.isFinite(Date.parse(parsed.updatedAt))) throw new Error("content");
      teamTargets = parsed.targets;
    } catch {
      return invalid("AGENT_INTERCOM_BOSS_TEAM_TARGET_SOURCE must be an exact owner-only canonical run target source");
    }
  } else {
    try {
      teamTargets = JSON.parse(env.AGENT_INTERCOM_BOSS_TEAM_TARGETS ?? "");
    } catch {
      return invalid("AGENT_INTERCOM_BOSS_TEAM_TARGETS must be a JSON array of exact stable session IDs");
    }
  }
  if (!Array.isArray(teamTargets) || !teamTargets.every(exactNonEmptyString)) {
    return invalid("Boss team targets must be a JSON array of exact stable session IDs");
  }
  const targetSet = new Set(teamTargets);
  if (targetSet.size !== teamTargets.length || !targetSet.has(managerTarget)) {
    return invalid("Boss team targets must be unique and include the exact Manager target");
  }
  if (sourcePath === undefined && (teamTargets.length !== expectedTargets.length || expectedTargets.some((target) => !targetSet.has(target)))) {
    return invalid("AGENT_INTERCOM_BOSS_TEAM_TARGETS must contain exactly the canonical manager, worker, scout, and adversary session IDs for the run");
  }
  if (targetSet.has(controllerTarget)) {
    return invalid("AGENT_INTERCOM_BOSS_CONTROLLER_TARGET must be distinct from every canonical team target");
  }

  const visibility = env.AGENT_INTERCOM_BOSS_VISIBILITY ?? "team-only";
  if (visibility !== "team-only" && visibility !== "local") {
    return invalid("AGENT_INTERCOM_BOSS_VISIBILITY must be team-only or local");
  }

  return {
    present: true,
    restricted: visibility === "team-only",
    valid: true,
    runId,
    role,
    controllerTarget,
    managerTarget,
    teamTargets: Object.freeze([...(teamTargets as string[])]),
    selfTarget: `boss-${role}-${runSuffix}`,
    runSuffix,
    visibility,
  };
}

export function bossSelfSessionError(scope: BossTeamScope, selfId: string): string | undefined {
  if (!scope.present || !scope.valid) return scope.present && "error" in scope ? scope.error : undefined;
  return selfId === scope.selfTarget
    ? undefined
    : `Boss session identity mismatch: expected ${scope.selfTarget}, received ${selfId}`;
}

/** Exact stable session IDs this Boss role may address in team-only mode. */
export function bossAllowedTargets(scope: BossTeamScope): ReadonlySet<string> | undefined {
  if (!scope.restricted) return undefined;
  if (!scope.valid) return new Set();

  const allowed = new Set(scope.teamTargets);
  if (scope.role === "manager") allowed.add(scope.controllerTarget);
  else allowed.delete(scope.controllerTarget);
  return allowed;
}

function liveAllowedIds<T extends BossSession>(scope: BossTeamScope, sessions: readonly T[]): Set<string> {
  const liveIds = new Set(sessions.map((session) => session.id));
  return new Set([...bossAllowedTargets(scope) ?? []].filter((target) => liveIds.has(target)));
}

export type BossTargetResolution =
  | { allowed: true; targetId: string }
  | {
      allowed: false;
      code: "BOSS_TEAM_METADATA_INVALID" | "BOSS_TEAM_SCOPE_DENIED" | "BOSS_TEAM_TARGET_NOT_CONNECTED";
      error: string;
    };

export class BossTeamScopeError extends Error {
  constructor(
    readonly code: Exclude<BossTargetResolution, { allowed: true }>["code"],
    message: string,
  ) {
    super(message);
    this.name = "BossTeamScopeError";
  }
}

/** Resolves only an exact live stable session ID; names and ID prefixes are denied. */
export function resolveBossLiveTarget<T extends BossSession>(
  scope: BossTeamScope,
  target: string,
  sessions: readonly T[],
  selfId?: string,
): BossTargetResolution {
  if (!scope.present) return { allowed: true, targetId: target };
  if (!scope.valid) {
    return { allowed: false, code: "BOSS_TEAM_METADATA_INVALID", error: `Boss team scope is unavailable: ${"error" in scope ? scope.error : "invalid metadata"}` };
  }
  if (selfId !== undefined) {
    const selfError = bossSelfSessionError(scope, selfId);
    if (selfError) return { allowed: false, code: "BOSS_TEAM_METADATA_INVALID", error: selfError };
  }

  if (scope.restricted && !bossAllowedTargets(scope)!.has(target)) {
    return { allowed: false, code: "BOSS_TEAM_SCOPE_DENIED", error: `Boss team scope denied exact session ID "${target}"; use an exact ID returned by intercom_team` };
  }
  if (!sessions.some((session) => session.id === target)) {
    return { allowed: false, code: "BOSS_TEAM_TARGET_NOT_CONNECTED", error: `Boss target exact session ID "${target}" is not connected` };
  }
  return { allowed: true, targetId: target };
}

export function isBossControllerReadinessControl(
  scope: BossTeamScope,
  direction: "inbound" | "outbound",
  peerId: string,
  selfId: string,
  control: { type: string; version: number } | undefined,
): boolean {
  if (!scope.present || !scope.valid || !scope.restricted) return false;
  if (bossSelfSessionError(scope, selfId)) return false;
  if (scope.role === "manager" || peerId !== scope.controllerTarget || control?.version !== 1) return false;
  return control.type === (direction === "inbound" ? ORCHESTRATOR_READINESS_PROBE : ORCHESTRATOR_READINESS_ACK);
}

/** Authorizes an inbound sender before any inbox or reply state is mutated. */
export function authorizeBossSender(scope: BossTeamScope, senderId: string, selfId: string): BossTargetResolution {
  if (!scope.present) return { allowed: true, targetId: senderId };
  if (!scope.valid) {
    return { allowed: false, code: "BOSS_TEAM_METADATA_INVALID", error: `Boss team scope is unavailable: ${"error" in scope ? scope.error : "invalid metadata"}` };
  }
  const selfError = bossSelfSessionError(scope, selfId);
  if (selfError) return { allowed: false, code: "BOSS_TEAM_METADATA_INVALID", error: selfError };
  if (scope.restricted && !bossAllowedTargets(scope)!.has(senderId)) {
    return { allowed: false, code: "BOSS_TEAM_SCOPE_DENIED", error: `Boss team scope denied inbound exact session ID "${senderId}" for role=${scope.role}` };
  }
  return { allowed: true, targetId: senderId };
}

/** Returns the session with this exact stable ID. */
export function resolveBossLiveSession<T extends BossSession>(sessions: readonly T[], target: string): T | undefined {
  return sessions.find((session) => session.id === target);
}

/** Keeps self plus live exact-ID sessions allowed by the Boss visibility policy. */
export function filterBossSessions<T extends Pick<SessionInfo, "id">>(
  scope: BossTeamScope,
  sessions: readonly T[],
  selfId: string,
): T[] {
  if (!scope.present) return [...sessions];
  if (bossSelfSessionError(scope, selfId)) return sessions.filter((session) => session.id === selfId);
  const allowed = bossAllowedTargets(scope);
  if (!allowed) return [...sessions];
  const allowedIds = liveAllowedIds(scope, sessions);
  return sessions.filter((session) => session.id === selfId || allowedIds.has(session.id));
}
