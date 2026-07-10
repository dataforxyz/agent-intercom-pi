import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBrokerOwnership, hasBrokerOwnership, releaseBrokerOwnership } from "./ownership.ts";

test("broker ownership rejects a second live owner and releases only its own file", () => {
  const root = mkdtempSync(join(tmpdir(), "intercom-owner-"));
  const path = join(root, "broker.owner");
  try {
    acquireBrokerOwnership(path);
    assert.equal(hasBrokerOwnership(path), true);
    assert.throws(() => acquireBrokerOwnership(path), /already owned by live process/);
    releaseBrokerOwnership(path, process.pid + 1);
    assert.equal(hasBrokerOwnership(path), true);
    releaseBrokerOwnership(path);
    assert.equal(hasBrokerOwnership(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("broker ownership replaces a stale owner file", () => {
  const root = mkdtempSync(join(tmpdir(), "intercom-owner-stale-"));
  const path = join(root, "broker.owner");
  try {
    writeFileSync(path, "2147483647");
    acquireBrokerOwnership(path);
    assert.equal(readFileSync(path, "utf8"), String(process.pid));
    releaseBrokerOwnership(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

