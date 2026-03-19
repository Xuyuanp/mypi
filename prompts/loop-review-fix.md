---
description: start a review-fix loop to fix all P0-P2 issues in the codebase, and make a decision log in DECISIONS.md for those you disagree with
---

$ARGUMENTS <!-- optional: scope filter, extra context, e.g. "focus on pkg/server/" -->

## Review-Fix Loop

Start a loop (max 5 iterations):

1. Run command `pi --model openai/gpt-5.3-codex --print --no-session --review uncommitted go > REVIEW.md` (set a longer timeout if needed -- the review can be slow on large diffs).
2. Read the result in REVIEW.md.
3. Read DECISIONS.md (if it exists) to learn which issues have already been decided on.
4. For every P0-P2 issue in REVIEW.md:
   - If it matches an issue already recorded in DECISIONS.md and the reviewer's reasoning is the same, skip it. If the reviewer provides a new reason, reconsider and either fix it or update your DECISIONS.md entry with a response to the new reason.
   - If you agree, fix it.
   - If you disagree, append an entry to DECISIONS.md explaining your reasoning (see format below).
5. If this iteration produced no new fixes and no new decisions (all remaining P0-P2 issues were already in DECISIONS.md), exit the loop.
6. Otherwise, go to step 1.

After the loop ends:

1. Output a summary(see format below):
2. Delete REVIEW.md

## DECISIONS.md Format

DECISIONS.md is append-only. Each entry should follow this structure so future reviewers (who cannot see prior REVIEW.md contents) have enough context:

```markdown
### <Issue title or one-line summary>

- **Severity**: P0 / P1 / P2
- **Reviewer said**: <brief paraphrase of the reviewer's concern>
- **Decision**: Disagree
- **Reason**: <your rationale>
```

## Output Summary Format:

```
## Review-Fix Summary

- **Iterations**: <number>

### Fixed (<count>)

| #   | Severity | Issue | What was done |
| --- | -------- | ----- | ------------- |
| 1   | P0       | ...   | ...           |

### Disagreed (<count>)

| #   | Severity | Issue | Reason |
| --- | -------- | ----- | ------ |
| 1   | P1       | ...   | ...    |

### Unresolved P0-P2 (<count>)

| #   | Severity | Issue | Reason |
| --- | -------- | ----- | ------ |
| 1   | P1       | ...   | ...    |

### Skipped P3+ (<count>)

| #   | Severity | Issue |
| --- | -------- | ----- |
| 1   | P3       | ...   |
```

Omit any section whose count is 0.

## Notes

- DO NOT include issues that you have already fixed in DECISIONS.md -- only issues you disagree with.
- For P3 and lower issues, you may fix them at your discretion, but you do not need to record them in DECISIONS.md if you choose not to fix them.
