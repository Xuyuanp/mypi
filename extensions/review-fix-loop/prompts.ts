/**
 * Prompt text for the review-fix-loop extension.
 *
 * All functions are pure (string in, string out, no side effects).
 * The fix discipline content (per-issue procedure, test-first,
 * DECISIONS.md format) originates from prompts/loop-review-fix.md.
 */

import { promises as fsPromises } from "node:fs";
import { dirname, join, resolve } from "node:path";

// -- Review rubric (copied from ../pi-review/review.ts) --

export const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or "best effort" silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

## Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed> (call out re-use of dormant feature flags!)
- **This change changes configuration defaults:** <config var changed>

Rules for this section:
1. These are informational callouts for the human reviewer, not fix items.
2. Do not include them in Findings unless there is an independent defect.
3. These callouts alone must not change the verdict.
4. Only include callouts that apply to the reviewed change.
5. Keep each emitted callout bold exactly as written.
6. If none apply, write "- (none)".

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix, only flag issues and optionally provide short suggestion blocks.
7. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.`;

// -- Review system prompt --

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
    let currentDir = resolve(cwd);

    while (true) {
        const piDir = join(currentDir, ".pi");
        const guidelinesPath = join(currentDir, "REVIEW_GUIDELINES.md");

        const piStats = await fsPromises.stat(piDir).catch(() => null);
        if (piStats?.isDirectory()) {
            const gStats = await fsPromises.stat(guidelinesPath).catch(() => null);
            if (gStats?.isFile()) {
                try {
                    const content = await fsPromises.readFile(
                        guidelinesPath,
                        "utf8",
                    );
                    const trimmed = content.trim();
                    return trimmed ? trimmed : null;
                } catch {
                    return null;
                }
            }
            return null;
        }

        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) return null;
        currentDir = parentDir;
    }
}

export async function buildReviewSystemPrompt(cwd: string): Promise<string> {
    let prompt = REVIEW_RUBRIC;
    const guidelines = await loadProjectReviewGuidelines(cwd);
    if (guidelines) {
        prompt += `\n\n---\n\nThis project has additional instructions for code reviews:\n\n${guidelines}`;
    }
    return prompt;
}

// -- Review user prompt --

export function buildReviewUserPrompt(
    diffPath: string,
    extraFocus: string | undefined,
): string {
    const parts = [
        "Review the current code changes and provide prioritized findings.",
        "",
        `The diff has been saved to \`${diffPath}\`. Read it first.`,
        "",
        "Before reviewing, also read these files if they exist:",
        "- `PLAN.md` -- the specification these changes implement. Evaluate the diff against the plan, not against abstract ideals. Check the working directory and subdirectories.",
        "- `./DECISIONS.md` (working directory root, never in subdirectories) -- an append-only log of issue outcomes (both fixed and declined) from prior review-fix cycles.",
        "",
        "## DECISIONS.md deduplication",
        "",
        "When DECISIONS.md exists:",
        "1. Before flagging a finding, check whether a semantically similar issue already appears in DECISIONS.md.",
        "2. **Declined entries** (Disagree / Could not reproduce): if the decline reason is sound, **suppress the finding**. You may only re-flag if you have **new evidence** \u2014 a concrete scenario, reproduction path, or provable impact that the prior decline reason did not address. Restating the same concern in different words does not count.",
        "3. **Fixed entries**: do not flag code patterns that a fixed entry shows were intentionally introduced as part of a prior fix. If the fix itself introduced a new bug, that is valid to flag \u2014 but you must explain why the fix is defective.",
        "4. When re-flagging any prior entry, explicitly reference the DECISIONS.md entry and state what new evidence or defect you are providing.",
        "",
        "You may use the `read` tool to inspect full source files for additional context.",
    ];

    if (extraFocus) {
        parts.push("", `Additional focus: ${extraFocus}`);
    }

    return parts.join("\n");
}

// -- Fix discipline prompts --

const PER_ISSUE_PROCEDURE = `## Per-Issue Procedure

For each P0-P2 issue, follow these steps in order:

1. **Check DECISIONS.md.**
   - If the issue is semantically similar to an existing **declined** entry (Disagree / Could not reproduce) and the core reviewer reasoning is unchanged, skip it.
   - If a prior **Fixed** entry exists for the same issue but the reviewer flags it again, do NOT skip -- the fix may have been incomplete. Re-evaluate from step 2.
   - If the reviewer provides a new reason for a declined entry, reconsider: either fix it (continue to step 2) or append a new DECISIONS.md entry responding to the new reason (then stop for this issue).
2. **Decide: agree or disagree.**
   - If you **disagree**, append an entry to DECISIONS.md (see **DECISIONS.md Format** below). Stop for this issue.
   - If you **agree**, continue to step 3.
3. **Write a failing test** that reproduces the issue. Run it (e.g., \`go test <pkg> -run <TestName>\`) and read terminal output to confirm it fails.
   - If the issue is genuinely untestable (e.g., typo-only comment/documentation change, purely formatting/config metadata change), skip the test. Continue to step 4.
   - If you cannot reproduce the issue (test compiles but passes before any fix), record it in DECISIONS.md as \`Decision: Could not reproduce\` and stop for this issue.
   - If you fail to produce a compiling, reliably reproducing test after 2 attempts, append a DECISIONS.md entry with \`Decision: Could not reproduce\` and list attempted approaches; then continue to step 4 to fix the code directly.
   - See **Test Placement Rules** below for edge cases.
4. **Fix the code.**
5. **Run the test again** and confirm it passes. If it fails, return to step 4.
6. **Log the fix in DECISIONS.md.** Append an entry with \`Decision: Fixed\` (see **DECISIONS.md Format** below). If the issue already has a DECISIONS.md entry from an earlier step (e.g., Could not reproduce before a direct fix), explicitly supersede it in the new entry.`;

const DECISIONS_FORMAT = `## DECISIONS.md Format

DECISIONS.md is append-only and MUST live at the working directory root (\`./DECISIONS.md\`). Never create it in a subdirectory.
Each entry SHOULD follow this structure so future reviewers (who cannot see prior review contents) have enough context.
If appending a new decision for a previously logged issue, reference the prior entry and explicitly state that the new entry supersedes it:

\`\`\`markdown
### <Issue title or one-line summary>

- **Severity**: P0 / P1 / P2
- **Reviewer said**: <brief paraphrase of the reviewer's concern>
- **Decision**: Fixed / Disagree / Could not reproduce
- **Reason**: <your rationale, or for Fixed: what was changed and why>

---
\`\`\``;

const TEST_PLACEMENT_RULES = `## Test Placement Rules

- **Issue spans multiple packages**: place the test in the package closest to root cause.
- **Issue is in generated code**: test the generator input/output rather than the generated file.
- **Flaky / concurrency bugs**: still attempt a reproducing test (race detector, stress loop, deterministic harness) before falling back to \`N/A\`.
- **Existing test already covers it**: update the existing test to fail on the bug rather than creating a duplicate; reference it in the Test column.`;

const P3_TRIAGE = `## P3+ Triage

P3+ issues do not require the full Per-Issue Procedure (test-first is optional).
You may fix P3+ issues at your discretion. Log each in DECISIONS.md with the same format as P0-P2 entries.`;

export function buildFixPrompt(
    reviewOutput: string,
    iteration: number,
    maxIterations: number,
): string {
    const parts = [
        `# Review-Fix Iteration ${iteration + 1} of ${maxIterations}`,
        "",
        "An external reviewer has analyzed the current code changes. The full review output is below.",
        "Read `./DECISIONS.md` (working directory root) if it exists to learn which issues have already been decided.",
        "For every P0-P2 issue in the review, run the Per-Issue Procedure.",
        "",
        "---",
        "",
        "## Review Output",
        "",
        reviewOutput,
        "",
        "---",
        "",
        PER_ISSUE_PROCEDURE,
        "",
        DECISIONS_FORMAT,
        "",
        TEST_PLACEMENT_RULES,
        "",
        P3_TRIAGE,
    ];
    return parts.join("\n");
}
