import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { existsSync, readFileSync } from "fs";
import { writeDurableJson } from "../durable-json.ts";
import { restrictIntercomRuntimeFile } from "./paths.ts";

export const REMOTE_ACCESS_STATE_VERSION = 2;
export const REMOTE_ACCESS_CREDENTIAL_VERSION = 1;
export const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PRINCIPAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type RemotePrincipalState = "active" | "revoked";
export type RemotePrincipalPolicy = "remote-tree";

export interface RemotePrincipalRecord {
  id: string;
  name: string;
  credentialHash: string;
  parentSessionId: string;
  rootSessionId: string;
  remoteHostId: string;
  generation: number;
  policy: RemotePrincipalPolicy;
  canDelegate: boolean;
  depth: number;
  maxDepth: number;
  maxChildren: number;
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
  canDelegate?: boolean;
  depth?: number;
  maxDepth?: number;
  maxChildren?: number;
}

export interface ChildEnrollmentRequest {
  name: string;
  expiresAt?: number;
  canDelegate?: boolean;
  maxDepth?: number;
  maxChildren?: number;
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

export type RemotePrincipalMetadata = Omit<RemotePrincipalRecord, "credentialHash">;

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
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}

function boundedInteger(value: number | undefined, fallback: number, field: string, minimum: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new Error(`Invalid ${field}`);
  return resolved;
}

function parseState(raw: unknown): RemoteAccessState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("expected object");
  const state = raw as Record<string, unknown>;
  if (state.version !== 1 && state.version !== REMOTE_ACCESS_STATE_VERSION) throw new Error("unsupported version");
  if (typeof state.principals !== "object" || state.principals === null || Array.isArray(state.principals)) throw new Error("invalid principals");
  if (typeof state.enrollments !== "object" || state.enrollments === null || Array.isArray(state.enrollments)) throw new Error("invalid enrollments");
  if (state.adminCredentialHash !== undefined && typeof state.adminCredentialHash !== "string") throw new Error("invalid admin credential hash");
  const principals: Record<string, RemotePrincipalRecord> = {};
  for (const [id, value] of Object.entries(state.principals as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid principal ${id}`);
    const principal = value as Record<string, unknown>;
    if (
      principal.id !== id
      || typeof principal.name !== "string"
      || typeof principal.credentialHash !== "string"
      || typeof principal.parentSessionId !== "string"
      || typeof principal.rootSessionId !== "string"
      || typeof principal.remoteHostId !== "string"
      || typeof principal.generation !== "number"
      || (principal.state !== "active" && principal.state !== "revoked")
      || typeof principal.expiresAt !== "number"
      || typeof principal.createdAt !== "number"
      || typeof principal.updatedAt !== "number"
    ) throw new Error(`invalid principal ${id}`);
    const depth = boundedInteger(principal.depth as number | undefined, 1, "principal depth", 1, 32);
    const maxDepth = boundedInteger(principal.maxDepth as number | undefined, depth, "maximum delegation depth", depth, 32);
    const maxChildren = boundedInteger(principal.maxChildren as number | undefined, 0, "maximum child count", 0, 128);
    principals[id] = {
      ...(principal as unknown as RemotePrincipalRecord),
      policy: "remote-tree",
      canDelegate: principal.canDelegate === true,
      depth,
      maxDepth,
      maxChildren,
    };
  }
  const enrollments: Record<string, EnrollmentRecord> = {};
  for (const [hash, value] of Object.entries(state.enrollments as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid enrollment ${hash}`);
    const enrollment = value as EnrollmentRecord;
    const template = enrollment.template;
    if (!template || typeof template !== "object") throw new Error(`invalid enrollment ${hash}`);
    const depth = boundedInteger(template.depth, 1, "enrollment depth", 1, 32);
    enrollments[hash] = {
      ...enrollment,
      template: {
        ...template,
        canDelegate: template.canDelegate === true,
        depth,
        maxDepth: boundedInteger(template.maxDepth, depth, "enrollment maximum depth", depth, 32),
        maxChildren: boundedInteger(template.maxChildren, 0, "enrollment maximum children", 0, 128),
      },
    };
  }
  return {
    version: REMOTE_ACCESS_STATE_VERSION,
    ...(typeof state.adminCredentialHash === "string" ? { adminCredentialHash: state.adminCredentialHash } : {}),
    principals,
    enrollments,
  };
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
    const depth = boundedInteger(template.depth, 1, "principal depth", 1, 32);
    const maxDepth = boundedInteger(template.maxDepth, depth, "maximum delegation depth", depth, 32);
    const maxChildren = boundedInteger(template.maxChildren, 0, "maximum child count", 0, 128);
    const canDelegate = template.canDelegate === true;
    if (canDelegate && (maxDepth <= depth || maxChildren === 0)) throw new Error("Delegating principals require remaining depth and child capacity");
    const normalized: EnrollmentTemplate = {
      name: requireText(template.name, "principal name", 256),
      parentSessionId: requireText(template.parentSessionId, "parent session ID"),
      rootSessionId: requireText(template.rootSessionId, "root session ID"),
      remoteHostId: requireText(template.remoteHostId, "remote host ID", 256),
      expiresAt: principalExpiresAt,
      canDelegate,
      depth,
      maxDepth,
      maxChildren,
    };
    this.pruneExpiredEnrollments(now);
    this.state.enrollments[tokenHash] = { tokenHash, template: normalized, expiresAt, createdAt: now };
    this.persist();
    return { enrollmentToken, expiresAt };
  }

  issueChildEnrollment(
    parentSessionId: string,
    parentGeneration: number,
    request: ChildEnrollmentRequest,
    ttlMs = DEFAULT_ENROLLMENT_TTL_MS,
  ): IssuedEnrollment {
    const parent = this.validatePrincipal(parentSessionId, parentGeneration);
    if (!parent.canDelegate) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent principal cannot delegate children");
    const now = this.now();
    const activeChildren = Object.values(this.state.principals).filter((principal) =>
      principal.parentSessionId === parent.id && principal.state === "active" && principal.expiresAt > now
    ).length;
    const pendingChildren = Object.values(this.state.enrollments).filter((enrollment) =>
      enrollment.template.parentSessionId === parent.id && enrollment.expiresAt > now
    ).length;
    if (activeChildren + pendingChildren >= parent.maxChildren) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent child limit is exhausted");
    const depth = parent.depth + 1;
    if (depth > parent.maxDepth) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent delegation depth is exhausted");
    const maxDepth = boundedInteger(request.maxDepth, depth, "child maximum depth", depth, parent.maxDepth);
    const maxChildren = boundedInteger(request.maxChildren, 0, "child maximum count", 0, parent.maxChildren);
    const canDelegate = request.canDelegate === true;
    if (canDelegate && (maxDepth <= depth || maxChildren === 0)) throw new Error("Delegating child requires remaining depth and child capacity");
    const expiresAt = request.expiresAt ?? parent.expiresAt;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > parent.expiresAt) {
      throw new Error("Child expiry must not exceed the parent expiry");
    }
    return this.issueEnrollment({
      name: request.name,
      parentSessionId: parent.id,
      rootSessionId: parent.rootSessionId,
      remoteHostId: parent.remoteHostId,
      expiresAt,
      canDelegate,
      depth,
      maxDepth,
      maxChildren,
    }, ttlMs);
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
      policy: "remote-tree",
      canDelegate: enrollment.template.canDelegate === true,
      depth: enrollment.template.depth!,
      maxDepth: enrollment.template.maxDepth!,
      maxChildren: enrollment.template.maxChildren!,
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

  inspectSubtree(principalId: string): RemotePrincipalMetadata[] {
    const result: RemotePrincipalMetadata[] = [];
    const queue = [principalId];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const principal = this.state.principals[id];
      if (!principal) continue;
      const { credentialHash: _credentialHash, ...metadata } = principal;
      result.push(structuredClone(metadata));
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    return result;
  }

  adoptSubtree(principalId: string, newParentSessionId: string, newRootSessionId: string): RemotePrincipalRecord[] {
    const principal = this.state.principals[principalId];
    if (!principal) throw new Error("Unknown adopted principal");
    if (principalId === newParentSessionId) throw new Error("Adoption would create an ownership cycle");
    let ancestor = this.state.principals[newParentSessionId];
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      if (ancestor.id === principalId) throw new Error("Adoption would create an ownership cycle");
      seen.add(ancestor.id);
      ancestor = this.state.principals[ancestor.parentSessionId];
    }
    const ids = this.subtreePrincipalIds(principalId);
    const now = this.now();
    principal.parentSessionId = requireText(newParentSessionId, "new parent session ID");
    for (const id of ids) {
      const changed = this.state.principals[id];
      changed.rootSessionId = requireText(newRootSessionId, "new root session ID");
      changed.generation += 1;
      changed.updatedAt = now;
    }
    const changedIds = new Set(ids);
    for (const [hash, enrollment] of Object.entries(this.state.enrollments)) {
      if (changedIds.has(enrollment.template.parentSessionId)) delete this.state.enrollments[hash];
    }
    this.persist();
    return ids.map((id) => structuredClone(this.state.principals[id]));
  }

  expirePrincipals(now = this.now()): RemotePrincipalRecord[] {
    const changed = new Map<string, RemotePrincipalRecord>();
    const expiredRoots = Object.values(this.state.principals)
      .filter((principal) => principal.state === "active" && principal.expiresAt <= now)
      .sort((left, right) => left.depth - right.depth);
    for (const principal of expiredRoots) {
      if (changed.has(principal.id)) continue;
      for (const revoked of this.revoke(principal.id)) changed.set(revoked.id, revoked);
    }
    return [...changed.values()];
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

  private subtreePrincipalIds(principalId: string): string[] {
    const result: string[] = [];
    const queue = [principalId];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id) || !this.state.principals[id]) continue;
      seen.add(id);
      result.push(id);
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    return result;
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
