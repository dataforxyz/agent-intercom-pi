import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDirPath } from "./broker/paths.ts";

export interface TeamSession {
  id: string;
  name?: string;
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
  coworkers: TeamMember[];
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

export function formatIntercomTeam(team: IntercomTeam): string {
  const manager = team.manager
    ? `${team.manager.target} [${team.manager.connected ? "connected" : "not connected"}]`
    : "unknown";
  const lines = [
    `Manager: ${manager}`,
    `You: ${team.self.id}${team.self.isManager ? " [manager]" : ""}`,
  ];
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
