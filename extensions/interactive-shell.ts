/**
 * Interactive Shell Extension
 *
 * Provides full terminal access for interactive commands. The TUI suspends
 * while they run and resumes when they exit.
 *
 * Commands:
 *   /edit [path]         # Open $EDITOR (defaults to nvim)
 *   /shell [command]     # Open $SHELL, optionally running a command
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
        // Match at start
        if (
            trimmed === cmdLower ||
            trimmed.startsWith(`${cmdLower} `) ||
            trimmed.startsWith(`${cmdLower}\t`)
        ) {
            return true;
        }
        // Match after pipe: "cat file | less"
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

async function runInteractiveCommand(
    ui: ExtensionUIContext,
    command: string,
    args: readonly string[],
) {
    return await ui.custom<number | null>((tui, _theme, _kb, done) => {
        // Stop TUI to release terminal
        tui.stop();

        // Clear screen
        process.stdout.write("\x1b[2J\x1b[H");

        const result = spawnSync(command, args, {
            stdio: "inherit",
            env: process.env,
        });

        // Restart TUI
        tui.start();
        tui.requestRender(true);

        // Signal completion
        done(result.status);

        // Return empty component (immediately disposed since done() was called)
        return { render: () => [], invalidate: () => {} };
    });
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

            // Run command with full terminal access
            const shell = process.env.SHELL || "/bin/sh";
            await runInteractiveCommand(ctx.ui, shell, ["-c", editor]);
        },
    });

    pi.registerCommand("shell", {
        description: "Open interactive shell",
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                return;
            }

            const shell = process.env.SHELL || "/bin/sh";
            let shArgs: string[] = [];
            if (args.trim().length > 0) {
                shArgs = ["-c", args];
            }
            await runInteractiveCommand(ctx.ui, shell, shArgs);
        },
    });

    pi.on("user_bash", async (event, ctx) => {
        let command = event.command;
        let forceInteractive = false;

        // Check for !i prefix (command comes without the leading !)
        // The prefix parsing happens before this event, so we check if command starts with "i "
        if (command.startsWith("i ") || command.startsWith("i\t")) {
            forceInteractive = true;
            command = command.slice(2).trim();
        }

        const shouldBeInteractive =
            forceInteractive || isInteractiveCommand(command);
        if (!shouldBeInteractive) {
            return; // Let normal handling proceed
        }

        // No UI available (print mode, RPC, etc.)
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

        const shell = process.env.SHELL || "/bin/sh";
        const exitCode = await runInteractiveCommand(ctx.ui, shell, ["-c", command]);

        // Return result to prevent default bash handling
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
}
