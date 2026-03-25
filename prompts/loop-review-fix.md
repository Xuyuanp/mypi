---
description: start a review-fix loop to fix all P0-P2 issues in the codebase, and make a decision log in DECISIONS.md for those you disagree with
---

$ARGUMENTS <!-- optional: scope filter, extra context, e.g. "focus on pkg/server/" -->

## Review-Fix Loop

Start a loop (max 5 iterations):

1. Run command `pi --model openai/gpt-5.3-codex --print --offline --no-session --review uncommitted go > REVIEW.md` (set a longer timeout if needed; review can be slow on large diffs).
2. Read the result in REVIEW.md.
3. Read DECISIONS.md (if it exists) to learn which issues have already been decided.
4. For every P0-P2 issue in REVIEW.md, run the **Per-Issue Procedure** below.
   - P3+ issues do not require the procedure or a DECISIONS.md entry.
   - You may fix P3+ issues at your discretion and list them in the "Skipped P3+" summary table.
5. Check the exit condition:
   - Exit the loop immediately when all P0-P2 issues in REVIEW.md have either been fixed, or have an existing **declined** DECISIONS.md entry covering the same issue with unchanged reviewer reasoning.
6. If not exiting, go to step 1.

After the loop exits:

7. Output a summary (see **Output Summary Format** below).
8. Delete REVIEW.md.

## Per-Issue Procedure

For each P0-P2 issue, follow these steps in order:

1. **Check DECISIONS.md.**
   - If the issue is semantically similar to an existing **declined** entry (Disagree / Could not reproduce) and the core reviewer reasoning is unchanged, skip it.
   - If a prior **Fixed** entry exists for the same issue but the reviewer flags it again, do NOT skip -- the fix may have been incomplete. Re-evaluate from step 2.
   - If the reviewer provides a new reason for a declined entry, reconsider: either fix it (continue to step 2) or append a new DECISIONS.md entry responding to the new reason (then stop for this issue).
2. **Decide: agree or disagree.**
   - If you **disagree**, append an entry to DECISIONS.md (see **DECISIONS.md Format** below). Stop for this issue.
   - If you **agree**, continue to step 3.
3. **Write a failing test** that reproduces the issue. Run it (e.g., `go test <pkg> -run <TestName>`) and read terminal output to confirm it fails.
   - If the issue is genuinely untestable (e.g., typo-only comment/documentation change, purely formatting/config metadata change), skip the test and mark Test as `N/A` with reason in summary. Continue to step 4.
   - If you cannot reproduce the issue (test compiles but passes before any fix), record it in DECISIONS.md as `Decision: Could not reproduce` and stop for this issue.
   - If you fail to produce a compiling, reliably reproducing test after 2 attempts, append a DECISIONS.md entry with `Decision: Could not reproduce` and list attempted approaches; then continue to step 4 to fix the code directly. Mark Test as `N/A (could not build reliable reproducer)` in summary.
   - See **Test Placement Rules** below for edge cases.
4. **Fix the code.**
5. **Run the test again** and confirm it passes. If it fails, return to step 4.
6. **Log the fix in DECISIONS.md.** Append an entry with `Decision: Fixed` (see **DECISIONS.md Format** below). If the issue already has a DECISIONS.md entry from an earlier step (e.g., Could not reproduce before a direct fix), explicitly supersede it in the new entry.

## DECISIONS.md Format

DECISIONS.md is append-only. Each entry SHOULD follow this structure so future reviewers (who cannot see prior REVIEW.md contents) have enough context.
If appending a new decision for a previously logged issue, reference the prior entry and explicitly state that the new entry supersedes it:

```markdown
### <Issue title or one-line summary>

- **Severity**: P0 / P1 / P2
- **Reviewer said**: <brief paraphrase of the reviewer's concern>
- **Decision**: Fixed / Disagree / Could not reproduce
- **Reason**: <your rationale, or for Fixed: what was changed and why>

---
```

## Output Summary Format

Output once, after loop exit:

```markdown
## Review-Fix Summary

- **Iterations**: <number>

### Fixed (<count>)

| #   | Severity | Issue | Test                                                 | What was done |
| --- | -------- | ----- | ---------------------------------------------------- | ------------- |
| 1   | P0       | ...   | `pkg/server/handler_test.go:TestXxx` or N/A (reason) | ...           |

### Disagreed (<count>)

| #   | Severity | Issue | Reason |
| --- | -------- | ----- | ------ |
| 1   | P1       | ...   | ...    |

### Unresolved P0-P2 (<count>)

| #   | Severity | Issue | Reason                                                                                     |
| --- | -------- | ----- | ------------------------------------------------------------------------------------------ |
| 1   | P1       | ...   | Still reproducible but no safe fix yet / blocked by dependency / requires product decision |

### Skipped P3+ (<count>)

| #   | Severity | Issue |
| --- | -------- | ----- |
| 1   | P3       | ...   |
```

Omit any section whose count is 0.

## Test Placement Rules

- **Issue spans multiple packages**: place the test in the package closest to root cause.
- **Issue is in generated code**: test the generator input/output rather than the generated file.
- **Flaky / concurrency bugs**: still attempt a reproducing test (race detector, stress loop, deterministic harness) before falling back to `N/A`.
- **Existing test already covers it**: update the existing test to fail on the bug rather than creating a duplicate; reference it in the Test column.
