/**
 * Pi Notify Extension
 *
 * Sends a macOS notification via `alerter` when Pi agent is done and waiting for input.
 * The notification shows the pi session name and tmux session context.
 * Clicking the notification switches to the tmux session/pane where pi is running.
 * Closing the notification does nothing.
 *
 * Optional: set PI_NOTIFY_SOUND_CMD to play a custom sound alongside the notification.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile, spawn } from "node:child_process";

const ALERTER_TIMEOUT = 10;

function getTmuxTarget(): string | undefined {
    const paneId = process.env.TMUX_PANE;
    if (!paneId || !process.env.TMUX) return undefined;
    return paneId;
}

function buildSwitchCommand(paneId: string): string {
    return `tmux switch-client -t "${paneId}" && tmux select-pane -t "${paneId}"`;
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

function notify(sessionName: string): void {
    const tmuxTarget = getTmuxTarget();

    const title = `Pi - ${sessionName}`;
    const body = tmuxTarget
        ? `Ready for input (tmux pane ${tmuxTarget})`
        : "Ready for input";

    const args = [
        "--title",
        title,
        "--message",
        body,
        "--timeout",
        String(ALERTER_TIMEOUT),
        "--json",
    ];

    if (process.env.PI_NOTIFY_SOUND) {
        args.push("--sound", process.env.PI_NOTIFY_SOUND);
    }

    if (tmuxTarget) {
        args.push("--group", `pi-${tmuxTarget}`);
    }

    const child = execFile("alerter", args, (error, stdout) => {
        if (error || !tmuxTarget) return;

        try {
            const result = JSON.parse(stdout);
            if (result.activationType === "contentsClicked") {
                const switchCmd = buildSwitchCommand(tmuxTarget);
                const sh = spawn("bash", ["-c", switchCmd], {
                    detached: true,
                    stdio: "ignore",
                });
                sh.unref();
            }
        } catch { }
    });
    child.unref();

    runSoundHook();
}

export default function(pi: ExtensionAPI) {
    pi.on("agent_end", async (_event, ctx) => {
        if (!ctx.hasUI) {
            return;
        }

        const sessionName = ctx.sessionManager.getSessionName() ?? "noname";
        notify(sessionName);
    });
}
