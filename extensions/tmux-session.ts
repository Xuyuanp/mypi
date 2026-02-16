/**
 * Tmux Session Extension
 *
 * Manages a tmux user option `@pi-session` to track whether a pi session
 * is active in the current tmux pane.
 *
 * Behavior:
 * - On session_start: if not in tmux, do nothing. If @pi-session is already
 *   set, skip (another pi instance owns it) and mark as "not owner".
 *   Otherwise, set @pi-session to 1.
 * - On session_shutdown: unset @pi-session only if this instance set it.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
    let isOwner = false;

    function inTmux(): boolean {
        return !!process.env.TMUX;
    }

    async function getTmuxOption(): Promise<string | undefined> {
        const { stdout, code } = await pi.exec("tmux", [
            "show-options",
            "-g",
            "-v",
            "@pi-session",
        ]);
        if (code !== 0) return undefined;
        return stdout.trim() || undefined;
    }

    async function setTmuxOption(): Promise<void> {
        await pi.exec("tmux", ["set-option", "-g", "@pi-session", "1"]);
    }

    async function unsetTmuxOption(): Promise<void> {
        await pi.exec("tmux", ["set-option", "-g", "-u", "@pi-session"]);
    }

    pi.on("session_start", async () => {
        if (!inTmux()) return;

        const current = await getTmuxOption();
        if (current) {
            // Another pi instance already owns this flag — don't touch it
            isOwner = false;
            return;
        }

        await setTmuxOption();
        isOwner = true;
    });

    pi.on("session_shutdown", async () => {
        if (!inTmux() || !isOwner) return;
        await unsetTmuxOption();
        isOwner = false;
    });
}
