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
 *
 * Shortcuts:
 *   ctrl+g               # Open editor content in external editor
 *
 * Bang commands (auto-detected or forced):
 *   !vim file.txt        # Auto-detected as interactive
 *   !i any-command       # Force interactive mode with !i prefix
 *   !git rebase -i HEAD~3
 *   !htop
 *
 * Configuration via environment variables:
 *   INTERACTIVE_COMMANDS - Additional commands (comma-separated)
 *   INTERACTIVE_EXCLUDE  - Commands to exclude (comma-separated)
 *
 * Note: This only intercepts user `!` commands, not agent bash tool calls.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    ExtensionAPI,
    ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";

// Default interactive commands - editors, pagers, git ops, TUIs
const DEFAULT_INTERACTIVE_COMMANDS = [
    // Editors
    "vim",
    "nvim",
    "vi",
    "nano",
    "emacs",
    "pico",
    "micro",
    "helix",
    "hx",
    "kak",
    // Pagers
    "less",
    "more",
    "most",
    // Git interactive
    "git commit",
    "git rebase",
    "git merge",
    "git cherry-pick",
    "git revert",
    "git add -p",
    "git add --patch",
    "git add -i",
    "git add --interactive",
    "git stash -p",
    "git stash --patch",
    "git reset -p",
    "git reset --patch",
    "git checkout -p",
    "git checkout --patch",
    "git difftool",
    "git mergetool",
    // System monitors
    "htop",
    "top",
    "btop",
    "glances",
    // File managers
    "ranger",
    "nnn",
    "lf",
    "mc",
    "vifm",
    // Git TUIs
    "tig",
    "lazygit",
    "gitui",
    // Fuzzy finders
    "fzf",
    "sk",
    // Remote sessions
    "ssh",
    "telnet",
    "mosh",
    // Database clients
    "psql",
    "mysql",
    "sqlite3",
    "mongosh",
    "redis-cli",
    // Kubernetes/Docker
    "kubectl edit",
    "kubectl exec -it",
    "docker exec -it",
    "docker run -it",
    // Other
    "tmux",
    "screen",
    "ncdu",
];

function getInteractiveCommands(): string[] {
    const additional =
        process.env.INTERACTIVE_COMMANDS?.split(",")
            .map((s) => s.trim())
            .filter(Boolean) ?? [];
    const excluded = new Set(
        process.env.INTERACTIVE_EXCLUDE?.split(",").map((s) =>
            s.trim().toLowerCase(),
        ) ?? [],
    );
    return [...DEFAULT_INTERACTIVE_COMMANDS, ...additional].filter(
        (cmd) => !excluded.has(cmd.toLowerCase()),
    );
}

function isInteractiveCommand(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    const commands = getInteractiveCommands();

    for (const cmd of commands) {
        const cmdLower = cmd.toLowerCase();
        if (
            trimmed === cmdLower ||
            trimmed.startsWith(`${cmdLower} `) ||
            trimmed.startsWith(`${cmdLower}\t`)
        ) {
            return true;
        }
        const pipeIdx = trimmed.lastIndexOf("|");
        if (pipeIdx !== -1) {
            const afterPipe = trimmed.slice(pipeIdx + 1).trim();
            if (afterPipe === cmdLower || afterPipe.startsWith(`${cmdLower} `)) {
                return true;
            }
        }
    }
    return false;
}

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
        writeFileSync("/dev/tty", "");
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

    pi.on("user_bash", async (event, ctx) => {
        let command = event.command;
        let forceInteractive = false;

        if (command.startsWith("i ") || command.startsWith("i\t")) {
            forceInteractive = true;
            command = command.slice(2).trim();
        }

        const shouldBeInteractive =
            forceInteractive || isInteractiveCommand(command);
        if (!shouldBeInteractive) {
            return;
        }

        if (!ctx.hasUI) {
            return {
                result: {
                    output: "(interactive commands require TUI)",
                    exitCode: 1,
                    cancelled: false,
                    truncated: false,
                },
            };
        }

        const exitCode = await runShellInteractively(ctx.ui, ["-c", command]);

        const output =
            exitCode === 0
                ? "(interactive command completed successfully)"
                : `(interactive command exited with code ${exitCode})`;

        return {
            result: {
                output,
                exitCode: exitCode ?? 1,
                cancelled: false,
                truncated: false,
            },
        };
    });

    pi.registerShortcut("ctrl+g", {
        description: "Open editor content in external editor",
        handler: async (ctx) => {
            const editor = process.env.VISUAL || process.env.EDITOR || "nvim";
            const text = ctx.ui.getEditorText();

            const dir = mkdtempSync(join(tmpdir(), "pi-edit-"));
            const tmpFile = join(dir, "EDITOR.md");

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
                rmSync(dir, { recursive: true, force: true });
            }
        },
    });
}
