/**
 * Interactive Shell Extension
 *
 * Provides full terminal access for interactive commands.
 * Commands run in an alternate screen buffer so the conversation
 * is preserved underneath and restored without re-scrolling.
 *
 * Commands:
 *   /edit [path]         # Open $EDITOR (defaults to nvim)
 *   /shell [command]     # Open $SHELL, optionally running a command
 *   /view                # View last assistant message in editor (readonly)
 *   /nvim-review [files] # Open files in Neovim review mode
 *
 * Shortcuts:
 *   ctrl+g               # Open editor content in external editor
 *   ctrl+shift+v         # View last assistant message in editor (readonly)
 */

import { spawnSync } from "node:child_process";
import {
    closeSync,
    constants,
    existsSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";

type ReadonlySessionManager = ExtensionCommandContext["sessionManager"];

function saveTtyState(): string | null {
    const result = spawnSync("stty", ["-g"], {
        stdio: ["inherit", "pipe", "pipe"],
        encoding: "utf-8",
    });
    return result.status === 0 ? result.stdout.trim() : null;
}

function restoreTtyState(saved: string): void {
    spawnSync("stty", [saved], { stdio: "inherit" });
}

async function forceRerender(ui: ExtensionUIContext): Promise<void> {
    // Clear terminal to invalidate any stale screen content
    writeToTty("\x1b[2J\x1b[H");
    // Open and close a custom UI to force the TUI to do a full re-render
    await ui.custom<void>((tui, _theme, _kb, done) => {
        tui.requestRender(true);
        setTimeout(() => done(undefined), 100);
        return { render: () => [], invalidate: () => {} };
    });
}

// Detect /dev/tty once; it won't appear mid-process.
const hasDevTty = (() => {
    try {
        const fd = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
        closeSync(fd);
        return true;
    } catch {
        return false;
    }
})();

function writeToTty(data: string): void {
    if (hasDevTty) {
        writeFileSync("/dev/tty", data);
    }
}

function runInteractiveCommand(
    command: string,
    args: readonly string[],
): number | null {
    // Save TUI's terminal state (raw mode, etc.)
    const savedTty = saveTtyState();

    // Restore canonical mode so the child gets proper echo/line editing
    spawnSync("stty", ["sane"], { stdio: "inherit" });

    // Write directly to /dev/tty since process.stdout is a pipe in pi
    writeToTty("\x1b[?1049h\x1b[2J\x1b[H");

    const result = spawnSync(command, args, {
        stdio: "inherit",
    });

    // Restore TUI screen. If a child program (htop, vim, etc.) exited
    // alternate screen, the terminal is already in NORMAL and this is
    // a no-op. Otherwise it switches back from ALTERNATE to NORMAL.
    writeToTty("\x1b[?1049l");

    // Restore TUI's terminal state
    if (savedTty) {
        restoreTtyState(savedTty);
    }

    return result.status;
}

const defaultShell = process.env.SHELL || "/bin/sh";

async function runShellInteractively(
    ui: ExtensionUIContext,
    args: readonly string[],
): Promise<number | null> {
    const exitCode = runInteractiveCommand(defaultShell, args);
    await forceRerender(ui);
    return exitCode;
}

function getLastAssistantText(
    sessionManager: ReadonlySessionManager,
): string | undefined {
    const branch = sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "assistant") continue;
        for (let j = msg.content.length - 1; j >= 0; j--) {
            const block = msg.content[j];
            if (block.type === "text") return block.text;
        }
        return undefined;
    }
    return undefined;
}

async function viewLastAssistantMessage(
    ui: ExtensionUIContext,
    sessionManager: ReadonlySessionManager,
): Promise<void> {
    const text = getLastAssistantText(sessionManager);
    if (!text) {
        ui.notify("No assistant message to view", "warning");
        return;
    }

    const tmpFile = join(tmpdir(), `pi-view-${process.pid}.md`);

    try {
        writeFileSync(tmpFile, text, "utf-8");

        const editor = process.env.EDITOR || "nvim";
        const args: string[] = [];
        if (/n?vim$/.test(editor)) args.push("-R");
        args.push(tmpFile);

        const exitCode = runInteractiveCommand(defaultShell, [
            "-c",
            `${editor} ${args.join(" ")}`,
        ]);
        await forceRerender(ui);

        if (exitCode !== 0 && exitCode !== null) {
            ui.notify(`Editor exited with code ${exitCode}`, "warning");
        }
    } finally {
        try {
            unlinkSync(tmpFile);
        } catch {}
    }
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("edit", {
        description: "Open editor",
        handler: async (path, ctx) => {
            if (!ctx.hasUI) {
                return;
            }

            let editor = process.env.EDITOR || "nvim";
            path = path.trim();
            if (path.length > 0) {
                editor += ` ${path}`;
            }

            await runShellInteractively(ctx.ui, ["-c", editor]);
        },
    });

    pi.registerCommand("shell", {
        description: "Open interactive shell",
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                return;
            }

            const shArgs: string[] = args.trim().length > 0 ? ["-c", args] : [];
            await runShellInteractively(ctx.ui, shArgs);
        },
    });

    pi.registerCommand("view", {
        description: "View last assistant message in editor",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI || !ctx.isIdle()) return;
            await viewLastAssistantMessage(ctx.ui, ctx.sessionManager);
        },
    });

    pi.registerShortcut("ctrl+shift+v", {
        description: "View last assistant message in editor",
        handler: async (ctx) => {
            if (!ctx.hasUI || !ctx.isIdle()) return;
            await viewLastAssistantMessage(ctx.ui, ctx.sessionManager);
        },
    });

    pi.registerCommand("nvim-review", {
        description: "Open files in Neovim review mode",
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("/nvim-review requires interactive mode", "error");
                return;
            }

            let files = args
                .trim()
                .split(/\s+/)
                .filter((f) => f.length > 0);

            if (files.length === 0) {
                const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
                    encoding: "utf-8",
                });
                const untracked = spawnSync(
                    "git",
                    ["ls-files", "--others", "--exclude-standard"],
                    { encoding: "utf-8" },
                );
                const combined = [
                    diff.status === 0 ? diff.stdout : "",
                    untracked.status === 0 ? untracked.stdout : "",
                ].join("\n");
                files = combined
                    .trim()
                    .split("\n")
                    .filter((f) => f.length > 0);
            }

            if (files.length === 0) {
                ctx.ui.notify(
                    "No files specified and no changed files found",
                    "warning",
                );
                return;
            }

            const outputFile = join(tmpdir(), `pi-nvim-review-${process.pid}.md`);

            try {
                const escapedPath = outputFile.replace(/'/g, "\\'");
                const setupCmd = `Review ${escapedPath}`;

                const exitCode = runInteractiveCommand("nvim", [
                    "-R",
                    "-c",
                    setupCmd,
                    ...files,
                ]);
                await forceRerender(ctx.ui);

                if (exitCode !== 0 && exitCode !== null) {
                    ctx.ui.notify(`Neovim exited with code ${exitCode}`, "warning");
                    return;
                }

                if (!existsSync(outputFile)) return;

                const result = readFileSync(outputFile, "utf-8").trim();
                if (result.length === 0) return;

                ctx.ui.setEditorText(result);
            } finally {
                try {
                    unlinkSync(outputFile);
                } catch {}
            }
        },
    });

    pi.registerShortcut("ctrl+g", {
        description: "Open editor content in external editor",
        handler: async (ctx) => {
            const editor = process.env.VISUAL || process.env.EDITOR || "nvim";
            const text = ctx.ui.getEditorText();

            const tmpFile = join(tmpdir(), `pi-edit-${process.pid}.md`);

            try {
                writeFileSync(tmpFile, text, "utf-8");

                // Run the editor without an immediate rerender so we
                // can update the editor text first, then rerender once
                // with the correct content.
                const exitCode = runInteractiveCommand(defaultShell, [
                    "-c",
                    `${editor} ${tmpFile}`,
                ]);

                if (exitCode !== 0) {
                    await forceRerender(ctx.ui);
                    ctx.ui.notify(`Editor exited with code ${exitCode}`, "warning");
                    return;
                }
                const updated = readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
                ctx.ui.setEditorText(updated);
                await forceRerender(ctx.ui);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                ctx.ui.notify(`External editor failed: ${msg}`, "error");
            } finally {
                try {
                    unlinkSync(tmpFile);
                } catch {}
            }
        },
    });
}
