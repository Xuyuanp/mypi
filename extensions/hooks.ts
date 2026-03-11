/**
 * Hooks Extension
 *
 * Attach hook commands to tool lifecycle events. Hooks run shell commands
 * before (pre) or after (post) a tool executes.
 *
 * The event is sent to the hook command via stdin as a JSON object.
 *
 * Pre hooks receive:
 * {
 *   "event": "PreToolUse",
 *   "toolName": "edit",
 *   "toolCallId": "...",
 *   "input": { "path": "...", "oldText": "...", "newText": "..." }
 * }
 *
 * Post hooks receive:
 * {
 *   "event": "PostToolUse",
 *   "toolName": "edit",
 *   "toolCallId": "...",
 *   "input": { ... },
 *   "content": [ ... ],
 *   "isError": false
 * }
 *
 * Exit codes (PreToolUse):
 *   0   — allow (tool proceeds)
 *   1   — warn and allow (stderr shown as warning)
 *   2   — block (stderr shown as error)
 *   other — prompt the user to allow or block
 *
 * Input rewriting (PreToolUse only):
 *   Pre hooks may write JSON to stdout to rewrite tool input before
 *   execution. The JSON must contain an "updatedInput" object whose
 *   fields are shallow-merged into the original tool input.
 *
 *   Example stdout: { "updatedInput": { "command": "rtk git status" } }
 *
 *   - Exit 0 + updatedInput → rewrite and allow
 *   - Exit 1 + updatedInput → warn, rewrite, and allow
 *   - Exit 2               → block (stdout ignored)
 *   - Empty or non-JSON stdout → input unchanged (backward compatible)
 *
 * Exit codes (PostToolUse):
 *   0   — success (result unchanged)
 *   ≠0  — stderr appended to result
 *
 * Matchers are regex patterns tested against the tool name (case-insensitive).
 * Omit `matcher` or use "*" to match all tools.
 *
 * Configuration is loaded from `.pi/hooks.json` (project-local) and/or
 * `~/.pi/agent/hooks.json` (global). Both are merged, with project-local
 * hooks appended after global hooks.
 *
 * Example `.pi/hooks.json`:
 * {
 *   "PreToolUse": [
 *     {
 *       "matcher": "bash",
 *       "hooks": [
 *         { "name": "safety-gate", "command": ["node", "check_command.js"], "timeout": 10000 }
 *       ]
 *     }
 *   ],
 *   "PostToolUse": [
 *     {
 *       "matcher": "edit|write",
 *       "hooks": [
 *         { "name": "lint", "command": ["./lint-changed.sh"] }
 *       ]
 *     }
 *   ]
 * }
 *
 * Each hook has an optional `name` for display purposes. The `scope` field
 * ("global" or "project") is added automatically based on which config file
 * the hook was loaded from.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────

type HookScope = "global" | "project";

interface HookHandler {
    name?: string;
    command: string[];
    timeout?: number;
    scope: HookScope;
}

interface MatcherGroup {
    matcher?: string;
    hooks: HookHandler[];
    /** Compiled regex — populated at load time */
    _re?: RegExp;
}

interface HooksConfig {
    PreToolUse: MatcherGroup[];
    PostToolUse: MatcherGroup[];
}

interface RawHookHandler {
    name?: string;
    command: string[];
    timeout?: number;
}

interface RawMatcherGroup {
    matcher?: string;
    hooks: RawHookHandler[];
}

// ── Config loading ─────────────────────────────────────────────────────

function compileMatcher(group: MatcherGroup): void {
    if (!group.matcher || group.matcher === "*") {
        group._re = undefined; // matches everything
    } else {
        try {
            group._re = new RegExp(`^(?:${group.matcher})$`, "i");
        } catch {
            group._re = undefined; // fallback: match everything on bad regex
        }
    }
}

function matchesTool(group: MatcherGroup, toolName: string): boolean {
    if (!group._re) return true; // no matcher or "*" — match all
    return group._re.test(toolName);
}

function loadConfigFile(filePath: string, scope: HookScope): HooksConfig | null {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;

        const config: HooksConfig = { PreToolUse: [], PostToolUse: [] };

        for (const phase of ["PreToolUse", "PostToolUse"] as const) {
            const rawGroups = parsed[phase] as RawMatcherGroup[] | undefined;
            if (!Array.isArray(rawGroups)) continue;
            for (const rg of rawGroups) {
                const group: MatcherGroup = {
                    matcher: rg.matcher,
                    hooks: (rg.hooks ?? []).map((h) => ({ ...h, scope })),
                };
                compileMatcher(group);
                config[phase].push(group);
            }
        }

        if (config.PreToolUse.length === 0 && config.PostToolUse.length === 0)
            return null;
        return config;
    } catch {
        return null;
    }
}

function mergeConfigs(...configs: (HooksConfig | null)[]): HooksConfig {
    const merged: HooksConfig = { PreToolUse: [], PostToolUse: [] };
    for (const config of configs) {
        if (!config) continue;
        merged.PreToolUse.push(...config.PreToolUse);
        merged.PostToolUse.push(...config.PostToolUse);
    }
    return merged;
}

// ── Hook execution ─────────────────────────────────────────────────────

function resolveHookCwd(hook: HookHandler, projectCwd: string): string {
    return hook.scope === "project"
        ? projectCwd
        : path.join(os.homedir(), ".pi", "agent");
}

function runHook(
    hook: HookHandler,
    eventPayload: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeout: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const [cmd, ...args] = hook.command;
        const child = spawn(cmd, args, {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: timeout,
            env,
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on("error", (err) => {
            resolve({
                code: 1,
                stdout: "",
                stderr: `Hook failed to execute: ${err.message}`,
            });
        });

        child.on("close", (code) => {
            resolve({
                code: code ?? 1,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
            });
        });

        child.stdin.on("error", () => {
            // Ignore EPIPE — child exited without reading stdin
        });
        child.stdin.write(eventPayload);
        child.stdin.end();
    });
}

/** Parse hook stdout for an updatedInput object. Returns null if absent or invalid. */
function parseUpdatedInput(stdout: string): Record<string, unknown> | null {
    if (!stdout) return null;
    try {
        const parsed = JSON.parse(stdout);
        if (
            parsed &&
            typeof parsed === "object" &&
            parsed.updatedInput &&
            typeof parsed.updatedInput === "object" &&
            !Array.isArray(parsed.updatedInput)
        ) {
            return parsed.updatedInput as Record<string, unknown>;
        }
    } catch {
        // Not JSON or malformed — no rewrite
    }
    return null;
}

/** Shallow-merge updatedInput from hook stdout into the tool event input. */
function applyUpdatedInput(
    event: { input: Record<string, unknown> },
    stdout: string,
): void {
    const updated = parseUpdatedInput(stdout);
    if (!updated) return;
    for (const [key, value] of Object.entries(updated)) {
        event.input[key] = value;
    }
}

/** Collect all hooks matching a tool name from a list of matcher groups. */
function collectHooks(groups: MatcherGroup[], toolName: string): HookHandler[] {
    const result: HookHandler[] = [];
    for (const group of groups) {
        if (matchesTool(group, toolName)) {
            result.push(...group.hooks);
        }
    }
    return result;
}

// ── Display helpers ────────────────────────────────────────────────────

function hookDisplayName(hook: HookHandler): string {
    if (hook.name) return `${hook.name} (${hook.scope})`;
    return `${hook.command.join(" ")} (${hook.scope})`;
}

function formatSummary(config: HooksConfig): string {
    const lines: string[] = [];
    for (const phase of ["PreToolUse", "PostToolUse"] as const) {
        for (const group of config[phase]) {
            const matcher = group.matcher || "*";
            for (const hook of group.hooks) {
                lines.push(`  ${phase} [${matcher}] → ${hookDisplayName(hook)}`);
            }
        }
    }
    return lines.join("\n");
}

function countHooks(config: HooksConfig): number {
    let count = 0;
    for (const phase of ["PreToolUse", "PostToolUse"] as const) {
        for (const group of config[phase]) {
            count += group.hooks.length;
        }
    }
    return count;
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let config: HooksConfig = { PreToolUse: [], PostToolUse: [] };

    function reloadConfig(cwd: string) {
        const globalPath = path.join(os.homedir(), ".pi", "agent", "hooks.json");
        const projectPath = path.join(cwd, ".pi", "hooks.json");
        config = mergeConfigs(
            loadConfigFile(globalPath, "global"),
            loadConfigFile(projectPath, "project"),
        );
    }

    pi.on("session_start", async (_event, ctx) => {
        reloadConfig(ctx.cwd);
        const total = countHooks(config);
        if (total > 0) {
            ctx.ui.notify(
                `Hooks loaded (${total}):\n${formatSummary(config)}`,
                "info",
            );
        }
    });

    pi.registerCommand("hooks-reload", {
        description: "Reload hooks configuration",
        handler: async (_args, ctx) => {
            reloadConfig(ctx.cwd);
            const total = countHooks(config);
            if (total > 0) {
                ctx.ui.notify(
                    `Hooks reloaded (${total}):\n${formatSummary(config)}`,
                    "info",
                );
            } else {
                ctx.ui.notify("Hooks reloaded: no hooks configured", "info");
            }
        },
    });

    // ── Pre-tool hooks (can block) ─────────────────────────────────────

    pi.on("tool_call", async (event, ctx) => {
        const hooks = collectHooks(config.PreToolUse, event.toolName);
        if (hooks.length === 0) return undefined;

        const env = { ...process.env, PI_PROJECT_DIR: ctx.cwd };
        const payload = JSON.stringify({
            event: "PreToolUse",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: event.input,
        });

        for (const hook of hooks) {
            const timeout = hook.timeout ?? 30000;
            const cwd = resolveHookCwd(hook, ctx.cwd);
            const result = await runHook(hook, payload, cwd, env, timeout);

            if (result.code === 0) {
                applyUpdatedInput(event, result.stdout);
                continue;
            }

            const label = hookDisplayName(hook);

            if (result.code === 1) {
                const msg = result.stderr
                    ? `Hook [${label}] warning: ${result.stderr}`
                    : `Hook [${label}] exited with code ${result.code}`;
                ctx.ui.notify(msg, "warning");
                applyUpdatedInput(event, result.stdout);
                continue;
            }

            const reason = result.stderr
                ? `Hook [${label}] blocked: ${result.stderr}`
                : `Hook [${label}] exited with code ${result.code}`;

            if (result.code === 2) {
                ctx.ui.notify(reason, "error");
                return { block: true, reason };
            }

            // Other exit codes: ask user
            if (ctx.hasUI) {
                const choice = await ctx.ui.select(
                    `⚠️ ${reason}\n\nAllow this tool call?`,
                    ["Yes, continue", "No, block"],
                );
                if (choice === "Yes, continue") continue;
            }
            return { block: true, reason };
        }

        return undefined;
    });

    // ── Post-tool hooks (can modify result) ────────────────────────────

    pi.on("tool_result", async (event, ctx) => {
        const hooks = collectHooks(config.PostToolUse, event.toolName);
        if (hooks.length === 0) return undefined;

        const env = { ...process.env, PI_PROJECT_DIR: ctx.cwd };
        const payload = JSON.stringify({
            event: "PostToolUse",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: event.input,
            content: event.content,
            isError: event.isError,
        });

        const errors: string[] = [];

        for (const hook of hooks) {
            const timeout = hook.timeout ?? 30000;
            const cwd = resolveHookCwd(hook, ctx.cwd);
            const result = await runHook(hook, payload, cwd, env, timeout);

            if (result.code !== 0) {
                const label = hookDisplayName(hook);
                const msg = result.stderr
                    ? `Hook [${label}]: ${result.stderr}`
                    : `Hook [${label}] exited with code ${result.code}`;
                errors.push(msg);
            }
        }

        if (errors.length > 0) {
            const feedback = errors.join("\n");
            return {
                content: [
                    ...event.content,
                    {
                        type: "text" as const,
                        text: `\n\n[Post-hook feedback]\n${feedback}`,
                    },
                ],
            };
        }

        return undefined;
    });
}
