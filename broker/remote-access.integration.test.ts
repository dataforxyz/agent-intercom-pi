import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("authenticated remote gateway assigns identity and enforces phase zero visibility", { concurrency: false }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "agent-intercom-remote-gateway-"));
  const intercomDir = join(agentDir, "intercom");
  const localPath = join(intercomDir, "broker.sock");
  const remotePath = join(intercomDir, "remote-gateway.sock");
  const broker = spawn(process.execPath, ["--import", "tsx", join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: agentDir, USERPROFILE: agentDir },
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
        policySemanticsVersion: 1,
        policySemanticsHash: "78178a5fd57c353342642968d3a27262ed02cb236927723675d875959413dce3",
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

    const reusedEnrollment = await connect(remotePath);
    peers.push(reusedEnrollment);
    reusedEnrollment.send(registration("other", "other", { enrollmentToken: enrollment.enrollmentToken }));
    assert.equal((await reusedEnrollment.waitFor((message) => message.type === "error")).code, "ACCESS_DENIED");

    root.send({ type: "list", requestId: "root-list" });
    const rootSessions = await root.waitFor((message) => message.type === "sessions" && message.requestId === "root-list");
    assert.deepEqual(rootSessions.sessions.map((session: any) => session.id).sort(), [registered.sessionId, "local-root", "unrelated"].sort());
    assert.equal(rootSessions.sessions.find((session: any) => session.id === registered.sessionId).name, "ika/manager");

    unrelated.send({ type: "list", requestId: "unrelated-list" });
    const unrelatedSessions = await unrelated.waitFor((message) => message.type === "sessions" && message.requestId === "unrelated-list");
    assert.deepEqual(unrelatedSessions.sessions.map((session: any) => session.id).sort(), ["local-root", "unrelated"]);

    remote.send({ type: "list", requestId: "remote-list" });
    const remoteSessions = await remote.waitFor((message) => message.type === "sessions" && message.requestId === "remote-list");
    assert.deepEqual(remoteSessions.sessions.map((session: any) => session.id).sort(), [registered.sessionId, "local-root"].sort());

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
    assert.deepEqual(revoked.changedPrincipalIds, [registered.sessionId]);
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

    const auditText = readFileSync(join(intercomDir, "broker-audit.jsonl"), "utf8");
    const auditEvents = auditText.trim().split("\n").map((line) => JSON.parse(line).event);
    assert.ok(auditEvents.includes("enrollment_issued"));
    assert.ok(auditEvents.includes("enrollment_consumed"));
    assert.ok(auditEvents.includes("remote_connect"));
    assert.ok(auditEvents.includes("remote_reconnect"));
    assert.ok(auditEvents.includes("remote_delivery_denied"));
    assert.ok(auditEvents.includes("credential_reuse_denied"));
    assert.ok(auditEvents.includes("principal_revoked"));
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
