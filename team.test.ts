import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatIntercomTeam, resolveIntercomTeam } from "./team.ts";

const worker = (id: string, runId: string, managerSessionId: string, state = "running") => ({ id, runId, harness: "pi", role: "reviewer", state, owned: true, managerSessionId, intercomTarget: id });

test("intercom team resolves the current manager and live coworkers after adoption", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "intercom-team-"));
  const storeDir = join(agentDir, "intercom", "orchestrator");
  await mkdir(storeDir, { recursive: true });
  try {
    await writeFile(join(storeDir, "workers.json"), JSON.stringify({ version: 1, workers: [worker("self", "run-self", "manager-a"), worker("sibling", "run-sibling", "manager-a"), worker("stopped", "run-stopped", "manager-a", "stopped"), worker("other", "run-other", "manager-b")] }));
    const first = await resolveIntercomTeam({ selfId: "self", agentDir, env: { AGENT_INTERCOM_WORKER_ID: "self", AGENT_INTERCOM_RUN_ID: "run-self", AGENT_INTERCOM_MANAGER_SESSION_ID: "stale-manager" }, sessions: [{ id: "manager-a" }, { id: "sibling" }] });
    assert.deepEqual(first.manager, { target: "manager-a", connected: true });
    assert.deepEqual(first.coworkers.map((entry) => entry.id), ["sibling"]);
    assert.match(formatIntercomTeam(first), /Manager: manager-a \[connected\]/);

    await writeFile(join(storeDir, "workers.json"), JSON.stringify({ version: 1, workers: [worker("self", "run-self", "manager-b"), worker("other", "run-other", "manager-b")] }));
    const adopted = await resolveIntercomTeam({ selfId: "self", agentDir, env: { AGENT_INTERCOM_WORKER_ID: "self", AGENT_INTERCOM_RUN_ID: "run-self", AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-a" }, sessions: [{ id: "manager-b" }, { id: "other" }] });
    assert.deepEqual(adopted.manager, { target: "manager-b", connected: true });
    assert.deepEqual(adopted.coworkers.map((entry) => entry.id), ["other"]);
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
