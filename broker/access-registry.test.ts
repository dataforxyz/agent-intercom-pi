import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
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

test("version-one registry records migrate to non-delegating tree principals", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-access-migrate-"));
  const path = join(root, "broker-access.json");
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      principals: {
        legacy: {
          id: "legacy",
          name: "legacy",
          credentialHash: "0".repeat(64),
          parentSessionId: "root",
          rootSessionId: "root",
          remoteHostId: "host",
          generation: 1,
          policy: "remote-parent",
          state: "active",
          expiresAt: 2_000_000_000_000,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      enrollments: {},
    }));
    const principal = new RemoteAccessRegistry(path, () => 1_800_000_000_000).snapshot().principals.legacy;
    assert.equal(principal.policy, "remote-tree");
    assert.equal(principal.canDelegate, false);
    assert.equal(principal.depth, 1);
    assert.equal(principal.maxDepth, 1);
    assert.equal(principal.maxChildren, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("delegated child enrollment is broker-computed and cannot widen parent limits", () => {
  const f = fixture();
  try {
    const parent = f.registry.consumeEnrollment(f.registry.issueEnrollment({
      ...template,
      canDelegate: true,
      depth: 1,
      maxDepth: 3,
      maxChildren: 1,
    }).enrollmentToken);
    const childEnrollment = f.registry.issueChildEnrollment(parent.principal.id, 1, {
      name: "ika/lead",
      canDelegate: true,
      maxDepth: 3,
      maxChildren: 1,
    });
    assert.throws(
      () => f.registry.issueChildEnrollment(parent.principal.id, 1, { name: "ika/sibling" }),
      (error: unknown) => error instanceof RemoteAccessError && error.code === "INVALID_ENROLLMENT",
    );
    const child = f.registry.consumeEnrollment(childEnrollment.enrollmentToken);
    assert.equal(child.principal.parentSessionId, parent.principal.id);
    assert.equal(child.principal.rootSessionId, template.rootSessionId);
    assert.equal(child.principal.remoteHostId, template.remoteHostId);
    assert.equal(child.principal.depth, 2);
    assert.equal(child.principal.maxDepth, 3);
    assert.equal(child.principal.maxChildren, 1);
    assert.equal(child.principal.canDelegate, true);
    assert.throws(
      () => f.registry.issueChildEnrollment(child.principal.id, 1, { name: "too-wide", maxDepth: 4 }),
      /Invalid child maximum depth/,
    );
    const grandchild = f.registry.consumeEnrollment(f.registry.issueChildEnrollment(child.principal.id, 1, {
      name: "ika/worker",
    }).enrollmentToken);
    assert.equal(grandchild.principal.depth, 3);
    assert.equal(grandchild.principal.canDelegate, false);
    assert.equal(grandchild.principal.maxDepth, 3);
    const metadata = f.registry.inspectSubtree(parent.principal.id);
    assert.deepEqual(metadata.map((principal) => principal.id), [parent.principal.id, child.principal.id, grandchild.principal.id]);
    assert.equal(metadata.some((principal) => "credentialHash" in principal), false);
  } finally {
    f.close();
  }
});

test("non-delegating principals cannot issue child enrollment", () => {
  const f = fixture();
  try {
    const parent = f.registry.consumeEnrollment(f.registry.issueEnrollment(template).enrollmentToken);
    assert.throws(
      () => f.registry.issueChildEnrollment(parent.principal.id, 1, { name: "child" }),
      (error: unknown) => error instanceof RemoteAccessError && error.code === "INVALID_ENROLLMENT",
    );
  } finally {
    f.close();
  }
});

test("adoption rewrites ancestry, fences generations, and cancels pending delegated tokens", () => {
  const f = fixture();
  try {
    const parent = f.registry.consumeEnrollment(f.registry.issueEnrollment({
      ...template,
      canDelegate: true,
      maxDepth: 3,
      maxChildren: 1,
    }).enrollmentToken);
    const child = f.registry.consumeEnrollment(f.registry.issueChildEnrollment(parent.principal.id, 1, {
      name: "child",
      canDelegate: true,
      maxDepth: 3,
      maxChildren: 1,
    }).enrollmentToken);
    f.registry.issueChildEnrollment(child.principal.id, 1, { name: "pending-grandchild" });
    assert.throws(() => f.registry.adoptSubtree(parent.principal.id, child.principal.id, "root"), /ownership cycle/);
    const changed = f.registry.adoptSubtree(child.principal.id, "other-local-root", "other-local-root");
    assert.deepEqual(changed.map((principal) => principal.id), [child.principal.id]);
    assert.equal(changed[0].parentSessionId, "other-local-root");
    assert.equal(changed[0].rootSessionId, "other-local-root");
    assert.equal(changed[0].generation, 2);
    assert.equal(Object.keys(f.registry.snapshot().enrollments).length, 0);
  } finally {
    f.close();
  }
});

test("expiry reconciliation recursively generation-fences an expired subtree", () => {
  const f = fixture();
  try {
    const parent = f.registry.consumeEnrollment(f.registry.issueEnrollment({
      ...template,
      expiresAt: 1_800_000_001_000,
      canDelegate: true,
      maxDepth: 2,
      maxChildren: 1,
    }).enrollmentToken);
    const child = f.registry.consumeEnrollment(f.registry.issueChildEnrollment(parent.principal.id, 1, { name: "child" }).enrollmentToken);
    f.advance(1001);
    const expired = f.registry.expirePrincipals();
    assert.deepEqual(new Set(expired.map((principal) => principal.id)), new Set([parent.principal.id, child.principal.id]));
    assert.equal(expired.every((principal) => principal.state === "revoked" && principal.generation === 2), true);
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
