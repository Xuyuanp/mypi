/**
 * Subagent Tool - Task delegation to specialized agents.
 *
 * Thin wiring layer: tool registration, event subscriptions, and
 * delegation to execute.ts / background.ts / render.ts.
 *
 * Key capabilities:
 * - Concurrent execution: no executionMode declared, so the agent
 *   loop can batch multiple subagent calls via Promise.all.
 * - Model override: per-call model param > agent default > parent.
 * - Abort support: SIGTERM on signal, SIGKILL after 5s timeout.
 * - TUI rendering: collapsed/expanded views with tool-specific
 *   formatting, status icons, and usage stats (tokens/cost/time).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "./agents.js";
import { BACKGROUND_RESULT_TYPE, createBackgroundManager } from "./background.js";
import { registerSubagentCommand } from "./command.js";
import {
    executeBackground,
    executeForeground,
    makeErrorToolResult,
    makeResumeErrorResult,
} from "./orchestration.js";
import { renderSubagentResult } from "./render.js";
import {
    deriveSessionPath,
    hydrateResolvedAgent,
    resolveAgentConfig,
} from "./resolve.js";
import { lookupSubagentSession } from "./resume.js";
import type { AgentSpec, PersistedResolvedAgent, SubagentDetails } from "./types.js";
import { formatModelString } from "./types.js";

// ── Re-exports for backward compatibility ────────────────────────────
export type { BackgroundAgent } from "./types.js";
export { createZeroUsage } from "./types.js";

// ── Renderer state ───────────────────────────────────────────────────

/**
 * Shared renderer state passed between renderCall and renderResult
 * via ToolRenderContext.state. Allows renderResult to communicate
 * the resolved agent back to renderCall for display in the header.
 */
interface SubagentRenderState {
    resolvedAgent?: PersistedResolvedAgent;
}

// ── Local helpers ────────────────────────────────────────────────────

function escapeXml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Subagent tool params ─────────────────────────────────────────────

const SubagentParams = Type.Object({
    agent: Type.String({
        description:
            "Name of an available agent. Must match a <name> from the agent list.",
    }),
    description: Type.String({
        description: "A short (3-5 word) summary of the delegated task.",
    }),
    task: Type.String({
        description:
            "Self-contained task description. The subagent has NO access to your conversation history -- include all necessary context, file paths, constraints, and expected output format. Be explicit about whether to write code or only research.",
    }),
    model: Type.Optional(
        Type.String({
            description: 'Model override, e.g. "anthropic/claude-sonnet:high".',
        }),
    ),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory override for the subprocess.",
        }),
    ),
    skills: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Skill names to attach. Replaces the agent's default skills.",
        }),
    ),
    background: Type.Optional(
        Type.Boolean({
            description: "Run as a fire-and-forget background task.",
        }),
    ),
});

const ResumeParams = Type.Object({
    id: Type.String({
        description: "Session ID of the completed subagent to resume.",
    }),
    follow_up: Type.String({
        description:
            "New message to send to the subagent, continuing its conversation.",
    }),
});

function buildToolDescription(agents: AgentSpec[]): string {
    const agentList =
        agents.length > 0
            ? [...agents]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(
                      (a) =>
                          `<agent>\n  <name>${escapeXml(a.name)}</name>\n  <description>${escapeXml(a.description)}</description>\n</agent>`,
                  )
                  .join("\n")
            : "(none)";

    return `Spawn an agent to work on a focused task in an isolated context with its own tool set.

The result is only visible to you. If the user should see it, summarize it yourself.

<available_agents>
${agentList}
</available_agents>

**Writing the \`task\`**
- The agent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The agent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

**Usage of Optional Parameters**

- \`model\`: Set only when the user explicitly requests a specific model; otherwise omit to use the agent default.
- \`cwd\`: Set when the task targets a different project root than the current working directory.
- \`skills\`: Attach specialized skills by name. Use when the task requires domain knowledge not built into the agent.
- \`background\`: Set to true for fire-and-forget work whose result you do not need to continue your current turn. Multiple foreground agents already run in parallel within a single turn -- prefer foreground unless you truly do not need the result.

**When NOT to Use**

- Reading a known file path
- Searching a small number of known files
- Tasks that can be completed in one or two direct tool calls

Each completed subagent can be resumed via subagent_resume using the subagent ID shown in the result.`;
}

// ── Extension entry point ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    const knownAgents = discoverAgents();
    const bgManager = createBackgroundManager((msg, opts) =>
        pi.sendMessage(msg, opts),
    );

    registerSubagentCommand(pi, bgManager, knownAgents);

    let skillCache = new Map<string, Skill>();

    pi.on("session_start", (_event, ctx) => {
        bgManager.setSessionActive(true);
        bgManager.setUI((key, factory) => ctx.ui.setWidget(key, factory));
    });

    pi.on("session_shutdown", async () => {
        await bgManager.shutdown();
    });

    pi.on("before_agent_start", (event) => {
        const skills = event.systemPromptOptions.skills;
        skillCache = skills ? new Map(skills.map((s) => [s.name, s])) : new Map();
    });

    // Register custom message renderer for background agent results
    pi.registerMessageRenderer<SubagentDetails>(
        BACKGROUND_RESULT_TYPE,
        (message, { expanded }, theme) => {
            const details = message.details;
            const bgDetails =
                details &&
                typeof details === "object" &&
                "kind" in details &&
                details.kind === "background"
                    ? (details as SubagentDetails)
                    : undefined;
            if (!bgDetails) {
                const contentText =
                    typeof message.content === "string"
                        ? message.content
                        : message.content
                              .map((p) => (p.type === "text" ? p.text : ""))
                              .join("");
                return new Text(contentText || "(no output)", 0, 0);
            }
            return renderSubagentResult(bgDetails, expanded, theme);
        },
    );

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: buildToolDescription(knownAgents),
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const parentThinkingLevel = pi.getThinkingLevel();
            const parentModel = ctx.model
                ? {
                      provider: ctx.model.provider,
                      name: ctx.model.id,
                      thinkingLevel:
                          parentThinkingLevel === "off"
                              ? undefined
                              : parentThinkingLevel,
                      contextWindow: ctx.model.contextWindow,
                  }
                : undefined;
            const resolved = resolveAgentConfig(params, knownAgents, skillCache, {
                parentModel,
                getContextWindow: (provider, name) =>
                    ctx.modelRegistry.find(provider, name)?.contextWindow,
            });
            if (typeof resolved === "string") {
                return makeErrorToolResult(resolved, params);
            }

            const resolvedAgent = resolved;
            const session = deriveSessionPath(
                resolvedAgent.name,
                ctx.sessionManager.getSessionFile(),
            );

            if (params.background) {
                return executeBackground(
                    resolvedAgent,
                    params,
                    session,
                    bgManager,
                    onUpdate,
                    ctx.cwd,
                );
            }

            return executeForeground(
                resolvedAgent,
                params,
                session,
                signal,
                onUpdate,
                ctx.cwd,
            );
        },

        renderCall(args, theme, context) {
            const agentName = args.agent || "...";
            const desc = args.description || "...";
            const bgIndicator = args.background ? theme.fg("muted", " (bg)") : "";
            const state = context.state as SubagentRenderState;
            const modelPart = state.resolvedAgent
                ? theme.fg(
                      "muted",
                      ` ${formatModelString(state.resolvedAgent.model)}`,
                  )
                : "";
            const text =
                theme.fg("toolTitle", theme.bold("subagent ")) +
                theme.fg("text", agentName) +
                modelPart +
                bgIndicator +
                theme.fg("dim", ` ${desc}`);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, context) {
            const details = result.details;
            if (!details || typeof details !== "object" || !("kind" in details)) {
                const text = result.content[0];
                return new Text(
                    text?.type === "text"
                        ? theme.fg("dim", text.text)
                        : "(no output)",
                    0,
                    0,
                );
            }
            const typed = details as SubagentDetails;
            // Publish resolved agent to shared state for renderCall
            const state = context.state as SubagentRenderState;
            if (typed.resolvedAgent) state.resolvedAgent = typed.resolvedAgent;

            if (typed.kind === "background") {
                const contentText = result.content[0];
                const msg =
                    contentText?.type === "text" ? contentText.text : "(started)";
                if (expanded && typed.result.task) {
                    const container = new Container();
                    container.addChild(new Text(theme.fg("dim", msg), 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(
                        new Text(
                            theme.fg(
                                "muted",
                                "\u2500\u2500\u2500 Task \u2500\u2500\u2500",
                            ),
                            0,
                            0,
                        ),
                    );
                    container.addChild(
                        new Text(theme.fg("dim", typed.result.task), 0, 0),
                    );
                    return container;
                }
                return new Text(theme.fg("dim", msg), 0, 0);
            }
            return renderSubagentResult(typed, expanded, theme);
        },
    });

    // ── subagent_resume tool ──────────────────────────────────────────

    pi.registerTool({
        name: "subagent_resume",
        label: "Subagent Resume",
        description:
            "Resume a completed subagent session with a follow-up message. " +
            "Use when the follow-up depends on the subagent's prior context " +
            "(files it read, conclusions it reached, changes it made). " +
            "The subagent reloads its full conversation history and continues from where it left off. " +
            "Always executes in foreground (blocking).",
        parameters: ResumeParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const { id, follow_up } = params;

            if (bgManager.agents.has(id)) {
                return makeResumeErrorResult(
                    `Agent "${id}" is still running. Wait for it to complete or cancel it first.`,
                );
            }

            const entries = ctx.sessionManager.getBranch() as any[];
            const lookup = lookupSubagentSession(entries, id);

            if (!lookup.found) {
                if (lookup.error === "no_session_info") {
                    return makeResumeErrorResult(
                        `Session "${id}" predates resume support (no session info stored).`,
                    );
                }
                const available =
                    lookup.availableIds.length > 0
                        ? lookup.availableIds.map((i) => `"${i}"`).join(", ")
                        : "none";
                return makeResumeErrorResult(
                    `No subagent found with id "${id}". Available sessions: ${available}.`,
                );
            }

            const { details: matchedDetails, session } = lookup;

            const sessionFile = path.join(session.dir, `${session.id}.jsonl`);
            if (!fs.existsSync(sessionFile)) {
                return makeResumeErrorResult(
                    `Session file not found on disk: ${sessionFile}`,
                );
            }

            if (!matchedDetails.resolvedAgent) {
                return makeResumeErrorResult(
                    `Session "${id}" has no resolved agent info. Cannot resume.`,
                );
            }

            const resolvedAgent = hydrateResolvedAgent(
                matchedDetails.resolvedAgent,
                knownAgents,
            );
            if (!resolvedAgent) {
                return makeResumeErrorResult(
                    `Agent "${matchedDetails.resolvedAgent.name}" is no longer available.`,
                );
            }

            return executeForeground(
                resolvedAgent,
                {
                    description: "",
                    ...lookup.originalParams,
                    agent: resolvedAgent.name,
                    task: follow_up,
                    background: false,
                },
                session,
                signal,
                onUpdate,
                ctx.cwd,
                { resumedFrom: id, resume: true },
            );
        },

        renderCall(args, theme, context) {
            const sessionId = args.id || "...";
            const agentName = sessionId.replace(/-[^-]+$/, "") || sessionId;
            const state = context.state as SubagentRenderState;
            const modelPart = state.resolvedAgent
                ? theme.fg(
                      "muted",
                      ` ${formatModelString(state.resolvedAgent.model)}`,
                  )
                : "";
            const rawFollowUp = args.follow_up
                ? args.follow_up.replace(/\s+/g, " ").trim()
                : "...";
            const followUp =
                rawFollowUp.length > 60
                    ? `${rawFollowUp.slice(0, 60)}...`
                    : rawFollowUp;
            const text =
                theme.fg("toolTitle", theme.bold("subagent_resume ")) +
                theme.fg("text", agentName) +
                modelPart +
                theme.fg("dim", ` ${followUp}`);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, context) {
            const details = result.details;
            if (
                !details ||
                typeof details !== "object" ||
                !("kind" in details) ||
                details.kind !== "foreground"
            ) {
                const text = result.content[0];
                return new Text(
                    text?.type === "text"
                        ? theme.fg("dim", text.text)
                        : "(no output)",
                    0,
                    0,
                );
            }
            // Publish resolved agent to shared state for renderCall
            const typed = details as SubagentDetails;
            const state = context.state as SubagentRenderState;
            if (typed.resolvedAgent) state.resolvedAgent = typed.resolvedAgent;

            return renderSubagentResult(typed, expanded, theme);
        },
    });
}
