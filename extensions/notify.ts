/**
 * Pi Notify Extension
 *
 * Sends a notification when Pi agent is done and waiting for input.
 * Routes notifications based on focus state:
 *   - Focused on pi's exact tmux pane: do nothing
 *   - Ghostty focused but different pane/session: tmux status-bar message
 *   - Ghostty not focused: macOS system notification via `alerter`
 *
 * The tmux message includes session:window.pane so you know where to go.
 * Clicking the system notification activates Ghostty and switches to the
 * correct tmux session/window/pane.
 *
 * Optional env vars:
 *   PI_NOTIFY_SOUND_CMD - shell command to play a custom sound
 *   PI_NOTIFY_SOUND     - macOS sound name for alerter
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ALERTER_TIMEOUT = 10;

interface TmuxContext {
    sessionName: string;
    windowIndex: string;
    paneIndex: string;
    paneId: string;
}

type FocusState = "exact" | "terminal" | "away";

async function getTmuxContext(): Promise<TmuxContext | undefined> {
    const paneId = process.env.TMUX_PANE;
    if (!paneId || !process.env.TMUX) return undefined;

    try {
        const { stdout } = await execFileAsync("tmux", [
            "display-message", "-t", paneId, "-p",
            "#{session_name} #{window_index} #{pane_index} #{pane_id}",
        ]);
        const [sessionName, windowIndex, paneIndex, resolvedPaneId] = stdout.trim().split(" ");
        if (!sessionName || !windowIndex || !paneIndex || !resolvedPaneId) return undefined;
        return { sessionName, windowIndex, paneIndex, paneId: resolvedPaneId };
    } catch {
        return undefined;
    }
}

async function isGhosttyFocused(): Promise<boolean> {
    try {
        const { stdout: asn } = await execFileAsync("lsappinfo", ["front"]);
        const { stdout: info } = await execFileAsync("lsappinfo", [
            "info", "-only", "name", asn.trim(),
        ]);
        return info.toLowerCase().includes("ghostty");
    } catch {
        return false;
    }
}

async function isPaneActive(paneId: string): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync("tmux", [
            "display-message", "-t", paneId, "-p",
            "#{pane_active} #{window_active} #{session_attached}",
        ]);
        const [paneActive, windowActive, sessionAttached] = stdout.trim().split(" ");
        return paneActive === "1" && windowActive === "1" && Number(sessionAttached) >= 1;
    } catch {
        return false;
    }
}

async function getFocusState(paneId: string): Promise<FocusState> {
    const ghosttyFocused = await isGhosttyFocused();
    if (!ghosttyFocused) return "away";

    const paneActive = await isPaneActive(paneId);
    return paneActive ? "exact" : "terminal";
}

function formatTmuxTarget(ctx: TmuxContext): string {
    return `${ctx.sessionName}:${ctx.windowIndex}.${ctx.paneIndex}`;
}

async function getTmuxClients(): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync("tmux", [
            "list-clients", "-F", "#{client_name}",
        ]);
        return stdout.trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

async function notifyTmux(piSessionName: string, ctx: TmuxContext): Promise<void> {
    const target = formatTmuxTarget(ctx);
    const message = `[Pi] ${piSessionName} ready | from ${target}`;

    const clients = await getTmuxClients();
    for (const client of clients) {
        try {
            const child = spawn("tmux", ["display-message", "-c", client, message], {
                detached: true,
                stdio: "ignore",
            });
            child.unref();
        } catch { }
    }
}

function buildFocusCommand(ctx: TmuxContext): string {
    const target = `${ctx.sessionName}:${ctx.windowIndex}`;
    return [
        `osascript -e 'tell application "ghostty" to activate'`,
        `tmux switch-client -t "${target}"`,
        `tmux select-pane -t "${ctx.paneId}"`,
    ].join(" && ");
}

function notifySystem(piSessionName: string, ctx: TmuxContext): void {
    const target = formatTmuxTarget(ctx);
    const title = `Pi - ${piSessionName}`;
    const body = `Ready for input (tmux ${target})`;

    const args = [
        "--title", title,
        "--message", body,
        "--timeout", String(ALERTER_TIMEOUT),
        "--json",
        "--group", `pi-${ctx.paneId}`,
    ];

    if (process.env.PI_NOTIFY_SOUND) {
        args.push("--sound", process.env.PI_NOTIFY_SOUND);
    }

    const child = execFile("alerter", args, (error, stdout) => {
        if (error) return;

        try {
            const result = JSON.parse(stdout);
            if (result.activationType === "contentsClicked") {
                const cmd = buildFocusCommand(ctx);
                const sh = spawn("bash", ["-c", cmd], {
                    detached: true,
                    stdio: "ignore",
                });
                sh.unref();
            }
        } catch { }
    });
    child.unref();
}

function runSoundHook(): void {
    const command = process.env.PI_NOTIFY_SOUND_CMD?.trim();
    if (!command) return;

    try {
        const child = spawn(command, {
            shell: true,
            detached: true,
            stdio: "ignore",
        });
        child.unref();
    } catch { }
}

export default function(pi: ExtensionAPI) {
    let tmuxContext: TmuxContext | undefined;

    getTmuxContext().then((ctx) => {
        tmuxContext = ctx;
    });

    pi.on("agent_end", async (_event, ctx) => {
        if (!ctx.hasUI) return;

        const piSessionName = ctx.sessionManager.getSessionName() ?? "noname";

        if (!tmuxContext) {
            notifySystem(piSessionName, {
                sessionName: "unknown",
                windowIndex: "0",
                paneIndex: "0",
                paneId: process.env.TMUX_PANE ?? "",
            });
            runSoundHook();
            return;
        }

        const state = await getFocusState(tmuxContext.paneId);

        if (state === "exact") return;

        if (state === "terminal") {
            await notifyTmux(piSessionName, tmuxContext);
        } else {
            notifySystem(piSessionName, tmuxContext);
        }

        runSoundHook();
    });
}
