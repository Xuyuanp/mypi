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
4. [Messages: cache marker placement](#4-messages-cache-marker-placement)
5. [Beta headers and API params: latch once, never flip](#5-beta-headers-and-api-params-latch-once-never-flip)
6. [Fork/subagent cache sharing](#6-forksubagent-cache-sharing)
7. [Long conversations: compaction and context editing](#7-long-conversations-compaction-and-context-editing)
8. [Dates and volatile values](#8-dates-and-volatile-values)
9. [Cache break detection](#9-cache-break-detection)
10. [Checklist](#10-checklist)

---

## 1. Mental model

The Anthropic API caches KV attention states at prefix boundaries you mark with
`cache_control: { type: 'ephemeral' }`. The cache key is composed of:

```
hash(beta_headers + model + tool_schemas + system_prompt_blocks + messages_prefix)
```

**Render order is `tools` -> `system` -> `messages`.** Tools render first, so a
breakpoint on the last system block caches tools + system together. This is why
any per-turn content in the tool array invalidates the system prompt's cache
too: tools physically precede system in the rendered prefix (Section 3).

**Any byte-level change to any component before the cache breakpoint invalidates
the entire cached prefix.** There is no partial invalidation. A single character
change in one tool description can bust 50,000+ tokens of cached context.

The server-side cache has two TTL tiers:

- **5 minutes** -- default `ephemeral`
- **1 hour** -- `ephemeral` with `ttl: '1h'`

### The golden rule

> If it does not change between API calls, do not let it change between API
> calls. Memoize, latch, freeze, pin -- whatever it takes.

### Invalidation is tiered, not all-or-nothing

"Any byte change invalidates everything downstream" is the rule to design
around, but the API has three cache tiers. A change only invalidates its own
tier and everything after it -- not the tiers before it:

| Change                                          | Tools | System | Messages |
| ----------------------------------------------- | :---: | :----: | :------: |
| Tool definitions (add/remove/reorder)           |  bust |  bust  |   bust   |
| Model switch                                    |  bust |  bust  |   bust   |
| Beta headers                                    |  bust |  bust  |   bust   |
| `speed`, web-search, citations toggle           |  keep |  bust  |   bust   |
| System prompt content                           |  keep |  bust  |   bust   |
| `tool_choice`, images, `thinking` enable/disable|  keep |  keep  |   bust   |
| Message content                                 |  keep |  keep  |   bust   |

Implication: you can flip `tool_choice` per request or toggle `thinking`
without losing the tools + system cache. Don't over-engineer latches for those
(Section 5). Only tool-definition, model, and beta-header changes force a full
rebuild.

### Minimum cacheable prefix (model-dependent)

A prefix shorter than the model's minimum **silently will not cache** -- no
error, just `cache_creation_input_tokens: 0`. The same 3K-token prompt caches
on Sonnet 4.5 but not on Opus:

| Model                                              | Minimum |
| -------------------------------------------------- | ------: |
| Opus 4.8, Opus 4.7, Opus 4.6, Opus 4.5, Haiku 4.5  |   4096  |
| Sonnet 4.6, Haiku 3.5, Haiku 3                      |   2048  |
| Sonnet 4.5, Sonnet 4.1, Sonnet 4, Sonnet 3.7        |   1024  |

There is also a hard cap of **4 `cache_control` breakpoints per request**
(Section 4 covers where to place the message-side markers).

### Economics: when caching pays off

- **Cache read:** ~0.1x base input price.
- **Cache write:** 1.25x for the 5-minute TTL, 2x for the 1-hour TTL.

Break-even depends on TTL. With the 5-minute TTL, two requests already pay for
themselves (1.25x write + 0.1x read = 1.35x, vs 2x uncached). With the 1-hour
TTL you need at least three requests (2x + 0.2x = 2.2x, vs 3x uncached). The
1-hour TTL keeps entries alive across gaps in bursty traffic, but the doubled
write cost means it must earn more reads to break even.

---

## 2. System prompt: the static/dynamic split

### Problem

A naive system prompt that interleaves stable instructions with user- or
session-specific content (env info, memory, connected MCP servers) drops the
volatile bytes inside the cached prefix. Every session-specific change then
busts the whole system prompt instead of just the part that actually changed.

### Solution: boundary marker

Split your system prompt array into two zones using a sentinel string:

```
[static_block_1, static_block_2, "__BOUNDARY__", dynamic_block_1, dynamic_block_2]
```

When building `TextBlockParam[]` for the API, find the sentinel and place the
breakpoint at the boundary so the stable prefix caches and the volatile tail
sits outside it:

```typescript
// Split the system prompt at the static/dynamic boundary; the breakpoint goes
// on the static block so the stable prefix is reused across turns and sessions.
function buildSystemBlocks(promptParts: string[]): TextBlockParam[] {
  const boundaryIndex = promptParts.indexOf("__BOUNDARY__");
  const blocks: TextBlockParam[] = [];

  // Static content before boundary -- byte-stable, carries the cache marker
  const staticText = promptParts.slice(0, boundaryIndex).join("\n\n");
  if (staticText) {
    blocks.push({
      type: "text",
      text: staticText,
      cache_control: { type: "ephemeral" },
    });
  }

  // Dynamic content after boundary -- volatile, no marker
  const dynamicText = promptParts.slice(boundaryIndex + 1).join("\n\n");
  if (dynamicText) {
    blocks.push({ type: "text", text: dynamicText });
  }

  return blocks;
}
```

### What goes where

**Before boundary (static, byte-stable prefix):**

- Agent identity and role description
- System instructions (tool usage rules, security reminders)
- Coding best practices
- Tone, style, and output efficiency guidelines

**After boundary (dynamic, volatile):**

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

// Recomputed every turn -- WILL break the cached prefix when the value changes.
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

## 4. Messages: cache marker placement

### Where the marker goes

Place a `cache_control` marker on the last content block of the most recently
appended turn. Each subsequent request reuses the entire prior-conversation
prefix, and cache hits accrue incrementally as the conversation grows.

Combined with the system-prompt breakpoint (Section 2), a typical request uses 2
of the 4 allowed breakpoints. The remaining budget can go to earlier stability
boundaries in long conversations -- but read the 20-block lookback caveat below
before adding more, and remember each extra breakpoint is an extra cache-write
position the server keeps alive.

### Implementation

```typescript
function addCacheMarkers(
  messages: MessageParam[],
  enableCaching: boolean,
  skipCacheWrite: boolean,
): MessageParam[] {
  if (!enableCaching) return messages;

  // Mark the newest turn. For fire-and-forget forks, mark the shared prefix
  // point instead (see skipCacheWrite below).
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

### Caveat: the 20-block lookback window

Each `cache_control` breakpoint walks backward **at most 20 content blocks** to
find a prior cache entry to resume from. In an agentic loop, a single turn can
append more than 20 blocks (many `tool_use` / `tool_result` pairs). When that
happens, the trailing marker cannot reach the previous turn's cached block, and
the request silently misses despite a byte-identical prefix.

Fix it by placing an intermediate breakpoint roughly every ~15 blocks inside an
oversized turn, so each marker stays within 20 blocks of the previous cached
position. This is the main reason to spend more than the one trailing marker.

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

  // Each header is latched: once a session activates the feature, the header
  // keeps being sent for the rest of the session even if the feature goes idle.
  // Use the real, current beta header strings -- they are part of the cache key.
  if (ensureHeaderLatched("compaction", state.compactionEnabled)) {
    headers.push("compact-2026-01-12");
  }
  if (ensureHeaderLatched("task-budgets", state.taskBudgetsEnabled)) {
    headers.push("task-budgets-2026-03-13");
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

- Beta headers (the exact header set is hashed into the key)
- Model ID
- 1h TTL eligibility (evaluate once at session start, store the result)
- TTL allowlist (which query sources get 1h -- evaluate once, store)

**Keep dynamic (does NOT bust the tools + system prefix):**

- `tool_choice` (changes per request; tools + system cache survives)
- `thinking` enable/disable and images (system cache survives)
- `max_tokens` (does not affect cache)

Note: `speed`, web-search, and citations toggles **do** invalidate the system
cache (see the invalidation table in Section 1) -- they are not free to flip
mid-session. Only `tool_choice` and the message-tier params above are safe.

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

### Sequence the fan-out -- a cache entry is not readable until it is written

A cache entry becomes readable only **after the first request's response begins
streaming**. If you fire N forks with an identical prefix in parallel, none can
read what the others are still writing -- every one pays the full cache-creation
cost.

For fan-out (parallel subagents, speculative branches sharing the parent
prefix): send one request first, await its **first streamed token** (not the
full response), then fire the remaining N-1. They will read the cache the first
request just wrote.

```typescript
async function fanOut(prefixRequests: RequestParams[]) {
  const [first, ...rest] = prefixRequests;

  // Prime the cache: await the first streamed token, not the full message.
  const firstStream = client.messages.stream(first);
  await firstStream.once("streamEvent"); // cache entry is now readable

  // Now the rest hit the cache the first request wrote.
  const restResults = await Promise.all(rest.map((r) => runRequest(r)));
  const firstResult = await firstStream.finalMessage();
  return [firstResult, ...restResults];
}
```

---

## 7. Long conversations: compaction and context editing

### Problem

As conversations grow, old tool results (file reads, command output) consume
context but are no longer useful. Blanking them out client-side changes the
message bytes, which changes the wire prefix, which busts the cache. You need a
way to shrink context without rewriting the cached prefix yourself.

### Use the documented server-side features

There is no client-side "delete a block from the KV cache" primitive. Use the
two features the API actually exposes:

- **Compaction** (beta header `compact-2026-01-12`; Opus 4.6+/Sonnet 4.6). The
  API summarizes earlier context automatically as the prompt approaches the
  trigger threshold (default ~150K tokens). Critical: append the full
  `response.content` -- including any compaction blocks -- back into `messages`
  every turn. The API uses those blocks to replace the compacted history on the
  next request; extracting only the text silently loses the compaction state.

- **Context editing / `context_management`** for server-side clearing of stale
  tool results. This is a documented request param, not a client-side prefix
  rewrite.

Both rebuild the cached prefix once when they fire, then resume caching from the
new, smaller prefix. Expect a one-time cache-creation cost at the boundary --
flag it so break detection does not treat it as a regression (see Section 9).

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

### Read the right `usage` fields

The response `usage` object reports three separate token counts:

| Field                         | Meaning                                              |
| ----------------------------- | ---------------------------------------------------- |
| `cache_creation_input_tokens` | Written to cache this request (paid the ~1.25x write)|
| `cache_read_input_tokens`     | Served from cache this request (paid ~0.1x)          |
| `input_tokens`                | The **uncached remainder only**, billed at full price|

`input_tokens` is not the total prompt size. Total prompt size is
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. An agent
that ran for hours can show `input_tokens: 4000` while the rest was served from
cache -- always sum the three fields, never read `input_tokens` alone.

If `cache_read_input_tokens` is zero across repeated requests that should share
a prefix, a silent invalidator is at work -- diff the rendered prefix bytes
between two requests (see the diff output below) to find the offending byte.

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
  cacheControlHash: number; // TTL settings
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
| After context editing            | Flag as expected drop, skip detection for 1 call  |
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
- [ ] **A cache marker is on the newest turn** (or the second-to-last message
      for `skipCacheWrite` forks), within the 4-breakpoint limit. Extra markers
      are added only to bridge the 20-block lookback window in long turns.
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
- [ ] **Compaction / context-editing boundaries notify the detection system.**
      The one-time cache-creation cost is flagged to prevent false alarms.
- [ ] **The cacheable prefix clears the model's minimum.** Prefixes below the
      per-model threshold (4096 tokens on Opus/Haiku 4.5, 2048 on Sonnet 4.6,
      1024 on older Sonnet) silently never cache.
- [ ] **Cache metrics sum all three `usage` fields.** Reporting reads
      `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
      never `input_tokens` alone.
- [ ] **Fan-out is sequenced.** Parallel requests sharing a prefix prime the
      cache with one request (await its first token) before firing the rest.
