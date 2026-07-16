---
name: pi-intercom
description: |
  Streamline session-to-session coordination with pi-intercom. Send messages,
  delegate tasks, and coordinate work across multiple pi sessions on the same
  machine. Use for planner-worker workflows, cross-session context sharing,
  and real-time collaboration between sessions.
---

# Pi Intercom Skill

Use this skill when you need to coordinate work across multiple pi sessions
running on the same machine. Pi-intercom enables direct 1:1 messaging between
sessions for delegation, context sharing, and collaborative workflows.

When you are supervising `pi-subagents`, delegated child agents can escalate to
you via `contact_supervisor` if `pi-subagents` supplied child bridge metadata.
This skill covers how to handle those orchestrator-side escalations.

## When to Use

- **Task delegation**: Split work between a planner session and worker sessions
- **Context handoffs**: Send findings from a research session to an execution session
- **Clarification loops**: Worker asks questions, planner answers, work continues
- **Multi-session workflows**: Coordinate between specialized sessions (frontend/backend, research/implementation)

## Core Patterns

### Pattern 1: Planner-Worker Delegation

The most common pattern. One session holds the big picture, others do hands-on work.

**Setup** (in each session):
```
/name planner    # Terminal 1
/name worker     # Terminal 2
```

**Planner delegates a task** (fire-and-forget):
```typescript
intercom_send({
  to: "worker",
  message: "Task-3: Add retry logic to API client. Key files: src/api/client.ts. Ask if anything's unclear."
})
```

**Worker asks for clarification** (waits briefly, then continues asynchronously if needed):
```typescript
intercom_ask({
  to: "planner",
  message: "Should I use exponential backoff or fixed intervals?"
})
// → Returns a prompt reply as the result
// → After 30 seconds, returns control; a late reply arrives as a new intercom message
```

**Worker reports completion**:
```typescript
intercom_send({
  to: "planner",
  message: "Task-3 complete. Added exponential backoff (100ms → 1600ms, max 5 retries)."
})
```

Use `ask` only when the next step genuinely depends on an answer. Keep at most one unresolved ask to the same recipient; the broker rejects a second one. Different recipients may be asked concurrently when their answers are genuinely blocking. Assignments, completion notices, follow-ups, progress requests, and status checkpoints should use `send` so they do not create unnecessary wait edges.

### Pattern 2: Send Related Updates as a Burst

The receiver durably queues every message and combines messages that arrive within a 300 ms quiet window into one model turn (never waiting more than 1 second). This means several independently produced updates can be sent promptly without waking the recipient once per message:

```typescript
intercom_send({ to: "planner", message: "Tests pass." })
intercom_send({ to: "planner", message: "One API compatibility concern remains." })
intercom_send({ to: "planner", message: "See src/client.ts:88." })
```

Do not add artificial sleeps to form a batch. Each original message keeps its sender, ID, attachments, timestamp, and reply context.

### Pattern 3: Find Your Manager or Team

Orchestrator-owned coworkers should use the no-argument team tool instead of searching the global peer list:

```typescript
intercom_team({})
// → Manager target plus live coworkers owned by that manager
```

Use the returned manager target directly with `intercom_send` or `intercom_ask`. The manager follows adoption dynamically.

### Pattern 4: Global Status Check

Use the global list only when you need independently launched peers:

```typescript
intercom_list({})
// → Shows all connected sessions with names, cwd, models, and live status (`idle`, `thinking`, `tool:<name>`)
```

### Pattern 5: Reply Naturally

When responding to an inbound ask, prefer `reply` instead of reconstructing raw IDs:

```typescript
// In the turn triggered by the ask:
intercom_reply({
  message: "Use exponential backoff starting at 100ms."
})

// If replying later and there might be more than one pending ask:
intercom_pending({})
intercom_reply({ to: "planner", which: "oldest", message: "Use exponential backoff starting at 100ms." })
```

`intercom_reply` preserves exact threading internally. `intercom_pending` labels same-sender asks as `oldest`/`latest`; models never see or construct the protocol message ID.

### Pattern 5: Broadcast to Multiple Workers

Send to multiple sessions in parallel:

```typescript
const workers = ["worker-1", "worker-2", "worker-3"];
const task = "Check for null pointer exceptions in your assigned files";

// Fire-and-forget to all workers
workers.forEach(w => 
  intercom_send({ to: w, message: task })
);
```

### Pattern 6: Send with Attachments

Share code snippets, files, or context:

```typescript
intercom_send({
  to: "worker",
  message: "Here's the fix for the auth issue:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: `function validateUser(user: User | null) {
  if (!user) throw new Error("User required");
  return user.email?.includes("@");
}`
  }]
})
```

### Pattern 7: Handle Subagent Escalations (Orchestrator Side)

When `pi-subagents` spawns a delegated child and supplies child bridge metadata,
that child can reach you through `contact_supervisor`. You receive a formatted
message that includes run metadata:

```
**From subagent-worker-78f659a3-1**

Subagent needs a supervisor decision.
Run: 78f659a3
Agent: worker
Child index: 0

Which API should I use?
```

**Reply using `reply`:**

```typescript
// The reply hint in the incoming message will show the exact call:
intercom_reply({ message: "Use the stable v2 API." })
```

This works because `reply` resolves the correct sender and message ID automatically.

**Three types of escalations to expect:**

| Type | What it means | How to respond |
|------|---------------|----------------|
| `need_decision` | Subagent waits up to 30 seconds, then continues asynchronously while the request remains open. | Reply promptly with a clear decision. If you need more context, ask follow-up questions via `reply`. |
| `interview_request` | Subagent waits up to 30 seconds for structured answers, then continues asynchronously. | Reply with plain JSON or a fenced `json` block using the provided `{ "responses": [...] }` shape. |
| `progress_update` | Subagent is sharing meaningful progress or a plan-changing discovery. Not blocking. | Read and acknowledge. No reply required unless you want to redirect. |

**When a subagent asks:**

```typescript
// In the turn triggered by the incoming ask:
intercom_reply({ message: "Use exponential backoff, max 3 retries." })
```

**When a subagent sends an interview request:**

Read the rendered questions in the incoming message and reply with the exact ids in JSON. `info` questions are context-only and do not need response entries:

```typescript
intercom_reply({
  message: "```json\n{\n  \"responses\": [\n    { \"id\": \"api\", \"value\": \"Stable API\" },\n    { \"id\": \"constraints\", \"value\": \"Keep the public error shape unchanged.\" }\n  ]\n}\n```"
})
```

**If you receive multiple pending asks from different subagents:**

```typescript
intercom_pending({})
// → Shows all unresolved inbound asks with sender, elapsed time, and preview

intercom_reply({ to: "subagent-worker-78f659a3-1", message: "Use the v2 API." })
```

**Important:** Only sessions where `pi-subagents` supplied child bridge metadata
get the `contact_supervisor` tool. Normal sessions use the split `intercom_send`,
`intercom_ask`, `intercom_reply`, `intercom_team`, `intercom_list`, `intercom_pending`, and
`intercom_status` tools. If you see the formatted supervisor decision/progress update message, treat
it as a `contact_supervisor` escalation.

## Key Differences

| Action | Behavior | Use When |
|--------|----------|----------|
| `send` | Fire-and-forget | You don't need a response |
| `ask` | Waits up to 30 seconds, then continues asynchronously | You need an answer but should not hold the agent indefinitely |
| `reply` | Responds to the active or pending inbound ask | You were asked something and need to answer naturally |
| `pending` | Lists unresolved inbound asks | You need to see who is waiting before replying |
| `list` | Returns all sessions with live status | You need to discover targets or choose an idle peer |
| `status` | Returns your connection state | Troubleshooting |

## Optional: Visible Peer Sessions via cmux or tmux

If no suitable intercom-connected peer session already exists and the task benefits from a long-lived visible conversation, you may spawn a new `pi` session.

Prefer `cmux new-split right` over new surfaces or workspaces so both sessions are visible side by side.

If `cmux` is unavailable, `tmux` is an optional fallback when it is installed and relevant. Use it with a private socket so the session is isolated and observable.

Use spawned peer sessions only for:
- same-codebase worker/planner splits
- reference-codebase scouting
- long-lived visible conversations where the user benefits from watching both sides

Do not use this for unrelated repos, trivial questions, or work you can finish cleanly in the current session.

### Preferred: cmux Worker or Scout Session

Same codebase:

```bash
cmux new-split right
sleep 0.5
cmux send --surface right 'cd /path/to/current/repo && pi\n'
```

Reference codebase:

```bash
cmux new-split right
sleep 0.5
cmux send --surface right 'cd /path/to/reference/repo && pi\n'
```

### Optional Fallback: tmux Worker or Scout Session

Same codebase:

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/pi-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/pi.sock"
SESSION=pi-worker
tmux -S "$SOCKET" new -d -s "$SESSION" -c "/path/to/current/repo" 'pi'
```

Reference codebase:

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/pi-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/pi.sock"
SESSION=pi-reference-auth
tmux -S "$SOCKET" new -d -s "$SESSION" -c "/path/to/reference/repo" 'pi'
```

When you use `tmux`, tell the user how to watch it:

```bash
tmux -S "$SOCKET" attach -t "$SESSION"
```

After launch, name the new session clearly so it is easy to target:

```text
/name worker
/name reference-auth
```

Then coordinate from the current session:

```typescript
intercom_send({
  to: "worker",
  message: "Take task X. Ask if blocked."
})

intercom_ask({
  to: "reference-auth",
  message: "How does this repo structure token refresh retries?"
})
```

### Spawn Decision Rule

Spawn a visible peer session only when all of these are true:
- no existing intercom-connected session already fits the need
- the work benefits from a long-lived visible peer session
- the peer session is either in the same codebase or in an intentional reference codebase
- `cmux` is available, or `tmux` is available as an intentional fallback

If neither `cmux` nor `tmux` is available, skip this path and use normal `intercom` workflows.

## Important Constraints

### `ask` Limitations

- **30-second soft wait**: If no reply arrives, the tool returns a successful pending result and the agent continues
- **10-minute reply window**: The recipient can still answer later; the reply arrives as a new intercom message
- **One synchronous wait per recipient**: Independent recipients may be asked concurrently, but a second unresolved ask to the same recipient is rejected
- **Deferred is not cancelled**: After the soft wait, reverse asks are allowed and the original request stays late-replyable, including across broker restart
- **Cannot self-target**: A session cannot ask itself

```typescript
// Check if already waiting before asking
const result = await intercom_ask({ to: "planner", message: "..." });
if (result.isError && result.content[0].text.includes("Already waiting")) {
  // Use send instead, or wait for current ask to complete
}
```

### `send` Behavior

- **No reply wait**: `send` waits only until the receiver durably queues and acknowledges the message; it never waits for a conversational reply
- **Structured delivery**: `accepted` means broker-accepted, while `delivered` means receiver-acknowledged
- **Crash replay**: Unfinished sends are durably replayed with the same message ID after broker reconnect, so do not invent a new ID for a manual retry
- **Burst batching**: Nearby inbound messages become one recipient turn after 300 ms quiet, capped at 1 second
- **Confirmation dialogs**: If `confirmSend: true` in config, interactive sessions show a confirmation dialog
- **Replies skip confirmation**: `intercom_reply` never shows a send confirmation dialog

## Best Practices

### Use `ask` for decision workflows

When the worker needs information to proceed:

```typescript
// GOOD: Worker waits briefly for a prompt decision
const reply = await intercom_ask({
  to: "planner",
  message: "API rate limit is 100/min. Should I implement client-side throttling or batching?"
});
// If reply.details?.pending is true, continue only with work that does not depend on the answer.
// A late answer will arrive as a new intercom message.
```

### Use `send` for notifications

When you just want to inform:

```typescript
// GOOD: Fire-and-forget notification
intercom_send({
  to: "reviewer",
  message: "PR #123 is ready for review. Key changes in auth.ts."
});
// Continue immediately, don't wait
```

### Include reply hints in messages

Make it easy for recipients to respond:

```typescript
// GOOD: Recipient sees exact command to reply
intercom_send({
  to: "worker",
  message: `Found the issue in auth.ts:142. Use getUserById() instead of getUser().

Reply with: intercom_reply({ message: "..." })`
});
```

### Name sessions meaningfully

Use `/name` so others can target you easily:

```
/name api-worker
/name frontend-dev
/name planner
```

## Error Handling

### Common Errors and Solutions

**"Already waiting for a reply"**
```typescript
// You already have an unresolved ask to this recipient.
// Use send for a non-blocking follow-up or progress/status request.
intercom_send({ to: "planner", message: "Additional context for the open question." });

// Or wait for the current ask to resolve before asking another question.
// Asks to a different recipient may proceed concurrently.
```

**"Cannot message the current session"**
```typescript
// You cannot target yourself
// This usually means you confused session names - double-check the target
```

**"Session not found"**
```typescript
const result = await intercom_send({ to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" - check the name and list available sessions
  await intercom_list({});
}
```

**Ask continues asynchronously after 30 seconds**
```typescript
const result = await intercom_ask({ to: "planner", message: "..." });
if (result.details?.pending) {
  // The message was delivered, but no prompt reply arrived.
  // Continue independent work; a late reply will trigger a new intercom message.
}
```

## Troubleshooting

### Session not appearing in list

1. Check intercom is enabled: `intercom_status({})`
2. Verify the target session has loaded pi-intercom
3. Ensure both sessions are on the same machine (intercom is same-machine only)

### Message not delivered

```typescript
const result = await intercom_send({ to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" or delivery failure reason
}
```

### Connection lost

Sessions automatically reconnect if the broker restarts. If persistently disconnected:

```typescript
intercom_status({})
// Check if broker is running and restart if needed
```

## Common Workflows

### Research → Implementation Handoff

```typescript
// Research session finds relevant code
intercom_send({
  to: "impl-session",
  message: "Found the bug. The issue is in validateUser() - it doesn't check for null.",
  attachments: [{
    type: "snippet",
    name: "validate.ts",
    language: "typescript",
    content: `// Line 45-52 - missing null check
function validateUser(user: User) {
  return user.email?.includes("@"); // crashes if user is null
}`
  }]
});
```

### Pair Debugging

```typescript
// Session A encounters error
intercom_ask({
  to: "session-b",
  message: "Getting 'Cannot read property of undefined' at line 78. Can you check if data.users is populated before this call?"
});

// Session B investigates and replies
intercom_reply({
  message: "data.users is null. The fetch failed silently. Add error handling in loadUsers()."
});
```

### Progress Reporting

```typescript
// Worker sends periodic updates
intercom_send({ to: "planner", message: "Task-1 complete (15min). Starting Task-2." });
// ... work ...
intercom_send({ to: "planner", message: "Task-2 complete (30min). Task-3 blocked - need API key." });
// ... get unblocked ...
intercom_send({ to: "planner", message: "Task-3 complete. All done." });
```

### Long-Running Task with Checkpoints

```typescript
// For long tasks, use send for progress and ask only for concrete decisions

// 1. Initial send with full context
intercom_send({
  to: "worker",
  message: "Implement user authentication. This will take 30+ minutes. I'll check in at milestones."
});

// 2. Worker sends progress via send (no timeout)
intercom_send({ to: "planner", message: "Milestone 1: Login form complete (10min)" });

// 3. Worker asks for specific decision when needed
const decision = await intercom_ask({
  to: "planner",
  message: "Should we use JWT or session cookies? Need decision to continue."
});
// Continue with the decision when prompt; otherwise continue only independent work.
```
