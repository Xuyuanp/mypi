#!/usr/bin/env bash
#
# project-new.sh — Clone a repo into a bare-repo + worktree setup
#
# Usage: project-new.sh <repo-url>
#
# Env vars (set by the extension from config):
#   PROJECT_ROOT_DIR       — Parent directory for all projects (e.g. ~/projects)
#   PROJECT_DEFAULT_BRANCH — Default branch name (e.g. master)
#   PROJECT_WORKTREE_DIR   — Worktree subdirectory name (e.g. worktrees)
#
# Creates:
#   $PROJECT_ROOT_DIR/$REPO_NAME/
#   ├── .bare/                          # Bare git clone
#   ├── .git                            # File pointing to .bare
#   ├── $REPO_NAME/                     # Master worktree
#   └── $PROJECT_WORKTREE_DIR/          # Future task worktrees
#
set -euo pipefail

REPO_URL="${1:?Usage: project-new.sh <repo-url>}"

ROOT_DIR="${PROJECT_ROOT_DIR:?PROJECT_ROOT_DIR not set}"
DEFAULT_BRANCH="${PROJECT_DEFAULT_BRANCH:?PROJECT_DEFAULT_BRANCH not set}"
WORKTREE_DIR="${PROJECT_WORKTREE_DIR:?PROJECT_WORKTREE_DIR not set}"

# ── Resolve repo name from URL ───────────────────────────────────
# Handles: https://.../<name>.git, git@...:org/<name>.git, <name>.git, <name>
REPO_NAME="$(basename "$REPO_URL" .git)"

if [[ -z "$REPO_NAME" ]]; then
    echo "Error: could not resolve repo name from '$REPO_URL'" >&2
    exit 1
fi

PROJECT_HOME="$ROOT_DIR/$REPO_NAME"

# ── Guard: already exists? ───────────────────────────────────────
if [[ -d "$PROJECT_HOME" ]]; then
    echo "Error: project directory already exists: $PROJECT_HOME" >&2
    exit 1
fi

# ── Clone bare repo ─────────────────────────────────────────────
echo "Cloning bare repo..."
mkdir -p "$PROJECT_HOME"
git clone --bare "$REPO_URL" "$PROJECT_HOME/.bare" 2>&1

# ── Create .git file pointing to .bare ───────────────────────────
echo "gitdir: ./.bare" > "$PROJECT_HOME/.git"

# ── Configure fetch to track remote branches properly ────────────
# Bare clones don't set this by default
git -C "$PROJECT_HOME" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"

# ── Create master worktree ───────────────────────────────────────
cd "$PROJECT_HOME"
echo "Creating worktree for '$DEFAULT_BRANCH'..."
git worktree add "$REPO_NAME" "$DEFAULT_BRANCH" 2>&1

# ── Spawn tmux session ──────────────────────────────────────────
SESSION_NAME="${REPO_NAME}@${DEFAULT_BRANCH}"

# Avoid colons and periods in tmux session names
SESSION_NAME="${SESSION_NAME//:/-}"
SESSION_NAME="${SESSION_NAME//./-}"

if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
    echo "Warning: tmux session '$SESSION_NAME' already exists, skipping" >&2
else
    echo "Spawning tmux session '$SESSION_NAME'..."
    tmux new-session -d -s "$SESSION_NAME" \
        -e "PROJECT_HOME=$PROJECT_HOME" \
        -c "$PROJECT_HOME/$REPO_NAME"
fi

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo "✓ Project ready"
echo "  Repo:       $REPO_NAME"
echo "  Home:       $PROJECT_HOME"
echo "  Worktree:   $PROJECT_HOME/$REPO_NAME"
echo "  Session:    $SESSION_NAME"
echo ""
echo "Attach with: tmux switch-client -t '$SESSION_NAME'"
