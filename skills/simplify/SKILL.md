---
name: simplify
description: >-
  Automated code reviewer and fixer that scans recent changes for reuse opportunities,
  quality issues, and inefficiencies — then applies corrections directly. Use when the user
  says "simplify", "clean up my code", "review and fix", or wants a second pass on code they
  just wrote before committing. Also triggers on requests like "check for duplication",
  "optimize this", or "any reuse opportunities?"
---

# /simplify

Review recent code changes across three dimensions and fix issues directly.

## Step 1: Identify Changes

Determine what to review:

1. Check for uncommitted git changes (staged + unstaged): `git diff HEAD`
2. If there are no git changes, ask the user which files to review

If the diff is empty and no files are obvious from context, ask before proceeding.

## Step 2: Launch Three Parallel Review Agents

Spawn three subagent workers concurrently, each analyzing the same diff from a different angle.
Pass each agent the full diff (or file paths if large) and the project's root directory as cwd.

### Agent 1: Code Reuse

Task prompt:

```
Review the following diff for code reuse opportunities. Search the codebase for existing
utilities, helpers, constants, and patterns that could replace newly written code. Flag any
duplication of functionality that already exists elsewhere in the project.

For each finding, report:
- The new code location (file + line range)
- The existing utility/helper that could be used instead (file + export name)
- A brief explanation of why it's a valid replacement

Only report findings where the existing code is a clear, drop-in (or near drop-in)
replacement. Skip marginal cases.

Diff:
<diff content>
```

### Agent 2: Code Quality

Task prompt:

```
Review the following diff for code quality issues. Look for:
- Redundant or unnecessary state
- Parameter sprawl (too many params where an object/config would be clearer)
- Copy-paste with slight variation (should be abstracted)
- Leaky abstractions (implementation details exposed to callers)
- Stringly-typed code (string literals where enums/constants belong)
- Comments that restate the obvious
- Overly complex control flow that could be simplified
- Dead code or unreachable branches

For each finding, report the file, line range, what the issue is, and a concrete fix.
Skip stylistic nitpicks — focus on structural improvements.

Diff:
<diff content>
```

### Agent 3: Efficiency

Task prompt:

```
Review the following diff for performance and efficiency issues. Look for:
- Redundant computations (same value computed multiple times)
- Missed concurrency opportunities (sequential awaits that could be parallel)
- Hot-path bloat (expensive operations in tight loops)
- No-op state updates inside loops
- TOCTOU anti-patterns (check-then-act where the check can go stale)
- Memory leaks (event listeners not cleaned up, unbounded caches)
- Overly broad operations (reading entire files/collections when only a subset is needed)
- O(n^2) patterns hiding in plain sight

For each finding, report the file, line range, what the issue is, estimated impact,
and a concrete fix.

Diff:
<diff content>
```

## Step 3: Aggregate and Fix

Once all three agents complete:

1. Collect their findings into a single list
2. Discard false positives or low-value findings (note them briefly with reason)
3. For each valid finding, apply the fix directly to the code
4. Summarize what was changed at the end

If all agents report no issues, confirm the code is clean — do not invent problems.

## User Arguments

If the user provides additional focus (e.g. `/simplify focus on error handling`), append
their guidance as supplementary context to each agent's task prompt. It steers attention
without replacing the default review criteria.
