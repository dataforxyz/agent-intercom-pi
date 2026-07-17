import { authorize, type AuthorizationDecision, type PolicyAction, type PolicyPrincipal, type PolicyState } from "@dataforxyz/agent-intercom-core";
import type { SessionInfo } from "../types.ts";

export function policyPrincipalForSession(session: SessionInfo): PolicyPrincipal {
  if (session.origin === "remote") {
    if (!session.parentSessionId || !session.rootSessionId || !session.generation) {
      throw new Error(`Remote session ${session.id} is missing broker-owned policy metadata`);
    }
    return {
      id: session.id,
      kind: "remote",
      state: "active",
      generation: session.generation,
      policy: "remote-parent",
      parentSessionId: session.parentSessionId,
      rootSessionId: session.rootSessionId,
    };
  }
  return {
    id: session.id,
    kind: "local",
    state: "active",
    generation: 1,
    policy: "local-public",
    rootSessionId: session.id,
  };
}

export function policyStateForSessions(sessions: Iterable<SessionInfo>): PolicyState {
  const principals: Record<string, PolicyPrincipal> = {};
  for (const session of sessions) principals[session.id] = policyPrincipalForSession(session);
  return { principals };
}

export function authorizeSessionAction(
  sessions: Iterable<SessionInfo>,
  actorId: string,
  action: PolicyAction,
  targetId: string,
): AuthorizationDecision {
  const state = policyStateForSessions(sessions);
  const actor = state.principals[actorId];
  const target = state.principals[targetId];
  return authorize(state, actorId, action, targetId, {
    actorGeneration: actor?.generation,
    targetGeneration: target?.generation,
  });
}

export function visibleSessions(sessions: Iterable<SessionInfo>, actorId: string): SessionInfo[] {
  const values = Array.from(sessions);
  return values.filter((target) => authorizeSessionAction(values, actorId, "discover", target.id).allowed);
}
