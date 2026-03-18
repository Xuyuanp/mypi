---
description: start a review-fix loop to fix all P0-P2 issues in the codebase, and make a decision log in DECISIONS.md for those you disagree with
---

$ARGUMENTS

## Review-Fix loop

start a loop:

1. run command `pi --model openai/gpt-5.3-codex --print --no-session --review uncommitted go > REVIEW.md`
2. read the result in REVIEW.md
3. check all P0-P2 issues, fix those you agress with, and challenge those you disagree with by appending your reason in DECISIONS.md
4. go to step 1, and repeat the process until there are no more P0-P2 issues left

## Note

- DECISIONS.md is append only, write your desicion with a brief context, the reviewer in new turn won't be able to see the previous review result, but can read the DECISIONS.md to understand the context of your desicion. This is to avoid bias in the review process.
- DO NOT include the issues that you have already fixed in the DECISIONS.md, only include the issues that you disagree with, and explain your reason for disagreement.
- The review command may take some time to run, especially if there are many uncommitted changes, so set a longer timeout for the command if needed.
- For P3 issues, you can choose to fix them or not, but you don't need to include them in the DECISIONS.md if you choose not to fix them.
