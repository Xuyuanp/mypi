/**
 * File Guard Extension
 *
 * Prevents the LLM from editing files it hasn't read, or files that have
 * been modified since the last read. Acts as a safety net against blind
 * edits and stale-context overwrites.
 *
 * Mechanism:
 *   - On `tool_call` for `read`: stat() the file and store its mtime
 *     before the read executes.
 *   - On `tool_result` for `read` with isError: roll back the tracked
 *     entry so a failed read does not count as "read".
 *   - On `tool_call` for `edit`/`write`: check whether the file has been
 *     read and whether its mtime still matches. Block if not.
 *   - On `tool_result` for `edit`/`write`: update the stored mtime so
 *     subsequent edits to the same file are not blocked by the agent's
 *     own prior mutation.
 *
 * State is in-memory only and cleared on session_start.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Path resolution ────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
    let p = filePath.startsWith("@") ? filePath.slice(1) : filePath;
    if (p === "~" || p.startsWith("~/")) {
        p = homedir() + p.slice(1);
    }
    return isAbsolute(p) ? p : resolve(cwd, p);
}

// ── FileTracker ────────────────────────────────────────────────────────

type TrackResult = { tracked: true } | { tracked: false; reason: "not_file" };

type CheckResult =
    | { allowed: true }
    | { allowed: false; reason: "not_tracked" | "mtime_mismatch" };

class FileTracker {
    private mtimes = new Map<string, number>();

    /** Reset all tracked state. */
    clear(): void {
        this.mtimes.clear();
    }

    /**
     * Record the current mtime of a file. Call before the read executes.
     * Skips directories and unreadable paths.
     */
    async track(absolutePath: string): Promise<TrackResult> {
        try {
            const s = await stat(absolutePath);
            if (!s.isFile()) return { tracked: false, reason: "not_file" };
            this.mtimes.set(absolutePath, s.mtimeMs);
            return { tracked: true };
        } catch {
            return { tracked: false, reason: "not_file" };
        }
    }

    /**
     * Check whether an edit/write to this file should be allowed.
     * Returns { allowed: true } for new files (stat fails with ENOENT).
     * Fails closed on other stat errors (EACCES, EPERM, IO errors).
     */
    async check(absolutePath: string): Promise<CheckResult> {
        let currentMtimeMs: number;
        try {
            const s = await stat(absolutePath);
            currentMtimeMs = s.mtimeMs;
        } catch (err: unknown) {
            // Only treat missing-path errors as "new file".
            // All other errors (EACCES, EPERM, IO) fail closed.
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT" || code === "ENOTDIR") {
                return { allowed: true };
            }
            return { allowed: false, reason: "not_tracked" };
        }

        const storedMtime = this.mtimes.get(absolutePath);
        if (storedMtime === undefined) {
            return { allowed: false, reason: "not_tracked" };
        }

        if (currentMtimeMs !== storedMtime) {
            return { allowed: false, reason: "mtime_mismatch" };
        }

        return { allowed: true };
    }

    /**
     * Remove a tracked entry. Used to roll back after a failed read.
     */
    untrack(absolutePath: string): void {
        this.mtimes.delete(absolutePath);
    }

    /**
     * Update the stored mtime after a successful edit/write.
     * Silently ignores stat failures.
     */
    async update(absolutePath: string): Promise<void> {
        try {
            const s = await stat(absolutePath);
            this.mtimes.set(absolutePath, s.mtimeMs);
        } catch {}
    }
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    const tracker = new FileTracker();

    pi.on("session_start", async () => {
        tracker.clear();
    });

    pi.on("tool_call", async (event, ctx) => {
        if (
            event.toolName !== "read" &&
            event.toolName !== "edit" &&
            event.toolName !== "write"
        ) {
            return;
        }

        const rawPath = (event.input as { path?: string }).path;
        if (!rawPath) return;

        const absolutePath = resolvePath(rawPath, ctx.cwd);

        if (event.toolName === "read") {
            await tracker.track(absolutePath);
            return;
        }

        // edit / write — gate against stored mtime
        const result = await tracker.check(absolutePath);
        if (result.allowed) return undefined;

        const message =
            result.reason === "not_tracked"
                ? `File "${rawPath}" has not been read in this session. ` +
                  "Read the file first before editing."
                : `File "${rawPath}" has been modified since it was ` +
                  "last read (mtime mismatch). Read the file again " +
                  "before editing.";

        return { block: true, reason: message };
    });

    pi.on("tool_result", async (event, ctx) => {
        const rawPath = (event.input as { path?: string }).path;
        if (!rawPath) return;

        const absolutePath = resolvePath(rawPath, ctx.cwd);

        // Failed read: roll back the optimistic track() from tool_call
        if (event.toolName === "read") {
            if (event.isError) {
                tracker.untrack(absolutePath);
            }
            // Successful reads: no action needed. The mtime was
            // captured in tool_call before execution — re-statting
            // here would introduce the T1-T2 race (file modified
            // between read execution and this handler).
            return;
        }

        // Successful edit/write: update stored mtime
        if (
            (event.toolName === "edit" || event.toolName === "write") &&
            !event.isError
        ) {
            await tracker.update(absolutePath);
        }
    });
}
