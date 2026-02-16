---
name: project-new
description: Clone a git repo into a bare-repo + worktree + tmux session setup. Use when the user wants to create a new project, clone a repo with worktree isolation, or set up a bare-repo project structure. Triggers include 'new project', 'clone repo', 'setup project', or any request to initialize a repo for parallel AI-driven development.
---

# Project New

## Overview

Clone a git repository into a **bare-repo + worktree** structure optimized for parallel development, then spawn a tmux master session.

## When to Use

- "Create a new project from `<repo-url>`"
- "Clone `<repo-url>` with worktree setup"
- "Set up project for `<repo-url>`"

## Defaults

| Variable         | Value          | Condition       |
| ---------------- | -------------- | --------------- |
| `ROOT_DIR`       | `~/myprojects` | GitHub repos    |
| `ROOT_DIR`       | `~/projects`   | All other repos |
| `DEFAULT_BRANCH` | auto-detected  | from remote HEAD, fallback `master` |
| `WORKTREE_DIR`   | `worktrees`    |                 |

## The Process

### Step 1: Resolve Repo Name and Root Dir

Extract `REPO_NAME` from the URL. Handles HTTPS, SSH, and `.git` suffix.
Set `ROOT_DIR` based on the git host — GitHub repos go to `~/myprojects`, everything else to `~/projects`.

```bash
WORKTREE_DIR="worktrees"

REPO_NAME="$(basename "$REPO_URL" .git)"

# GitHub repos → ~/myprojects, others → ~/projects
if [[ "$REPO_URL" == *github.com* ]]; then
    ROOT_DIR="$HOME/myprojects"
else
    ROOT_DIR="$HOME/projects"
fi

PROJECT_HOME="$ROOT_DIR/$REPO_NAME"
```

### Step 2: Guard — Already Exists

```bash
[[ -d "$PROJECT_HOME" ]] && { echo "Error: $PROJECT_HOME already exists"; exit 1; }
```

### Step 3: Clone Bare Repo

```bash
mkdir -p "$PROJECT_HOME"
git clone --bare "$REPO_URL" "$PROJECT_HOME/.bare"
```

### Step 4: Create `.git` File

```bash
echo "gitdir: ./.bare" > "$PROJECT_HOME/.git"
```

### Step 5: Configure Remote Fetch

Bare clones don't track remote branches by default. Fix that:

```bash
git -C "$PROJECT_HOME" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
```

### Step 6: Detect Default Branch

Read the default branch from the remote HEAD. Fallback to `master` if detection fails.

```bash
DEFAULT_BRANCH="$(git -C "$PROJECT_HOME" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-master}"
```

### Step 7: Create Master Worktree

```bash
cd "$PROJECT_HOME"
git worktree add "$REPO_NAME" "$DEFAULT_BRANCH"
```

### Step 8: Spawn Tmux Master Session

Export both `PROJECT_HOME` and `DEFAULT_BRANCH` so worker skills (e.g. `project-task`) can use them.

```bash
SESSION_NAME="${REPO_NAME}@${DEFAULT_BRANCH}"
# Sanitize: tmux forbids colons and periods
SESSION_NAME="${SESSION_NAME//:/-}"
SESSION_NAME="${SESSION_NAME//./-}"

tmux new-session -d -s "$SESSION_NAME" \
    -e "PROJECT_HOME=$PROJECT_HOME" \
    -e "DEFAULT_BRANCH=$DEFAULT_BRANCH" \
    -c "$PROJECT_HOME/$REPO_NAME"
```

### Step 9: Output Summary

```
✓ Project ready
  Repo:       $REPO_NAME
  Home:       $PROJECT_HOME
  Worktree:   $PROJECT_HOME/$REPO_NAME
  Session:    $SESSION_NAME

Attach with: tmux switch-client -t '$SESSION_NAME'
```

## Result Structure

```
$ROOT_DIR/$REPO_NAME/          # ~/myprojects/ for GitHub, ~/projects/ for others
├── .bare/                     # Bare git data
├── .git                       # File → .bare
└── $REPO_NAME/                # Master worktree (tmux session starts here)
```

## Common Mistakes

| Mistake                                 | Fix                                       |
| --------------------------------------- | ----------------------------------------- |
| Forgetting `remote.origin.fetch` config | Bare clones need this to track branches   |
| Colons/periods in tmux session name     | Always sanitize before `tmux new-session` |
| Cloning into existing directory         | Check first, abort if exists              |

## Red Flags

**Never:** clone into an existing project directory, skip the `.git` file creation, forget the `remote.origin.fetch` config.

**Always:** sanitize tmux session names, set `PROJECT_HOME` env var in the tmux session.
