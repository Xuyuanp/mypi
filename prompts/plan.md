---
description: write a detailed implementation plan for a non-trivial change. This template is designed to be comprehensive
argument-hint: "<change-description>"
---

$ARGUMENTS

# Plan Template

Use this template for every implementation plan. Fill in every section. Delete
nothing -- if a section does not apply, write "N/A" and explain why.

Save the plan in PLAN.md or follow the user's instruction.

---

## {Title}

**Date:** YYYY-MM-DD

## Problem

What is broken, missing, or suboptimal? State the observable symptom, not the
solution. Include a reproduction path or concrete example if applicable.

## Goal

One sentence. What is true after this work lands that is not true today?

## Non-goals

What this plan explicitly does not do. Name the tempting adjacent improvements
and state they are out of scope.

## Design

How the solution works. Include:

- Data flow or call chain (e.g., `requestHandler` -> `validateInput` ->
  `persist`)
- New types, interfaces, or function signatures (exact code, not prose)
- Which module/package owns each new symbol

```
// Example: exact signatures, not "add a method to validate input"
interface InputValidator {
    validate(ctx: Context, input: RawInput): Result<ValidatedInput, ValidationError>
}
```

## File list

**Every** file that will appear in the diff. Include dependency manifests, docs,
configs, linter configs, .gitignore -- not just source files. Use this
checklist after drafting the list:

- [ ] Does this change add or remove a dependency? -> add dependency manifest
      (e.g., `package.json`, `go.mod`, `requirements.txt`, `Cargo.toml`)
- [ ] Does this change add a new module, build flag, or lint rule? -> check
      build config and linter config
- [ ] Does this change rename or move a symbol referenced in docs? -> add
      affected documentation files

| File                        | Action | What changes                                    |
| --------------------------- | ------ | ----------------------------------------------- |
| `src/handlers/create.ts`    | Modify | Add `resolveCluster` helper, update `onCreate`  |
| `src/handlers/create.test.ts` | Modify | Add 3 test cases (see Test impact section)    |
| `package.json`              | Modify | Add `zod` dependency                            |
| ...                         |        |                                                 |

## Test impact

For every modified production function, list the test functions that cover it.
This is not optional -- search the test files and record the results.

| Changed function | Tests that depend on it                            | Test change needed                               |
| ---------------- | -------------------------------------------------- | ------------------------------------------------ |
| `streamOutput`   | `test_running_streams`, `test_completed_streams`   | Update assertion on `follow` flag                |
| `buildConfig`    | `test_config_defaults`                             | Add assertion for new `nodeName` field           |
| ...              |                                                    |                                                  |

### New tests

List every new test by name, with a one-line description of what it verifies.

| Test                              | Verifies                                |
| --------------------------------- | --------------------------------------- |
| `test_create_resource_not_found`  | Returns 422 when target does not exist  |
| ...                               |                                         |

## Edge cases (failure-mode driven)

Organize by **what can go wrong at each step**, not by input variation. For each
step in the implementation path, ask: what if this step fails? what state have
we already committed? can we still return a proper error?

| Step               | Failure mode               | Observable behavior                   | Handling                                      |
| ------------------ | -------------------------- | ------------------------------------- | --------------------------------------------- |
| Validate input     | Schema violation           | Error before any side effects         | Return structured error response              |
| Write to database  | Connection lost mid-write  | Partial state committed               | Wrap in transaction, rollback on failure      |
| Stream response    | Client disconnects         | Context canceled                      | Listen for cancellation, clean up resources   |
| ...                |                            |                                       |                                               |

## While we're here

Adjacent improvements that are tempting because you will already be in these
files. For each, make an explicit decision:

| Improvement                                  | Decision            | Rationale                                    |
| -------------------------------------------- | ------------------- | -------------------------------------------- |
| Extract shared validation logic into a util  | Include             | Already modifying both callers, low risk     |
| Add request body size to access logs         | Exclude (follow-up) | Separate concern, adds scope                 |
| ...                                          |                     |                                              |

## Verification

How to verify the change is correct. Include both automated and manual steps.

```bash
# Automated (adapt to project tooling)
<format command>
<lint command>
<test command>
```

List any manual verification steps (e.g., inspect generated output, check log
format, test in staging environment).

## Assumptions

Anything you are assuming to be true that, if false, would invalidate this plan.

- The `getItems` method returns fully populated child objects (verified by
  reading the source)
- The client library retries transient failures automatically (verified by
  reading the docs)

---

## Template usage notes

### What makes a good plan (lessons from past plans)

1. **Be concrete.** Include exact function signatures, type definitions, and
   test case names. Prose descriptions of code changes ("update the handler")
   are a sign the plan is not fully thought through.

2. **Count every file.** Plans routinely underestimate the diff size by omitting
   "boring" files (dependency manifests, configs, docs). Every file in the diff
   is a file someone reviews.

3. **Trace test dependencies.** Do not guess whether tests need updating. Search
   the codebase and record which tests call each function you are changing.

4. **Do not promise incremental phases you will not deliver.** If the work will
   ship as one commit (it almost always does), plan it as one commit. Only
   specify phases if each has a concrete validation gate and you will actually
   stop between them.

5. **Edge cases follow the code path, not the input space.** "Invalid name" is
   an input edge case. "Database fails after response headers are committed" is
   a failure-mode edge case. The latter is what catches real bugs.

6. **Name what you will not do.** The "while we're here" and "non-goals"
   sections prevent unacknowledged scope creep. An undocumented divergence from
   the plan is worse than a larger plan that accounts for the extra work.

7. **The plan is a contract.** If you diverge during implementation, stop and
   call out the change before proceeding.
