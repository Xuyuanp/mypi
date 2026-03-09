/**
 * Tmux Pane Status Extension
 *
 * Maintains pane-scoped tmux user options that reflect pi session state.
 * External tools (tmux status bar, scripts) can read these to display
 * session info.
 *
 * Options (all pane-level via `set-option -p -t <paneId>`):
 *   @pi-session-running       "1" while a pi session owns this pane
 *   @pi-session-name          session display name (e.g. "Debug 500 errors")
 *   @pi-session-status        "idle" | "thinking" | "tool" | "input"
 *   @pi-session-status-updated-at  unix epoch (seconds) when status last changed
 *
 * Ownership: if @pi-session-running is already set when we start, another
 * pi instance owns this pane -- we stay inert.
 *
 * All tmux calls are fire-and-forget to avoid blocking the agent.
 * Requires tmux >= 3.0 for pane-level options (-p flag).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Status = "idle" | "thinking" | "tool" | "input";

const OPTION_RUNNING = "@pi-session-running";
const OPTION_NAME = "@pi-session-name";
const OPTION_STATUS = "@pi-session-status";
const OPTION_STATUS_UPDATED_AT = "@pi-session-status-updated-at";

const ALL_OPTIONS = [
    OPTION_RUNNING,
    OPTION_NAME,
    OPTION_STATUS,
    OPTION_STATUS_UPDATED_AT,
] as const;

export default function (pi: ExtensionAPI) {
    let isOwner = false;
    let paneId: string | undefined;
    let cachedName: string | undefined;

    function inTmux(): boolean {
        return !!process.env.TMUX && !!process.env.TMUX_PANE;
    }

    if (!inTmux()) return;

    async function getOption(key: string): Promise<string | undefined> {
        if (!paneId) return undefined;
        try {
            const { stdout, code } = await pi.exec("tmux", [
                "show-options",
                "-p",
                "-t",
                paneId,
                "-v",
                key,
            ]);
            if (code !== 0) return undefined;
            return stdout.trim() || undefined;
        } catch {
            return undefined;
        }
    }

    function setOption(key: string, value: string): void {
        if (!paneId) return;
        pi.exec("tmux", ["set-option", "-p", "-t", paneId, key, value]).catch(
            () => {},
        );
    }

    function unsetOption(key: string): void {
        if (!paneId) return;
        pi.exec("tmux", ["set-option", "-p", "-t", paneId, "-u", key]).catch(
            () => {},
        );
    }

    function unsetAll(): void {
        for (const key of ALL_OPTIONS) {
            unsetOption(key);
        }
    }

    function setStatus(status: Status): void {
        if (!isOwner) return;
        setOption(OPTION_STATUS, status);
        setOption(OPTION_STATUS_UPDATED_AT, String(Math.floor(Date.now() / 1000)));
    }

    function syncName(): void {
        if (!isOwner) return;
        const name = pi.getSessionName();
        if (name === cachedName) return;
        cachedName = name;
        if (name) {
            setOption(OPTION_NAME, name);
        } else {
            unsetOption(OPTION_NAME);
        }
    }

    // -- Lifecycle events --

    pi.on("session_start", async () => {
        paneId = process.env.TMUX_PANE;

        const current = await getOption(OPTION_RUNNING);
        if (current) {
            isOwner = false;
            return;
        }

        isOwner = true;
        setOption(OPTION_RUNNING, "1");
        setStatus("idle");
        syncName();
    });

    pi.on("session_switch", async () => {
        cachedName = undefined;
        syncName();
    });

    pi.on("turn_start", async () => {
        setStatus("thinking");
    });

    pi.on("tool_call", async (event) => {
        if (event.toolName === "questionnaire") {
            setStatus("input");
        }
    });

    pi.on("tool_execution_start", async () => {
        setStatus("tool");
    });

    pi.on("tool_execution_end", async () => {
        setStatus("thinking");
    });

    pi.on("turn_end", async () => {
        syncName();
    });

    pi.on("agent_end", async () => {
        setStatus("idle");
        syncName();
    });

    pi.on("session_shutdown", async () => {
        if (!inTmux() || !isOwner) return;
        unsetAll();
        isOwner = false;
    });
}
