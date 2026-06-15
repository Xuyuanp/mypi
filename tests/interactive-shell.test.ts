/**
 * Unit tests for interactive-shell extension helpers.
 *
 * Focused on `collectReviewFiles`, which derives the candidate file
 * list for `/nvim-review` from git state. The list must be expressed
 * as paths usable from the given `cwd` so nvim opens the right files
 * when pi runs in a subdirectory of the repo.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectReviewFiles } from "../extensions/interactive-shell.js";

function git(cwd: string, ...args: string[]): void {
    const result = spawnSync("git", args, {
        cwd,
        encoding: "utf-8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "test",
            GIT_COMMITTER_EMAIL: "test@example.com",
        },
    });
    if (result.status !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
        );
    }
}

describe("collectReviewFiles", () => {
    let repo: string;

    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), "pi-nvim-review-test-"));
        git(repo, "init", "-q");
        // Disable any user/system gitignore_global interference.
        git(repo, "config", "commit.gpgsign", "false");

        mkdirSync(join(repo, "sub"), { recursive: true });
        mkdirSync(join(repo, "other"), { recursive: true });
        writeFileSync(join(repo, "sub", "tracked.txt"), "v1\n");
        writeFileSync(join(repo, "other", "tracked.txt"), "v1\n");
        writeFileSync(join(repo, "root-tracked.txt"), "v1\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "init");
    });

    afterEach(() => {
        rmSync(repo, { recursive: true, force: true });
    });

    it("returns [] when cwd is not in a git repo", () => {
        const outside = mkdtempSync(join(tmpdir(), "pi-nvim-review-outside-"));
        try {
            expect(collectReviewFiles(outside)).toEqual([]);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("returns [] when repo is clean", () => {
        expect(collectReviewFiles(repo)).toEqual([]);
        expect(collectReviewFiles(join(repo, "sub"))).toEqual([]);
    });

    it("from repo root: returns paths relative to root", () => {
        writeFileSync(join(repo, "sub", "tracked.txt"), "v2\n");
        writeFileSync(join(repo, "sub", "untracked.txt"), "new\n");

        const files = collectReviewFiles(repo);
        expect(files.sort()).toEqual(
            ["sub/tracked.txt", "sub/untracked.txt"].sort(),
        );
    });

    it("from subdir: paths are relative to subdir, not repo root", () => {
        writeFileSync(join(repo, "sub", "tracked.txt"), "v2\n");
        writeFileSync(join(repo, "sub", "untracked.txt"), "new\n");

        const files = collectReviewFiles(join(repo, "sub"));
        // Regression guard: must NOT be "sub/tracked.txt" — that's the
        // pre-fix bug where nvim tried to open <cwd>/sub/tracked.txt.
        expect(files.sort()).toEqual(["tracked.txt", "untracked.txt"].sort());
    });

    it("from subdir: omits changes outside the subdir subtree", () => {
        // Modify a file in a sibling dir, plus one in our subdir.
        writeFileSync(join(repo, "other", "tracked.txt"), "v2\n");
        writeFileSync(join(repo, "root-tracked.txt"), "v2\n");
        writeFileSync(join(repo, "sub", "tracked.txt"), "v2\n");
        writeFileSync(join(repo, "other", "untracked.txt"), "x\n");

        const files = collectReviewFiles(join(repo, "sub"));
        expect(files).toEqual(["tracked.txt"]);
    });

    it("includes deleted tracked files (relative to cwd)", () => {
        rmSync(join(repo, "sub", "tracked.txt"));

        const files = collectReviewFiles(join(repo, "sub"));
        expect(files).toEqual(["tracked.txt"]);
    });
});
