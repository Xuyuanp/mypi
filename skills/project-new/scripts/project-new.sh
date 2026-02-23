#!/usr/bin/env bash
#
# project-new.sh — Clone a repo into a bare-repo + worktree + tmux session setup
#
# Usage: project-new.sh <repo-url>
#
# Optional env overrides:
#   PROJECT_ROOT_DIR       — Parent directory (default: ~/myprojects for GitHub, ~/projects otherwise)
#   PROJECT_DEFAULT_BRANCH — Default branch (default: auto-detected from remote HEAD, fallback master)
#
# Creates:
#   $ROOT_DIR/$REPO_NAME/
#   ├── .bare/              # Bare git clone
#   ├── .git                # File pointing to .bare
#   └── $REPO_NAME/         # Master worktree (tmux session starts here)
#
set -euo pipefail

REPO_URL="${1:?Usage: project-new.sh <repo-url>}"

# ── Resolve repo name from URL ───────────────────────────────────
REPO_NAME="$(basename "$REPO_URL" .git)"
if [[ -z "$REPO_NAME" ]]; then
    echo "Error: could not resolve repo name from '$REPO_URL'" >&2
    exit 1
fi

# ── Resolve root dir ─────────────────────────────────────────────
if [[ -n "${PROJECT_ROOT_DIR:-}" ]]; then
    ROOT_DIR="$PROJECT_ROOT_DIR"
elif [[ "$REPO_URL" == *github.com* ]]; then
    ROOT_DIR="$HOME/myprojects"
else
    ROOT_DIR="$HOME/projects"
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

# ── Configure fetch to track remote branches ─────────────────────
git -C "$PROJECT_HOME" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"

# ── Detect default branch ────────────────────────────────────────
if [[ -n "${PROJECT_DEFAULT_BRANCH:-}" ]]; then
    DEFAULT_BRANCH="$PROJECT_DEFAULT_BRANCH"
else
    DEFAULT_BRANCH="$(git -C "$PROJECT_HOME" ls-remote --symref origin HEAD 2>/dev/null \
        | awk '/^ref:/ { sub(/refs\/heads\//, "", $2); print $2 }')" || true
    DEFAULT_BRANCH="${DEFAULT_BRANCH:-master}"
fi

# ── Create master worktree ───────────────────────────────────────
cd "$PROJECT_HOME"
echo "Creating worktree for '$DEFAULT_BRANCH'..."
git worktree add "$REPO_NAME" "$DEFAULT_BRANCH" 2>&1

# ── Spawn tmux session ──────────────────────────────────────────
SESSION_NAME="${REPO_NAME}@${DEFAULT_BRANCH}"
SESSION_NAME="${SESSION_NAME//:/-}"
SESSION_NAME="${SESSION_NAME//./-}"

if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
    echo "Warning: tmux session '$SESSION_NAME' already exists, skipping" >&2
else
    echo "Spawning tmux session '$SESSION_NAME'..."
    tmux new-session -d -s "$SESSION_NAME" \
        -e "PROJECT_HOME=$PROJECT_HOME" \
        -e "DEFAULT_BRANCH=$DEFAULT_BRANCH" \
        -c "$PROJECT_HOME/$REPO_NAME"
fi

# ── Done ─────────────────────────────────────────────────────────
cat <<EOF

Done! Project ready
  Repo:       $REPO_NAME
  Home:       $PROJECT_HOME
  Worktree:   $PROJECT_HOME/$REPO_NAME
  Branch:     $DEFAULT_BRANCH
  Session:    $SESSION_NAME

Attach with: tmux switch-client -t '$SESSION_NAME'
EOF
