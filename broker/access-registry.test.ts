import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import { RemoteAccessError, RemoteAccessRegistry } from "./access-registry.ts";

function fixture(now = 1_800_000_000_000) {
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-access-"));
  let clock = now;
  const registry = new RemoteAccessRegistry(join(root, "broker-access.json"), () => clock);
  return {
    root,
    registry,
    advance(ms: number) { clock += ms; },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

const template = {
  name: "ika/manager",
  parentSessionId: "local-root",
  rootSessionId: "local-root",
  remoteHostId: "ika-dev-v3",
};

test("admin credential persists privately and authenticates by hash", () => {
  const f = fixture();
  try {
    const path = join(f.root, "broker-admin.json");
    const token = f.registry.ensureAdminCredential(path);
    assert.equal(f.registry.authenticateAdmin(token), true);
    assert.equal(f.registry.authenticateAdmin(`${token}x`), false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const state = readFileSync(join(f.root, "broker-access.json"), "utf8");
    assert.equal(state.includes(token), false);
    assert.equal(f.registry.ensureAdminCredential(path), token);
  } finally {
    f.close();
  }
});

test("one-use enrollment assigns broker identity and stores only hashes", () => {
  const f = fixture();
  try {
    const issued = f.registry.issueEnrollment(template);
    const consumed = f.registry.consumeEnrollment(issued.enrollmentToken);
    assert.match(consumed.principal.id, /^[0-9a-f-]{36}$/);
    assert.equal(consumed.principal.name, template.name);
    assert.equal(consumed.principal.parentSessionId, template.parentSessionId);
    assert.equal(consumed.principal.generation, 1);
    assert.equal(
      f.registry.authenticateSession(consumed.principal.id, 1, consumed.sessionCredential).id,
      consumed.principal.id,
    );
    const persisted = readFileSync(join(f.root, "broker-access.json"), "utf8");
    assert.equal(persisted.includes(issued.enrollmentToken), false);
    assert.equal(persisted.includes(consumed.sessionCredential), false);
    assert.throws(
      () => f.registry.consumeEnrollment(issued.enrollmentToken),
      (error: unknown) => error instanceof RemoteAccessError && error.code === "INVALID_ENROLLMENT",
    );
  } finally {
    f.close();
  }
});

test("expired enrollment is consumed fail-closed", () => {
  const f = fixture();
  try {
    const issued = f.registry.issueEnrollment(template, 1000);
    f.advance(1001);
    assert.throws(
      () => f.registry.consumeEnrollment(issued.enrollmentToken),
      (error: unknown) => error instanceof RemoteAccessError && error.code === "INVALID_ENROLLMENT",
    );
    assert.equal(Object.keys(f.registry.snapshot().enrollments).length, 0);
  } finally {
    f.close();
  }
});

test("reconnect requires the exact assigned identity, credential, and generation", () => {
  const f = fixture();
  try {
    const issued = f.registry.issueEnrollment(template);
    const consumed = f.registry.consumeEnrollment(issued.enrollmentToken);
    assert.throws(
      () => f.registry.authenticateSession("chosen-id", 1, consumed.sessionCredential),
      (error: unknown) => error instanceof RemoteAccessError && error.code === "INVALID_CREDENTIAL",
    );
    assert.throws(
      () => f.registry.authenticateSession(consumed.principal.id, 1, "wrong"),
      (error: unknown) => error instanceof RemoteAccessError && error.code === "INVALID_CREDENTIAL",
    );
    assert.throws(
      () => f.registry.authenticateSession(consumed.principal.id, 2, consumed.sessionCredential),
      (error: unknown) => error instanceof RemoteAccessError && error.code === "STALE_GENERATION",
    );
  } finally {
    f.close();
  }
});

test("recursive revoke increments generations and invalidates reconnect", () => {
  const f = fixture();
  try {
    const parent = f.registry.consumeEnrollment(f.registry.issueEnrollment(template).enrollmentToken);
    const child = f.registry.consumeEnrollment(f.registry.issueEnrollment({
      ...template,
      name: "ika/child",
      parentSessionId: parent.principal.id,
    }).enrollmentToken);
    const changed = f.registry.revoke(parent.principal.id);
    assert.deepEqual(new Set(changed.map((principal) => principal.id)), new Set([parent.principal.id, child.principal.id]));
    assert.equal(changed.every((principal) => principal.state === "revoked" && principal.generation === 2), true);
    assert.throws(
      () => f.registry.authenticateSession(child.principal.id, 1, child.sessionCredential),
      (error: unknown) => error instanceof RemoteAccessError && error.code === "REVOKED_CREDENTIAL",
    );
  } finally {
    f.close();
  }
});
