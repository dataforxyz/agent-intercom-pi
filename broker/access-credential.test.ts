import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import { ACCESS_CREDENTIAL_ENV, loadRemoteAccessCredential, writeRemoteSessionCredential } from "./access-credential.ts";

function withTempFile(content: unknown, run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-credential-"));
  const path = join(root, "credential.json");
  writeFileSync(path, JSON.stringify(content), { mode: 0o600 });
  try {
    run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("loads a private one-use enrollment credential from the configured path", () => {
  withTempFile({ enrollmentToken: "one-use-secret" }, (path) => {
    assert.deepEqual(loadRemoteAccessCredential({ [ACCESS_CREDENTIAL_ENV]: path }), {
      path,
      access: { enrollmentToken: "one-use-secret" },
      enrollment: true,
    });
  });
});

test("atomically replaces enrollment material with assigned reconnect state", () => {
  withTempFile({ enrollmentToken: "one-use-secret" }, (path) => {
    writeRemoteSessionCredential(path, "assigned-session", {
      origin: "remote",
      remoteHostId: "ika-dev-v3",
      parentSessionId: "local-root",
      rootSessionId: "local-root",
      generation: 1,
      sessionCredential: "reconnect-secret",
    });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      version: 1,
      sessionCredential: "reconnect-secret",
      sessionId: "assigned-session",
      generation: 1,
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(loadRemoteAccessCredential({ [ACCESS_CREDENTIAL_ENV]: path })?.access, {
      sessionCredential: "reconnect-secret",
      sessionId: "assigned-session",
      generation: 1,
    });
  });
});

test("credential parsing fails closed", () => {
  withTempFile({ sessionCredential: "secret", sessionId: "id", generation: 1 }, (path) => {
    assert.throws(() => loadRemoteAccessCredential({ [ACCESS_CREDENTIAL_ENV]: path }), /Invalid Agent Intercom access credential/);
  });
});
