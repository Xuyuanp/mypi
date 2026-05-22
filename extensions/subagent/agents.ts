/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_AGENTS_DIR = path.join(__dirname, "agents");

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    source: "user" | "system";
    filePath: string;
}

export interface AgentDiscoveryResult {
    agents: AgentConfig[];
}

function loadAgentsFromDir(dir: string, source: "user" | "system"): AgentConfig[] {
    const agents: AgentConfig[] = [];

    if (!fs.existsSync(dir)) {
        return agents;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return agents;
    }

    for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;

        const filePath = path.join(dir, entry.name);
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        const { frontmatter, body } =
            parseFrontmatter<Record<string, string>>(content);

        if (!frontmatter.name || !frontmatter.description) {
            continue;
        }

        const tools = frontmatter.tools
            ?.split(",")
            .map((t: string) => t.trim())
            .filter(Boolean);

        agents.push({
            name: frontmatter.name,
            description: frontmatter.description,
            tools: tools && tools.length > 0 ? tools : undefined,
            model: frontmatter.model,
            systemPrompt: body,
            source,
            filePath,
        });
    }

    return agents;
}

export function discoverAgents(): AgentDiscoveryResult {
    const userDir = path.join(getAgentDir(), "agents");

    const systemAgents = loadAgentsFromDir(SYSTEM_AGENTS_DIR, "system");
    const userAgents = loadAgentsFromDir(userDir, "user");

    const agentMap = new Map<string, AgentConfig>();

    // System agents have lowest priority (overridden by user)
    for (const agent of systemAgents) agentMap.set(agent.name, agent);
    for (const agent of userAgents) agentMap.set(agent.name, agent);

    return { agents: Array.from(agentMap.values()) };
}

export function formatAgentList(
    agents: AgentConfig[],
    maxItems: number,
): { text: string; remaining: number } {
    if (agents.length === 0) return { text: "none", remaining: 0 };
    const listed = agents.slice(0, maxItems);
    const remaining = agents.length - listed.length;
    return {
        text: listed
            .map((a) => `${a.name} (${a.source}): ${a.description}`)
            .join("; "),
        remaining,
    };
}
