import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath } from "../config.ts";
import { resolveIntercomTeam } from "../team.ts";

test("config and team discovery use INTERCOM_DIR independently of the Pi config root", async () => {
  const root = await mkdtemp(join(tmpdir(), "intercom-directory-"));
  const previous = process.env.INTERCOM_DIR;
  try {
    process.env.INTERCOM_DIR = root;
    assert.equal(getConfigPath(), join(root, "config.json"));
    await mkdir(join(root, "orchestrator"));
    await writeFile(join(root, "orchestrator", "workers.json"), JSON.stringify({ workers: [
      { id: "peer", managerSessionId: "manager", owned: true, state: "ready" },
      { id: "unrelated", managerSessionId: "elsewhere", owned: true, state: "ready" },
    ] }));
    const team = await resolveIntercomTeam({ selfId: "manager", sessions: [{ id: "peer" }], agentDir: join(root, "pi-config"), env: { INTERCOM_DIR: root } });
    assert.deepEqual(team.coworkers.map((member) => member.id), ["peer"]);
  } finally {
    if (previous === undefined) delete process.env.INTERCOM_DIR;
    else process.env.INTERCOM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
