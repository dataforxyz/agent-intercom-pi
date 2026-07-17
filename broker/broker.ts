import net from "net";
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { POLICY_SEMANTICS_HASH, POLICY_SEMANTICS_VERSION, type PolicyAction } from "@dataforxyz/agent-intercom-core";
import { writeMessage, createMessageReader } from "./framing.ts";
import {
  ensureIntercomRuntimeDir,
  getBrokerAccessStateFilePath,
  getBrokerAdminCredentialFilePath,
  getBrokerAskStateFilePath,
  getBrokerAuditFilePath,
  getBrokerListenTarget,
  getBrokerPortFilePath,
  getIntercomDirPath,
  getRemoteGatewaySocketPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";
import { getAskTimeoutMs } from "../config.ts";
import { writeDurableJson } from "../durable-json.ts";
import { acquireBrokerOwnership, hasBrokerOwnership, releaseBrokerOwnership } from "./ownership.ts";
import { RemoteAccessRegistry, type RemotePrincipalRecord } from "./access-registry.ts";
import { authorizeSessionAction, visibleSessions } from "./authorization.ts";
import { BrokerAuditLog } from "./audit.ts";
import type {
  AskCancellationReason,
  BrokerErrorCode,
  BrokerMessage,
  DeliveryFailureCode,
  Message,
  Attachment,
  SessionInfo,
  SessionRegistration,
} from "../types.ts";

const INTERCOM_DIR = getIntercomDirPath();
const LISTEN_TARGET = getBrokerListenTarget();
const REMOTE_LISTEN_TARGET = getRemoteGatewaySocketPath();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
const OWNER_PATH = join(INTERCOM_DIR, "broker.owner");
const PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
const ASK_STATE_PATH = getBrokerAskStateFilePath(INTERCOM_DIR);
const ACCESS_STATE_PATH = getBrokerAccessStateFilePath(INTERCOM_DIR);
const ADMIN_CREDENTIAL_PATH = getBrokerAdminCredentialFilePath(INTERCOM_DIR);
const AUDIT_PATH = getBrokerAuditFilePath(INTERCOM_DIR);
const BROKER_STATE_ID = randomUUID();
const MAX_SESSIONS = 128;
const MAX_UNREGISTERED_CONNECTIONS = 32;
const REGISTRATION_TIMEOUT_MS = 1000;
const RATE_LIMIT_CAPACITY = 240;
const RATE_LIMIT_REFILL_PER_SECOND = 120;
const REMOTE_RATE_LIMIT_CAPACITY = 60;
const REMOTE_RATE_LIMIT_REFILL_PER_SECOND = 30;
const PRESENCE_HEARTBEAT_MS = 1000;
const DELIVERY_ACK_TIMEOUT_MS = 8000;
const RECENT_DELIVERY_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_DELIVERIES = 1024;
const MAX_PENDING_DELIVERIES_PER_SESSION = 64;
const MAX_PENDING_ASKS_PER_SESSION = 64;
const RATE_LIMIT_BYTES_PER_TOKEN = 8 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 256 * 1024;
const MAX_ATTACHMENT_CONTENT_BYTES = 512 * 1024;
const MAX_ATTACHMENTS = 16;
const MAX_MESSAGE_ID_LENGTH = 256;
const MAX_TARGET_LENGTH = 512;
const MAX_SESSION_NAME_LENGTH = 256;
const MAX_SESSION_CWD_LENGTH = 4096;
const MAX_SESSION_MODEL_LENGTH = 512;
const MAX_SESSION_STATUS_LENGTH = 512;

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
  lastPresenceBroadcastAt: number;
}

type ConnectionOrigin = "local" | "remote";

interface ConnectionState {
  socket: net.Socket;
  origin: ConnectionOrigin;
  tokens: number;
  refillPerSecond: number;
  lastRefillAt: number;
}

interface AskEdge {
  messageId: string;
  from: string;
  to: string;
  createdAt: number;
  expiresAt: number;
  state: "blocking" | "deferred";
  timeout: NodeJS.Timeout;
}

interface PersistedAskEdge {
  messageId: string;
  from: string;
  to: string;
  createdAt: number;
  expiresAt: number;
  state: "blocking" | "deferred";
}

interface PendingDelivery {
  id: string;
  key: string;
  fingerprint: string;
  message: Message;
  from: string;
  to: string;
  senderSocket: net.Socket;
  recipientSocket: net.Socket;
  action: PolicyAction;
  fromGeneration: number;
  toGeneration: number;
  timeout: NodeJS.Timeout;
}

interface RecentDelivery {
  fingerprint: string;
  from: string;
  to: string;
  action: PolicyAction;
  fromGeneration: number;
  toGeneration: number;
  retryable: boolean;
  response:
    | { type: "delivered"; messageId: string; deliveryId: string }
    | { type: "delivery_failed"; messageId: string; accepted: boolean; code: DeliveryFailureCode; reason: string };
  expiresAt: number;
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const attachment = value as Record<string, unknown>;

  if (
    attachment.type !== "file"
    && attachment.type !== "snippet"
    && attachment.type !== "context"
  ) {
    return false;
  }

  if (
    typeof attachment.name !== "string"
    || attachment.name.length > 256
    || typeof attachment.content !== "string"
    || Buffer.byteLength(attachment.content, "utf-8") > MAX_ATTACHMENT_CONTENT_BYTES
  ) {
    return false;
  }

  return attachment.language === undefined || typeof attachment.language === "string";
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (
    typeof message.id !== "string"
    || message.id.length === 0
    || message.id.length > MAX_MESSAGE_ID_LENGTH
    || typeof message.timestamp !== "number"
    || !Number.isFinite(message.timestamp)
  ) {
    return false;
  }

  if (
    message.replyTo !== undefined
    && (typeof message.replyTo !== "string" || message.replyTo.length === 0 || message.replyTo.length > MAX_MESSAGE_ID_LENGTH)
  ) {
    return false;
  }

  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") {
    return false;
  }

  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }

  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string" || Buffer.byteLength(content.text, "utf-8") > MAX_MESSAGE_TEXT_BYTES) {
    return false;
  }

  return content.attachments === undefined
    || (
      Array.isArray(content.attachments)
      && content.attachments.length <= MAX_ATTACHMENTS
      && content.attachments.every(isAttachment)
    );
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSessionRegistration(value: unknown): value is SessionRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.cwd !== "string"
    || session.cwd.length === 0
    || session.cwd.length > MAX_SESSION_CWD_LENGTH
    || typeof session.model !== "string"
    || session.model.length === 0
    || session.model.length > MAX_SESSION_MODEL_LENGTH
    || typeof session.pid !== "number"
    || !Number.isFinite(session.pid)
    || typeof session.startedAt !== "number"
    || !Number.isFinite(session.startedAt)
    || typeof session.lastActivity !== "number"
    || !Number.isFinite(session.lastActivity)
  ) {
    return false;
  }

  if (session.name !== undefined && (typeof session.name !== "string" || session.name.length > MAX_SESSION_NAME_LENGTH)) {
    return false;
  }

  return session.status === undefined
    || (typeof session.status === "string" && session.status.length <= MAX_SESSION_STATUS_LENGTH);
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private askEdges = new Map<string, AskEdge>();
  private pendingDeliveries = new Map<string, PendingDelivery>();
  private pendingDeliveryKeys = new Map<string, string>();
  private recentDeliveries = new Map<string, RecentDelivery>();
  private connections = new Set<net.Socket>();
  private unregisteredConnections = new Set<net.Socket>();
  private server: net.Server;
  private remoteServer: net.Server | null = null;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private readonly askTimeoutMs = getAskTimeoutMs();
  private readonly accessRegistry: RemoteAccessRegistry;
  private readonly audit: BrokerAuditLog;

  constructor() {
    ensureIntercomRuntimeDir(INTERCOM_DIR);
    acquireBrokerOwnership(OWNER_PATH);
    this.accessRegistry = new RemoteAccessRegistry(ACCESS_STATE_PATH);
    this.audit = new BrokerAuditLog(AUDIT_PATH);
    this.accessRegistry.ensureAdminCredential(ADMIN_CREDENTIAL_PATH);
    this.loadAskEdges();
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      for (const socketPath of [LISTEN_TARGET, REMOTE_LISTEN_TARGET]) {
        try {
          unlinkSync(socketPath);
        } catch {
          // A clean startup has no stale socket to remove.
        }
      }
    }
    this.server = net.createServer((socket) => this.handleConnection(socket, "local"));
    if (process.platform !== "win32" && typeof LISTEN_TARGET === "string") {
      this.remoteServer = net.createServer((socket) => this.handleConnection(socket, "remote"));
    }
  }

  start(): void {
    let localListening = false;
    let remoteListening = this.remoteServer === null;
    const announceWhenReady = () => {
      if (!localListening || !remoteListening) return;
      writeFileSync(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(PID_PATH);
      console.log(`Intercom broker started (pid: ${process.pid}, remote-access-v1)`);
    };
    const onLocalListening = () => {
      if (typeof LISTEN_TARGET === "string") {
        restrictIntercomRuntimeFile(LISTEN_TARGET);
      } else {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Intercom TCP broker started without a TCP address");
        }
        const endpoint: BrokerConnectTarget = {
          transport: "tcp",
          host: LISTEN_TARGET.host,
          port: address.port,
          stateId: BROKER_STATE_ID,
        };
        writeFileSync(PORT_PATH, `${JSON.stringify(endpoint)}\n`, { mode: INTERCOM_RUNTIME_FILE_MODE });
        restrictIntercomRuntimeFile(PORT_PATH);
      }
      localListening = true;
      announceWhenReady();
    };

    if (typeof LISTEN_TARGET === "string") {
      this.server.listen(LISTEN_TARGET, onLocalListening);
    } else {
      this.server.listen({ host: LISTEN_TARGET.host, port: LISTEN_TARGET.port }, onLocalListening);
    }
    if (this.remoteServer) {
      this.remoteServer.listen(REMOTE_LISTEN_TARGET, () => {
        restrictIntercomRuntimeFile(REMOTE_LISTEN_TARGET);
        remoteListening = true;
        announceWhenReady();
      });
    }
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket, origin: ConnectionOrigin): void {
    this.connections.add(socket);
    let sessionId: string | null = null;
    let registrationTimeout: NodeJS.Timeout | null = null;
    const armRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
      }
      this.unregisteredConnections.delete(socket);
      this.unregisteredConnections.add(socket);
      this.evictOldestUnregisteredConnections(socket);
      registrationTimeout = setTimeout(() => {
        if (!sessionId) {
          socket.destroy();
        }
      }, REGISTRATION_TIMEOUT_MS);
      registrationTimeout.unref?.();
    };
    const clearRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
        registrationTimeout = null;
      }
      this.unregisteredConnections.delete(socket);
    };
    armRegistrationTimeout();
    const connection: ConnectionState = {
      socket,
      origin,
      tokens: origin === "remote" ? REMOTE_RATE_LIMIT_CAPACITY : RATE_LIMIT_CAPACITY,
      refillPerSecond: origin === "remote" ? REMOTE_RATE_LIMIT_REFILL_PER_SECOND : RATE_LIMIT_REFILL_PER_SECOND,
      lastRefillAt: Date.now(),
    };

    const reader = createMessageReader((msg) => {
      const byteCost = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(msg), "utf-8") / RATE_LIMIT_BYTES_PER_TOKEN));
      if (!this.consumeToken(connection, byteCost)) {
        this.sendError(socket, "RATE_LIMITED", "Intercom broker rate limit exceeded");
        socket.destroy(new Error("Intercom broker rate limit exceeded"));
        return;
      }
      try {
        this.handleMessage(socket, origin, msg, sessionId, (id) => {
          sessionId = id;
          if (id) {
            clearRegistrationTimeout();
          } else {
            armRegistrationTimeout();
          }
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === "Invalid intercom TCP endpoint credentials") {
          socket.destroy();
          return;
        }
        this.sendError(socket, "INVALID_REQUEST", reason);
        socket.end();
      }
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      clearRegistrationTimeout();
      this.connections.delete(socket);
      if (sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing?.socket === socket) {
          if (existing.info.origin === "remote") {
            this.audit.tryRecord({
              event: "remote_disconnect",
              outcome: "observed",
              actorId: sessionId,
              remoteHostId: existing.info.remoteHostId,
              generation: existing.info.generation,
              reason: "SOCKET_CLOSED",
            });
          }
          this.broadcastVisible({ type: "session_left", sessionId }, existing.info, sessionId);
          this.sessions.delete(sessionId);
          this.clearPendingDeliveriesForSession(sessionId, socket);
          this.deferAskEdgesForSession(sessionId);
          this.scheduleShutdownCheck();
        }
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private evictOldestUnregisteredConnections(currentSocket: net.Socket): void {
    while (this.unregisteredConnections.size > MAX_UNREGISTERED_CONNECTIONS) {
      const [oldest] = this.unregisteredConnections;
      if (!oldest) {
        return;
      }
      if (oldest === currentSocket && this.unregisteredConnections.size === 1) {
        return;
      }
      this.unregisteredConnections.delete(oldest);
      oldest.destroy();
    }
  }

  private consumeToken(connection: ConnectionState, cost = 1, now = Date.now()): boolean {
    const elapsedMs = now - connection.lastRefillAt;
    if (elapsedMs > 0) {
      connection.tokens = Math.min(
        connection.origin === "remote" ? REMOTE_RATE_LIMIT_CAPACITY : RATE_LIMIT_CAPACITY,
        connection.tokens + elapsedMs * connection.refillPerSecond / 1000,
      );
      connection.lastRefillAt = now;
    }
    if (connection.tokens < cost) {
      return false;
    }
    connection.tokens -= cost;
    return true;
  }

  private sendError(socket: net.Socket, code: BrokerErrorCode, error: string): void {
    writeMessage(socket, { type: "error", code, error });
  }

  private sendDeliveryFailure(
    socket: net.Socket,
    messageId: string,
    accepted: boolean,
    code: DeliveryFailureCode,
    reason: string,
  ): void {
    writeMessage(socket, { type: "delivery_failed", messageId, accepted, code, reason });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }

  private handleMessage(
    socket: net.Socket,
    origin: ConnectionOrigin,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;
    const requiresEndpointAuth = typeof LISTEN_TARGET !== "string";
    const hasEndpointAuth = clientMessage.stateId === BROKER_STATE_ID;

    if (clientMessage.type === "health") {
      if (typeof clientMessage.requestId !== "string") {
        throw new Error("Invalid health message");
      }
      if (requiresEndpointAuth && !hasEndpointAuth) {
        throw new Error("Invalid intercom TCP endpoint credentials");
      }
      writeMessage(socket, {
        type: "health_ok",
        requestId: clientMessage.requestId,
        protocol: INTERCOM_PROTOCOL_NAME,
        version: INTERCOM_PROTOCOL_VERSION,
        remoteAccess: this.remoteAccessContract(),
      });
      return;
    }

    if (clientMessage.type === "access_control") {
      if (origin !== "local" || currentId !== null) {
        this.sendError(socket, "ACCESS_DENIED", "Remote access control is unavailable on this connection");
        socket.end();
        return;
      }
      this.handleAccessControl(socket, clientMessage);
      return;
    }

    if (requiresEndpointAuth && clientMessage.type === "register" && !hasEndpointAuth) {
      throw new Error("Invalid intercom TCP endpoint credentials");
    }

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }
    if (currentId && !this.isCurrentPrincipal(currentId)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote session authorization is no longer valid");
      socket.destroy();
      return;
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (
          clientMessage.protocol !== INTERCOM_PROTOCOL_NAME
          || clientMessage.version !== INTERCOM_PROTOCOL_VERSION
        ) {
          this.sendError(
            socket,
            "PROTOCOL_MISMATCH",
            `Unsupported intercom protocol; expected ${INTERCOM_PROTOCOL_NAME} v${INTERCOM_PROTOCOL_VERSION}`,
          );
          socket.end();
          break;
        }

        if (currentId) {
          throw new Error("Received duplicate register message");
        }
        
        let id: string;
        let remotePrincipal: RemotePrincipalRecord | undefined;
        let issuedSessionCredential: string | undefined;
        let enrollmentConsumed = false;
        if (origin === "remote") {
          if (this.sessions.size >= MAX_SESSIONS) {
            this.sendError(socket, "TOO_MANY_SESSIONS", "Too many registered intercom sessions");
            socket.destroy();
            break;
          }
          const access = clientMessage.access;
          if (typeof access !== "object" || access === null || Array.isArray(access)) {
            this.audit.tryRecord({ event: "remote_registration_denied", outcome: "denied", reason: "MISSING_CREDENTIAL" });
            this.sendError(socket, "ACCESS_DENIED", "Remote registration requires an access credential");
            socket.end();
            break;
          }
          const fields = access as Record<string, unknown>;
          try {
            if (typeof fields.enrollmentToken === "string") {
              const consumed = this.accessRegistry.consumeEnrollment(fields.enrollmentToken);
              remotePrincipal = consumed.principal;
              issuedSessionCredential = consumed.sessionCredential;
              enrollmentConsumed = true;
            } else if (
              typeof fields.sessionCredential === "string"
              && typeof fields.sessionId === "string"
              && typeof fields.generation === "number"
              && Number.isSafeInteger(fields.generation)
            ) {
              remotePrincipal = this.accessRegistry.authenticateSession(fields.sessionId, fields.generation, fields.sessionCredential);
            } else {
              throw new Error("Invalid remote access credential shape");
            }
          } catch {
            this.audit.tryRecord({ event: "remote_registration_denied", outcome: "denied", reason: "INVALID_CREDENTIAL" });
            this.sendError(socket, "ACCESS_DENIED", "Remote registration credential was rejected");
            socket.end();
            break;
          }
          id = remotePrincipal.id;
          if (this.sessions.has(id)) {
            this.audit.tryRecord({
              event: "credential_reuse_denied",
              outcome: "denied",
              actorId: id,
              remoteHostId: remotePrincipal.remoteHostId,
              generation: remotePrincipal.generation,
              reason: "ALREADY_ACTIVE",
            });
            this.sendError(socket, "ACCESS_DENIED", "Remote session credential is already active");
            socket.end();
            break;
          }
        } else {
          id = randomUUID();
          if (clientMessage.sessionId !== undefined) {
            if (!isSessionId(clientMessage.sessionId)) {
              throw new Error("Invalid register sessionId");
            }
            id = clientMessage.sessionId;
          }
          const previous = this.sessions.get(id);
          if (!previous && this.sessions.size >= MAX_SESSIONS) {
            this.sendError(socket, "TOO_MANY_SESSIONS", "Too many registered intercom sessions");
            socket.destroy();
            break;
          }
          if (previous) {
            this.clearPendingDeliveriesForSession(id, previous.socket);
            this.deferAskEdgesForSession(id);
            previous.socket.end();
          }
        }
        setId(id);
        const session = clientMessage.session;
        const info: SessionInfo = remotePrincipal ? {
          id,
          name: remotePrincipal.name,
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...(session.status !== undefined ? { status: session.status } : {}),
          trustedLocal: false,
          origin: "remote",
          remoteHostId: remotePrincipal.remoteHostId,
          parentSessionId: remotePrincipal.parentSessionId,
          rootSessionId: remotePrincipal.rootSessionId,
          generation: remotePrincipal.generation,
        } : {
          id,
          ...(session.name !== undefined ? { name: session.name } : {}),
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...(session.status !== undefined ? { status: session.status } : {}),
          trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32",
          origin: "local",
        };
        if (remotePrincipal) {
          this.audit.record({
            event: enrollmentConsumed ? "enrollment_consumed" : "remote_reconnect",
            outcome: "allowed",
            actorId: id,
            targetId: remotePrincipal.parentSessionId,
            remoteHostId: remotePrincipal.remoteHostId,
            generation: remotePrincipal.generation,
          });
          this.audit.record({
            event: "remote_connect",
            outcome: "allowed",
            actorId: id,
            targetId: remotePrincipal.parentSessionId,
            remoteHostId: remotePrincipal.remoteHostId,
            generation: remotePrincipal.generation,
          });
        }
        this.sessions.set(id, { socket, info, lastPresenceBroadcastAt: Date.now() });

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, {
          type: "registered",
          sessionId: id,
          protocol: INTERCOM_PROTOCOL_NAME,
          version: INTERCOM_PROTOCOL_VERSION,
          ...(remotePrincipal ? {
            remoteAccess: this.remoteAccessContract(),
            access: {
              origin: "remote",
              remoteHostId: remotePrincipal.remoteHostId,
              parentSessionId: remotePrincipal.parentSessionId,
              rootSessionId: remotePrincipal.rootSessionId,
              generation: remotePrincipal.generation,
              ...(issuedSessionCredential ? { sessionCredential: issuedSessionCredential } : {}),
            },
          } : {}),
        });
        this.broadcastVisible({ type: "session_joined", session: info }, info, id);
        break;
      }

      case "unregister": {
        if (!currentId) {
          throw new Error("Received unregister before register");
        }
        if (clientMessage.preserveAsks !== undefined && typeof clientMessage.preserveAsks !== "boolean") {
          throw new Error("Invalid unregister preserveAsks value");
        }
        const existing = this.sessions.get(currentId);
        if (existing?.socket === socket) {
          if (existing.info.origin === "remote") {
            this.audit.tryRecord({
              event: "remote_disconnect",
              outcome: "observed",
              actorId: currentId,
              remoteHostId: existing.info.remoteHostId,
              generation: existing.info.generation,
              reason: "UNREGISTERED",
            });
          }
          this.broadcastVisible({ type: "session_left", sessionId: currentId }, existing.info, currentId);
          this.sessions.delete(currentId);
          this.clearPendingDeliveriesForSession(currentId, socket);
          if (clientMessage.preserveAsks) {
            this.deferAskEdgesForSession(currentId);
          } else {
            this.clearAskEdgesForSession(currentId, "session_disconnected");
          }
          this.scheduleShutdownCheck();
        }
        setId(null);
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }

        const allSessions = Array.from(this.sessions.values(), (session) => session.info);
        const sessions = visibleSessions(allSessions, currentId!);
        const actor = this.sessions.get(currentId!);
        if (actor?.info.origin === "remote" && sessions.length < allSessions.length) {
          this.audit.tryRecord({
            event: "remote_visibility_filtered",
            outcome: "observed",
            actorId: currentId!,
            remoteHostId: actor.info.remoteHostId,
            generation: actor.info.generation,
            visibleCount: sessions.length,
            hiddenCount: allSessions.length - sessions.length,
          });
        }
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        if (!currentId) {
          throw new Error("Received send before register");
        }
        const message = clientMessage.message;
        const messageId = typeof message === "object"
          && message !== null
          && "id" in message
          && typeof message.id === "string"
          && message.id.length > 0
          && message.id.length <= MAX_MESSAGE_ID_LENGTH
          ? message.id
          : "unknown";

        if (
          typeof clientMessage.to !== "string"
          || clientMessage.to.length === 0
          || clientMessage.to.length > MAX_TARGET_LENGTH
          || !isMessage(message)
        ) {
          this.sendDeliveryFailure(socket, messageId, false, "INVALID_MESSAGE", "Invalid message format");
          break;
        }

        const action: PolicyAction = message.replyTo ? "reply" : message.expectsReply ? "ask" : "send";
        this.pruneRecentDeliveries();
        const deliveryKey = this.deliveryKey(currentId, message.id);
        const fingerprint = JSON.stringify({
          to: clientMessage.to,
          replyTo: message.replyTo,
          expectsReply: message.expectsReply,
          content: message.content,
        });
        const recent = this.recentDeliveries.get(deliveryKey);
        if (recent) {
          if (recent.fingerprint !== fingerprint) {
            this.sendDeliveryFailure(socket, message.id, false, "DUPLICATE_MESSAGE_ID", "Message ID was already used with a different payload");
            break;
          }
          const actor = this.sessions.get(currentId);
          const target = this.sessions.get(recent.to);
          const authorizationStillValid = Boolean(
            actor
            && target
            && (actor.info.generation ?? 1) === recent.fromGeneration
            && (target.info.generation ?? 1) === recent.toGeneration
            && this.isAuthorized(currentId, recent.action, recent.to)
          );
          if (recent.retryable || !authorizationStillValid) {
            this.recentDeliveries.delete(deliveryKey);
          } else {
            if (recent.response.type === "delivered") {
              writeMessage(socket, {
                type: "delivery_accepted",
                messageId: message.id,
                deliveryId: recent.response.deliveryId,
              });
            }
            writeMessage(socket, recent.response);
            break;
          }
        }
        const existingDeliveryId = this.pendingDeliveryKeys.get(deliveryKey);
        if (existingDeliveryId) {
          const existing = this.pendingDeliveries.get(existingDeliveryId);
          if (!existing || existing.fingerprint !== fingerprint) {
            this.sendDeliveryFailure(socket, message.id, false, "DUPLICATE_MESSAGE_ID", "Message ID is already pending with a different payload");
            break;
          }
          const actor = this.sessions.get(existing.from);
          const target = this.sessions.get(existing.to);
          if (
            actor
            && target
            && (actor.info.generation ?? 1) === existing.fromGeneration
            && (target.info.generation ?? 1) === existing.toGeneration
            && this.isAuthorized(existing.from, existing.action, existing.to)
          ) {
            writeMessage(socket, { type: "delivery_accepted", messageId: message.id, deliveryId: existing.id });
            break;
          }
          this.failPendingDelivery(existing.id, "SESSION_NOT_FOUND", "Delivery authorization changed while pending");
        }

        if (
          this.pendingDeliveries.size >= MAX_PENDING_DELIVERIES
          || this.countPendingDeliveriesFrom(currentId) >= MAX_PENDING_DELIVERIES_PER_SESSION
        ) {
          this.sendDeliveryFailure(socket, message.id, false, "TOO_MANY_PENDING_DELIVERIES", "Too many messages are waiting for receiver acknowledgement");
          break;
        }

        const candidates = this.findSessions(clientMessage.to);
        const targets = candidates.filter((target) => this.isAuthorized(currentId, action, target.info.id));
        if (candidates.length > 0 && targets.length === 0) {
          const actor = this.sessions.get(currentId);
          this.audit.tryRecord({
            event: "remote_delivery_denied",
            outcome: "denied",
            actorId: currentId,
            targetId: candidates.length === 1 ? candidates[0].info.id : undefined,
            remoteHostId: actor?.info.remoteHostId ?? candidates.find((candidate) => candidate.info.remoteHostId)?.info.remoteHostId,
            generation: actor?.info.generation,
            reason: "POLICY_DENIED",
          });
        }
        if (targets.length === 1) {
          const fromSession = this.sessions.get(currentId);
          if (!fromSession || fromSession.socket !== socket) {
            this.sendDeliveryFailure(socket, message.id, false, "SENDER_NOT_FOUND", "Sender session not found");
            break;
          }
          const target = targets[0];
          const replyEdge = message.replyTo
            ? this.askEdges.get(this.askKey(target.info.id, message.replyTo))
            : undefined;
          if (message.replyTo && !replyEdge) {
            this.sendDeliveryFailure(socket, message.id, false, "INVALID_REPLY_TARGET", "Reply target does not match a pending ask");
            break;
          }
          if (replyEdge && (replyEdge.to !== currentId || replyEdge.from !== target.info.id)) {
            this.sendDeliveryFailure(socket, message.id, false, "INVALID_REPLY_TARGET", "Reply target does not match the pending ask");
            break;
          }
          if (message.expectsReply) {
            const existingAsk = Array.from(this.askEdges.values()).find((edge) =>
              edge.from === currentId && edge.to === target.info.id
            );
            if (existingAsk) {
              this.sendDeliveryFailure(socket, message.id, false, "ASK_ALREADY_PENDING", "Another ask to this session is still unresolved. Wait for its reply or use intercom_send for a non-blocking follow-up.");
              break;
            }
            const reverseEdge = Array.from(this.askEdges.values()).find((edge) =>
              edge.state === "blocking"
              && !(message.replyTo === edge.messageId && target.info.id === edge.from)
              && edge.from === target.info.id
              && edge.to === currentId
            );
            if (reverseEdge) {
              this.sendDeliveryFailure(socket, message.id, false, "MUTUAL_ASK", "Mutual ask refused: target session is already waiting for a reply from this session.");
              break;
            }
            if (this.countAskEdgesFrom(currentId) >= MAX_PENDING_ASKS_PER_SESSION) {
              this.sendDeliveryFailure(socket, message.id, false, "TOO_MANY_PENDING_ASKS", "Too many asks are already waiting for replies");
              break;
            }
            this.addAskEdge(message.id, currentId, target.info.id);
          }

          const deliveryId = randomUUID();
          const timeout = setTimeout(() => {
            this.failPendingDelivery(deliveryId, "DELIVERY_TIMEOUT", "Recipient did not acknowledge the message in time");
          }, DELIVERY_ACK_TIMEOUT_MS);
          timeout.unref?.();
          const pending: PendingDelivery = {
            id: deliveryId,
            key: deliveryKey,
            fingerprint,
            message,
            from: currentId,
            to: target.info.id,
            senderSocket: socket,
            recipientSocket: target.socket,
            action,
            fromGeneration: fromSession.info.generation ?? 1,
            toGeneration: target.info.generation ?? 1,
            timeout,
          };
          this.pendingDeliveries.set(deliveryId, pending);
          this.pendingDeliveryKeys.set(deliveryKey, deliveryId);
          writeMessage(socket, { type: "delivery_accepted", messageId: message.id, deliveryId });
          writeMessage(target.socket, {
            type: "message",
            deliveryId,
            from: fromSession.info,
            message,
          });
          break;
        }

        if (targets.length > 1) {
          this.sendDeliveryFailure(socket, message.id, false, "AMBIGUOUS_TARGET", `Multiple sessions named \"${clientMessage.to}\" are connected. Use the session ID instead.`);
          break;
        }

        this.sendDeliveryFailure(socket, message.id, false, "SESSION_NOT_FOUND", "Session not found");
        break;
      }

      case "message_received": {
        if (!currentId) {
          throw new Error("Received message_received before register");
        }
        if (typeof clientMessage.deliveryId !== "string") {
          throw new Error("Invalid message_received message");
        }
        this.acknowledgePendingDelivery(clientMessage.deliveryId, currentId, socket);
        break;
      }

      case "message_rejected": {
        if (!currentId) {
          throw new Error("Received message_rejected before register");
        }
        if (
          typeof clientMessage.deliveryId !== "string"
          || clientMessage.code !== "CONFLICTING_MESSAGE_ID"
          || typeof clientMessage.reason !== "string"
          || clientMessage.reason.length > 1024
        ) {
          throw new Error("Invalid message_rejected message");
        }
        const pending = this.pendingDeliveries.get(clientMessage.deliveryId);
        if (pending?.to === currentId && pending.recipientSocket === socket) {
          this.failPendingDelivery(clientMessage.deliveryId, clientMessage.code, clientMessage.reason);
        }
        break;
      }

      case "defer_ask": {
        if (!currentId) {
          throw new Error("Received defer_ask before register");
        }
        if (
          typeof clientMessage.messageId !== "string"
          || clientMessage.messageId.length > MAX_MESSAGE_ID_LENGTH
          || typeof clientMessage.requestId !== "string"
          || clientMessage.requestId.length > MAX_MESSAGE_ID_LENGTH
        ) {
          throw new Error("Invalid defer_ask message");
        }
        const edge = this.askEdges.get(this.askKey(currentId, clientMessage.messageId));
        const applied = Boolean(edge?.from === currentId);
        if (edge?.from === currentId && edge.state === "blocking") {
          edge.state = "deferred";
          this.persistAskEdges();
          this.notifyAskDeferred(edge);
        }
        writeMessage(socket, { type: "ask_control_result", requestId: clientMessage.requestId, action: "defer", messageId: clientMessage.messageId, applied });
        break;
      }

      case "cancel_ask": {
        if (!currentId) {
          throw new Error("Received cancel_ask before register");
        }
        if (
          typeof clientMessage.messageId !== "string"
          || clientMessage.messageId.length > MAX_MESSAGE_ID_LENGTH
          || typeof clientMessage.requestId !== "string"
          || clientMessage.requestId.length > MAX_MESSAGE_ID_LENGTH
        ) {
          throw new Error("Invalid cancel_ask message");
        }
        const session = this.sessions.get(currentId);
        const edgeKey = this.askKey(currentId, clientMessage.messageId);
        const edge = this.askEdges.get(edgeKey);
        const applied = Boolean(session?.socket === socket && edge?.from === currentId);
        if (applied) {
          this.removeAskEdge(edgeKey, "cancelled", true);
        }
        writeMessage(socket, { type: "ask_control_result", requestId: clientMessage.requestId, action: "cancel", messageId: clientMessage.messageId, applied });
        break;
      }

      case "presence": {
        if (!currentId) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentId);
        if (session?.socket === socket) {
          let changed = false;
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string" || clientMessage.name.length > MAX_SESSION_NAME_LENGTH) {
              throw new Error("Invalid presence name");
            }
            if (session.info.origin !== "remote" && session.info.name !== clientMessage.name) {
              session.info.name = clientMessage.name;
              changed = true;
            }
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string" || clientMessage.status.length > MAX_SESSION_STATUS_LENGTH) {
              throw new Error("Invalid presence status");
            }
            if (session.info.status !== clientMessage.status) {
              session.info.status = clientMessage.status;
              changed = true;
            }
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string" || clientMessage.model.length > MAX_SESSION_MODEL_LENGTH) {
              throw new Error("Invalid presence model");
            }
            if (session.info.model !== clientMessage.model) {
              session.info.model = clientMessage.model;
              changed = true;
            }
          }
          const now = Date.now();
          session.info.lastActivity = now;
          if (changed || now - session.lastPresenceBroadcastAt >= PRESENCE_HEARTBEAT_MS) {
            session.lastPresenceBroadcastAt = now;
            this.broadcastVisible({ type: "presence_update", session: session.info }, session.info, currentId);
          }
        }
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private remoteAccessContract() {
    return {
      feature: "remote-access-v1" as const,
      policySemanticsVersion: POLICY_SEMANTICS_VERSION,
      policySemanticsHash: POLICY_SEMANTICS_HASH,
    };
  }

  private handleAccessControl(socket: net.Socket, message: Record<string, unknown>): void {
    if (
      typeof message.requestId !== "string"
      || message.requestId.length > MAX_MESSAGE_ID_LENGTH
      || typeof message.adminToken !== "string"
      || !this.accessRegistry.authenticateAdmin(message.adminToken)
    ) {
      this.sendError(socket, "ACCESS_DENIED", "Remote access control credential or request was rejected");
      socket.end();
      return;
    }
    if (message.action === "revoke_subtree") {
      if (typeof message.principalId !== "string" || !isSessionId(message.principalId)) {
        this.sendError(socket, "INVALID_REQUEST", "Invalid remote principal ID");
        socket.end();
        return;
      }
      const priorSessions = Array.from(this.sessions.values(), (session) => session.info);
      const changed = this.accessRegistry.revoke(message.principalId);
      this.disconnectRevokedPrincipals(changed, priorSessions);
      writeMessage(socket, {
        type: "access_control_result",
        requestId: message.requestId,
        action: "revoke_subtree",
        changedPrincipalIds: changed.map((principal) => principal.id),
      });
      socket.end();
      return;
    }
    if (
      message.action !== "issue_enrollment"
      || typeof message.enrollment !== "object"
      || message.enrollment === null
      || Array.isArray(message.enrollment)
    ) {
      this.sendError(socket, "INVALID_REQUEST", "Unknown remote access control action");
      socket.end();
      return;
    }
    const enrollment = message.enrollment as Record<string, unknown>;
    if (
      typeof enrollment.name !== "string"
      || typeof enrollment.parentSessionId !== "string"
      || typeof enrollment.rootSessionId !== "string"
      || typeof enrollment.remoteHostId !== "string"
      || (enrollment.ttlMs !== undefined && (typeof enrollment.ttlMs !== "number" || !Number.isSafeInteger(enrollment.ttlMs)))
      || (enrollment.expiresAt !== undefined && (typeof enrollment.expiresAt !== "number" || !Number.isSafeInteger(enrollment.expiresAt)))
    ) {
      this.sendError(socket, "INVALID_REQUEST", "Invalid remote enrollment request");
      socket.end();
      return;
    }
    const parent = this.sessions.get(enrollment.parentSessionId);
    if (!parent || parent.info.origin === "remote" || enrollment.rootSessionId !== parent.info.id) {
      this.sendError(socket, "ACCESS_DENIED", "Enrollment parent must be an active local root session");
      socket.end();
      return;
    }
    const issued = this.accessRegistry.issueEnrollment({
      name: enrollment.name,
      parentSessionId: parent.info.id,
      rootSessionId: parent.info.id,
      remoteHostId: enrollment.remoteHostId,
      ...(enrollment.expiresAt !== undefined ? { expiresAt: enrollment.expiresAt as number } : {}),
    }, enrollment.ttlMs as number | undefined);
    this.audit.record({
      event: "enrollment_issued",
      outcome: "allowed",
      actorId: parent.info.id,
      targetId: enrollment.name,
      remoteHostId: enrollment.remoteHostId,
      reason: `expires:${issued.expiresAt}`,
    });
    writeMessage(socket, {
      type: "access_control_result",
      requestId: message.requestId,
      action: "issue_enrollment",
      enrollmentToken: issued.enrollmentToken,
      expiresAt: issued.expiresAt,
    });
    socket.end();
  }

  private disconnectRevokedPrincipals(changed: RemotePrincipalRecord[], priorSessions: SessionInfo[]): void {
    const changedIds = new Set(changed.map((principal) => principal.id));
    for (const principal of changed) {
      const live = this.sessions.get(principal.id);
      if (!live) {
        this.audit.record({
          event: "principal_revoked",
          outcome: "allowed",
          actorId: principal.id,
          remoteHostId: principal.remoteHostId,
          generation: principal.generation,
          reason: "OFFLINE",
        });
        continue;
      }
      const subject = priorSessions.find((session) => session.id === principal.id) ?? live.info;
      for (const [recipientId, recipient] of this.sessions) {
        if (
          recipientId !== principal.id
          && !changedIds.has(recipientId)
          && authorizeSessionAction(priorSessions, recipientId, "discover", principal.id).allowed
        ) {
          writeMessage(recipient.socket, { type: "session_left", sessionId: principal.id });
        }
      }
      this.clearPendingDeliveriesForSession(principal.id, live.socket);
      this.clearAskEdgesForSession(principal.id, "authorization_revoked");
      this.sessions.delete(principal.id);
      for (const [key, recent] of this.recentDeliveries) {
        if (recent.from === principal.id || recent.to === principal.id) this.recentDeliveries.delete(key);
      }
      this.audit.record({
        event: "principal_revoked",
        outcome: "allowed",
        actorId: principal.id,
        targetId: subject.parentSessionId,
        remoteHostId: principal.remoteHostId,
        generation: principal.generation,
        reason: "DISCONNECTED",
      });
      live.socket.destroy();
    }
    if (changed.length > 0) this.scheduleShutdownCheck();
  }

  private isCurrentPrincipal(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.info.origin !== "remote") return true;
    try {
      this.accessRegistry.validatePrincipal(sessionId, session.info.generation ?? 0);
      return true;
    } catch {
      return false;
    }
  }

  private isAuthorized(actorId: string, action: PolicyAction, targetId: string): boolean {
    if (!this.isCurrentPrincipal(actorId) || !this.isCurrentPrincipal(targetId)) return false;
    return authorizeSessionAction(
      Array.from(this.sessions.values(), (session) => session.info),
      actorId,
      action,
      targetId,
    ).allowed;
  }

  private broadcastVisible(message: BrokerMessage, subject: SessionInfo, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude && this.isAuthorized(id, "discover", subject.id)) {
        writeMessage(session.socket, message);
      }
    }
  }

  private askKey(fromSessionId: string, messageId: string): string {
    return `${fromSessionId}\u0000${messageId}`;
  }

  private deliveryKey(fromSessionId: string, messageId: string): string {
    return `${fromSessionId}\u0000${messageId}`;
  }

  private addAskEdge(messageId: string, from: string, to: string): void {
    const key = this.askKey(from, messageId);
    const previous = this.askEdges.get(key);
    if (previous) {
      clearTimeout(previous.timeout);
    }
    const createdAt = Date.now();
    const expiresAt = createdAt + this.askTimeoutMs;
    this.askEdges.set(key, {
      messageId,
      from,
      to,
      createdAt,
      expiresAt,
      state: "blocking",
      timeout: this.scheduleAskExpiry(key, expiresAt),
    });
    this.persistAskEdges();
  }

  private removeAskEdge(key: string, reason?: AskCancellationReason, notifyRecipient = false): void {
    const edge = this.askEdges.get(key);
    if (!edge) {
      return;
    }
    clearTimeout(edge.timeout);
    this.askEdges.delete(key);
    this.persistAskEdges();
    if (reason && notifyRecipient) {
      this.notifyAskCancelled(edge.to, edge.messageId, edge.from, reason);
    }
  }

  private notifyAskDeferred(edge: AskEdge): void {
    const recipient = this.sessions.get(edge.to);
    if (recipient) {
      writeMessage(recipient.socket, {
        type: "ask_deferred",
        messageId: edge.messageId,
        fromSessionId: edge.from,
      });
    }
  }

  private notifyAskCancelled(
    sessionId: string,
    messageId: string,
    fromSessionId: string,
    reason: AskCancellationReason,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      writeMessage(session.socket, { type: "ask_cancelled", messageId, fromSessionId, reason });
    }
  }

  private clearAskEdgesForSession(sessionId: string, reason: AskCancellationReason): void {
    let changed = false;
    for (const [key, edge] of this.askEdges) {
      if (edge.from === sessionId || edge.to === sessionId) {
        clearTimeout(edge.timeout);
        this.askEdges.delete(key);
        changed = true;
        if (edge.from === sessionId) {
          this.notifyAskCancelled(edge.to, edge.messageId, edge.from, reason);
        } else {
          this.notifyAskCancelled(edge.from, edge.messageId, edge.to, reason);
        }
      }
    }
    if (changed) {
      this.persistAskEdges();
    }
  }

  private deferAskEdgesForSession(sessionId: string): void {
    let changed = false;
    for (const edge of this.askEdges.values()) {
      if ((edge.from === sessionId || edge.to === sessionId) && edge.state === "blocking") {
        edge.state = "deferred";
        changed = true;
        if (edge.from === sessionId) {
          this.notifyAskDeferred(edge);
        }
      }
    }
    if (changed) {
      this.persistAskEdges();
    }
  }

  private scheduleAskExpiry(key: string, expiresAt: number): NodeJS.Timeout {
    const delay = Math.max(1, Math.min(expiresAt - Date.now(), 2_147_483_647));
    const timeout = setTimeout(() => {
      if (expiresAt > Date.now()) {
        const edge = this.askEdges.get(key);
        if (edge) {
          clearTimeout(edge.timeout);
          edge.timeout = this.scheduleAskExpiry(key, expiresAt);
        }
        return;
      }
      this.removeAskEdge(key, "expired", true);
    }, delay);
    timeout.unref?.();
    return timeout;
  }

  private loadAskEdges(): void {
    if (!existsSync(ASK_STATE_PATH)) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(ASK_STATE_PATH, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("expected an object");
      }
      const state = parsed as Record<string, unknown>;
      if (state.version !== 1) {
        throw new Error("unsupported state version");
      }
      const edges = state.edges;
      if (!Array.isArray(edges)) {
        throw new Error("expected an edges array");
      }

      const now = Date.now();
      for (const candidate of edges) {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
          continue;
        }
        const edge = candidate as Record<string, unknown>;
        if (
          typeof edge.messageId !== "string"
          || edge.messageId.length === 0
          || edge.messageId.length > MAX_MESSAGE_ID_LENGTH
          || !isSessionId(edge.from)
          || !isSessionId(edge.to)
          || typeof edge.createdAt !== "number"
          || !Number.isFinite(edge.createdAt)
          || typeof edge.expiresAt !== "number"
          || !Number.isFinite(edge.expiresAt)
          || edge.expiresAt <= now
          || (edge.state !== "blocking" && edge.state !== "deferred")
        ) {
          continue;
        }

        const key = this.askKey(edge.from, edge.messageId);
        this.askEdges.set(key, {
          messageId: edge.messageId,
          from: edge.from,
          to: edge.to,
          createdAt: edge.createdAt,
          expiresAt: edge.expiresAt,
          state: "deferred",
          timeout: this.scheduleAskExpiry(key, edge.expiresAt),
        });
      }
      this.persistAskEdges();
    } catch (error) {
      console.error(`Failed to load persisted ask state at ${ASK_STATE_PATH}:`, error);
      for (const edge of this.askEdges.values()) {
        clearTimeout(edge.timeout);
      }
      this.askEdges.clear();
      try {
        const corruptPath = `${ASK_STATE_PATH}.corrupt-${Date.now()}`;
        renameSync(ASK_STATE_PATH, corruptPath);
        restrictIntercomRuntimeFile(corruptPath);
      } catch {
        // Keep running with empty state even if the corrupt file cannot be moved.
      }
    }
  }

  private persistAskEdges(): void {
    const edges: PersistedAskEdge[] = Array.from(this.askEdges.values(), (edge) => ({
      messageId: edge.messageId,
      from: edge.from,
      to: edge.to,
      createdAt: edge.createdAt,
      expiresAt: edge.expiresAt,
      state: edge.state,
    }));
    writeDurableJson(ASK_STATE_PATH, { version: 1, edges });
  }

  private countAskEdgesFrom(sessionId: string): number {
    let count = 0;
    for (const edge of this.askEdges.values()) {
      if (edge.from === sessionId) {
        count += 1;
      }
    }
    return count;
  }

  private countPendingDeliveriesFrom(sessionId: string): number {
    let count = 0;
    for (const delivery of this.pendingDeliveries.values()) {
      if (delivery.from === sessionId) {
        count += 1;
      }
    }
    return count;
  }

  private acknowledgePendingDelivery(deliveryId: string, sessionId: string, socket: net.Socket): void {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending || pending.to !== sessionId || pending.recipientSocket !== socket) {
      return;
    }
    const sender = this.sessions.get(pending.from);
    const recipient = this.sessions.get(pending.to);
    if (
      !sender
      || !recipient
      || (sender.info.generation ?? 1) !== pending.fromGeneration
      || (recipient.info.generation ?? 1) !== pending.toGeneration
      || !this.isAuthorized(pending.from, pending.action, pending.to)
    ) {
      this.failPendingDelivery(deliveryId, "SESSION_NOT_FOUND", "Delivery authorization changed before acknowledgement");
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingDeliveries.delete(deliveryId);
    this.pendingDeliveryKeys.delete(pending.key);
    if (pending.message.replyTo) {
      this.removeAskEdge(this.askKey(pending.to, pending.message.replyTo));
    }
    const response = { type: "delivered" as const, messageId: pending.message.id, deliveryId };
    this.recentDeliveries.set(pending.key, {
      fingerprint: pending.fingerprint,
      from: pending.from,
      to: pending.to,
      action: pending.action,
      fromGeneration: pending.fromGeneration,
      toGeneration: pending.toGeneration,
      retryable: false,
      response,
      expiresAt: Date.now() + RECENT_DELIVERY_TTL_MS,
    });
    if (sender.socket === pending.senderSocket) {
      writeMessage(sender.socket, response);
    }
  }

  private failPendingDelivery(deliveryId: string, code: DeliveryFailureCode, reason: string): void {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingDeliveries.delete(deliveryId);
    this.pendingDeliveryKeys.delete(pending.key);
    if (pending.message.expectsReply) {
      this.removeAskEdge(this.askKey(pending.from, pending.message.id), "delivery_failed", true);
    }
    const response = {
      type: "delivery_failed" as const,
      messageId: pending.message.id,
      accepted: true,
      code,
      reason,
    };
    this.recentDeliveries.set(pending.key, {
      fingerprint: pending.fingerprint,
      from: pending.from,
      to: pending.to,
      action: pending.action,
      fromGeneration: pending.fromGeneration,
      toGeneration: pending.toGeneration,
      retryable: true,
      response,
      expiresAt: Date.now() + RECENT_DELIVERY_TTL_MS,
    });
    const sender = this.sessions.get(pending.from);
    if (sender?.socket === pending.senderSocket) {
      writeMessage(sender.socket, response);
    }
  }

  private clearPendingDeliveriesForSession(sessionId: string, socket: net.Socket): void {
    for (const delivery of Array.from(this.pendingDeliveries.values())) {
      if (delivery.to === sessionId && delivery.recipientSocket === socket) {
        this.failPendingDelivery(delivery.id, "RECIPIENT_DISCONNECTED", "Recipient disconnected before acknowledging the message");
      } else if (delivery.from === sessionId && delivery.senderSocket === socket) {
        this.failPendingDelivery(delivery.id, "SENDER_DISCONNECTED", "Sender disconnected before delivery was acknowledged");
      }
    }
  }

  private pruneRecentDeliveries(now = Date.now()): void {
    for (const [key, delivery] of this.recentDeliveries) {
      if (delivery.expiresAt <= now) {
        this.recentDeliveries.delete(key);
      }
    }
  }

  private findSessions(nameOrId: string): ConnectedSession[] {
    const byId = this.sessions.get(nameOrId);
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    const byName = Array.from(this.sessions.values()).filter(session => session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) {
      return byName;
    }

    return Array.from(this.sessions.entries())
      .filter(([id]) => id.startsWith(nameOrId))
      .map(([, session]) => session);
  }

  private shutdown(): void {
    console.log("Broker shutting down");
    
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    for (const delivery of this.pendingDeliveries.values()) {
      clearTimeout(delivery.timeout);
    }
    this.pendingDeliveries.clear();
    this.pendingDeliveryKeys.clear();
    for (const edge of this.askEdges.values()) {
      clearTimeout(edge.timeout);
    }
    this.askEdges.clear();
    const ownsBroker = hasBrokerOwnership(OWNER_PATH);
    if (ownsBroker && typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      for (const socketPath of [LISTEN_TARGET, REMOTE_LISTEN_TARGET]) {
        try {
          unlinkSync(socketPath);
        } catch {
          // The socket may already be gone if shutdown started after a disconnect.
        }
      }
    }
    if (ownsBroker) {
      try {
        unlinkSync(PORT_PATH);
      } catch {
        // The TCP endpoint file only exists when opt-in TCP transport is active.
      }
      try {
        unlinkSync(PID_PATH);
      } catch {
        // The PID file may already be gone if startup never completed.
      }
      releaseBrokerOwnership(OWNER_PATH);
    }
    this.server.close();
    this.remoteServer?.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
