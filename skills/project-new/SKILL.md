---
name: project-new
description: Clone a git repo into a bare-repo + worktree + tmux session setup. Use when the user wants to create a new project, clone a repo with worktree isolation, or set up a bare-repo project structure. Triggers include 'new project', 'clone repo', 'setup project', or any request to initialize a repo for parallel AI-driven development.
---

# Project New

Clone a git repository into a **bare-repo + worktree** structure, then spawn a tmux master session.

## Usage

Ask the user for `<repo-url>` if not provided, then run:

```bash
SKILL_DIR="<absolute path to this skill directory>"
bash "$SKILL_DIR/scripts/project-new.sh" "<repo-url>"
```

Optional env overrides (set before invoking):
- `PROJECT_ROOT_DIR` -- parent directory (default: `~/myprojects` for GitHub, `~/projects` otherwise)
- `PROJECT_DEFAULT_BRANCH` -- branch name (default: auto-detected from remote HEAD, fallback `master`)

## Result Structure

```
$ROOT_DIR/$REPO_NAME/
├── .bare/              # Bare git data
├── .git                # File pointing to .bare
└── $REPO_NAME/         # Master worktree (tmux session starts here)
```

The tmux session is named `$REPO_NAME@$DEFAULT_BRANCH` with `PROJECT_HOME` and `DEFAULT_BRANCH` exported as env vars for downstream skills (e.g. `project-task`).
