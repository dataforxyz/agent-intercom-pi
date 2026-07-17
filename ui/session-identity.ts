import type { SessionInfo } from "../types.ts";

const ANSI_SEQUENCE = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/g;

/** Make untrusted presence metadata safe to place directly in a terminal UI. */
export function sanitizeDisplayText(value: string | undefined, fallback = ""): string {
  const sanitized = (value ?? "")
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback;
}

/**
 * Return the shortest prefix which distinguishes every ID in the collection.
 * A small floor keeps isolated IDs useful to humans while still expanding
 * automatically when UUIDv7 values share a long timestamp prefix.
 */
export function shortestUniqueIdPrefixes(ids: readonly string[], minimumLength = 4): Map<string, string> {
  const uniqueIds = [...new Set(ids)];
  const result = new Map<string, string>();

  for (const id of uniqueIds) {
    let length = Math.min(Math.max(1, minimumLength), id.length);
    while (
      length < id.length
      && uniqueIds.some(other => other !== id && other.startsWith(id.slice(0, length)))
    ) {
      length += 1;
    }
    result.set(id, id.slice(0, length));
  }

  return result;
}

export function sessionOriginLabel(session: SessionInfo): string | undefined {
  if (session.origin !== "remote") return undefined;
  return `remote:${sanitizeDisplayText(session.remoteHostId, "unknown-host")}`;
}

export function formatSessionDisplayName(session: SessionInfo, fallback?: string): string {
  const name = sanitizeDisplayText(session.name, fallback ?? sanitizeDisplayText(session.id.slice(0, 8), "Unknown session"));
  const origin = sessionOriginLabel(session);
  return origin ? `${name} [${origin}]` : name;
}

export function searchableSessionText(session: SessionInfo): string {
  return [session.name, session.id, session.cwd, session.model, session.status, session.origin, session.remoteHostId, session.parentSessionId, session.rootSessionId]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLocaleLowerCase();
}
