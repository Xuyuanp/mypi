---
name: project-task
description: Create or reuse a git worktree and tmux session for a task branch, then execute a plan. Must be run from a master session of a bare-repo project. Use when the user wants to start a new task, create a feature branch with worktree, delegate work to a worker session, or any request to spawn a parallel task like 'create task', 'start feature', 'new worktree for branch'.
---

# Project Task

## Overview

Create (or reuse) a **git worktree + tmux session** for a task branch, within a bare-repo project. This is the delegation step — spawning a worker environment for parallel execution.

## When to Use

- "Create a task for `fea/add-jwt-auth`"
- "Start working on `fix/null-pointer`"
- "Spawn a worker for branch X with plan Y"

## Prerequisites

- `PROJECT_HOME` env var must be set (set automatically by `project-new` when creating the tmux session)
- Must be inside **tmux**
- Must be in the **master session** (`$REPO_NAME@$DEFAULT_BRANCH`)

## Defaults

| Variable            | Value       | Description                     |
| ------------------- | ----------- | ------------------------------- |
| `DEFAULT_BRANCH`    | from env    | Set by `project-new`, fallback `master` |
| `WORKTREE_DIR_NAME` | `worktrees` | Subdirectory for task worktrees |

## Arguments

| Arg      | Required | Description                                                        |
| -------- | -------- | ------------------------------------------------------------------ |
| `BRANCH` | Yes      | Branch name (e.g. `fea/add-jwt-auth`, `fix/login-crash`)           |
| `PLAN`   | Yes      | Plan name — maps to `.pi/project/<plan>.md` in the master worktree |

## The Process

### Step 1: Check PROJECT_HOME

`PROJECT_HOME` is set as an env var when the master tmux session is created by `project-new`. Abort if missing.

```bash
DEFAULT_BRANCH="${DEFAULT_BRANCH:-master}"
WORKTREE_DIR_NAME="worktrees"

if [[ -z "${PROJECT_HOME:-}" ]]; then
    echo "Error: PROJECT_HOME is not set. Run project-new first to create the project."
    exit 1
fi

REPO_NAME="$(basename "$PROJECT_HOME")"
```

### Step 2: Verify Master Session

ABORT if not in the master tmux session:

```bash
MASTER_SESSION="${REPO_NAME}@${DEFAULT_BRANCH}"
MASTER_SESSION="${MASTER_SESSION//:/-}"
MASTER_SESSION="${MASTER_SESSION//./-}"

if [[ -z "${TMUX:-}" ]]; then
    echo "Error: not running inside tmux"; exit 1
fi

CURRENT_SESSION="$(tmux display-message -p '#S')"
if [[ "$CURRENT_SESSION" != "$MASTER_SESSION" ]]; then
    echo "Error: must be run from master session '$MASTER_SESSION' (current: '$CURRENT_SESSION')"
    exit 1
fi
```

### Step 3: Create or Reuse Worktree

The worktree path mirrors the branch name: `$WORKTREE_DIR_NAME/$BRANCH`.

```bash
WORKTREE_PATH="$PROJECT_HOME/$WORKTREE_DIR_NAME/$BRANCH"

if [[ -d "$WORKTREE_PATH" ]]; then
    echo "Worktree already exists, reusing."
else
    mkdir -p "$(dirname "$WORKTREE_PATH")"

    if git -C "$PROJECT_HOME" show-ref --verify --quiet "refs/heads/$BRANCH"; then
        # Local branch exists
        git -C "$PROJECT_HOME" worktree add "$WORKTREE_PATH" "$BRANCH"
    elif git -C "$PROJECT_HOME" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
        # Remote branch exists — track it
        git -C "$PROJECT_HOME" worktree add "$WORKTREE_PATH" "$BRANCH"
    else
        # New branch — create from default branch
        git -C "$PROJECT_HOME" worktree add "$WORKTREE_PATH" -b "$BRANCH" "$DEFAULT_BRANCH"
    fi
fi
```

### Step 4: Create or Reuse Tmux Session

```bash
SESSION_NAME="${REPO_NAME}@${BRANCH}"
SESSION_NAME="${SESSION_NAME//:/-}"
SESSION_NAME="${SESSION_NAME//./-}"

if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
    echo "Tmux session '$SESSION_NAME' already exists, reusing."
else
    tmux new-session -d -s "$SESSION_NAME" \
        -e "PROJECT_HOME=$PROJECT_HOME" \
        -c "$WORKTREE_PATH"
fi
```

### Step 5: Verify Plan File

The plan file lives in the master worktree at `.pi/project/<plan>.md`:

```bash
PLAN_FILE="$PROJECT_HOME/$REPO_NAME/.pi/project/${PLAN}.md"

if [[ ! -f "$PLAN_FILE" ]]; then
    echo "Warning: plan file not found: $PLAN_FILE"
    echo "Create it before running the worker agent."
fi
```

### Step 6: TODO — Run Worker Agent

```bash
# tmux send-keys -t "=$SESSION_NAME" "pi -p < '$PLAN_FILE'" Enter
```

### Step 7: Output Summary

```
✓ Task ready
  Branch:    $BRANCH
  Worktree:  $WORKTREE_PATH
  Session:   $SESSION_NAME
  Plan:      $PLAN_FILE

Attach with: tmux switch-client -t '$SESSION_NAME'
```

## Branch Naming Convention

| Prefix  | Purpose          | Example                     |
| ------- | ---------------- | --------------------------- |
| `feat/` | New feature      | `feat/add-jwt-auth`         |
| `fix/`  | Bug fix / hotfix | `fix/null-pointer-on-login` |
| `ref/`  | Refactoring      | `ref/extract-auth-module`   |

## Common Mistakes

| Mistake                       | Fix                                   |
| ----------------------------- | ------------------------------------- |
| Running from a worker session | Must be in the master session         |
| Running outside tmux          | Must be inside tmux                   |
| Forgetting the plan file      | Create `.pi/project/<plan>.md` first  |
| Branch name without prefix    | Use `feat/`, `fix/`, or `ref/` prefix |

## Red Flags

**Never:** run from a non-master session, create worktrees outside `$WORKTREE_DIR_NAME`, skip tmux session name sanitization.

**Always:** check for existing worktree before creating, check for existing tmux session before spawning, set `PROJECT_HOME` env var in the worker session, verify the plan file exists.
