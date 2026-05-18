import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getConfigPath, loadConfig } from "./config.ts";

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function restoreEnv(): void {
  if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
}

test("getConfigPath honors PI_CODING_AGENT_DIR", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-intercom-agent-dir-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.equal(getConfigPath(), join(resolve(agentDir), "intercom", "config.json"));
  } finally {
    restoreEnv();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("loadConfig reads intercom config from PI_CODING_AGENT_DIR", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-intercom-agent-dir-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const configPath = join(agentDir, "intercom", "config.json");
  mkdirSync(join(agentDir, "intercom"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ enabled: false, inboundForkHandlers: { notify: "none" } }));
  try {
    const config = loadConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.inboundForkHandlers.notify, "none");
  } finally {
    restoreEnv();
    rmSync(agentDir, { recursive: true, force: true });
  }
});
