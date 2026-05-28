---
description: goal-driven review-fix using the `reviewer` subagent; progress is tracked via create_goal / get_goal / update_goal with a token budget
argument-hint: "[scope/context] [--budget <tokens>]"
---

$ARGUMENTS <!-- optional: scope filter / extra focus, plus optional `--budget <N>` token budget -->

## Review-Fix (goal-driven, subagent reviewer)

The work is tracked through the **goal tools** (`create_goal`, `get_goal`,
`update_goal`). Progress is made by calling the `reviewer` subagent (via
the `subagent` tool) on the current uncommitted diff and feeding findings
back to you for fixing. The goal is complete when the diff receives a clean
verdict, no changes remain, or the reviewer cannot drive further progress.

The reviewer subagent has **no `bash` / git access**, so you must collect the
diff yourself and pass the file path in its `task`.

---

### Setup (run once, before any review work)

1. **Parse `$ARGUMENTS`.** Split off `--budget <N>` if present; the remainder
   is the scope/extra-focus string passed to the reviewer.

2. **Create the goal.** Call `create_goal` with:
    - `objective`: a single sentence describing the desired end state, for
      example:
      `"All uncommitted changes pass review by the reviewer subagent (verdict 'correct', no blocking P0-P2 issues), with declined findings logged in DECISIONS.md. Scope/focus: <scope-string or 'entire diff'>."`
      Do NOT mention the token budget in the objective -- the goal tools
      surface budget state to the agent on their own. Keep the objective
      focused on the outcome.
    - `token_budget`: only set this when the user passed `--budget <N>` in
      `$ARGUMENTS`; otherwise omit it so the goal runs unlimited. (This
      matches the `create_goal` tool's own guidance: set `token_budget`
      only when an explicit budget is requested.)

---

### Procedure

Each iteration performs the steps below. Call `update_goal` (`status:
"complete"`) when an exit condition is met; otherwise the goal remains
active and the next iteration will continue the work.

Budget enforcement is handled by the goal tools and is out of scope for
this procedure -- do not poll `get_goal` just to check tokens.

1. **Collect the diff.** In a single bash invocation, write the following to
   `/tmp/pi-review-diff-<unix_ts>-<pid>.md` (use `$$` for the pid and
   `$(date +%s)` for the timestamp -- pick fresh values each time so
   parallel runs do not collide):
    - `## Git Status` from `git status --porcelain`
    - `## Staged Changes` from `git diff --staged` (in a ```diff fence)
    - `## Unstaged Changes` from `git diff` (in a ```diff fence)
    - `## Untracked Files` from `git ls-files --others --exclude-standard`
      (list only; the reviewer can `read` them itself)

   If **every** section is empty, exit with reason `no-changes` and call
   `update_goal` (`status: "complete"`).

2. **Load project review guidelines.** If
   `<repo-root>/.pi/REVIEW_GUIDELINES.md` exists, read it. The reviewer
   subagent's system prompt already contains the generic rubric, but its
   system prompt cannot be overridden -- so project-specific rules must be
   inlined into the `task` body.

3. **Invoke the reviewer subagent.** Call the `subagent` tool with:
    - `agent`: `"reviewer"`
    - `description`: `"review uncommitted changes"` (or scope-specific)
    - `task`: built from the **Reviewer Task Template** below.

   **Always** pass the diff via the file path -- never inline it, even when
   short. This keeps the parent context lean as the goal progresses and
   respects the reviewer agent's `>200 lines` guidance.

   Capture the subagent's final assistant message as `REVIEW`.

4. **Empty / failed REVIEW.** If `REVIEW` is empty or the tool reported an
   error, clean up the temp diff file and exit with reason `reviewer-error`.
   Do NOT mark the goal complete.

5. **Read `./DECISIONS.md`** at the working directory root if it exists, so
   the per-issue procedure can dedupe against prior decisions. Never create
   it in a subdirectory.

6. **Per-Issue Procedure.** For every P0-P2 issue in `REVIEW`, run the
   procedure in the next section.
    - P3+ issues do not require the procedure or a DECISIONS.md entry.
    - You may fix P3+ issues at your discretion and list them in the
      "Skipped P3+" summary table.

7. **Clean up** the temp diff file.

8. **Verdict gate.** Inspect `REVIEW`'s verdict line:
    - If it clearly says **`correct`** (no blocking issues), exit with
      reason `clean` and call `update_goal` (`status: "complete"`).
    - If every P0-P2 finding was already covered by a **declined**
      DECISIONS.md entry with unchanged reviewer reasoning (no real fixes
      or new declines applied), exit with reason `stuck-on-declines` and
      call `update_goal` complete -- further work cannot make progress.
    - Otherwise, the goal is not yet satisfied; keep working on it.

   Treat ambiguous wording (`partially correct`, `not correct`,
   `incorrect`) as **not** clean -- the goal is not yet satisfied.

---

### Exit conditions

| Reason                 | Goal action                              | Summary status   |
| ---------------------- | ---------------------------------------- | ---------------- |
| `clean`                | `update_goal` complete                   | correct          |
| `no-changes`           | `update_goal` complete                   | no-op            |
| `stuck-on-declines`    | `update_goal` complete                   | needs attention (all declined) |
| `reviewer-error`       | leave goal active                        | error            |
| Bash / git failure     | leave goal active                        | error            |

Call `update_goal` (`status: "complete"`) only on the terminal-success
rows. Leave the goal active for recoverable conditions (`reviewer-error`,
bash/git failure).

---

### Reviewer Task Template

Build the `task` string for the `subagent` tool from these blocks (in order),
joined by blank lines. Omit any block whose source is empty.

```text
Review the diff at <DIFF_PATH> (use the `read` tool to load it).

Before reviewing, also read these files if they exist:
- `PLAN.md` (working dir or subdirectories) -- evaluate the diff against the plan, not abstract ideals.
- `./DECISIONS.md` at the working directory root -- append-only log of prior review-fix outcomes.

## DECISIONS.md deduplication

When DECISIONS.md exists:
1. Before flagging a finding, check whether a semantically similar issue already appears in DECISIONS.md.
2. **Declined entries** (Disagree / Could not reproduce): if the decline reason is sound, **suppress the finding**. Re-flag only with **new evidence** -- a concrete scenario, reproduction path, or provable impact the prior decline did not address. Restating the same concern in different words does not count.
3. **Fixed entries**: do not flag patterns that a fixed entry shows were intentionally introduced. If the fix itself introduced a new bug, that is valid to flag -- but explain why the fix is defective.
4. When re-flagging any prior entry, explicitly reference the DECISIONS.md entry and state what new evidence or defect you are providing.

Additional focus: <SCOPE_STRING or "(none)">

---

This project has additional instructions for code reviews:

<CONTENTS OF .pi/REVIEW_GUIDELINES.md>
```

Replace `<DIFF_PATH>`, `<SCOPE_STRING>`, and the guidelines block with the
real values when you build the task. Drop the trailing `---` + guidelines
block entirely if `.pi/REVIEW_GUIDELINES.md` does not exist.

---

## Per-Issue Procedure

For each P0-P2 issue, follow these steps in order:

1. **Check DECISIONS.md.**
    - If the issue is semantically similar to an existing **declined** entry
      (Disagree / Could not reproduce) and the core reviewer reasoning is
      unchanged, skip it.
    - If a prior **Fixed** entry exists for the same issue but the reviewer
      flags it again, do NOT skip -- the fix may have been incomplete.
      Re-evaluate from step 2.
    - If the reviewer provides a new reason for a declined entry,
      reconsider: either fix it (continue to step 2) or append a new
      DECISIONS.md entry responding to the new reason (then stop for this
      issue).
2. **Decide: agree or disagree.**
    - If you **disagree**, append an entry to DECISIONS.md (see
      **DECISIONS.md Format** below). Stop for this issue.
    - If you **agree**, continue to step 3.
3. **Write a failing test** that reproduces the issue. Run it (e.g.,
   `npm test -- <name>`, `go test <pkg> -run <TestName>`) and read the
   terminal output to confirm it fails.
    - If the issue is genuinely untestable (typo-only comment/doc change,
      formatting/config metadata change), skip the test and mark Test as
      `N/A` with reason in summary. Continue to step 4.
    - If you cannot reproduce the issue (test compiles but passes before
      any fix), record it in DECISIONS.md as `Decision: Could not reproduce`
      and stop for this issue.
    - If you fail to produce a compiling, reliably reproducing test after
      2 attempts, append a DECISIONS.md entry with
      `Decision: Could not reproduce` and list attempted approaches; then
      continue to step 4 to fix the code directly. Mark Test as
      `N/A (could not build reliable reproducer)` in summary.
    - See **Test Placement Rules** below for edge cases.
4. **Fix the code.**
5. **Run the test again** and confirm it passes. If it fails, return to
   step 4.
6. **Log the fix in DECISIONS.md.** Append an entry with `Decision: Fixed`
   (see **DECISIONS.md Format** below). If the issue already has a
   DECISIONS.md entry from an earlier step (e.g., `Could not reproduce`
   before a direct fix), explicitly supersede it in the new entry.

## DECISIONS.md Format

DECISIONS.md is append-only and MUST live at the working directory root
(`./DECISIONS.md`). Never create it in a subdirectory.
Each entry SHOULD follow this structure so future reviewers (who cannot see
prior REVIEW contents) have enough context. If appending a new decision for
a previously logged issue, reference the prior entry and explicitly state
that the new entry supersedes it:

```markdown
### <Issue title or one-line summary>

- **Severity**: P0 / P1 / P2
- **Reviewer said**: <brief paraphrase of the reviewer's concern>
- **Decision**: Fixed / Disagree / Could not reproduce
- **Reason**: <your rationale, or for Fixed: what was changed and why>

---
```

## Test Placement Rules

- **Issue spans multiple packages**: place the test in the package closest to root cause.
- **Issue is in generated code**: test the generator input/output rather than the generated file.
- **Flaky / concurrency bugs**: still attempt a reproducing test (race detector, stress loop, deterministic harness) before falling back to `N/A`.
- **Existing test already covers it**: update the existing test to fail on the bug rather than creating a duplicate; reference it in the Test column.

## Output Summary Format

Output once, after the goal reaches a terminal state. Always include
`Goal status` so the user can tell whether the goal is still active
(resumable) or complete.

```markdown
## Review-Fix Summary

- **Exit reason**: clean / no-changes / stuck-on-declines / reviewer-error / error
- **Goal status**: complete / active (resumable)

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
