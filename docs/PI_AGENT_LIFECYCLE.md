# Pi Agent Lifecycle — Complete Event Map

> Reference for extension authors. All events are subscribed via `pi.on("event_name", handler)`.

## Overview

Pi's agent lifecycle is composed of 4 phases:

1. **Startup** — Load settings, discover resources, initialize session
2. **Input Processing** — Intercept/transform user prompt before the agent
3. **Agent Loop** — Outer orchestrator with nested turn cycles and tool execution
4. **Session Operations** — Compaction, tree navigation, switching, forking (can fire at any point)

---

## Phase 1: Startup

Pi loads settings, discovers extensions/skills/prompts/themes, compiles TypeScript via jiti, authenticates providers, and initializes or resumes a session from JSONL.

| Event                | Can Modify             | Payload                            | Notes                                                                                                               |
| -------------------- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `project_trust`      | Yes (decide trust)     | `{ cwd }`                          | Return `{ trusted: "yes"\|"no"\|"undecided", remember? }`. Fires before session_start.                              |
| `session_start`      | No                     | `{ reason, previousSessionFile? }` | Reasons: `"startup"` \| `"reload"` \| `"new"` \| `"resume"` \| `"fork"`.                                            |
| `resources_discover` | Yes (contribute paths) | `{ cwd, reason }`                  | Return `{ skillPaths?, promptPaths?, themePaths? }`. Reasons: `"startup"` \| `"reload"`. Fires after session_start. |

---

## Phase 2: Input Processing

Commands (`/model`, `/compact`, etc.) are checked first and bypass the agent entirely. Otherwise the prompt flows through extension hooks, skill/template expansion, and into the agent.

| Event                | Can Modify                       | Payload                                                  | Notes                                                                                                                                                                                                   |
| -------------------- | -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`              | Yes (intercept/transform/handle) | `{ text, images?, source, streamingBehavior? }`          | Return `{ action: "continue" }` to pass through, `{ action: "transform", text, images? }` to rewrite, or `{ action: "handled" }` to fully consume. Source: `"interactive"` \| `"rpc"` \| `"extension"`. |
| `user_bash`          | Yes (intercept)                  | `{ command, excludeFromContext, cwd }`                   | For `!command` syntax. Return `{ operations? }` or `{ result? }` to replace execution.                                                                                                                  |
| `before_agent_start` | Yes (inject context)             | `{ prompt, images?, systemPrompt, systemPromptOptions }` | Return `{ messages?, systemPrompt? }` to inject persistent `custom_message` entries and/or replace the system prompt for this turn.                                                                     |

---

## Phase 3: Agent Loop

The outer orchestrator. Fires once per user prompt. The loop continues as long as the LLM makes tool calls. When the LLM responds with `stopReason: "stop"` (no tool calls), the loop exits.

| Event           | Can Modify | Payload        | Notes                                                                         |
| --------------- | ---------- | -------------- | ----------------------------------------------------------------------------- |
| `agent_start`   | No         | `{}`           | Fired once when the agent begins processing the user's prompt.                |
| `message_start` | No         | `{ message }`  | Fires for user, assistant, and toolResult messages when persisted to session. |
| `agent_end`     | No         | `{ messages }` | All turns complete. Contains every message generated from this prompt.        |

### Turn Cycle (repeats while LLM calls tools)

Each turn is one LLM round-trip: build context, call provider, stream response, execute tools.

| Event                     | Can Modify            | Payload                              | Notes                                                                                                                                 |
| ------------------------- | --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `turn_start`              | No                    | `{ turnIndex, timestamp }`           | Marks the beginning of one LLM round-trip.                                                                                            |
| `context`                 | Yes (modify messages) | `{ messages }`                       | Deep copy of messages. Extensions can prune, inject RAG context, or rewrite content before the LLM sees it. Return `{ messages }`.    |
| `before_provider_request` | Yes (replace payload) | `{ payload }`                        | Inspect or replace the serialized provider payload (Anthropic/OpenAI/Google format). Return value replaces payload.                   |
| `after_provider_response` | No                    | `{ status, headers }`                | HTTP status + headers received. Fires before the streaming body is consumed.                                                          |
| `message_start`           | No                    | `{ message }`                        | Assistant response begins streaming.                                                                                                  |
| `message_update`          | No                    | `{ message, assistantMessageEvent }` | Token-by-token streaming. `assistantMessageEvent` contains granular stream events (text_delta, thinking_delta, toolcall_delta, etc.). |
| `message_end`             | Yes (replace message) | `{ message }`                        | Full assistant message received. Return `{ message }` to replace (must keep same role).                                               |

### Tool Execution (per tool call in response)

When the assistant response contains tool calls, they are executed (potentially in parallel).

| Event                   | Can Modify                  | Payload                                                       | Notes                                                                                                                                                                                          |
| ----------------------- | --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_execution_start`  | No                          | `{ toolCallId, toolName, args }`                              | Emitted in **assistant source order** during the preflight phase.                                                                                                                              |
| `tool_call`             | Yes (block or mutate input) | `{ toolCallId, toolName, input }`                             | Permission gate. Return `{ block: true, reason? }` to prevent execution. Mutate `event.input` in place to patch arguments. Typed union with type guards: `isToolCallEventType("bash", event)`. |
| `tool_execution_update` | No                          | `{ toolCallId, toolName, args, partialResult }`               | Partial results. In parallel mode, updates may interleave across concurrent tools.                                                                                                             |
| `tool_result`           | Yes (modify output)         | `{ toolCallId, toolName, input, content, isError, details? }` | Handlers chain like middleware. Return `{ content?, details?, isError? }` — omitted fields keep current values. Typed union with type guards: `isBashToolResult(event)`, etc.                  |
| `tool_execution_end`    | No                          | `{ toolCallId, toolName, result, isError }`                   | Emitted in **completion order** (not source order). Tool result message appended to session.                                                                                                   |

After all tool results are collected:

| Event      | Can Modify | Payload                               | Notes                                                                           |
| ---------- | ---------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `turn_end` | No         | `{ turnIndex, message, toolResults }` | If tool calls exist, loop back to `turn_start`. Otherwise, exit to `agent_end`. |

---

## Phase 4: Session Operations

These events are triggered by user commands or automatic thresholds, not by the agent loop. They can interrupt or wrap around any phase above.

### Compaction (`/compact` or auto-compaction)

| Event                    | Can Modify                | Payload                                                       | Notes                                                                                                  |
| ------------------------ | ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session_before_compact` | Yes (cancel or customize) | `{ preparation, branchEntries, customInstructions?, reason, willRetry, signal }` | Return `{ cancel: true }` to abort, or `{ compaction: CompactionResult }` to provide a custom summary. |
| `session_compact`        | No                        | `{ compactionEntry, fromExtension, reason, willRetry }`       | CompactionEntry saved. Old messages summarized, recent kept.                                           |

### Tree Navigation (`/tree`)

| Event                 | Can Modify                | Payload                                                   | Notes                                                                              |
| --------------------- | ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `session_before_tree` | Yes (cancel or customize) | `{ preparation, signal }`                                 | Return `{ cancel?, summary?, customInstructions?, replaceInstructions?, label? }`. |
| `session_tree`        | No                        | `{ newLeafId, oldLeafId, summaryEntry?, fromExtension? }` | BranchSummaryEntry appended. Leaf moves to target.                                 |

### Session Switching (`/new` or `/resume`)

| Event                   | Can Modify   | Payload                          | Notes                                                                                                                                                    |
| ----------------------- | ------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_before_switch` | Yes (cancel) | `{ reason, targetSessionFile? }` | Reason: `"new"` or `"resume"`. Return `{ cancel: true }` to prevent switch.                                                                              |
| `session_shutdown`      | No           | `{ reason, targetSessionFile? }` | Old extension instance cleaned up. Reasons: `"quit"` \| `"reload"` \| `"new"` \| `"resume"` \| `"fork"`. Then `session_start` fires for the new session. |

### Forking (`/fork`)

| Event                 | Can Modify   | Payload                   | Notes                                                                           |
| --------------------- | ------------ | ------------------------- | ------------------------------------------------------------------------------- |
| `session_before_fork` | Yes (cancel) | `{ entryId, position }`   | Position: `"before"` \| `"at"`. Return `{ cancel?, skipConversationRestore? }`. |
| `session_shutdown`    | No           | `{ reason: "fork", ... }` | Fires for the old session. Then `session_start` fires with `reason: "fork"`.    |

### Exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)

| Event              | Can Modify | Payload              | Notes                                                                          |
| ------------------ | ---------- | -------------------- | ------------------------------------------------------------------------------ |
| `session_shutdown` | No         | `{ reason: "quit" }` | Last chance for cleanup. Extensions should use a `sessionActive` flag pattern. |

### Model & Thinking Level

| Event                   | Can Modify | Payload                             | Notes                                                                                       |
| ----------------------- | ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `model_select`          | No         | `{ model, previousModel?, source }` | Source: `"set"` \| `"cycle"`. Fires on `/model`, Ctrl+P, or session restore.                       |
| `thinking_level_select` | No         | `{ level, previousLevel }`          | Fires when thinking level changes.                                                          |

---

## Session Storage

Sessions are stored as JSONL files with a tree structure. Each entry has:

- `id` — 8-char hex identifier
- `parentId` — parent entry ID (or `null` for root)
- `timestamp` — ISO 8601

The first entry is a header with type `"session"` (no id/parentId).

### Entry Types

| Type                    | In LLM Context   | Description                                            |
| ----------------------- | ---------------- | ------------------------------------------------------ |
| `message`               | Yes              | User/assistant/toolResult messages                     |
| `compaction`            | Yes (as summary) | Context compaction summary                             |
| `branch_summary`        | Yes (as context) | Summary of abandoned branch after tree navigation      |
| `custom`                | No               | Extension state persistence                            |
| `custom_message`        | Yes              | Extension-injected messages (via `before_agent_start`) |
| `model_change`          | No               | Model switch mid-session (provider/modelId)            |
| `thinking_level_change` | No               | Thinking level change                                  |
| `label`                 | No               | User-defined bookmark/marker (targetId, label)         |
| `session_info`          | No               | Session metadata (e.g., display name)                  |

All history is preserved — compaction only changes what the LLM sees. Navigate the tree in-place with `/tree`; fork branches with `/fork`.

---

## Extension Hooks Summary

10 events can intercept or modify behavior:

| Event                     | Capability                                   |
| ------------------------- | -------------------------------------------- |
| `project_trust`           | Decide project trust level                   |
| `input`                   | Rewrite prompts or fully handle input        |
| `user_bash`               | Intercept `!command` execution               |
| `before_agent_start`      | Inject context message, modify system prompt |
| `context`                 | Filter/inject messages before LLM            |
| `before_provider_request` | Replace serialized provider payload          |
| `message_end`             | Replace finalized assistant message          |
| `tool_call`               | Block execution or mutate tool input         |
| `tool_result`             | Modify tool output (middleware chain)        |
| `session_before_*`        | Cancel compaction, tree nav, switch, or fork |

Extensions register via `pi.on("event", handler)`. Handlers run in extension load order. For tool events, typed unions with type guards (`isToolCallEventType`, `isBashToolResult`, etc.) enable type-safe narrowing.

---

## Event Flow Diagram

```
Startup:
  project_trust -> session_start -> resources_discover

User sends prompt:
  input -> (skill/template expansion) -> before_agent_start -> agent_start
  +-- Turn cycle (repeats while tool calls exist):
  |     turn_start -> context -> before_provider_request
  |     -> [LLM request]
  |     -> after_provider_response -> message_start -> message_update* -> message_end
  |     +-- Tool execution (per tool call, potentially parallel):
  |     |     tool_execution_start -> tool_call -> [execute]
  |     |     -> tool_execution_update* -> tool_result -> tool_execution_end
  |     +-- turn_end
  +-- agent_end

Session switch:  session_before_switch -> session_shutdown -> session_start
Fork:            session_before_fork -> session_shutdown -> session_start (reason:"fork")
Compaction:      session_before_compact -> session_compact
Tree nav:        session_before_tree -> session_tree
Exit:            session_shutdown (reason:"quit")
```
