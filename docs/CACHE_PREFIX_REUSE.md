# Prompt-Cache Prefix Reuse in pi Sessions

How pi places Anthropic `cache_control` markers, and how the session tree turns
that into real `cache_read` when you navigate between branches. Every claim here
is backed by either a code reference in the shipped packages or a live API
experiment whose script lives in [`scripts/`](../scripts).

This is the empirical companion to [KV_CACHE.md](./KV_CACHE.md): KV_CACHE.md is
the design runbook; this doc records what we actually measured against
`claude-haiku-4-5`.

---

## 1. How pi sets `cache_control`

Marker placement is fully automatic in the pi-ai Anthropic provider
(`@earendil-works/pi-ai/dist/providers/anthropic.js`). You never place markers
yourself. pi resolves one `cacheControl` value and stamps it on the last block
of each cacheable tier.

### Retention (`getCacheControl`, ~L25-35)

- Reads the `cacheRetention` option, else env `PI_CACHE_RETENTION`, default
  `"short"`.
- `"short"` -> `{type:"ephemeral"}` (5-minute TTL).
- `"long"` -> `{type:"ephemeral", ttl:"1h"}` **only if**
  `model.supportsLongCacheRetention`; otherwise silently falls back to 5 minutes.
- `"none"` -> no `cache_control` emitted at all.

### Marker positions (one resolved marker, three independent sites)

| Tier | Code site | Marker position |
| --- | --- | --- |
| Tools | `convertTools` (~L926) | last tool only (`index === tools.length - 1`) |
| System | `buildParams` (~L672/679/689) | each system text block |
| Messages | `convertMessages` (~L885-905) | last block of the **last user message** |

The message-tier marker requires the conversation to end on a user turn
(`lastMessage.role === "user"`); string content is normalized into a text block
to carry it.

### Breakpoint budget (Anthropic hard cap = 4)

- **API-key auth** -> 3 markers: last tool + system prompt + last user message.
- **OAuth (Claude Code) auth** -> 4 markers: last tool + `"You are Claude Code…"`
  identity block + system prompt + last user message. **This hits the cap
  exactly** (`buildParams` pushes two marked system blocks).

Render order is `tools -> system -> messages`, so the markers define strictly
nested prefixes:

```
[tools]                          <- marker 1
[tools + system]                 <- marker 2
[tools + system + identity]      <- marker 3 (OAuth only)
[tools + system + all messages]  <- marker 4
```

A request reads from the longest previously-written prefix that still
byte-matches, and writes new entries at each marker it did not already have.
Consequence: under OAuth, pi already consumes all 4 breakpoints, so an extension
or fork has **zero** remaining budget — it can only relocate an existing marker,
never add one.

---

## 2. Why tree navigation is cache-friendly (the mechanism)

The pi session is a tree of entries linked by `parentId`
(`@earendil-works/pi-coding-agent/dist/core/session-manager.js`). `getBranch()`
walks from the current leaf to the root; `buildSessionContext` + `convertToLlm`
turn that path into the messages array in chronological order.

The load-bearing fact: editing/rewinding an earlier turn does **not** mutate or
copy anything. pi repoints the leaf and appends a *new child* off the shared
ancestor. Both branches pull the same `SessionEntry` objects from the `byId`
map, so `messages.push(entry.message)` pushes the **same object references** into
both branches. The provider serializes deterministically. Therefore the
shared-ancestor prefix is **byte-identical across sibling branches**, which is
the precondition for an Anthropic prefix-cache hit.

---

## 3. Proven: sibling branches reuse the shared prefix

Script: [`scripts/prove-tree-prefix-reuse.sh`](../scripts/prove-tree-prefix-reuse.sh)
(direct API, no SDK; `claude-haiku-4-5` via the local proxy). Each request is
shaped exactly as pi emits it — a `cache_control` marker on the system block and
on the **last user turn only**. A per-run nonce at the front of the system prompt
keeps every tier cold per run.

`P` is the shared ancestor turn (~6.8k tokens); `S` is the system prompt (~5.5k
tokens, its own cache tier). `[*]` is a marker.

| Request | shape | cache_read | cache_creation |
| --- | --- | --: | --: |
| `prime` | `sys=S[*]  msgs=[P[*]]` | 0 | 13090 |
| `branchA` | `sys=S[*]  msgs=[P, ackA, qA[*]]` | **13090** | 18 |
| `branchB` | `sys=S[*]  msgs=[P, ackB, qB[*]]` | **13090** | 18 |
| `negctrl` | `sys=S[*]  msgs=[P2, ackB, qB[*]]` | 5737 | 7377 |

Findings:

- `branchA` and `branchB` mark only their own tail; `P` is unmarked. Both still
  read the full 13090-token prefix, because the `P`-boundary entry was written by
  `prime` — exactly as an earlier real conversation turn establishes that
  boundary. Two different branches reuse the identical ancestor.
- `negctrl` mutates one token at the front of `P`. The read drops to ~5737 (the
  **system tier alone**) while the message region is rewritten (~7377). This is
  the live demonstration of **tiered invalidation**: a message-region change
  busts the message-tier entry but leaves the earlier system-tier entry readable.
  It is also the negative control proving the test can fail.

---

## 4. Proven: navigating back across multiple turns (per-turn granularity)

Script: [`scripts/prove-navigate-back-turns.sh`](../scripts/prove-navigate-back-turns.sh).

A real conversation marks each turn as it becomes the tail, so replaying turns
1..N leaves a cache entry at **each** turn boundary. Phase 1 replays the
conversation; phase 2 navigates back and re-asks an earlier turn (a sibling
branch). The reuse resumes at the last marked boundary before the edit.

| edit @ | ask (reqK) read | navigate back (editK) read | reused up to |
| --- | --: | --: | --- |
| turn 2 | 9500 | **9500** | turn-1 boundary |
| turn 3 | 11712 | **11712** | turn-2 boundary |
| turn 4 | 13923 | **13923** | turn-3 boundary |

Findings:

- **Breakpoints accumulate per turn.** Replay reads grow 0 -> 9500 -> 11712 ->
  13923, each step adding ~2.2k tokens (one turn).
- **Navigating back reuses the pre-edit boundary, exactly.** Editing turn K and
  re-asking reads precisely what the original turn-K request read (exact match,
  not approximate), because both diverge after turn K-1 and resume from that same
  marked boundary. `cache_creation` collapses to ~23 (just the edited tail).
- **Branch as late as possible, quantified.** Editing turn 4 reuses 13923 tokens
  vs 9500 for turn 2 — ~4.4k more tokens served from cache purely by branching
  later.

The cache does **not** resume at an arbitrary byte offset inside the edited turn.
It resumes at the last turn boundary that was ever a marked tail. Reuse
granularity is one turn.

---

## 5. Practical guidance for cache-friendly tree navigation

1. **Branch back within the TTL.** The shared prefix survives only 5 minutes
   (default) or 1 hour (`PI_CACHE_RETENTION=long`, on supporting models). For
   deliberate tree exploration, prefer `long` — it costs 2x on writes but breaks
   even after ~3 reads.
2. **Branch as late as possible.** Editing turn K discards turns K..N; editing a
   later turn reuses more (Section 4).
3. **Mind the 20-block lookback.** Each breakpoint walks back at most 20 content
   blocks. If the branch point sits behind a turn with many tool_use/tool_result
   blocks (> 20), the new marker cannot reach the ancestor boundary and misses
   despite identical bytes.
4. **Don't change model or tools between hops.** Either busts all tiers down to
   position 0, regardless of prefix identity.
5. **Clear the model minimum.** A cacheable prefix below the per-model threshold
   (4096 tokens on Opus/Haiku 4.5, 2048 on Sonnet 4.6, 1024 on older Sonnet)
   silently never caches. The proof scripts pad past 4096 for this reason.
6. **Compaction resets it once.** A `compaction` entry re-synthesizes a summary
   message (a new object) and drops pre-summary entries, changing the prefix once
   at that boundary — expected, one-time rewrite.

---

## 6. What these proofs do NOT cover

- **TTL expiry / server eviction timing.** The scripts run all requests inside
  one warm window; they cannot deterministically prove when an entry is dropped.
- **The 20-block lookback limit.** The ancestor boundaries in the scripts are
  within range; the lookback caveat (Section 5.3) is asserted from the API docs,
  not exercised here.
- **Refresh-on-read semantics.** Whether a cache *read* extends the TTL is a
  separate, proxy-dependent question (see the keepalive investigation), not
  addressed by these prefix-reuse proofs.

---

## 7. Reproducing

```sh
# auth: LITELLM_PI_API_KEY (see ~/.pi/agent/models.json), proxy on localhost:4000
bash scripts/prove-tree-prefix-reuse.sh
bash scripts/prove-navigate-back-turns.sh
```

Both scripts use a fresh per-run nonce (cold cache every run), call the Anthropic
Messages API directly with `curl`, and print each request's shape, the
read/creation outcome, and a PASS/FAIL verdict. They cost a few cents of
`claude-haiku-4-5` tokens per run.
