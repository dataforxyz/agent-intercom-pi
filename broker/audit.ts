import { closeSync, fsyncSync, openSync, writeSync } from "fs";
import { INTERCOM_RUNTIME_FILE_MODE, restrictIntercomRuntimeFile } from "./paths.ts";

export const BROKER_AUDIT_VERSION = 1;

export type BrokerAuditEvent =
  | "enrollment_issued"
  | "enrollment_consumed"
  | "remote_connect"
  | "remote_reconnect"
  | "remote_disconnect"
  | "remote_registration_denied"
  | "remote_delivery_denied"
  | "credential_reuse_denied"
  | "remote_visibility_filtered"
  | "tree_inspected"
  | "principal_revoked"
  | "principal_expired"
  | "principal_adopted"
  | "generation_fenced";

export interface BrokerAuditEntry {
  event: BrokerAuditEvent;
  outcome: "allowed" | "denied" | "observed";
  actorId?: string;
  targetId?: string;
  remoteHostId?: string;
  generation?: number;
  reason?: string;
  visibleCount?: number;
  hiddenCount?: number;
}

export class BrokerAuditLog {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  record(entry: BrokerAuditEntry): void {
    const line = `${JSON.stringify({
      version: BROKER_AUDIT_VERSION,
      timestamp: this.now(),
      ...entry,
    })}\n`;
    const descriptor = openSync(this.path, "a", INTERCOM_RUNTIME_FILE_MODE);
    try {
      writeSync(descriptor, line, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    restrictIntercomRuntimeFile(this.path);
  }

  tryRecord(entry: BrokerAuditEntry): void {
    try {
      this.record(entry);
    } catch (error) {
      console.error("Failed to append Agent Intercom broker audit event:", error);
    }
  }
}
