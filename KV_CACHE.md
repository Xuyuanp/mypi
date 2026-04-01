# KV-Cache Runbook for AI Coding Agents

A practical guide for writing KV-cache-friendly code when building an AI agent
that calls the Anthropic Messages API with prompt caching enabled.

Derived from reverse-engineering the Claude Code source code. Every rule below is
backed by a real bug, a real metric, or a real architectural decision observed in
production at scale.

---

## Table of contents

1. [Mental model](#1-mental-model)
2. [System prompt: the static/dynamic split](#2-system-prompt-the-staticdynamic-split)
3. [Tool schemas: freeze early, move dynamic content out](#3-tool-schemas-freeze-early-move-dynamic-content-out)
4. [Messages: the single-marker rule](#4-messages-the-single-marker-rule)
5. [Beta headers and API params: latch once, never flip](#5-beta-headers-and-api-params-latch-once-never-flip)
6. [Fork/subagent cache sharing](#6-forksubagent-cache-sharing)
7. [Microcompact: surgical cache editing](#7-microcompact-surgical-cache-editing)
8. [Dates and volatile values](#8-dates-and-volatile-values)
9. [Cache break detection](#9-cache-break-detection)
10. [Checklist](#10-checklist)

---

## 1. Mental model

The Anthropic API caches KV attention states at prefix boundaries you mark with
`cache_control: { type: 'ephemeral' }`. The cache key is composed of:

```
hash(system_prompt_blocks + tool_schemas + beta_headers + model + messages_prefix)
```

**Any byte-level change to any component before the cache breakpoint invalidates
the entire cached prefix.** There is no partial invalidation. A single character
change in one tool description can bust 50,000+ tokens of cached context.

The server-side cache has two TTL tiers:

- **5 minutes** -- default `ephemeral`
- **1 hour** -- `ephemeral` with `ttl: '1h'`, requires eligibility

And three scope levels:

- **`global`** -- shared across all users (for static, universal content)
- **`org`** -- shared within an organization
- **`null`/unset** -- per-conversation only

### The golden rule

> If it does not change between API calls, do not let it change between API
> calls. Memoize, latch, freeze, pin -- whatever it takes.

---

## 2. System prompt: the static/dynamic split

### Problem

A naive system prompt that mixes universal instructions with user-specific
content (env info, memory, connected MCP servers) makes the entire prompt
uncacheable at the global scope.

### Solution: boundary marker

Split your system prompt array into two zones using a sentinel string:

```
[static_block_1, static_block_2, "__BOUNDARY__", dynamic_block_1, dynamic_block_2]
```

When building `TextBlockParam[]` for the API, find the sentinel and assign cache
scopes by position:

```typescript
// Build up to 4 system prompt blocks with different cache scopes
function buildSystemBlocks(promptParts: string[]): TextBlockParam[] {
  const boundaryIndex = promptParts.indexOf("__BOUNDARY__");
  const blocks: TextBlockParam[] = [];

  // Block 1: static content before boundary -- globally cacheable
  const staticText = promptParts.slice(0, boundaryIndex).join("\n\n");
  if (staticText) {
    blocks.push({
      type: "text",
      text: staticText,
      cache_control: { type: "ephemeral", scope: "global" },
    });
  }

  // Block 2: dynamic content after boundary -- per-session, no global cache
  const dynamicText = promptParts.slice(boundaryIndex + 1).join("\n\n");
  if (dynamicText) {
    blocks.push({ type: "text", text: dynamicText });
  }

  return blocks;
}
```

### What goes where

**Before boundary (static, globally cacheable):**

- Agent identity and role description
- System instructions (tool usage rules, security reminders)
- Coding best practices
- Tone, style, and output efficiency guidelines

**After boundary (dynamic, per-session):**

- User memory files
- Environment info (cwd, git status, OS)
- Language preference
- Output style configuration
- MCP server instructions
- Session-specific tool guidance

### Memoize dynamic sections

Even after the boundary, sections that do not change within a session should be
computed once and cached. Build a small helper that distinguishes memoized
sections from per-turn sections:

```typescript
const sectionCache = new Map<string, string | null>();

// Computed once per session, reused until explicit reset
function memoizedSection(
  name: string,
  compute: () => string | null,
): string | null {
  if (sectionCache.has(name)) return sectionCache.get(name)!;
  const value = compute();
  sectionCache.set(name, value);
  return value;
}

// Recomputed every turn -- WILL break the org-level cache when value changes.
// Only use when genuinely unavoidable.
function volatileSection(compute: () => string | null): string | null {
  return compute();
}

// Reset on /clear, /compact, or session restart
function clearSectionCache() {
  sectionCache.clear();
}
```

**Rule: prefer moving volatile content to user-role messages in the conversation
(see Section 3) over recomputing system prompt sections.**

### Fallback when global scope is unavailable

When per-user content (e.g., non-deferred MCP tools) is present in the tool
array, the system prompt cannot use `scope: 'global'` because the tool block
(which precedes system blocks in the cache key) already contains per-user data.
Fall back to `'org'` scoping or omit the scope entirely.

---

## 3. Tool schemas: freeze early, move dynamic content out

### Problem

Tool schemas occupy an early position in the cache key. Any byte change busts the
entire tool block (~10K+ tokens) AND everything downstream. Sources of churn:

- Feature flag flips mid-session
- MCP servers connecting/disconnecting (tool count changes)
- Dynamic agent/plugin lists embedded in tool descriptions
- Conditional schema fields toggling based on user state

### Solution 1: session-frozen schema cache

Compute each tool's rendered schema once and cache it for the session lifetime:

```typescript
const toolSchemaCache = new Map<string, object>();

function getToolSchema(tool: Tool): object {
  const key = tool.name;
  if (toolSchemaCache.has(key)) {
    return toolSchemaCache.get(key)!;
  }

  // Compute the full schema: name, description, input_schema, strict, etc.
  // Feature flag values are captured HERE and frozen.
  const schema = {
    name: tool.name,
    description: tool.renderDescription(),
    input_schema: tool.getInputSchema(),
  };
  toolSchemaCache.set(key, schema);
  return schema;
}

// Per-request overlay: only these fields should vary between calls
function withRequestOverlay(
  base: object,
  opts: { deferLoading?: boolean; cacheControl?: object },
) {
  return {
    ...base,
    ...(opts.deferLoading && { defer_loading: true }),
    ...(opts.cacheControl && { cache_control: opts.cacheControl }),
  };
}
```

### Solution 2: move dynamic content to conversation messages

If a tool description includes a list that changes between turns (e.g., available
subagent types, connected MCP servers), move it out of the tool description and
into a user-role message tagged with `<system-reminder>`:

**Before (cache-busting):**

```
tool.description = `Launch agents. Available types:\n- worker\n- researcher\n- reviewer`
```

**After (cache-stable):**

```
tool.description = `Launch agents. Available types are listed in <system-reminder> messages.`

// In the conversation messages:
messages.push({
  role: "user",
  content: "<system-reminder>Available agent types:\n- worker\n- researcher\n- reviewer</system-reminder>"
})
```

The tool description is now static. The dynamic list lives in the message stream
where it does not affect the tool block cache key. Use incremental diffs
(added/removed) rather than full re-renders when the list changes between turns.

**Production impact: moving agent listings out of tool descriptions saved 10.2%
of fleet-wide `cache_creation` tokens.**

### Solution 3: `defer_loading` for tool search

When many tools are registered (MCP + plugins), mark infrequently-used tools with
`defer_loading: true`. The API strips deferred tools from the prompt -- they do
not affect the cache key at all. The model discovers them via a search tool when
needed.

---

## 4. Messages: the single-marker rule

### The rule

Place exactly ONE `cache_control` marker per API request, on the last message
(or the second-to-last for fire-and-forget forks).

### Why not multiple markers?

The API's KV page manager frees local-attention KV pages at cached prefix
positions NOT in the token boundary set. With two markers, the second-to-last
position is protected and its locals survive an extra turn even though no future
request will ever resume from there. With one marker, those pages are freed
immediately.

### Implementation

```typescript
function addCacheMarkers(
  messages: MessageParam[],
  enableCaching: boolean,
  skipCacheWrite: boolean,
): MessageParam[] {
  if (!enableCaching) return messages;

  // One marker only. For fire-and-forget forks, mark the shared prefix point.
  const markerIndex = skipCacheWrite
    ? messages.length - 2
    : messages.length - 1;

  return messages.map((msg, i) => {
    if (i !== markerIndex) return msg;

    // Add cache_control to the last content block of the marked message
    const content = Array.isArray(msg.content)
      ? [...msg.content]
      : [{ type: "text", text: msg.content }];
    const lastBlock = content[content.length - 1];
    content[content.length - 1] = {
      ...lastBlock,
      cache_control: { type: "ephemeral" },
    };
    return { ...msg, content };
  });
}
```

### `skipCacheWrite` for fire-and-forget forks

When a forked agent will never have a follow-up request (one-shot summarization,
speculative execution), use `skipCacheWrite`. This shifts the marker to
`messages[last - 1]` -- the last prefix point shared with the parent. The write
to that position is a no-op merge on the server (the entry already exists), and
the fork does not pollute the KV cache with its ephemeral tail content.

---

## 5. Beta headers and API params: latch once, never flip

### Problem

The server-side cache key includes the set of beta headers. Toggling a header
mid-session changes the key, busting 50-70K tokens of cached prompt.

### Solution: sticky-on latches

Once a beta header is first sent, it must keep being sent for the rest of the
session, regardless of whether the underlying feature is still active:

```typescript
// Session state: starts as false, flips to true, never flips back
const headerLatches: Record<string, boolean> = {};

function ensureHeaderLatched(name: string, shouldEnable: boolean): boolean {
  if (headerLatches[name]) return true; // already latched on
  if (!shouldEnable) return false; // not yet needed
  headerLatches[name] = true; // latch on -- permanent for session
  return true;
}

function buildBetaHeaders(state: SessionState): string[] {
  const headers: string[] = [...BASE_HEADERS];

  // The HEADER is latched (always sent once activated).
  // The BEHAVIOR (e.g., speed: 'fast') stays dynamic per-call.
  if (ensureHeaderLatched("fast-mode", state.fastModeRequested)) {
    headers.push("fast-mode-2025-01-01");
  }
  if (ensureHeaderLatched("auto-mode", state.autoModeActive)) {
    headers.push("auto-mode-2025-01-01");
  }
  if (ensureHeaderLatched("cache-editing", state.cacheEditingEnabled)) {
    headers.push("cache-editing-2025-01-01");
  }

  return headers;
}

// Only reset on explicit session boundaries
function clearLatches() {
  for (const key of Object.keys(headerLatches)) {
    delete headerLatches[key];
  }
}
```

### What to latch vs what stays dynamic

**Latch (affects cache key):**

- Beta headers
- 1h TTL eligibility (evaluate once at session start, store the result)
- TTL allowlist (which query sources get 1h -- evaluate once, store)
- Cache editing feature toggle

**Keep dynamic (does NOT affect cache key):**

- `speed` body param (fast-mode cooldown can suppress without header change)
- `context_management.edits` (server-side clearing, separate from cache key)
- `max_tokens` (does not affect cache)
- `temperature` (does not affect cache)

### When to clear latches

Only on explicit reset: a `/clear` command, `/compact` command, or full session
restart. Never mid-conversation.

---

## 6. Fork/subagent cache sharing

### The principle

A forked agent (compaction, background memory, speculation) should produce an API
request with a byte-identical prefix to the parent's last request. This
guarantees a prompt cache hit with zero cache-creation cost.

### The cache-safe parameter bundle

Identify and thread the 5 cache-critical values from parent to child:

```typescript
interface CacheSafeParams {
  renderedSystemPrompt: string[]; // exact bytes as last sent, NOT recomputed
  userContext: Record<string, string>;
  systemContext: Record<string, string>;
  tools: ToolDefinition[]; // same tool array, same order
  model: string;
  parentMessages: Message[]; // parent conversation up to fork point
}
```

### Critical implementation details

**1. Pass rendered system prompt bytes. Do not recompute.**

Calling your `buildSystemPrompt()` function at fork spawn time can diverge from
what the parent last sent. Feature flags may have refreshed. Memoized sections
may have a different cache state. Any divergence changes the prefix bytes and
busts the cache. Instead, capture the rendered bytes after the parent's last API
call and thread them to the child.

```typescript
// After each main-loop API call, snapshot the rendered system prompt
let lastRenderedSystemPrompt: string[] | null = null;

function onMainLoopCallComplete(renderedPrompt: string[]) {
  lastRenderedSystemPrompt = renderedPrompt;
}

// When spawning a fork, use the snapshot -- never recompute
function spawnFork(directive: string) {
  runForkedAgent({
    systemPrompt: lastRenderedSystemPrompt!, // exact bytes
    messages: [...parentMessages, { role: "user", content: directive }],
    // ...
  });
}
```

**2. Clone mutable state that affects message serialization.**

If your system replaces large tool results with summaries (a "content replacement
budget"), the fork must clone the parent's replacement decisions -- not start
fresh. A fresh state would make different replacement choices on the same
`tool_use_id`s, producing a different wire prefix.

```typescript
// Clone the parent's replacement state so the fork makes identical decisions
const forkedReplacementState = structuredClone(parentReplacementState);
```

**3. Save/restore pattern for post-turn forks.**

After each main-loop turn, save the current cache-safe params to a module-level
slot. Post-turn background work (prompt suggestion, memory extraction) reads from
this slot instead of requiring every caller to thread params through:

```typescript
let savedParams: CacheSafeParams | null = null;

function saveCacheSafeParams(params: CacheSafeParams) {
  savedParams = params;
}

function getLastCacheSafeParams(): CacheSafeParams {
  if (!savedParams)
    throw new Error("No saved params -- main loop has not run yet");
  return savedParams;
}
```

---

## 7. Microcompact: surgical cache editing

### Problem

As conversations grow, old tool results (file reads, command output) consume
context but are no longer useful. Blanking out old content client-side changes the
message bytes, which changes the wire prefix, which busts the cache.

### Solution: `cache_edits` API feature

Instead of modifying message content, instruct the API to delete specific blocks
from the server-side KV cache:

```typescript
// Step 1: Tag tool_result blocks with a stable cache_reference
// (only within the cached prefix, strictly before the last cache_control marker)
for (const msg of messagesBeforeCacheMarker) {
  for (const block of msg.content) {
    if (block.type === "tool_result") {
      block.cache_reference = block.tool_use_id;
    }
  }
}

// Step 2: In subsequent requests, include deletion instructions
const requestBody = {
  // ... normal params ...
  cache_edits: {
    type: "cache_edits",
    edits: [
      { type: "delete", cache_reference: "toolu_abc123" },
      { type: "delete", cache_reference: "toolu_def456" },
    ],
  },
};
```

### Pinning: consume once, re-send forever

Once a `cache_edits` block is inserted at a specific user message index, it must
be re-sent at that same position in every subsequent request. The server needs to
see the deletions consistently.

```typescript
interface PinnedEdit {
  messageIndex: number;
  edits: { type: "delete"; cache_reference: string }[];
}

const pinnedEdits: PinnedEdit[] = [];
let pendingEdits: PinnedEdit | null = null;

// Called by the compaction system when it decides to evict old tool results
function scheduleCacheEdits(messageIndex: number, toolUseIds: string[]) {
  pendingEdits = {
    messageIndex,
    edits: toolUseIds.map((id) => ({ type: "delete", cache_reference: id })),
  };
}

// Called once during request construction
function applyAndPinEdits(messages: MessageParam[]) {
  // Re-insert all previously-pinned edits at their original positions
  for (const pinned of pinnedEdits) {
    insertIntoMessage(messages[pinned.messageIndex], pinned.edits);
  }

  // Insert new edits and pin them
  if (pendingEdits) {
    insertIntoMessage(messages[pendingEdits.messageIndex], pendingEdits.edits);
    pinnedEdits.push(pendingEdits);
    pendingEdits = null;
  }
}
```

### Notify your cache break detection

After sending `cache_edits` deletions, flag the expected drop so the break
detection system does not fire a false positive (see Section 9).

---

## 8. Dates and volatile values

### Problem

The current date changes at midnight. If embedded in the system prompt, it busts
the entire cached prefix once per day for every active session.

### Solutions

**1. Memoize at session start.**

```typescript
// Captured once at session creation. Stale after midnight,
// but "stale date" is better than "entire-conversation cache bust."
let sessionDate: string | null = null;

function getSessionDate(): string {
  if (!sessionDate) {
    sessionDate = new Date().toISOString().slice(0, 10);
  }
  return sessionDate;
}
```

When midnight rolls over, append a date-change notice as a user message at the
conversation tail -- never touch the cached prefix.

**2. Use coarse granularity in tool descriptions.**

Tool prompts that reference "the current date" should use month-year
("March 2026") instead of a full date. This changes monthly instead of daily.

**3. General rule.**

Any value that appears in the system prompt or tool descriptions and changes more
frequently than once per session is a cache buster. Move it to a tail-position
message, a `<system-reminder>` tag in the conversation, or compute it client-side
in a hook.

---

## 9. Cache break detection

Build observability into your cache layer. Without it, you will silently waste
thousands of dollars on cache-creation tokens from unintended prefix changes.

### Two-phase detection

**Phase 1 -- pre-call: record what you are about to send.**

Hash the current state of every cache-key component. Compare against the previous
call's hashes. Store what changed as "pending changes."

```typescript
interface PromptStateSnapshot {
  systemHash: number;
  toolsHash: number;
  perToolHashes: Record<string, number>; // drill-down for which tool changed
  model: string;
  betaHeaders: string[];
  cacheControlHash: number; // scope + TTL settings
  extraBodyHash: number;
}

let previousState: PromptStateSnapshot | null = null;
let pendingChanges: string[] | null = null;

function recordPromptState(current: PromptStateSnapshot) {
  if (!previousState) {
    previousState = current;
    return;
  }
  const changes: string[] = [];
  if (current.systemHash !== previousState.systemHash)
    changes.push("system prompt changed");
  if (current.toolsHash !== previousState.toolsHash) {
    // Drill down: which specific tool's description changed?
    for (const [name, hash] of Object.entries(current.perToolHashes)) {
      if (previousState.perToolHashes[name] !== hash)
        changes.push(`tool "${name}" changed`);
    }
  }
  if (current.model !== previousState.model) changes.push("model changed");
  // ... check betaHeaders, cacheControlHash, extraBodyHash ...

  pendingChanges = changes.length > 0 ? changes : null;
  previousState = current;
}
```

**Phase 2 -- post-call: check the API response for actual cache miss.**

```typescript
function checkForCacheBreak(
  cacheReadTokens: number,
  prevCacheReadTokens: number | null,
  timeSinceLastCall: number | null,
) {
  if (prevCacheReadTokens === null) return; // first call, no baseline

  const drop = prevCacheReadTokens - cacheReadTokens;
  const dropPercent = drop / prevCacheReadTokens;

  // Only flag significant drops (>5% AND >2000 tokens)
  if (dropPercent <= 0.05 || drop < 2000) {
    pendingChanges = null;
    return;
  }

  // Attribute the break
  if (pendingChanges && pendingChanges.length > 0) {
    log.warn(
      `Cache break: ${pendingChanges.join(", ")} [${prevCacheReadTokens} -> ${cacheReadTokens}]`,
    );
  } else if (timeSinceLastCall && timeSinceLastCall > 60 * 60 * 1000) {
    log.info("Cache break: likely 1h TTL expiry (no client changes)");
  } else if (timeSinceLastCall && timeSinceLastCall > 5 * 60 * 1000) {
    log.info("Cache break: likely 5min TTL expiry (no client changes)");
  } else {
    log.info(
      "Cache break: likely server-side eviction (no client changes, <5min gap)",
    );
  }

  pendingChanges = null;
}
```

### False positive suppression

| Situation                        | Action                                            |
| -------------------------------- | ------------------------------------------------- |
| After compaction                 | Reset baseline (set `prevCacheReadTokens = null`) |
| After `cache_edits` deletion     | Flag as expected drop, skip detection for 1 call  |
| Gap >5min with no client changes | Label "possible 5min TTL expiry"                  |
| Gap >1h with no client changes   | Label "possible 1h TTL expiry"                    |
| No client changes, <5min gap     | Label "likely server-side eviction"               |
| Deferred tools changed           | Exclude from tool hash (API strips them)          |

### Diff output for debugging

When a break is detected with client-side changes, write a unified diff of
`{model + system_prompt_text + sorted_tool_details}` between the previous and
current state. This makes it trivial to find the exact bytes that changed.

---

## 10. Checklist

Before shipping any change that touches the API call path:

- [ ] **System prompt content is in the correct zone.** Static/universal content
      goes before the boundary. User/session-specific content goes after.
- [ ] **Dynamic content is NOT in tool descriptions.** Agent lists, MCP servers,
      deferred tools, or anything that changes between turns goes in conversation
      messages, not tool prompts.
- [ ] **Tool schemas are frozen per session.** A schema cache is consulted before
      rendering. Mid-session flag flips do not affect the serialized bytes.
- [ ] **Exactly one cache marker per request.** The marker is on the last message
      (or second-to-last for `skipCacheWrite` forks).
- [ ] **Beta headers are latched, not toggled.** Once sent, a header stays in
      every subsequent request until explicit session reset.
- [ ] **TTL eligibility is evaluated once at session start.** The result is stored
      and never re-evaluated mid-session.
- [ ] **Fork agents inherit cache-safe params.** System prompt bytes, tools,
      model, replacement state, and message prefix are byte-identical to the parent.
- [ ] **Volatile values are memoized.** Dates are captured at session start; any
      value that changes more often than once per session uses a tail-position message.
- [ ] **Cache break detection covers the change.** Any new API param or header is
      hashed in the pre-call phase so breaks are correctly attributed.
- [ ] **`cache_edits` deletions notify the detection system.** Expected token
      drops are flagged to prevent false alarms.
