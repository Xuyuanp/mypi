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
 *   PI_NOTIFY_SOUND - macOS sound name for alerter (default: "default")
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Exec = ExtensionAPI["exec"];

const NOTIFY_TIMEOUT_SECONDS = 20;

interface Notification {
    title: string;
    subtitle: string;
    message: string;
}

interface TmuxContext {
    sessionName: string;
    windowIndex: string;
    paneIndex: string;
    paneId: string;
}

type FocusState = "exact" | "terminal" | "away";

async function getTmuxContext(exec: Exec): Promise<TmuxContext | undefined> {
    const paneId = process.env.TMUX_PANE;
    if (!paneId || !process.env.TMUX) return undefined;

    try {
        const { stdout, code } = await exec("tmux", [
            "display-message",
            "-t",
            paneId,
            "-p",
            "#{session_name} #{window_index} #{pane_index} #{pane_id}",
        ]);
        if (code !== 0) return undefined;
        const [sessionName, windowIndex, paneIndex, resolvedPaneId] = stdout
            .trim()
            .split(" ");
        if (!sessionName || !windowIndex || !paneIndex || !resolvedPaneId)
            return undefined;
        return { sessionName, windowIndex, paneIndex, paneId: resolvedPaneId };
    } catch {
        return undefined;
    }
}

async function isGhosttyFocused(exec: Exec): Promise<boolean> {
    try {
        const { stdout: asn, code: c1 } = await exec("lsappinfo", ["front"]);
        if (c1 !== 0) return false;
        const { stdout: info, code: c2 } = await exec("lsappinfo", [
            "info",
            "-only",
            "name",
            asn.trim(),
        ]);
        if (c2 !== 0) return false;
        return info.toLowerCase().includes("ghostty");
    } catch {
        return false;
    }
}

async function isPaneActive(paneId: string, exec: Exec): Promise<boolean> {
    try {
        const { stdout, code } = await exec("tmux", [
            "display-message",
            "-t",
            paneId,
            "-p",
            "#{pane_active} #{window_active} #{session_attached}",
        ]);
        if (code !== 0) return false;
        const [paneActive, windowActive, sessionAttached] = stdout
            .trim()
            .split(" ");
        return (
            paneActive === "1" && windowActive === "1" && Number(sessionAttached) >= 1
        );
    } catch {
        return false;
    }
}

async function getFocusState(paneId: string, exec: Exec): Promise<FocusState> {
    const ghosttyFocused = await isGhosttyFocused(exec);
    if (!ghosttyFocused) return "away";

    const paneActive = await isPaneActive(paneId, exec);
    return paneActive ? "exact" : "terminal";
}

async function getTmuxClients(exec: Exec): Promise<string[]> {
    try {
        const { stdout, code } = await exec("tmux", [
            "list-clients",
            "-F",
            "#{client_name}",
        ]);
        if (code !== 0) return [];
        return stdout.trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

async function notifyTmux(
    notification: Notification,
    exec: Exec,
): Promise<void> {
    const message = `${notification.title} (${notification.subtitle}) | ${notification.message}`;

    const clients = await getTmuxClients(exec);
    await Promise.allSettled(
        clients.map((client) =>
            exec("tmux", [
                "display-message",
                "-d",
                String(NOTIFY_TIMEOUT_SECONDS * 1000),
                "-c",
                client,
                message,
            ]),
        ),
    );
}

async function focusPane(tmux: TmuxContext, exec: Exec): Promise<void> {
    const target = `${tmux.sessionName}:${tmux.windowIndex}`;
    await exec("osascript", ["-e", 'tell application "ghostty" to activate']);
    await exec("tmux", ["switch-client", "-t", target]);
    await exec("tmux", ["select-pane", "-t", tmux.paneId]);
}

function notifySystem(
    notification: Notification,
    tmux: TmuxContext,
    exec: Exec,
): void {
    const args = [
        "--title",
        notification.title,
        "--subtitle",
        notification.subtitle,
        "--message",
        notification.message,
        "--timeout",
        String(NOTIFY_TIMEOUT_SECONDS),
        "--json",
        "--group",
        `pi-${tmux.paneId}`,
        "--sound",
        process.env.PI_NOTIFY_SOUND || "default",
    ];

    exec("alerter", args)
        .then(({ stdout }) => {
            try {
                const result = JSON.parse(stdout);
                if (result.activationType === "contentsClicked") {
                    focusPane(tmux, exec).catch(() => { });
                }
            } catch { }
        })
        .catch(() => { });
}

function buildNotification(
    piSessionName: string,
    message: string,
    tmux: TmuxContext | undefined,
): Notification {
    const subtitle = tmux
        ? `${tmux.sessionName}:${tmux.windowIndex}.${tmux.paneIndex}`
        : "unknown:0.0";
    return {
        title: `[Pi] - ${piSessionName}`,
        subtitle,
        message,
    };
}

async function sendNotification(
    piSessionName: string,
    message: string,
    tmuxContext: TmuxContext | undefined,
    exec: Exec,
): Promise<void> {
    const notification = buildNotification(piSessionName, message, tmuxContext);

    if (!tmuxContext) {
        notifySystem(
            notification,
            {
                sessionName: "unknown",
                windowIndex: "0",
                paneIndex: "0",
                paneId: process.env.TMUX_PANE ?? "",
            },
            exec,
        );
        return;
    }

    const state = await getFocusState(tmuxContext.paneId, exec);

    if (state === "exact") return;

    if (state === "terminal") {
        await notifyTmux(notification, exec);
    } else {
        notifySystem(notification, tmuxContext, exec);
    }
}

export default function(pi: ExtensionAPI) {
    let tmuxContext: TmuxContext | undefined;

    getTmuxContext(pi.exec).then((resolved) => {
        tmuxContext = resolved;
    });

    async function notify(
        ctx: {
            hasUI: boolean;
            sessionManager: { getSessionName(): string | undefined };
        },
        message: string,
    ): Promise<void> {
        if (!ctx.hasUI) return;
        const piSessionName = ctx.sessionManager.getSessionName() ?? "noname";
        await sendNotification(piSessionName, message, tmuxContext, pi.exec);
    }

    pi.on("agent_end", async (_event, ctx) => {
        await notify(ctx, "Ready for input");
    });

    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName === "questionnaire") {
            await notify(ctx, "Question waiting for answer");
        }
    });
}
