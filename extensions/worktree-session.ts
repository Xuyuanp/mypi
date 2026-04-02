/**
 * Git worktree session sharing.
 *
 * When pi starts inside a git worktree, this extension redirects the
 * session directory to match the main repository root so that the
 * worktree and the main checkout share the same session pool.
 *
 * Detection: compare `git rev-parse --git-common-dir` (shared .git)
 * with `<toplevel>/.git`. If they differ the cwd is a worktree.
 */

import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";

function git(args: string, cwd: string): string | null {
    try {
        return execSync(`git ${args}`, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3000,
        }).trim();
    } catch {
        return null;
    }
}

function getMainRepoRoot(cwd: string): string | null {
    const toplevel = git("rev-parse --show-toplevel", cwd);
    if (!toplevel) return null;

    const commonDir = git("rev-parse --git-common-dir", cwd);
    if (!commonDir) return null;

    // commonDir may be relative; resolve against toplevel
    const resolvedCommon = realpathSync(resolve(toplevel, commonDir));
    const localGitDir = realpathSync(join(toplevel, ".git"));

    if (resolvedCommon === localGitDir) {
        // Not a worktree -- common dir is our own .git
        return null;
    }

    // Main repo root is the parent of the shared .git directory
    return dirname(resolvedCommon);
}

function encodeSessionDir(cwd: string): string {
    const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(getAgentDir(), "sessions", safePath);
}

export default function (pi: ExtensionAPI) {
    pi.on("session_directory", async (event) => {
        const mainRoot = getMainRepoRoot(event.cwd);
        if (!mainRoot) return;

        return { sessionDir: encodeSessionDir(mainRoot) };
    });
}
