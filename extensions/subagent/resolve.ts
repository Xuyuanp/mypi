/**
 * Agent configuration resolution pipeline.
 *
 * Pure functions that validate and transform raw parameters into
 * fully-resolved execution configs. No I/O, no framework mutation,
 * no async (aside from deriveSessionPath which uses randomUUID).
 *
 * Completes the resolve/persist/hydrate lifecycle:
 * - resolveAgentConfig() builds a ResolvedAgent from params + registry
 * - persistAgent() strips the systemPrompt for storage
 * - hydrateResolvedAgent() re-attaches the prompt from the registry
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";

import type { Skill } from "@earendil-works/pi-coding-agent";
import type {
    AgentSpec,
    Model,
    PersistedResolvedAgent,
    ResolvedAgent,
    SubagentToolParams,
} from "./types.js";
import { parseModelString } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface ResolveAgentConfigOptions {
    parentModel?: Model;
    getContextWindow: (provider: string, name: string) => number | undefined;
}

// ── Skill resolution ─────────────────────────────────────────────────

/**
 * Resolve skill names to absolute file paths via the skill cache.
 * Returns resolved paths, or an error message if any skill is unknown.
 */
export function resolveSkills(
    skillNames: string[] | undefined,
    skillCache: Map<string, Skill>,
):
    | { paths: string[] | undefined; error?: never }
    | { error: string; paths?: never } {
    if (!skillNames?.length) return { paths: undefined };
    const unresolved = skillNames.filter((name) => !skillCache.has(name));
    if (unresolved.length) {
        const available =
            skillCache.size > 0
                ? [...skillCache.keys()].map((n) => `"${n}"`).join(", ")
                : "none (skill cache empty)";
        const msg = `Unknown skill${unresolved.length > 1 ? "s" : ""}: ${unresolved.map((n) => `"${n}"`).join(", ")}. Available: ${available}.`;
        return { error: msg };
    }
    return {
        paths: skillNames.map((name) => skillCache.get(name)!.filePath),
    };
}

// ── Agent config resolution ──────────────────────────────────────────

/**
 * Validate params and resolve the final ResolvedAgent.
 * Returns a ResolvedAgent on success, or an error string on failure.
 */
export function resolveAgentConfig(
    params: SubagentToolParams,
    agents: AgentSpec[],
    skillCache: Map<string, Skill>,
    opts: ResolveAgentConfigOptions,
): ResolvedAgent | string {
    const agent = agents.find((a) => a.name === params.agent);
    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return `Unknown agent: "${params.agent}". Available agents: ${available}.`;
    }

    const skillNames =
        params.skills !== undefined ? params.skills : agent.skillNames;
    const skillResult = resolveSkills(skillNames, skillCache);
    if (skillResult.error) {
        return skillResult.error;
    }

    const resolvedModelStr = (params.model || undefined) ?? agent.model;
    const resolvedModel = resolvedModelStr
        ? parseModelString(resolvedModelStr)
        : opts.parentModel;
    if (!resolvedModel) {
        return resolvedModelStr
            ? `Invalid model: "${resolvedModelStr}". Expected "provider/name" or "provider/name:thinking".`
            : "No model available: agent has no default model and no parent model is set.";
    }

    if (resolvedModelStr) {
        resolvedModel.contextWindow =
            opts.getContextWindow(resolvedModel.provider, resolvedModel.name) ??
            opts.parentModel?.contextWindow;
    }

    return {
        name: agent.name,
        tools: agent.tools,
        skillPaths: skillResult.paths,
        model: resolvedModel,
        systemPrompt: agent.systemPrompt,
        source: agent.source,
    };
}

// ── Session path derivation ──────────────────────────────────────────

/** Derive a subagent session directory and ID from the parent session. */
export function deriveSessionPath(
    agentName: string,
    sessionFile: string | undefined,
): { dir: string; id: string } | undefined {
    if (!sessionFile) return undefined;
    const dir = path.resolve(sessionFile.slice(0, -".jsonl".length), "subagent");
    const id = `${agentName}-${randomUUID().slice(0, 8)}`;
    return { dir, id };
}

/**
 * Derive a fork session path in the same directory as the original.
 * Uses the same ID scheme as deriveSessionPath: `${agentName}-${randomUUID().slice(0, 8)}`.
 * Retries if the generated ID matches originalSession.id.
 */
export function deriveForkSessionPath(
    originalSession: { dir: string; id: string },
    agentName: string,
): { dir: string; id: string } {
    let id: string;
    do {
        id = `${agentName}-${randomUUID().slice(0, 8)}`;
    } while (id === originalSession.id);
    return { dir: originalSession.dir, id };
}

// ── Persistence lifecycle ────────────────────────────────────────────

/** Strip systemPrompt from ResolvedAgent for session persistence. */
export function persistAgent(agent: ResolvedAgent): PersistedResolvedAgent {
    const { systemPrompt: _, ...rest } = agent;
    return rest;
}

/**
 * Re-hydrate a PersistedResolvedAgent back to a full ResolvedAgent.
 *
 * Completes the resolve/persist/hydrate lifecycle:
 * - resolveAgentConfig() builds a ResolvedAgent from params + registry
 * - persistAgent() strips the systemPrompt for storage
 * - hydrateResolvedAgent() re-attaches the prompt from the registry
 *
 * Returns undefined when the agent is no longer in the registry.
 */
export function hydrateResolvedAgent(
    persisted: PersistedResolvedAgent,
    agents: AgentSpec[],
): ResolvedAgent | undefined {
    const agent = agents.find((a) => a.name === persisted.name);
    if (!agent) return undefined;
    return { ...persisted, systemPrompt: agent.systemPrompt };
}
