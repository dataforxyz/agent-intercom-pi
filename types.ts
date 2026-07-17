export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  origin?: "local" | "remote";
  remoteHostId?: string;
  parentSessionId?: string;
  rootSessionId?: string;
  generation?: number;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type SessionRegistration = Omit<
  SessionInfo,
  "id" | "peerUid" | "trustedLocal" | "origin" | "remoteHostId" | "parentSessionId" | "rootSessionId" | "generation"
>;

export interface RemoteEnrollmentAccess {
  enrollmentToken: string;
}

export interface RemoteSessionAccess {
  sessionCredential: string;
  sessionId: string;
  generation: number;
}

export type RemoteRegistrationAccess = RemoteEnrollmentAccess | RemoteSessionAccess;

export interface RemoteAccessMetadata {
  origin: "remote";
  remoteHostId: string;
  parentSessionId: string;
  rootSessionId: string;
  generation: number;
  sessionCredential?: string;
}

export interface RemoteAccessContract {
  feature: "remote-access-v1";
  policySemanticsVersion: number;
  policySemanticsHash: string;
}

export type DeliveryFailureCode =
  | "INVALID_MESSAGE"
  | "SESSION_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "SENDER_NOT_FOUND"
  | "INVALID_REPLY_TARGET"
  | "MUTUAL_ASK"
  | "ASK_ALREADY_PENDING"
  | "DUPLICATE_MESSAGE_ID"
  | "CONFLICTING_MESSAGE_ID"
  | "TOO_MANY_PENDING_DELIVERIES"
  | "TOO_MANY_PENDING_ASKS"
  | "RECIPIENT_DISCONNECTED"
  | "SENDER_DISCONNECTED"
  | "DELIVERY_TIMEOUT";

export type BrokerErrorCode =
  | "PROTOCOL_MISMATCH"
  | "INVALID_REQUEST"
  | "ACCESS_DENIED"
  | "REMOTE_ACCESS_INCOMPATIBLE"
  | "RATE_LIMITED"
  | "TOO_MANY_SESSIONS";

export type AskCancellationReason =
  | "cancelled"
  | "expired"
  | "delivery_failed"
  | "session_disconnected";

export type ClientMessage =
  | { type: "health"; requestId: string; stateId?: string }
  | { type: "register"; protocol: string; version: number; session: SessionRegistration; sessionId?: string; stateId?: string; access?: RemoteRegistrationAccess }
  | { type: "access_control"; requestId: string; adminToken: string; action: "issue_enrollment"; enrollment: { name: string; parentSessionId: string; rootSessionId: string; remoteHostId: string; ttlMs?: number; expiresAt?: number } }
  | { type: "unregister"; preserveAsks?: boolean }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "message_received"; deliveryId: string }
  | { type: "message_rejected"; deliveryId: string; code: "CONFLICTING_MESSAGE_ID"; reason: string }
  | { type: "defer_ask"; requestId: string; messageId: string }
  | { type: "cancel_ask"; requestId: string; messageId: string }
  | { type: "presence"; name?: string; status?: string; model?: string };

export type BrokerMessage =
  | { type: "health_ok"; requestId: string; protocol: string; version: number; remoteAccess?: RemoteAccessContract }
  | { type: "registered"; sessionId: string; protocol: string; version: number; remoteAccess?: RemoteAccessContract; access?: RemoteAccessMetadata }
  | { type: "access_control_result"; requestId: string; action: "issue_enrollment"; enrollmentToken: string; expiresAt: number }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; deliveryId: string; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; code: BrokerErrorCode; error: string }
  | { type: "delivery_accepted"; messageId: string; deliveryId: string }
  | { type: "delivered"; messageId: string; deliveryId: string }
  | { type: "delivery_failed"; messageId: string; accepted: boolean; code: DeliveryFailureCode; reason: string }
  | { type: "ask_deferred"; messageId: string; fromSessionId: string }
  | { type: "ask_cancelled"; messageId: string; fromSessionId: string; reason: AskCancellationReason }
  | { type: "ask_control_result"; requestId: string; action: "defer" | "cancel"; messageId: string; applied: boolean };
