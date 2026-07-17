import { readFileSync } from "fs";
import { writeDurableJson } from "../durable-json.ts";
import type { RemoteAccessMetadata, RemoteRegistrationAccess } from "../types.ts";

export const ACCESS_CREDENTIAL_ENV = "AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH";
export const ACCESS_CREDENTIAL_VERSION = 1;

export interface EnrollmentCredentialFile {
  version?: typeof ACCESS_CREDENTIAL_VERSION;
  enrollmentToken: string;
}

export interface SessionCredentialFile {
  version: typeof ACCESS_CREDENTIAL_VERSION;
  sessionCredential: string;
  sessionId: string;
  generation: number;
}

export interface LoadedRemoteAccessCredential {
  path: string;
  access: RemoteRegistrationAccess;
  enrollment: boolean;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function loadRemoteAccessCredential(env: NodeJS.ProcessEnv = process.env): LoadedRemoteAccessCredential | undefined {
  const path = env[ACCESS_CREDENTIAL_ENV]?.trim();
  if (!path) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Agent Intercom access credential at ${path}`);
  }
  const credential = parsed as Record<string, unknown>;
  if (nonEmptyString(credential.enrollmentToken)) {
    return { path, access: { enrollmentToken: credential.enrollmentToken }, enrollment: true };
  }
  if (
    credential.version === ACCESS_CREDENTIAL_VERSION
    && nonEmptyString(credential.sessionCredential)
    && nonEmptyString(credential.sessionId)
    && typeof credential.generation === "number"
    && Number.isSafeInteger(credential.generation)
    && credential.generation > 0
  ) {
    return {
      path,
      access: {
        sessionCredential: credential.sessionCredential,
        sessionId: credential.sessionId,
        generation: credential.generation,
      },
      enrollment: false,
    };
  }
  throw new Error(`Invalid Agent Intercom access credential at ${path}`);
}

export function writeRemoteSessionCredential(
  path: string,
  sessionId: string,
  metadata: RemoteAccessMetadata,
): void {
  if (!metadata.sessionCredential) {
    throw new Error("Remote enrollment response omitted the session credential");
  }
  writeDurableJson(path, {
    version: ACCESS_CREDENTIAL_VERSION,
    sessionCredential: metadata.sessionCredential,
    sessionId,
    generation: metadata.generation,
  } satisfies SessionCredentialFile);
}
