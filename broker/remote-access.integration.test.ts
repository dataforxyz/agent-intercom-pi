import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createMessageReader, writeMessage } from "./framing.ts";

const repoDir = resolve(import.meta.dirname, "..");

class RawPeer {
  readonly messages: unknown[] = [];
  private waiters: Array<{ predicate: (message: any) => boolean; resolve: (message: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = [];

  constructor(readonly socket: net.Socket) {
    socket.on("data", createMessageReader((message) => {
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timeout);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }, (error) => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }));
  }

  send(message: unknown): void {
    writeMessage(this.socket, message);
  }

  waitFor(predicate: (message: any) => boolean, timeoutMs = 5000): Promise<any> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for broker message; received ${JSON.stringify(this.messages)}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connect(path: string): Promise<RawPeer> {
  const socket = net.connect(path);
  await once(socket, "connect");
  return new RawPeer(socket);
}

async function waitForBrokerReady(broker: ReturnType<typeof spawn>): Promise<void> {
  const stdout = broker.stdout;
  if (!stdout) throw new Error("broker stdout is unavailable");
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("broker startup timeout")), 10_000);
    stdout.on("data", function onData(chunk: Buffer) {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        stdout.off("data", onData);
        resolveReady();
      }
    });
    broker.once("exit", (code) => reject(new Error(`broker exited early: ${code}`)));
  });
}

function registration(name: string, sessionId: string, access?: unknown) {
  return {
    type: "register",
    protocol: "pi-intercom",
    version: 3,
    sessionId,
    ...(access ? { access } : {}),
    session: {
      name,
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    },
  };
}

test("authenticated remote gateway assigns identity and enforces ownership-tree visibility", { concurrency: false }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "agent-intercom-remote-gateway-"));
  const intercomDir = join(agentDir, "intercom");
  const localPath = join(intercomDir, "broker.sock");
  const remotePath = join(intercomDir, "remote-gateway.sock");
  const broker = spawn(process.execPath, ["--import", "tsx", join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: agentDir, USERPROFILE: agentDir, PI_INTERCOM_REMOTE_EXPIRY_SWEEP_MS: "50" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const peers: RawPeer[] = [];
  try {
    await waitForBrokerReady(broker);

    const health = await connect(remotePath);
    peers.push(health);
    health.send({ type: "health", requestId: "health-1" });
    assert.deepEqual(await health.waitFor((message) => message.type === "health_ok"), {
      type: "health_ok",
      requestId: "health-1",
      protocol: "pi-intercom",
      version: 3,
      remoteAccess: {
        feature: "remote-access-v1",
        policySemanticsVersion: 2,
        policySemanticsHash: "f3b00e503631bc91123aedfbcf1df72cc9913e1893c09728b2c598f3dcdfdfe0",
      },
    });

    const unauthorized = await connect(remotePath);
    peers.push(unauthorized);
    unauthorized.send(registration("forged", "forged-id"));
    assert.equal((await unauthorized.waitFor((message) => message.type === "error")).code, "ACCESS_DENIED");

    const root = await connect(localPath);
    peers.push(root);
    root.send(registration("local-root", "local-root"));
    await root.waitFor((message) => message.type === "registered");

    const unrelated = await connect(localPath);
    peers.push(unrelated);
    unrelated.send(registration("unrelated", "unrelated"));
    await unrelated.waitFor((message) => message.type === "registered");

    const adminToken = JSON.parse(readFileSync(join(intercomDir, "broker-admin.json"), "utf8")).adminToken;
    const control = await connect(localPath);
    peers.push(control);
    control.send({
      type: "access_control",
      requestId: "enroll-1",
      adminToken,
      action: "issue_enrollment",
      enrollment: {
        name: "ika/manager",
        parentSessionId: "local-root",
        rootSessionId: "local-root",
        remoteHostId: "ika-dev-v3",
        canDelegate: true,
        maxDepth: 3,
        maxChildren: 2,
      },
    });
    const enrollment = await control.waitFor((message) => message.type === "access_control_result");
    assert.equal(typeof enrollment.enrollmentToken, "string");

    const remote = await connect(remotePath);
    peers.push(remote);
    remote.send(registration("attacker-selected-name", "attacker-selected-id", { enrollmentToken: enrollment.enrollmentToken }));
    const registered = await remote.waitFor((message) => message.type === "registered");
    assert.notEqual(registered.sessionId, "attacker-selected-id");
    assert.equal(registered.access.remoteHostId, "ika-dev-v3");
    assert.equal(registered.access.parentSessionId, "local-root");
    assert.equal(registered.access.sessionCredential.length > 20, true);
    assert.equal(registered.access.canDelegate, true);
    assert.equal(registered.access.depth, 1);
    assert.equal(registered.access.maxDepth, 3);
    assert.equal(registered.access.maxChildren, 2);

    const issueChild = async (parent: any, name: string, options: Record<string, unknown> = {}) => {
      const controlPeer = await connect(remotePath);
      peers.push(controlPeer);
      controlPeer.send({
        type: "access_control",
        requestId: `delegate-${name}`,
        action: "issue_child_enrollment",
        access: {
          sessionCredential: parent.access.sessionCredential,
          sessionId: parent.sessionId,
          generation: parent.access.generation,
        },
        enrollment: { name, ...options },
      });
      return await controlPeer.waitFor((message) =>
        (message.type === "access_control_result" && message.requestId === `delegate-${name}`) || message.type === "error"
      );
    };
    const connectChild = async (enrollmentToken: string, selectedName: string) => {
      const childPeer = await connect(remotePath);
      peers.push(childPeer);
      childPeer.send(registration(selectedName, `selected-${selectedName}`, { enrollmentToken }));
      return { peer: childPeer, registered: await childPeer.waitFor((message) => message.type === "registered") };
    };

    const leadEnrollment = await issueChild(registered, "ika/lead", { canDelegate: true, maxDepth: 3, maxChildren: 1 });
    assert.equal(leadEnrollment.action, "issue_child_enrollment");
    const lead = await connectChild(leadEnrollment.enrollmentToken, "forged-lead");
    assert.equal(lead.registered.access.parentSessionId, registered.sessionId);
    assert.equal(lead.registered.access.rootSessionId, "local-root");
    assert.equal(lead.registered.access.depth, 2);

    const workerEnrollment = await issueChild(lead.registered, "ika/worker");
    const worker = await connectChild(workerEnrollment.enrollmentToken, "forged-worker");
    assert.equal(worker.registered.access.parentSessionId, lead.registered.sessionId);
    assert.equal(worker.registered.access.depth, 3);
    assert.equal(worker.registered.access.canDelegate, false);

    const siblingEnrollment = await issueChild(registered, "ika/sibling");
    const sibling = await connectChild(siblingEnrollment.enrollmentToken, "forged-sibling");
    const exhausted = await issueChild(registered, "ika/too-many");
    assert.equal(exhausted.type, "error");
    assert.equal(exhausted.code, "ACCESS_DENIED");

    worker.peer.send({ type: "list", requestId: "worker-tree" });
    const workerTree = await worker.peer.waitFor((message) => message.type === "sessions" && message.requestId === "worker-tree");
    assert.deepEqual(workerTree.sessions.map((session: any) => session.id).sort(), ["local-root", registered.sessionId, lead.registered.sessionId, worker.registered.sessionId].sort());
    assert.equal(workerTree.sessions.some((session: any) => session.id === sibling.registered.sessionId), false);

    remote.send({ type: "list", requestId: "manager-tree" });
    const managerTree = await remote.waitFor((message) => message.type === "sessions" && message.requestId === "manager-tree");
    assert.deepEqual(managerTree.sessions.map((session: any) => session.id).sort(), ["local-root", registered.sessionId, lead.registered.sessionId, worker.registered.sessionId, sibling.registered.sessionId].sort());

    const inspectAs = async (principal: any, targetId?: string) => {
      const inspectPeer = await connect(remotePath);
      peers.push(inspectPeer);
      inspectPeer.send({
        type: "access_control",
        requestId: `inspect-${principal.sessionId}-${targetId ?? "self"}`,
        action: "inspect_tree",
        access: {
          sessionCredential: principal.access.sessionCredential,
          sessionId: principal.sessionId,
          generation: principal.access.generation,
        },
        ...(targetId ? { principalId: targetId } : {}),
      });
      return await inspectPeer.waitFor((message) => message.type === "access_control_result" || message.type === "error");
    };
    const managerInspection = await inspectAs(registered);
    assert.deepEqual(new Set(managerInspection.principals.map((principal: any) => principal.id)), new Set([registered.sessionId, lead.registered.sessionId, worker.registered.sessionId, sibling.registered.sessionId]));
    assert.equal(managerInspection.principals.every((principal: any) => principal.connected === true && principal.credentialHash === undefined), true);
    const forbiddenInspection = await inspectAs(worker.registered, registered.sessionId);
    assert.equal(forbiddenInspection.code, "ACCESS_DENIED");
    const workerInspection = await inspectAs(worker.registered);
    assert.deepEqual(workerInspection.principals.map((principal: any) => principal.id), [worker.registered.sessionId]);

    const adminInspectionPeer = await connect(localPath);
    peers.push(adminInspectionPeer);
    adminInspectionPeer.send({ type: "access_control", requestId: "admin-inspect", adminToken, action: "inspect_tree", principalId: registered.sessionId });
    const adminInspection = await adminInspectionPeer.waitFor((message) => message.type === "access_control_result" && message.action === "inspect_tree");
    assert.deepEqual(new Set(adminInspection.principals.map((principal: any) => principal.id)), new Set([registered.sessionId, lead.registered.sessionId, worker.registered.sessionId, sibling.registered.sessionId]));

    const adoptControl = await connect(localPath);
    peers.push(adoptControl);
    adoptControl.send({
      type: "access_control",
      requestId: "adopt-sibling",
      adminToken,
      action: "adopt_subtree",
      principalId: sibling.registered.sessionId,
      newParentSessionId: "local-root",
    });
    const adopted = await adoptControl.waitFor((message) => message.type === "access_control_result" && message.action === "adopt_subtree");
    assert.equal(adopted.principals.length, 1);
    assert.equal(adopted.principals[0].id, sibling.registered.sessionId);
    assert.equal(adopted.principals[0].parentSessionId, "local-root");
    assert.equal(adopted.principals[0].generation, 2);
    assert.equal(adopted.principals[0].connected, false);

    const staleAdoptedReconnect = await connect(remotePath);
    peers.push(staleAdoptedReconnect);
    staleAdoptedReconnect.send(registration("stale-adopted", "stale-adopted", {
      sessionCredential: sibling.registered.access.sessionCredential,
      sessionId: sibling.registered.sessionId,
      generation: 1,
    }));
    assert.equal((await staleAdoptedReconnect.waitFor((message) => message.type === "error")).code, "ACCESS_DENIED");
    const adoptedSibling = await connect(remotePath);
    peers.push(adoptedSibling);
    adoptedSibling.send(registration("adopted", "adopted", {
      sessionCredential: sibling.registered.access.sessionCredential,
      sessionId: sibling.registered.sessionId,
      generation: 2,
    }));
    await adoptedSibling.waitFor((message) => message.type === "registered");
    remote.send({ type: "list", requestId: "manager-after-adoption" });
    const afterAdoption = await remote.waitFor((message) => message.type === "sessions" && message.requestId === "manager-after-adoption");
    assert.equal(afterAdoption.sessions.some((session: any) => session.id === sibling.registered.sessionId), false);

    const reusedEnrollment = await connect(remotePath);
    peers.push(reusedEnrollment);
    reusedEnrollment.send(registration("other", "other", { enrollmentToken: enrollment.enrollmentToken }));
    assert.equal((await reusedEnrollment.waitFor((message) => message.type === "error")).code, "ACCESS_DENIED");

    root.send({ type: "list", requestId: "root-list" });
    const rootSessions = await root.waitFor((message) => message.type === "sessions" && message.requestId === "root-list");
    assert.deepEqual(rootSessions.sessions.map((session: any) => session.id).sort(), [registered.sessionId, lead.registered.sessionId, worker.registered.sessionId, sibling.registered.sessionId, "local-root", "unrelated"].sort());
    assert.equal(rootSessions.sessions.find((session: any) => session.id === registered.sessionId).name, "ika/manager");

    unrelated.send({ type: "list", requestId: "unrelated-list" });
    const unrelatedSessions = await unrelated.waitFor((message) => message.type === "sessions" && message.requestId === "unrelated-list");
    assert.deepEqual(unrelatedSessions.sessions.map((session: any) => session.id).sort(), ["local-root", "unrelated"]);

    remote.send({ type: "list", requestId: "remote-list" });
    const remoteSessions = await remote.waitFor((message) => message.type === "sessions" && message.requestId === "remote-list");
    assert.deepEqual(remoteSessions.sessions.map((session: any) => session.id).sort(), [registered.sessionId, lead.registered.sessionId, worker.registered.sessionId, "local-root"].sort());

    remote.send({
      type: "send",
      to: "unrelated",
      message: { id: "denied-message", timestamp: Date.now(), content: { text: "should be hidden" } },
    });
    const denied = await remote.waitFor((message) => message.type === "delivery_failed" && message.messageId === "denied-message");
    assert.equal(denied.code, "SESSION_NOT_FOUND");

    const duplicate = await connect(remotePath);
    peers.push(duplicate);
    duplicate.send(registration("replacement", "replacement", {
      sessionCredential: registered.access.sessionCredential,
      sessionId: registered.sessionId,
      generation: registered.access.generation,
    }));
    assert.equal((await duplicate.waitFor((message) => message.type === "error")).code, "ACCESS_DENIED");

    remote.close();
    await root.waitFor((message) => message.type === "session_left" && message.sessionId === registered.sessionId);
    const reconnect = await connect(remotePath);
    peers.push(reconnect);
    reconnect.send(registration("changed-name", "changed-id", {
      sessionCredential: registered.access.sessionCredential,
      sessionId: registered.sessionId,
      generation: registered.access.generation,
    }));
    const reconnected = await reconnect.waitFor((message) => message.type === "registered");
    assert.equal(reconnected.sessionId, registered.sessionId);
    assert.equal(reconnected.access.sessionCredential, undefined);

    root.send({
      type: "send",
      to: registered.sessionId,
      message: { id: "delivered-before-revoke", timestamp: 100, content: { text: "must not replay after revoke" } },
    });
    const deliveredBeforeRevoke = await reconnect.waitFor((message) => message.type === "message" && message.message.id === "delivered-before-revoke");
    reconnect.send({ type: "message_received", deliveryId: deliveredBeforeRevoke.deliveryId });
    await root.waitFor((message) => message.type === "delivered" && message.messageId === "delivered-before-revoke");

    root.send({
      type: "send",
      to: registered.sessionId,
      message: { id: "revoked-pending", timestamp: Date.now(), expectsReply: true, content: { text: "pending during revoke" } },
    });
    await root.waitFor((message) => message.type === "delivery_accepted" && message.messageId === "revoked-pending");
    await reconnect.waitFor((message) => message.type === "message" && message.message.id === "revoked-pending");

    const revokeControl = await connect(localPath);
    peers.push(revokeControl);
    revokeControl.send({
      type: "access_control",
      requestId: "revoke-1",
      adminToken,
      action: "revoke_subtree",
      principalId: registered.sessionId,
    });
    const revoked = await revokeControl.waitFor((message) => message.type === "access_control_result" && message.action === "revoke_subtree");
    assert.deepEqual(new Set(revoked.changedPrincipalIds), new Set([registered.sessionId, lead.registered.sessionId, worker.registered.sessionId]));
    const revokedDelivery = await root.waitFor((message) => message.type === "delivery_failed" && message.messageId === "revoked-pending");
    assert.equal(revokedDelivery.code, "RECIPIENT_DISCONNECTED");

    root.send({
      type: "send",
      to: registered.sessionId,
      message: { id: "delivered-before-revoke", timestamp: 100, content: { text: "must not replay after revoke" } },
    });
    const fencedReplay = await root.waitFor((message) => message.type === "delivery_failed" && message.messageId === "delivered-before-revoke");
    assert.equal(fencedReplay.code, "SESSION_NOT_FOUND");

    const revokedReconnect = await connect(remotePath);
    peers.push(revokedReconnect);
    revokedReconnect.send(registration("revoked", "revoked", {
      sessionCredential: registered.access.sessionCredential,
      sessionId: registered.sessionId,
      generation: registered.access.generation,
    }));
    assert.equal((await revokedReconnect.waitFor((message) => message.type === "error")).code, "ACCESS_DENIED");

    const clientEnrollmentControl = await connect(localPath);
    peers.push(clientEnrollmentControl);
    clientEnrollmentControl.send({
      type: "access_control",
      requestId: "enroll-client",
      adminToken,
      action: "issue_enrollment",
      enrollment: {
        name: "ika/client",
        parentSessionId: "local-root",
        rootSessionId: "local-root",
        remoteHostId: "ika-dev-v3",
      },
    });
    const clientEnrollment = await clientEnrollmentControl.waitFor((message) => message.type === "access_control_result" && message.requestId === "enroll-client");
    const remoteClientDir = join(agentDir, "remote-client");
    const remoteClientIntercom = join(remoteClientDir, "intercom");
    const credentialPath = join(remoteClientDir, "credential.json");
    mkdirSync(remoteClientIntercom, { recursive: true, mode: 0o700 });
    symlinkSync(remotePath, join(remoteClientIntercom, "broker.sock"));
    writeFileSync(credentialPath, JSON.stringify({ version: 1, enrollmentToken: clientEnrollment.enrollmentToken }), { mode: 0o600 });
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousCredentialPath = process.env.AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH;
    process.env.PI_CODING_AGENT_DIR = remoteClientDir;
    process.env.AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH = credentialPath;
    try {
      const { IntercomClient } = await import("./client.ts");
      const firstClient = new IntercomClient();
      await firstClient.connect({
        name: "client-selected-name",
        cwd: repoDir,
        model: "test-client",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      }, "client-selected-id");
      const assignedClientId = firstClient.sessionId;
      assert.ok(assignedClientId && assignedClientId !== "client-selected-id");
      const persistedCredential = JSON.parse(readFileSync(credentialPath, "utf8"));
      assert.equal(persistedCredential.sessionId, assignedClientId);
      assert.equal(typeof persistedCredential.sessionCredential, "string");
      assert.equal(persistedCredential.enrollmentToken, undefined);
      const clientVisible = await firstClient.listSessions();
      assert.deepEqual(clientVisible.map((session) => session.id).sort(), [assignedClientId, "local-root"].sort());
      assert.equal(clientVisible.find((session) => session.id === assignedClientId)?.name, "ika/client");
      await firstClient.disconnect();

      const secondClient = new IntercomClient();
      await secondClient.connect({
        name: "changed-client-name",
        cwd: repoDir,
        model: "test-client",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      }, "another-selected-id");
      assert.equal(secondClient.sessionId, assignedClientId);
      await secondClient.disconnect();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousCredentialPath === undefined) delete process.env.AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH;
      else process.env.AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH = previousCredentialPath;
    }

    const expiringControl = await connect(localPath);
    peers.push(expiringControl);
    expiringControl.send({
      type: "access_control",
      requestId: "enroll-expiring",
      adminToken,
      action: "issue_enrollment",
      enrollment: {
        name: "ika/expiring",
        parentSessionId: "local-root",
        rootSessionId: "local-root",
        remoteHostId: "ika-dev-v3",
        expiresAt: Date.now() + 800,
      },
    });
    const expiringEnrollment = await expiringControl.waitFor((message) => message.type === "access_control_result" && message.requestId === "enroll-expiring");
    const expiring = await connect(remotePath);
    peers.push(expiring);
    expiring.send(registration("expiring", "expiring", { enrollmentToken: expiringEnrollment.enrollmentToken }));
    const expiringRegistered = await expiring.waitFor((message) => message.type === "registered");
    await new Promise<void>((resolve, reject) => {
      if (expiring.socket.destroyed) return resolve();
      const timeout = setTimeout(() => reject(new Error("expired principal remained connected")), 3000);
      expiring.socket.once("close", () => { clearTimeout(timeout); resolve(); });
    });
    const expiredReconnect = await connect(remotePath);
    peers.push(expiredReconnect);
    expiredReconnect.send(registration("expired", "expired", {
      sessionCredential: expiringRegistered.access.sessionCredential,
      sessionId: expiringRegistered.sessionId,
      generation: expiringRegistered.access.generation,
    }));
    assert.equal((await expiredReconnect.waitFor((message) => message.type === "error")).code, "ACCESS_DENIED");

    const auditText = readFileSync(join(intercomDir, "broker-audit.jsonl"), "utf8");
    const auditEvents = auditText.trim().split("\n").map((line) => JSON.parse(line).event);
    assert.ok(auditEvents.includes("enrollment_issued"));
    assert.ok(auditEvents.includes("enrollment_consumed"));
    assert.ok(auditEvents.includes("remote_connect"));
    assert.ok(auditEvents.includes("remote_reconnect"));
    assert.ok(auditEvents.includes("remote_delivery_denied"));
    assert.ok(auditEvents.includes("credential_reuse_denied"));
    assert.ok(auditEvents.includes("principal_revoked"));
    assert.ok(auditEvents.includes("tree_inspected"));
    assert.ok(auditEvents.includes("principal_expired"));
    assert.ok(auditEvents.includes("principal_adopted"));
    assert.equal(auditText.includes(enrollment.enrollmentToken), false);
    assert.equal(auditText.includes(registered.access.sessionCredential), false);
  } finally {
    for (const peer of peers) peer.close();
    broker.kill("SIGTERM");
    await Promise.race([once(broker, "exit"), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000))]);
    if (broker.exitCode === null) broker.kill("SIGKILL");
    rmSync(agentDir, { recursive: true, force: true });
  }
});
