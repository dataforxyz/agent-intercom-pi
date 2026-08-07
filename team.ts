import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDirPath } from "./broker/paths.ts";
import { bossSelfSessionError, resolveBossLiveSession, type BossTeamScope } from "./boss-team-scope.ts";

export interface TeamSession {
  id: string;
  name?: string;
  origin?: "local" | "remote";
}

interface StoredWorker {
  id?: unknown;
  runId?: unknown;
  harness?: unknown;
  role?: unknown;
  state?: unknown;
  owned?: unknown;
  managerSessionId?: unknown;
  intercomTarget?: unknown;
}

export interface TeamMember {
  id: string;
  target: string;
  harness?: string;
  role?: string;
  state?: string;
  connected: boolean;
}

export interface IntercomTeam {
  teamId?: string;
  self: { id: string; workerId?: string; isManager: boolean };
  manager?: { target: string; connected: boolean };
  controller?: { target: string; connected: boolean };
  coworkers: TeamMember[];
}

/** Authorizes a read-only local inbox lookup using exact orchestrator ownership. */
export function resolveManagedInboxSession(input: {
  team: IntercomTeam;
  sessions: TeamSession[];
  requestedSession: string;
}): TeamSession {
  if (!input.team.self.isManager) {
    throw new Error("Only a manager may inspect another session's pending-ask inbox");
  }
  const member = input.team.coworkers.find((entry) => entry.target === input.requestedSession);
  if (!member) {
    throw new Error(`Pending-ask inbox access denied for "${input.requestedSession}"; select an owned coworker target returned by intercom_team`);
  }
  const liveSession = input.sessions.find((session) => session.id === input.requestedSession);
  if (!liveSession) {
    throw new Error(`Pending-ask inbox access denied for "${input.requestedSession}"; the owned coworker target must equal an exact connected stable session ID`);
  }
  if (liveSession.origin === "remote") {
    throw new Error(`Pending-ask inbox "${input.requestedSession}" is remote and cannot be read from this host`);
  }
  return liveSession;
}

const LIVE_STATES = new Set(["provisioning", "running", "idle", "needs_attention", "stopping"]);

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function connectedTo(sessions: TeamSession[], target: string): boolean {
  const normalized = target.toLowerCase();
  return sessions.some((session) => session.id === target || session.name?.toLowerCase() === normalized);
}

async function readWorkers(agentDir: string): Promise<StoredWorker[]> {
  try {
    const parsed = JSON.parse(await readFile(join(agentDir, "intercom", "orchestrator", "workers.json"), "utf8")) as { workers?: unknown };
    return Array.isArray(parsed.workers) ? parsed.workers as StoredWorker[] : [];
  } catch {
    return [];
  }
}

export async function resolveIntercomTeam(input: {
  selfId: string;
  sessions: TeamSession[];
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<IntercomTeam> {
  const env = input.env ?? process.env;
  const workers = await readWorkers(input.agentDir ?? getAgentDirPath());
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);
  const current = workerId
    ? workers.find((worker) => stringValue(worker.id) === workerId && (!runId || stringValue(worker.runId) === runId))
    : undefined;
  const managerTarget = stringValue(current?.managerSessionId) ?? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET) ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
  const teamId = managerTarget ?? input.selfId;
  const isManager = !managerTarget;
  const coworkers = workers
    .filter((worker) => worker.owned === true)
    .filter((worker) => stringValue(worker.managerSessionId) === teamId)
    .filter((worker) => LIVE_STATES.has(stringValue(worker.state) ?? ""))
    .filter((worker) => stringValue(worker.id) !== workerId)
    .map((worker): TeamMember | undefined => {
      const id = stringValue(worker.id);
      if (!id) return undefined;
      const target = stringValue(worker.intercomTarget) ?? id;
      return {
        id,
        target,
        ...(stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}),
        ...(stringValue(worker.role) ? { role: stringValue(worker.role) } : {}),
        ...(stringValue(worker.state) ? { state: stringValue(worker.state) } : {}),
        connected: connectedTo(input.sessions, target),
      };
    })
    .filter((member): member is TeamMember => Boolean(member));

  return {
    teamId,
    self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager },
    manager: managerTarget
      ? { target: managerTarget, connected: connectedTo(input.sessions, managerTarget) }
      : { target: input.selfId, connected: true },
    coworkers,
  };
}

export function resolveBossIntercomTeam(input: {
  selfId: string;
  sessions: TeamSession[];
  scope: BossTeamScope;
}): IntercomTeam {
  const { scope } = input;
  if (!scope.present || !scope.valid || !scope.restricted) {
    throw new Error("error" in scope ? scope.error : "Boss team-only metadata is not active");
  }
  const selfError = bossSelfSessionError(scope, input.selfId);
  if (selfError) throw new Error(selfError);

  const isManager = scope.role === "manager";
  const managerSession = resolveBossLiveSession(input.sessions, scope.managerTarget);
  const controllerSession = resolveBossLiveSession(input.sessions, scope.controllerTarget);
  const manager = isManager
    ? { target: input.selfId, connected: true }
    : managerSession
      ? { target: scope.managerTarget, connected: true }
      : undefined;
  const controller = isManager && controllerSession
    ? { target: scope.controllerTarget, connected: true }
    : undefined;
  const excludedIds = new Set([input.selfId, managerSession?.id, controllerSession?.id].filter((id): id is string => Boolean(id)));
  const coworkerIds = new Set<string>();
  const coworkers: TeamMember[] = [];
  for (const target of scope.teamTargets) {
    const session = resolveBossLiveSession(input.sessions, target);
    if (!session || excludedIds.has(session.id) || coworkerIds.has(session.id)) continue;
    coworkerIds.add(session.id);
    coworkers.push({ id: session.id, target, connected: true });
  }

  return {
    ...(manager ? { teamId: manager.target } : {}),
    self: { id: input.selfId, isManager },
    ...(manager ? { manager } : {}),
    ...(controller ? { controller } : {}),
    coworkers,
  };
}

export function formatIntercomTeam(team: IntercomTeam): string {
  const manager = team.manager
    ? `${team.manager.target} [${team.manager.connected ? "connected" : "not connected"}]`
    : "unknown";
  const lines = [
    `Manager: ${manager}`,
    `You: ${team.self.id}${team.self.isManager ? " [manager]" : ""}`,
  ];
  if (team.controller) {
    lines.push(`Controller: ${team.controller.target} [connected]`);
  }
  if (team.coworkers.length === 0) {
    lines.push("Coworkers: none");
  } else {
    lines.push("Coworkers:");
    for (const coworker of team.coworkers) {
      const metadata = [coworker.harness, coworker.role, coworker.state].filter(Boolean).join(", ");
      lines.push(`- ${coworker.id} target=${coworker.target}${metadata ? ` (${metadata})` : ""} [${coworker.connected ? "connected" : "not connected"}]`);
    }
  }
  return lines.join("\n");
}
