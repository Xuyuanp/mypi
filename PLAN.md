# Background Subagent Mode

**Date:** 2026-06-06

## Problem

The subagent tool blocks until the subprocess completes. When the main agent
dispatches multiple independent subagents, it must wait for each sequentially
(or use concurrent tool calls which still block the turn). There is no way to
fire off a subagent and continue working on other tasks in the same turn, with
the result delivered asynchronously.

## Goal

The subagent tool supports a `background: true` mode that returns immediately
with an agent ID, runs the subprocess asynchronously, and injects the result
into the conversation as a follow-up message when done -- triggering a new LLM
turn so the agent can act on it.

## Non-goals

- **Live status bar progress** for background agents (deferred to a future version).
- **Auto-retry** of failed background agents.
- **Session resume** awareness (no orphan detection or "cancelled" injection on restart).
- **LLM-accessible cancel tool** (only user-facing `/subagent cancel <id>`).
- **Batching** multiple background results into a single message.

## Design

### Data flow

```
LLM calls subagent({ ..., background: true })
  → execute() spawns subprocess (fire-and-forget)
  → stores handle in backgroundAgents Map
  → returns immediately: "Background agent started: scout-a1b2c3d4"

[subprocess runs in background]

subprocess completes
  → pi.sendMessage({ customType, content, details }, { deliverAs: "followUp", triggerTurn: true })
  → removes handle from backgroundAgents Map

LLM sees injected message in next turn
  → custom renderer shows it like a foreground subagent result
```

### Shutdown flow

```
session_shutdown fires
  → iterate backgroundAgents Map
  → SIGTERM each process
  → setTimeout 5s → SIGKILL survivors
  → await all process exits
```

### Cancel flow

```
user types: /subagent cancel scout-a1b2c3d4
  → lookup in backgroundAgents Map
  → SIGTERM → SIGKILL after 5s
  → remove from Map
  → no result message injected
```

### New types and interfaces

```typescript
// In index.ts

interface BackgroundAgent {
    id: string;                          // e.g. "scout-a1b2c3d4"
    description: string;                 // 3-5 word summary from params
    agent: AgentConfig;                  // resolved agent config
    task: string;                        // original task text
    kill: () => void;                    // sends SIGTERM, then SIGKILL after 5s
    promise: Promise<AgentRunResult>;    // resolves on normal exit; rejects on abort
}
```

### Modified tool parameter schema

```typescript
const SubagentParams = Type.Object({
    agent: Type.String({
        description: "Name of the agent to invoke",
    }),
    description: Type.String({
        description:
            "A short (3-5 word) summary of what this subagent will do",
    }),
    task: Type.String({
        description: "Task to delegate to the agent",
    }),
    model: Type.Optional(
        Type.String({
            description:
                'Override the model for this invocation (e.g. "anthropic/claude-sonnet:high"). Only set this when the user explicitly requests a specific model; otherwise omit it to use the agent default.',
        }),
    ),
    cwd: Type.Optional(
        Type.String({
            description:
                "Working directory for the agent process",
        }),
    ),
    skills: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Override skills for this invocation. Replaces agent default skills.",
        }),
    ),
    background: Type.Optional(
        Type.Boolean({
            description:
                "Run in background \u2014 returns immediately with an agent ID. Result is delivered later as a follow-up message. Use when you can continue other work without waiting for this agent's output.",
        }),
    ),
});
```

### Execute function changes (background path)

The `kill` function needs access to the child process. Since `runSubagent`
encapsulates the subprocess and accepts `signal: AbortSignal | undefined`,
we pass an `AbortController` owned by the `BackgroundAgent` entry.
Calling `controller.abort()` triggers the existing abort logic inside
`runSubagent` (SIGTERM then SIGKILL after 5s). No refactor to `runSubagent`'s
return type needed.

```typescript
// Inside execute(), after resolving agent and session:

if (params.background) {
    const id = session?.id ?? `${sanitizeAgentName(resolvedAgent.name)}-${randomUUID().slice(0, 8)}`;

    const controller = new AbortController();

    // Fire-and-forget: spawn subprocess, don't await
    const promise = runSubagent(
        resolvedAgent,
        params.task,
        params.cwd ?? ctx.cwd,
        controller.signal,  // owned AbortController for cancel/shutdown
        undefined,           // no onProgress (no live updates)
        session,
        ctx,
    );

    const entry: BackgroundAgent = {
        id,
        description: params.description,
        agent: resolvedAgent,
        task: params.task,
        kill: () => controller.abort(),
        promise,
    };
    backgroundAgents.set(id, entry);

    // When done, inject result and clean up
    promise.then((result) => {
        backgroundAgents.delete(id);
        if (!sessionActive) return;  // session shut down while we were running

        const isError = result.exitCode !== 0
            || result.stopReason === "error"
            || result.stopReason === "aborted";
        const output = getFinalOutput(result.messages) || "(no output)";
        const status = isError ? "failed" : "completed";
        const content = `[Background agent ${id} ${status}]\n\n${output}`;

        pi.sendMessage<SubagentDetails>(
            {
                customType: "subagent_background_result",
                content,
                display: true,
                details: { result, execStatuses: undefined },
            },
            { deliverAs: "followUp", triggerTurn: true },
        );
    }).catch(() => {
        // Handles abort (cancel/shutdown) and pre-spawn failures.
        // Ensures the Map entry is always cleaned up.
        backgroundAgents.delete(id);
    });

    return {
        content: [{ type: "text", text: `Background agent started: ${id}` }],
    };
}
```

### Lifecycle flag (`sessionActive`)

Following the established pattern in this codebase (see `goals/index.ts`,
`session-name.ts`), a `sessionActive` flag in the closure prevents
`pi.sendMessage()` calls after shutdown. The flag is cleared **before**
killing background agents so that if a completing agent's `.then()` fires
between `kill()` and `Promise.allSettled()`, it bails out instead of
calling `sendMessage` on a dead session.

```typescript
let sessionActive = true;

pi.on("session_start", () => {
    sessionActive = true;
});

pi.on("session_shutdown", async () => {
    sessionActive = false;
    const entries = [...backgroundAgents.values()];
    if (entries.length === 0) return;
    for (const entry of entries) {
        entry.kill();
    }
    await Promise.allSettled(entries.map((e) => e.promise));
    backgroundAgents.clear();
});
```

### Message renderer

```typescript
pi.registerMessageRenderer<SubagentDetails>(
    "subagent_background_result",
    (message, { expanded }, theme) => {
        // Reuse the same rendering logic as renderResult
        // (extract from existing renderResult into a shared helper)
    },
);
```

### /subagent cancel command

The `backgroundAgents` Map is created in the `index.ts` closure and passed
to `registerSubagentCommand` as a second argument:

```typescript
// In index.ts default export:
const backgroundAgents = new Map<string, BackgroundAgent>();
registerSubagentCommand(pi, backgroundAgents);
```

The command handler dispatches on the first argument:

```typescript
// In command.ts (updated signature):
export function registerSubagentCommand(
    pi: ExtensionAPI,
    backgroundAgents: Map<string, BackgroundAgent>,
): void {
    pi.registerCommand("subagent", {
        description: "List agents or cancel a background agent",
        getArgumentCompletions(prefix) {
            if (prefix.startsWith("cancel ")) {
                const partial = prefix.slice("cancel ".length);
                return [...backgroundAgents.keys()]
                    .filter((id) => id.startsWith(partial))
                    .map((id) => ({ label: id, value: `cancel ${id}` }));
            }
            if ("cancel".startsWith(prefix)) {
                return [{ label: "cancel", value: "cancel " }];
            }
            return null;
        },
        handler: async (args, ctx: ExtensionCommandContext) => {
            const trimmed = args.trim();
            if (trimmed.startsWith("cancel ")) {
                const id = trimmed.slice("cancel ".length).trim();
                const entry = backgroundAgents.get(id);
                if (!entry) {
                    ctx.ui.notify(`No background agent with id: ${id}`);
                    return;
                }
                entry.kill();
                backgroundAgents.delete(id);
                ctx.ui.notify(`Cancelled background agent: ${id}`);
                return;
            }

            // Default: show agent list (existing TUI table)
            if (ctx.mode !== "tui") return;
            const rows = buildAgentRows(discoverAgents().agents);
            await ctx.ui.custom<void>((tui, theme, _kb, done) => {
                return new AgentsListView(tui, theme, rows, done);
            });
        },
    });
}
```

Note: `BackgroundAgent` interface must be exported from `index.ts` for
`command.ts` to reference in the Map type parameter.

## File list

| File | Action | What changes |
| --- | --- | --- |
| `extensions/subagent/index.ts` | Modify | Add `background` param to schema; add `BackgroundAgent` interface; add `backgroundAgents` Map in closure; branch execute() for background mode; add `session_shutdown` listener; register message renderer; extract shared rendering helper from `renderResult` |
| `extensions/subagent/command.ts` | Modify | Add `cancel` subcommand handling; accept `backgroundAgents` Map reference; argument completion for active IDs |

## Test impact

| Changed function | Tests that depend on it | Test change needed |
| --- | --- | --- |
| `buildAgentRows` | `tests/subagent-command.test.ts` (multiple) | No change -- pure function, not affected |
| `computeColumnWidths` | `tests/subagent-command.test.ts` (multiple) | No change |
| `clamp` | `tests/subagent-command.test.ts` (multiple) | No change |

The existing tests cover command rendering logic (pure functions). The new
background execution path and cancel subcommand are not covered by existing
tests.

### New tests

| Test | Verifies |
| --- | --- |
| `test_background_returns_immediately` | When `background: true`, execute() returns synchronously with agent ID content |
| `test_background_result_injected` | After subprocess completes, `pi.sendMessage` is called with correct customType, content, and delivery options |
| `test_background_error_injected` | When subprocess fails, injected message contains "failed" status and error output |
| `test_background_kill_on_shutdown` | `session_shutdown` aborts all running background agents and awaits their exit |
| `test_cancel_command_kills_agent` | `/subagent cancel <id>` kills the background agent and removes it from the map |
| `test_cancel_command_unknown_id` | `/subagent cancel <unknown>` reports not found |

## Edge cases (failure-mode driven)

| Step | Failure mode | Observable behavior | Handling |
| --- | --- | --- | --- |
| Spawn subprocess | spawn fails (e.g. pi binary not found) | `runSubagent` resolves with exitCode=1 (proc `error` event resolves the inner promise) | `.then()` fires normally; `isError` check catches exitCode !== 0 and injects "failed" status message |
| Subprocess running | Process exits non-zero | `result.exitCode !== 0` | Inject message with "failed" status, include stderr/errorMessage in content |
| Inject result via sendMessage | Session already shut down (race) | `sendMessage` may throw or no-op | Guard with a `sessionActive` flag cleared on `session_shutdown` |
| Cancel command | ID not found in map | User typo or already completed | Report "no background agent with that ID" |
| Cancel command | Process already exited (race) | `abort()` on finished process is no-op | Safe -- AbortController.abort() on already-resolved signal is harmless |
| session_shutdown | Background agent hangs after SIGTERM | Process doesn't exit within 5s | Existing `runSubagent` abort logic does SIGKILL after 5s; `Promise.allSettled` ensures we wait |
| Multiple dispatches | Same agent name dispatched twice | Two entries with different UUIDs | IDs are unique via `randomUUID().slice(0, 8)` -- no collision |
| Pre-spawn setup | `writePromptToTempFile` throws (disk full, permissions) | `runSubagent` promise rejects | `.catch()` on promise cleans up the Map entry; no result message injected (acceptable -- error is in host, not subagent) |
| Cancel / shutdown | `runSubagent` throws "Subagent was aborted" | Promise rejects (not resolves) | `.catch()` cleans up Map entry; `.then()` never fires so no spurious result message is injected |

## While we're here

| Improvement | Decision | Rationale |
| --- | --- | --- |
| Extract renderResult display logic into reusable helper | Include | Needed for message renderer; avoids duplication |
| Update `renderCall` to show `(bg)` indicator when `background: true` | Include | Trivial, improves TUI readability for background dispatches |
| Add `backgroundAgents` to `/subagent` list view (show running) | Exclude (follow-up) | Scope creep; no status bar in v1 |
| Make `runSubagent` return type more ergonomic | Exclude | AbortController approach avoids needing changes to runSubagent |

## Verification

```bash
# Automated
npm run check
npx vitest run
```

Manual verification:
1. Start pi, dispatch a subagent with `background: true`
2. Confirm tool returns immediately with agent ID
3. Continue interacting while background agent runs
4. Confirm result message appears after background agent completes
5. Confirm new LLM turn is triggered and agent acknowledges the result
6. Test `/subagent cancel <id>` kills a running background agent
7. Test quitting pi while background agent runs (confirm no orphan processes)

## Assumptions

- `pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true` can be called from an async callback (not just from within event handlers or tool execute). Verified: the `sendMessage` method is on the `ExtensionAPI` object (pi), not on ctx, so it's callable from anywhere in the extension closure.
- `AbortController.abort()` triggers the existing signal-based kill logic inside `runSubagent` without modification. Verified: `runSubagent` accepts `signal: AbortSignal | undefined` and registers an abort listener.
- The `session_shutdown` event is awaited by the framework, giving us time to kill and await background processes. Verified: per AGENTS.md error handling guidelines.
- `pi.sendMessage()` after `session_shutdown` is safe (either no-ops or throws). We guard with a `sessionActive` flag to avoid calling it post-shutdown.
