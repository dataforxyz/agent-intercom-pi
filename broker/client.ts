import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { POLICY_SEMANTICS_HASH, POLICY_SEMANTICS_VERSION } from "@dataforxyz/agent-intercom-core";
import { writeMessage, createMessageReader } from "./framing.ts";
import { PersistentOutboundOutbox } from "../outbound-outbox.ts";
import { loadRemoteAccessCredential, writeRemoteSessionCredential, type LoadedRemoteAccessCredential } from "./access-credential.ts";
import {
  getBrokerConnectTarget,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  type BrokerConnectTarget,
} from "./paths.ts";
import type {
  AskCancellationReason,
  DeliveryFailureCode,
  SessionInfo,
  Message,
  Attachment,
  SessionRegistration,
} from "../types.ts";

export interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
}

export interface SendResult {
  id: string;
  accepted: boolean;
  delivered: boolean;
  deliveryId?: string;
  code?: DeliveryFailureCode;
  reason?: string;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function connectToBrokerTarget(target: BrokerConnectTarget): net.Socket {
  return typeof target === "string"
    ? net.connect(target)
    : net.connect({ host: target.host, port: target.port });
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

  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }

  return attachment.language === undefined || typeof attachment.language === "string";
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }

  if (message.replyTo !== undefined && typeof message.replyTo !== "string") {
    return false;
  }

  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") {
    return false;
  }

  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }

  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") {
    return false;
  }

  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.id !== "string"
    || typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }

  if (session.status !== undefined && typeof session.status !== "string") {
    return false;
  }

  if (session.peerUid !== undefined && typeof session.peerUid !== "number") {
    return false;
  }

  if (session.trustedLocal !== undefined && typeof session.trustedLocal !== "boolean") return false;
  if (session.origin !== undefined && session.origin !== "local" && session.origin !== "remote") return false;
  if (session.remoteHostId !== undefined && typeof session.remoteHostId !== "string") return false;
  if (session.parentSessionId !== undefined && typeof session.parentSessionId !== "string") return false;
  if (session.rootSessionId !== undefined && typeof session.rootSessionId !== "string") return false;
  return session.generation === undefined || (typeof session.generation === "number" && Number.isSafeInteger(session.generation));
}

function isRemoteAccessMetadata(value: unknown): value is import("../types.ts").RemoteAccessMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const access = value as Record<string, unknown>;
  return access.origin === "remote"
    && typeof access.remoteHostId === "string"
    && typeof access.parentSessionId === "string"
    && typeof access.rootSessionId === "string"
    && typeof access.generation === "number"
    && Number.isSafeInteger(access.generation)
    && access.generation > 0
    && (access.sessionCredential === undefined || typeof access.sessionCredential === "string");
}

export class IntercomClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private pendingSends = new Map<string, {
    accepted: boolean;
    deliveryId?: string;
    resolve: (r: SendResult) => void;
    reject: (e: Error) => void;
  }>();
  private pendingLists = new Map<string, { resolve: (sessions: SessionInfo[]) => void; reject: (e: Error) => void }>();
  private pendingAskControls = new Map<string, { resolve: (applied: boolean) => void; timeout: NodeJS.Timeout }>();
  private outbox: PersistentOutboundOutbox | null = null;
  private remoteAccessCredential: LoadedRemoteAccessCredential | undefined;
  private disconnecting = false;
  private disconnectError: Error | null = null;

  private failPending(error: Error): void {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error);
    }
    this.pendingLists.clear();
    for (const pending of this.pendingAskControls.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingAskControls.clear();
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get outboxSize(): number {
    return this.outbox?.list().length ?? 0;
  }

  isConnected(): boolean {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }

  private requireActiveSocket(): net.Socket {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }

    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }

    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }

    return socket;
  }

  connect(session: SessionRegistration, sessionId?: string): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }

    return new Promise((resolve, reject) => {
      let socket: net.Socket;
      let target: BrokerConnectTarget;
      try {
        target = getBrokerConnectTarget();
        this.remoteAccessCredential = loadRemoteAccessCredential();
        socket = connectToBrokerTarget(target);
      } catch (error) {
        reject(toError(error));
        return;
      }
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 10000);
      
      let connectionEstablished = false;
      
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve();
      };
      
      const onError = (err: Error) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };

      const onSocketError = (err: Error) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
        }
      };

      const onReaderError = (error: Error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };

      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };

      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      
      try {
        writeMessage(socket, {
          type: "register",
          protocol: INTERCOM_PROTOCOL_NAME,
          version: INTERCOM_PROTOCOL_VERSION,
          session,
          ...(!this.remoteAccessCredential && sessionId ? { sessionId } : {}),
          ...(this.remoteAccessCredential ? { access: this.remoteAccessCredential.access } : {}),
          ...(typeof target === "string" ? {} : { stateId: target.stateId }),
        });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }

  private handleBrokerMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }

    const brokerMessage = msg as { type: string } & Record<string, unknown>;

    if (this._sessionId === null && brokerMessage.type !== "registered" && brokerMessage.type !== "error") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }

    switch (brokerMessage.type) {
      case "registered": {
        if (
          typeof brokerMessage.sessionId !== "string"
          || brokerMessage.protocol !== INTERCOM_PROTOCOL_NAME
          || brokerMessage.version !== INTERCOM_PROTOCOL_VERSION
        ) {
          throw new Error("Invalid registered message");
        }

        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }

        if (this.remoteAccessCredential) {
          const contract = brokerMessage.remoteAccess;
          const contractFields = typeof contract === "object" && contract !== null
            ? contract as Record<string, unknown>
            : undefined;
          if (
            !contractFields
            || contractFields.feature !== "remote-access-v1"
            || contractFields.policySemanticsVersion !== POLICY_SEMANTICS_VERSION
            || contractFields.policySemanticsHash !== POLICY_SEMANTICS_HASH
          ) {
            throw new Error("Remote Intercom policy contract is absent or incompatible");
          }
          if (!isRemoteAccessMetadata(brokerMessage.access)) {
            throw new Error("Remote Intercom registration omitted broker-owned provenance");
          }
          if (this.remoteAccessCredential.enrollment) {
            writeRemoteSessionCredential(this.remoteAccessCredential.path, brokerMessage.sessionId, brokerMessage.access);
          } else {
            const reconnect = this.remoteAccessCredential.access;
            if (!("sessionId" in reconnect) || reconnect.sessionId !== brokerMessage.sessionId || reconnect.generation !== brokerMessage.access.generation) {
              throw new Error("Remote Intercom reconnect identity or generation changed unexpectedly");
            }
          }
        }

        this._sessionId = brokerMessage.sessionId;
        this.outbox = new PersistentOutboundOutbox(brokerMessage.sessionId);
        this.replayOutbox();
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }

      case "sessions": {
        const { requestId, sessions } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
          throw new Error("Invalid sessions message");
        }

        const pending = this.pendingLists.get(requestId);
        if (!pending) {
          // Late list responses can still arrive after the caller has already timed out.
          return;
        }

        this.pendingLists.delete(requestId);
        pending.resolve(sessions);
        break;
      }

      case "message": {
        const { deliveryId, from, message } = brokerMessage;
        if (typeof deliveryId !== "string" || !isSessionInfo(from) || !isMessage(message)) {
          throw new Error("Invalid message event");
        }

        this.emit("message", from, message, deliveryId);
        break;
      }

      case "delivery_accepted": {
        const { deliveryId, messageId } = brokerMessage;
        if (typeof deliveryId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid delivery_accepted message");
        }

        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          return;
        }
        pending.accepted = true;
        pending.deliveryId = deliveryId;
        this.emit("delivery_accepted", messageId, deliveryId);
        break;
      }

      case "delivered": {
        const { deliveryId, messageId } = brokerMessage;
        if (typeof deliveryId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid delivered message");
        }

        this.outbox?.remove(messageId);
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          this.emit("outbox_delivered", messageId, deliveryId);
          return;
        }

        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, accepted: true, delivered: true, deliveryId });
        break;
      }

      case "delivery_failed": {
        const { accepted, code, messageId, reason } = brokerMessage;
        if (
          typeof accepted !== "boolean"
          || typeof code !== "string"
          || typeof messageId !== "string"
          || typeof reason !== "string"
        ) {
          throw new Error("Invalid delivery_failed message");
        }

        this.outbox?.remove(messageId);
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          this.emit("outbox_failed", messageId, code, reason);
          return;
        }

        this.pendingSends.delete(messageId);
        pending.resolve({
          id: messageId,
          accepted,
          delivered: false,
          code: code as DeliveryFailureCode,
          reason,
          ...(pending.deliveryId ? { deliveryId: pending.deliveryId } : {}),
        });
        break;
      }

      case "ask_deferred": {
        const { fromSessionId, messageId } = brokerMessage;
        if (typeof fromSessionId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid ask_deferred message");
        }
        this.emit("ask_deferred", messageId, fromSessionId);
        break;
      }

      case "ask_cancelled": {
        const { fromSessionId, messageId, reason } = brokerMessage;
        if (typeof fromSessionId !== "string" || typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid ask_cancelled message");
        }
        this.emit("ask_cancelled", messageId, fromSessionId, reason as AskCancellationReason);
        break;
      }

      case "ask_control_result": {
        const { action, applied, messageId, requestId } = brokerMessage;
        if (
          (action !== "defer" && action !== "cancel")
          || typeof applied !== "boolean"
          || typeof messageId !== "string"
          || typeof requestId !== "string"
        ) {
          throw new Error("Invalid ask_control_result message");
        }
        const pending = this.pendingAskControls.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingAskControls.delete(requestId);
        pending.resolve(applied);
        break;
      }

      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }

        this.emit("session_joined", brokerMessage.session);
        break;
      }

      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }

        this.emit("session_left", brokerMessage.sessionId);
        break;
      }

      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }

        this.emit("presence_update", brokerMessage.session);
        break;
      }

      case "error": {
        if (typeof brokerMessage.code !== "string" || typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }

        if (this._sessionId === null) {
          const error = new Error(brokerMessage.error) as Error & { code?: string };
          error.code = brokerMessage.code;
          throw error;
        }
        const error = new Error(brokerMessage.error) as Error & { code?: string };
        error.code = brokerMessage.code;
        this.emit("error", error);
        break;
      }

      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }

  async disconnect(preserveAsks = false): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new Error("Client disconnected"));
    if (!preserveAsks) this.outbox?.clear();

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2000);

      socket.once("close", onClose);
      socket.once("error", onError);

      try {
        writeMessage(socket, { type: "unregister", ...(preserveAsks ? { preserveAsks: true } : {}) });
        socket.end();
      } catch {
        // Disconnect should still finish even if the unregister write fails.
        socket.destroy();
      }
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const wrappedResolve = (sessions: SessionInfo[]) => {
        clearTimeout(timeout);
        resolve(sessions);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, 5000);
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  }

  send(to: string, options: SendOptions): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    
    const messageId = options.messageId ?? randomUUID();
    if (this.pendingSends.has(messageId)) {
      return Promise.resolve({
        id: messageId,
        accepted: false,
        delivered: false,
        code: "DUPLICATE_MESSAGE_ID",
        reason: `Message ID ${messageId} is already pending`,
      });
    }
    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: {
        text: options.text,
        attachments: options.attachments,
      },
    };

    try {
      this.outbox?.enqueue(to, message);
    } catch (error) {
      return Promise.reject(toError(error));
    }

    return new Promise((resolve, reject) => {
      const wrappedResolve = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, 10000);
      this.pendingSends.set(messageId, {
        accepted: false,
        resolve: wrappedResolve,
        reject: wrappedReject,
      });

      try {
        writeMessage(socket, { type: "send", to, message });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }

  acknowledgeMessage(deliveryId: string): boolean {
    return this.writeControlMessage({ type: "message_received", deliveryId });
  }

  rejectMessage(deliveryId: string, reason: string): boolean {
    return this.writeControlMessage({ type: "message_rejected", deliveryId, code: "CONFLICTING_MESSAGE_ID", reason });
  }

  deferAsk(messageId: string): Promise<boolean> {
    return this.sendAskControl("defer", messageId);
  }

  cancelAsk(messageId: string): Promise<boolean> {
    return this.sendAskControl("cancel", messageId);
  }

  private sendAskControl(action: "defer" | "cancel", messageId: string): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingAskControls.delete(requestId);
        resolve(false);
      }, 2000);
      timeout.unref?.();
      this.pendingAskControls.set(requestId, { resolve, timeout });
      if (!this.writeControlMessage({ type: action === "defer" ? "defer_ask" : "cancel_ask", requestId, messageId })) {
        clearTimeout(timeout);
        this.pendingAskControls.delete(requestId);
        resolve(false);
      }
    });
  }

  private writeControlMessage(message: Record<string, unknown>): boolean {
    if (this.disconnecting) {
      return false;
    }

    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return false;
    }

    try {
      writeMessage(socket, message);
      return true;
    } catch {
      // Control messages are best-effort; local cleanup must still proceed.
      return false;
    }
  }

  private replayOutbox(): void {
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) return;
    for (const entry of this.outbox?.list() ?? []) {
      if (this.pendingSends.has(entry.message.id)) continue;
      try {
        writeMessage(socket, { type: "send", to: entry.to, message: entry.message });
      } catch {
        return;
      }
    }
  }

  updatePresence(updates: { name?: string; status?: string; model?: string }): void {
    if (this.disconnecting) {
      return;
    }

    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }

    writeMessage(socket, { type: "presence", ...updates });
  }
}
