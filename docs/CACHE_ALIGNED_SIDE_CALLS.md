# Cache-Aligned Side Calls

Pattern for making LLM side-calls from extensions that reuse the session's KV cache, without blocking the agent loop.

**Related docs:**
- [KV_CACHE.md](./KV_CACHE.md) -- design principles for cache-friendly LLM calls
- [CACHE_PREFIX_REUSE.md](./CACHE_PREFIX_REUSE.md) -- how pi implements caching (marker placement, tree navigation, empirical proofs)

## Core Insight: Reuse the Cache

The most expensive part of an LLM call is processing the input prefix. By reusing the **same model, system prompt, tools, and message history** as the main conversation, the side-call gets a near-complete KV cache hit -- only the appended trailing message is new work for the model.

This is the btw.ts pattern:

```ts
// Preserve KV cache prefix: same system prompt + tools + messages
const systemPrompt = ctx.getSystemPrompt() ?? "";

const allTools = new Map(pi.getAllTools().map((t) => [t.name, t]));
const tools = pi
    .getActiveTools()
    .map((name) => allTools.get(name))
    .filter((t) => t !== undefined)
    .map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
    }));

const branch = ctx.sessionManager.getBranch();
const sctx = buildSessionContext(branch);
const llmMessages = convertToLlm(sctx.messages);

// Custom instruction goes in a trailing user message -- NOT the system
// prompt -- so the entire prefix is identical to the main conversation.
const messages: Message[] = [
    ...llmMessages,
    {
        role: "user",
        content: [{ type: "text", text: YOUR_INSTRUCTION }],
        timestamp: Date.now(),
    },
];

// Match the session's thinking level for prefix alignment
const thinkingLevel = pi.getThinkingLevel();
const reasoning = thinkingLevel !== "off" ? thinkingLevel : undefined;

const response = await completeSimple(
    model,
    { systemPrompt, messages, tools },
    { apiKey: auth.apiKey, headers: auth.headers, reasoning },
);
```

**Rules for cache alignment:**
- Use `ctx.model` (the session model), not a separate model
- Use `ctx.getSystemPrompt()` as-is -- do not prepend/modify
- Include tool definitions in the same order as the main session
- Send the full message history -- do not truncate or slice
- Put your custom instruction in an **appended user message** at the end
- Pass the same `reasoning` level as the session

## Non-Blocking Execution

When firing from an event handler (e.g. `agent_end`), do not `await` the LLM call. Use three mechanisms to stay safe:

1. **Eager flag** -- set a guard before launching to prevent re-entry
2. **Generation counter** -- detect stale results after session restarts
3. **`isActive` callback** -- check at each await boundary before applying side effects

```ts
interface State {
    done: boolean;
    sessionActive: boolean;
    generation: number;
}

export default function(pi: ExtensionAPI) {
    const state: State = { done: false, sessionActive: false, generation: 0 };

    pi.on("session_start", async () => {
        state.done = false;
        state.sessionActive = true;
        state.generation++;
    });

    pi.on("session_shutdown", async () => {
        state.sessionActive = false;
    });

    pi.on("agent_end", async (_event, ctx) => {
        if (!state.sessionActive || state.done) return;

        state.done = true;
        const gen = state.generation;

        doWork(
            pi,
            ctx,
            () => state.sessionActive && state.generation === gen,
        ).catch(() => {});
    });
}

async function doWork(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    isActive: () => boolean,
): Promise<void> {
    try {
        const result = await generateWithCache(pi, ctx);
        if (!isActive()) return;
        pi.setSessionName(result);
    } catch (error) {
        if (!isActive()) return;
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed: ${msg}`, "warning");
    }
}
```

**Why the generation counter matters:** Without it, a rapid shutdown + restart cycle sets `sessionActive` back to `true`. The in-flight work from the old session would then incorrectly pass the liveness check against the new session, applying a stale result.

## Reference

- `extensions/session-name.ts` -- title generation (fire-and-forget on `agent_end`)
- `extensions/btw.ts` -- side questions (interactive, blocks editor)
- `extensions/keepalive.ts` -- periodic ghost pings to keep Anthropic KV cache warm
