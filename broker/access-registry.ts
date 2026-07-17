import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { existsSync, readFileSync } from "fs";
import { writeDurableJson } from "../durable-json.ts";
import { restrictIntercomRuntimeFile } from "./paths.ts";

export const REMOTE_ACCESS_STATE_VERSION = 1;
export const REMOTE_ACCESS_CREDENTIAL_VERSION = 1;
export const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PRINCIPAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type RemotePrincipalState = "active" | "revoked";
export type RemotePrincipalPolicy = "remote-parent";

export interface RemotePrincipalRecord {
  id: string;
  name: string;
  credentialHash: string;
  parentSessionId: string;
  rootSessionId: string;
  remoteHostId: string;
  generation: number;
  policy: RemotePrincipalPolicy;
  state: RemotePrincipalState;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnrollmentTemplate {
  name: string;
  parentSessionId: string;
  rootSessionId: string;
  remoteHostId: string;
  expiresAt?: number;
}

export interface EnrollmentRecord {
  tokenHash: string;
  template: EnrollmentTemplate;
  expiresAt: number;
  createdAt: number;
}

export interface RemoteAccessState {
  version: typeof REMOTE_ACCESS_STATE_VERSION;
  adminCredentialHash?: string;
  principals: Record<string, RemotePrincipalRecord>;
  enrollments: Record<string, EnrollmentRecord>;
}

export interface IssuedEnrollment {
  enrollmentToken: string;
  expiresAt: number;
}

export interface ConsumedEnrollment {
  principal: RemotePrincipalRecord;
  sessionCredential: string;
}

export interface PersistedAdminCredential {
  version: typeof REMOTE_ACCESS_CREDENTIAL_VERSION;
  adminToken: string;
}

export class RemoteAccessError extends Error {
  constructor(
    readonly code: "INVALID_CREDENTIAL" | "EXPIRED_CREDENTIAL" | "REVOKED_CREDENTIAL" | "STALE_GENERATION" | "INVALID_ENROLLMENT",
    message: string,
  ) {
    super(message);
    this.name = "RemoteAccessError";
  }
}

function emptyState(): RemoteAccessState {
  return { version: REMOTE_ACCESS_STATE_VERSION, principals: {}, enrollments: {} };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secretsMatch(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function requireText(value: string, field: string, maxLength = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes("\0")) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}

function parseState(raw: unknown): RemoteAccessState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("expected object");
  const state = raw as Record<string, unknown>;
  if (state.version !== REMOTE_ACCESS_STATE_VERSION) throw new Error("unsupported version");
  if (typeof state.principals !== "object" || state.principals === null || Array.isArray(state.principals)) throw new Error("invalid principals");
  if (typeof state.enrollments !== "object" || state.enrollments === null || Array.isArray(state.enrollments)) throw new Error("invalid enrollments");
  if (state.adminCredentialHash !== undefined && typeof state.adminCredentialHash !== "string") throw new Error("invalid admin credential hash");
  return raw as RemoteAccessState;
}

export class RemoteAccessRegistry {
  private state: RemoteAccessState;

  constructor(private readonly statePath: string, private readonly now: () => number = Date.now) {
    this.state = this.load();
  }

  snapshot(): RemoteAccessState {
    return structuredClone(this.state);
  }

  ensureAdminCredential(credentialPath: string): string {
    if (existsSync(credentialPath)) {
      const parsed = JSON.parse(readFileSync(credentialPath, "utf8")) as Partial<PersistedAdminCredential>;
      if (parsed.version === REMOTE_ACCESS_CREDENTIAL_VERSION && typeof parsed.adminToken === "string" && parsed.adminToken.length >= 32) {
        const hash = hashSecret(parsed.adminToken);
        if (this.state.adminCredentialHash !== hash) {
          this.state.adminCredentialHash = hash;
          this.persist();
        }
        restrictIntercomRuntimeFile(credentialPath);
        return parsed.adminToken;
      }
    }
    const adminToken = newSecret();
    writeDurableJson(credentialPath, { version: REMOTE_ACCESS_CREDENTIAL_VERSION, adminToken });
    this.state.adminCredentialHash = hashSecret(adminToken);
    this.persist();
    return adminToken;
  }

  authenticateAdmin(adminToken: string): boolean {
    return typeof this.state.adminCredentialHash === "string" && secretsMatch(adminToken, this.state.adminCredentialHash);
  }

  issueEnrollment(template: EnrollmentTemplate, ttlMs = DEFAULT_ENROLLMENT_TTL_MS): IssuedEnrollment {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) throw new Error("Invalid enrollment TTL");
    const now = this.now();
    const enrollmentToken = newSecret();
    const tokenHash = hashSecret(enrollmentToken);
    const expiresAt = now + ttlMs;
    const principalExpiresAt = template.expiresAt ?? now + DEFAULT_PRINCIPAL_TTL_MS;
    if (!Number.isSafeInteger(principalExpiresAt) || principalExpiresAt <= now) throw new Error("Invalid principal expiry");
    const normalized: EnrollmentTemplate = {
      name: requireText(template.name, "principal name", 256),
      parentSessionId: requireText(template.parentSessionId, "parent session ID"),
      rootSessionId: requireText(template.rootSessionId, "root session ID"),
      remoteHostId: requireText(template.remoteHostId, "remote host ID", 256),
      expiresAt: principalExpiresAt,
    };
    this.pruneExpiredEnrollments(now);
    this.state.enrollments[tokenHash] = { tokenHash, template: normalized, expiresAt, createdAt: now };
    this.persist();
    return { enrollmentToken, expiresAt };
  }

  consumeEnrollment(enrollmentToken: string): ConsumedEnrollment {
    const now = this.now();
    const tokenHash = hashSecret(enrollmentToken);
    const enrollment = this.state.enrollments[tokenHash];
    if (!enrollment) throw new RemoteAccessError("INVALID_ENROLLMENT", "Enrollment credential is invalid or already consumed");
    delete this.state.enrollments[tokenHash];
    if (enrollment.expiresAt <= now) {
      this.persist();
      throw new RemoteAccessError("INVALID_ENROLLMENT", "Enrollment credential has expired");
    }
    const sessionCredential = newSecret();
    const id = randomUUID();
    const principal: RemotePrincipalRecord = {
      id,
      name: enrollment.template.name,
      credentialHash: hashSecret(sessionCredential),
      parentSessionId: enrollment.template.parentSessionId,
      rootSessionId: enrollment.template.rootSessionId,
      remoteHostId: enrollment.template.remoteHostId,
      generation: 1,
      policy: "remote-parent",
      state: "active",
      expiresAt: enrollment.template.expiresAt!,
      createdAt: now,
      updatedAt: now,
    };
    this.state.principals[id] = principal;
    this.persist();
    return { principal: structuredClone(principal), sessionCredential };
  }

  authenticateSession(sessionId: string, generation: number, sessionCredential: string): RemotePrincipalRecord {
    const principal = this.state.principals[sessionId];
    if (!principal || !secretsMatch(sessionCredential, principal.credentialHash)) {
      throw new RemoteAccessError("INVALID_CREDENTIAL", "Session credential is invalid");
    }
    return this.validatePrincipal(sessionId, generation);
  }

  validatePrincipal(sessionId: string, generation: number): RemotePrincipalRecord {
    const principal = this.state.principals[sessionId];
    if (!principal) throw new RemoteAccessError("INVALID_CREDENTIAL", "Remote principal does not exist");
    if (principal.state !== "active") throw new RemoteAccessError("REVOKED_CREDENTIAL", "Session credential is revoked");
    if (principal.expiresAt <= this.now()) throw new RemoteAccessError("EXPIRED_CREDENTIAL", "Session credential has expired");
    if (principal.generation !== generation) throw new RemoteAccessError("STALE_GENERATION", "Session credential generation is stale");
    return structuredClone(principal);
  }

  revoke(principalId: string): RemotePrincipalRecord[] {
    const now = this.now();
    const queue = [principalId];
    const seen = new Set<string>();
    const changed: RemotePrincipalRecord[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const principal = this.state.principals[id];
      if (!principal) continue;
      principal.state = "revoked";
      principal.generation += 1;
      principal.updatedAt = now;
      changed.push(structuredClone(principal));
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    if (changed.length) this.persist();
    return changed;
  }

  private pruneExpiredEnrollments(now = this.now()): void {
    for (const [hash, enrollment] of Object.entries(this.state.enrollments)) {
      if (enrollment.expiresAt <= now) delete this.state.enrollments[hash];
    }
  }

  private load(): RemoteAccessState {
    if (!existsSync(this.statePath)) return emptyState();
    try {
      return parseState(JSON.parse(readFileSync(this.statePath, "utf8")));
    } catch (error) {
      throw new Error(`Invalid remote access registry at ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    writeDurableJson(this.statePath, this.state);
  }
}
