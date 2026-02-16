#!/usr/bin/env bash
#
# project-task.sh — Create/reuse a worktree + tmux session for a task branch
#
# Usage: project-task.sh <branch> <plan>
#   e.g.: project-task.sh fea/add-jwt-auth add-jwt-auth
#
# Env vars (set by the extension from config):
#   PROJECT_ROOT_DIR       — Parent directory for all projects
#   PROJECT_DEFAULT_BRANCH — Default branch name (e.g. master)
#   PROJECT_WORKTREE_DIR   — Worktree subdirectory name (e.g. worktrees)
#
# Must be run from the master worktree of a bare-repo project.
#
set -euo pipefail

BRANCH="${1:?Usage: project-task.sh <branch> <plan>}"
PLAN="${2:?Usage: project-task.sh <branch> <plan>}"

DEFAULT_BRANCH="${PROJECT_DEFAULT_BRANCH:?PROJECT_DEFAULT_BRANCH not set}"
WORKTREE_DIR_NAME="${PROJECT_WORKTREE_DIR:?PROJECT_WORKTREE_DIR not set}"

# ── Resolve PROJECT_HOME ─────────────────────────────────────────
# Walk up from cwd to find the directory containing .bare/
find_project_home() {
    local dir="$PWD"
    while [[ "$dir" != "/" ]]; do
        if [[ -d "$dir/.bare" ]]; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

PROJECT_HOME="$(find_project_home)" || {
    echo "Error: not inside a bare-repo project (no .bare/ found)" >&2
    exit 1
}

REPO_NAME="$(basename "$PROJECT_HOME")"

# ── Check: must be in the master session ─────────────────────────
# The master worktree lives at $PROJECT_HOME/$REPO_NAME and is on $DEFAULT_BRANCH.
# We verify by checking the current tmux session name matches the master pattern.

MASTER_SESSION="${REPO_NAME}@${DEFAULT_BRANCH}"
# Sanitize the same way project-new.sh does
MASTER_SESSION="${MASTER_SESSION//:/-}"
MASTER_SESSION="${MASTER_SESSION//./-}"

if [[ -n "${TMUX:-}" ]]; then
    CURRENT_SESSION="$(tmux display-message -p '#S')"
    if [[ "$CURRENT_SESSION" != "$MASTER_SESSION" ]]; then
        echo "Error: must be run from the master session '$MASTER_SESSION'" >&2
        echo "  Current session: '$CURRENT_SESSION'" >&2
        exit 1
    fi
else
    echo "Error: not running inside tmux" >&2
    exit 1
fi

# ── Resolve worktree path ────────────────────────────────────────
# Branch like "fea/add-jwt-auth" → worktree at $WORKTREE_DIR_NAME/fea/add-jwt-auth
WORKTREE_PATH="$PROJECT_HOME/$WORKTREE_DIR_NAME/$BRANCH"

# ── Create or reuse worktree ────────────────────────────────────
if [[ -d "$WORKTREE_PATH" ]]; then
    echo "Worktree already exists at $WORKTREE_PATH, reusing."
else
    echo "Creating worktree for branch '$BRANCH'..."
    mkdir -p "$(dirname "$WORKTREE_PATH")"

    # Check if branch exists on remote
    if git -C "$PROJECT_HOME" show-ref --verify --quiet "refs/heads/$BRANCH" 2>/dev/null; then
        # Local branch exists — just add worktree
        git -C "$PROJECT_HOME" worktree add "$WORKTREE_PATH" "$BRANCH" 2>&1
    elif git -C "$PROJECT_HOME" show-ref --verify --quiet "refs/remotes/origin/$BRANCH" 2>/dev/null; then
        # Remote branch exists — track it
        git -C "$PROJECT_HOME" worktree add "$WORKTREE_PATH" "$BRANCH" 2>&1
    else
        # New branch — create from default branch
        git -C "$PROJECT_HOME" worktree add "$WORKTREE_PATH" -b "$BRANCH" "$DEFAULT_BRANCH" 2>&1
    fi
fi

# ── Tmux session ────────────────────────────────────────────────
SESSION_NAME="${REPO_NAME}@${BRANCH}"
SESSION_NAME="${SESSION_NAME//:/-}"
SESSION_NAME="${SESSION_NAME//./-}"

if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
    echo "Tmux session '$SESSION_NAME' already exists, reusing."
else
    echo "Spawning tmux session '$SESSION_NAME'..."
    tmux new-session -d -s "$SESSION_NAME" \
        -e "PROJECT_HOME=$PROJECT_HOME" \
        -c "$WORKTREE_PATH"
fi

# ── Plan file ────────────────────────────────────────────────────
PLAN_FILE="$PROJECT_HOME/$REPO_NAME/.pi/project/${PLAN}.md"

if [[ ! -f "$PLAN_FILE" ]]; then
    echo ""
    echo "Warning: plan file not found: $PLAN_FILE" >&2
    echo "  Create it before running the worker agent." >&2
fi

# ── TODO: run pi agent in the worker session ─────────────────────
# tmux send-keys -t "=$SESSION_NAME" "pi -p < '$PLAN_FILE'" Enter

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo "✓ Task ready"
echo "  Branch:    $BRANCH"
echo "  Worktree:  $WORKTREE_PATH"
echo "  Session:   $SESSION_NAME"
echo "  Plan:      $PLAN_FILE"
echo ""
echo "Attach with: tmux switch-client -t '$SESSION_NAME'"
