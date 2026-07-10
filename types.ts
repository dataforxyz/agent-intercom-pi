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

export type SessionRegistration = Omit<SessionInfo, "id" | "peerUid" | "trustedLocal">;

export type DeliveryFailureCode =
  | "INVALID_MESSAGE"
  | "SESSION_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "SENDER_NOT_FOUND"
  | "INVALID_REPLY_TARGET"
  | "MUTUAL_ASK"
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
  | "RATE_LIMITED"
  | "TOO_MANY_SESSIONS";

export type AskCancellationReason =
  | "cancelled"
  | "expired"
  | "delivery_failed"
  | "session_disconnected";

export type ClientMessage =
  | { type: "register"; protocol: string; version: number; session: SessionRegistration; sessionId?: string; stateId?: string }
  | { type: "unregister"; preserveAsks?: boolean }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "message_received"; deliveryId: string }
  | { type: "message_rejected"; deliveryId: string; code: "CONFLICTING_MESSAGE_ID"; reason: string }
  | { type: "defer_ask"; requestId: string; messageId: string }
  | { type: "cancel_ask"; requestId: string; messageId: string }
  | { type: "presence"; name?: string; status?: string; model?: string };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; protocol: string; version: number }
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
