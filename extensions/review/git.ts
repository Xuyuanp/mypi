/**
 * Git and GitHub/GitLab CLI operations for the review extension.
 *
 * All functions take an ExtensionAPI instance so they can call
 * pi.exec() without depending on module-level state.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export async function getMergeBase(
    pi: ExtensionAPI,
    branch: string,
): Promise<string | null> {
    try {
        const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
            "rev-parse",
            "--abbrev-ref",
            `${branch}@{upstream}`,
        ]);

        if (upstreamCode === 0 && upstream.trim()) {
            const { stdout: mergeBase, code } = await pi.exec("git", [
                "merge-base",
                "HEAD",
                upstream.trim(),
            ]);
            if (code === 0 && mergeBase.trim()) {
                return mergeBase.trim();
            }
        }

        const { stdout: mergeBase, code } = await pi.exec("git", [
            "merge-base",
            "HEAD",
            branch,
        ]);
        if (code === 0 && mergeBase.trim()) {
            return mergeBase.trim();
        }

        return null;
    } catch {
        return null;
    }
}

export async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
    const { stdout, code } = await pi.exec("git", [
        "branch",
        "--format=%(refname:short)",
    ]);
    if (code !== 0) return [];
    return stdout
        .trim()
        .split("\n")
        .filter((b) => b.trim());
}

export async function getRecentCommits(
    pi: ExtensionAPI,
    limit: number = 10,
): Promise<Array<{ sha: string; title: string }>> {
    const { stdout, code } = await pi.exec("git", [
        "log",
        `--oneline`,
        `-n`,
        `${limit}`,
    ]);
    if (code !== 0) return [];

    return stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
            const [sha, ...rest] = line.trim().split(" ");
            return { sha, title: rest.join(" ") };
        });
}

export async function hasUncommittedChanges(
    pi: ExtensionAPI,
): Promise<boolean> {
    const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
    return code === 0 && stdout.trim().length > 0;
}

export async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
    const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
    if (code !== 0) return false;

    const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim());
    const trackedChanges = lines.filter((line) => !line.startsWith("??"));
    return trackedChanges.length > 0;
}

export function parsePrReference(ref: string): number | null {
    const trimmed = ref.trim();

    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num > 0) {
        return num;
    }

    const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    if (urlMatch) {
        return parseInt(urlMatch[1], 10);
    }

    return null;
}

export async function getPrInfo(
    pi: ExtensionAPI,
    prNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
    const { stdout, code } = await pi.exec("gh", [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "baseRefName,title,headRefName",
    ]);

    if (code !== 0) return null;

    try {
        const data = JSON.parse(stdout);
        return {
            baseBranch: data.baseRefName,
            title: data.title,
            headBranch: data.headRefName,
        };
    } catch {
        return null;
    }
}

export async function checkoutPr(
    pi: ExtensionAPI,
    prNumber: number,
): Promise<{ success: boolean; error?: string }> {
    const { stdout, stderr, code } = await pi.exec("gh", [
        "pr",
        "checkout",
        String(prNumber),
    ]);

    if (code !== 0) {
        return {
            success: false,
            error: stderr || stdout || "Failed to checkout PR",
        };
    }

    return { success: true };
}

export function parseMrReference(ref: string): number | null {
    const trimmed = ref.trim();

    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num > 0) {
        return num;
    }

    const urlMatch = trimmed.match(/\/-\/merge_requests\/(\d+)/);
    if (urlMatch) {
        return parseInt(urlMatch[1], 10);
    }

    return null;
}

export async function getMrInfo(
    pi: ExtensionAPI,
    mrNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
    const { stdout, code } = await pi.exec("glab", [
        "mr",
        "view",
        String(mrNumber),
        "--output",
        "json",
    ]);

    if (code !== 0) return null;

    try {
        const data = JSON.parse(stdout);
        return {
            baseBranch: data.target_branch,
            title: data.title,
            headBranch: data.source_branch,
        };
    } catch {
        return null;
    }
}

export async function checkoutMr(
    pi: ExtensionAPI,
    mrNumber: number,
): Promise<{ success: boolean; error?: string }> {
    const { stdout, stderr, code } = await pi.exec("glab", [
        "mr",
        "checkout",
        String(mrNumber),
    ]);

    if (code !== 0) {
        return {
            success: false,
            error: stderr || stdout || "Failed to checkout MR",
        };
    }

    return { success: true };
}

export async function getCurrentBranch(
    pi: ExtensionAPI,
): Promise<string | null> {
    const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
    if (code === 0 && stdout.trim()) {
        return stdout.trim();
    }
    return null;
}

export async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
    const { stdout, code } = await pi.exec("git", [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "--short",
    ]);
    if (code === 0 && stdout.trim()) {
        return stdout.trim().replace("origin/", "");
    }

    const branches = await getLocalBranches(pi);
    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";

    return "main";
}
