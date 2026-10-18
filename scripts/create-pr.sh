#!/usr/bin/env bash
# create-pr.sh — Create a PR as aflow-pr-agent[bot] and request review from munchist.
#
# The PR is authored by the GitHub App so that the human review satisfies
# the "required approving review" ruleset without admin bypass.
#
# Usage:
#   ./scripts/create-pr.sh --title "feat(scope): description" --body "PR body text"
#   ./scripts/create-pr.sh --title "feat(scope): description" --body-file /tmp/pr-body.md
#   ./scripts/create-pr.sh --title "feat(scope): description"  # creates with no body
#   ./scripts/create-pr.sh                                      # re-requests review on existing PR
#   ./scripts/create-pr.sh --title "new title" --body "new body" # updates existing PR title/body
#
# If a PR already exists for the current branch, the script re-requests
# review and optionally updates the title/body. No duplicate PR is created.
#
#   ./scripts/create-pr.sh --dry-run                            # proves credentials, creates nothing
#
# Requirements:
#   - gh CLI authenticated
#   - APP_ID and APP_PRIVATE_KEY_FILE (or APP_PRIVATE_KEY) in the environment,
#     the repository's .env, or ~/.config/aflow/pr-bot.env — the last is the
#     one that resolves from every worktree
#   - On a feature branch (not main); pushed here when it has no upstream
#
# The App credentials belong to the maintainers. A contributor without them
# opens a pull request the ordinary way, with `gh pr create`.

set -euo pipefail

# ── Parse arguments ──────────────────────────────────────────────────────────

TITLE=""
BODY=""
BODY_FILE=""
BASE="main"
REVIEWER="munchist"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --title)    TITLE="$2";     shift 2 ;;
    --body)     BODY="$2";      shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --base)     BASE="$2";      shift 2 ;;
    --reviewer) REVIEWER="$2";  shift 2 ;;
    --dry-run)  DRY_RUN=1;        shift 1 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$BODY_FILE" ]; then
  BODY=$(cat "$BODY_FILE")
fi

# ── Resolve bot credentials ─────────────────────────────────────────────────

# .env is gitignored and therefore absent from every worktree, so credentials
# must also resolve from outside the checkout — otherwise the bot path fails in
# exactly the place agents work and callers fall back to an authored-by-human PR.
# Read with python rather than the dotenv package: a fresh worktree has no
# node_modules, and the reader must work there first of all. KEY=value lines,
# optional `export`, optional quotes, `#` comments; a key's last value wins.

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

read_env_key() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  ENV_FILE="$file" ENV_KEY="$key" python3 -c '
import os, re, sys
key = os.environ["ENV_KEY"]
pattern = re.compile(r"^\s*(?:export\s+)?" + re.escape(key) + r"\s*=\s*(.*?)\s*$")
found = None
with open(os.environ["ENV_FILE"], encoding="utf-8", errors="replace") as fh:
    for line in fh:
        m = pattern.match(line)
        if m:
            value = m.group(1)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"\x27":
                value = value[1:-1]
            else:
                value = value.split(" #", 1)[0].strip()
            found = value
if not found:
    sys.exit(1)
sys.stdout.write(found)
'
}

CRED_FILES=("$REPO_ROOT/.env" "$HOME/.config/aflow/pr-bot.env")
CRED_SOURCE="process environment"

for key in APP_ID APP_PRIVATE_KEY_FILE APP_PRIVATE_KEY; do
  if [ -z "${!key:-}" ]; then
    for cred_file in "${CRED_FILES[@]}"; do
      value=$(read_env_key "$cred_file" "$key" 2>/dev/null || true)
      if [ -n "$value" ]; then
        export "$key=$value"
        [ "$key" = "APP_ID" ] && CRED_SOURCE="$cred_file"
        break
      fi
    done
  fi
done

# ── Resolve repo and branch ─────────────────────────────────────────────────

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
BRANCH=$(git branch --show-current)

if [ "$BRANCH" = "$BASE" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "Error: you are on $BASE — switch to a feature branch first" >&2
  exit 1
fi

# The pull request shows what origin holds, so the branch is pushed first,
# every time. Not a check for an upstream: a branch made from origin/main
# tracks main and would read as pushed. A plain push is a no-op when origin is
# current and stops here, rather than opening a stale pull request, when the
# branch has diverged from it.
if [ "$DRY_RUN" -eq 0 ]; then
  echo "Pushing $BRANCH to origin..."
  git push -u origin "$BRANCH"
fi

EXISTING_PR=""
if [ "$DRY_RUN" -eq 0 ]; then
  EXISTING_PR=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number,url -q '.[0]')
fi


# ── Generate GitHub App token ────────────────────────────────────────────────

if [ -z "${APP_ID:-}" ]; then
  echo "Error: no APP_ID in the environment, $REPO_ROOT/.env or ~/.config/aflow/pr-bot.env." >&2
  echo "  This script opens pull requests as the maintainers' GitHub App. Without its" >&2
  echo "  credentials, open yours with: gh pr create" >&2
  exit 1
fi

# Resolve private key: file path (preferred) or inline env var (fallback)
if [ -n "${APP_PRIVATE_KEY_FILE:-}" ]; then
  # Expand ~ to $HOME (dotenv-cli does not expand tildes)
  APP_PRIVATE_KEY_FILE="${APP_PRIVATE_KEY_FILE/#\~/$HOME}"
  if [ ! -f "$APP_PRIVATE_KEY_FILE" ]; then
    echo "Error: APP_PRIVATE_KEY_FILE points to non-existent file: $APP_PRIVATE_KEY_FILE" >&2
    exit 1
  fi
  APP_PRIVATE_KEY=$(cat "$APP_PRIVATE_KEY_FILE")
elif [ -z "${APP_PRIVATE_KEY:-}" ]; then
  echo "Error: APP_PRIVATE_KEY_FILE or APP_PRIVATE_KEY must be set in environment" >&2
  echo "  Preferred: APP_PRIVATE_KEY_FILE=~/.config/aflow/pr-bot.pem" >&2
  exit 1
fi

generate_jwt() {
  local app_id="$1"
  local pem="$2"
  local now
  now=$(date +%s)
  local iat=$((now - 60))
  local exp=$((now + 600))

  local header
  header=$(printf '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
  local payload
  payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$iat" "$exp" "$app_id" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

  local signature
  signature=$(printf '%s.%s' "$header" "$payload" | \
    openssl dgst -sha256 -sign <(echo "$pem") -binary | \
    openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

echo "Generating GitHub App token..."
JWT=$(generate_jwt "$APP_ID" "$APP_PRIVATE_KEY")

# Get installation ID for this repo
INSTALL_ID=$(curl -sf \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/installation" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# Get installation access token
APP_TOKEN=$(curl -sf \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/$INSTALL_ID/access_tokens" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "Token generated for installation $INSTALL_ID"

if [ "$DRY_RUN" -eq 1 ]; then
  REPO_COUNT=$(curl -sf \
    -H "Authorization: token $APP_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/installation/repositories" | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['total_count'])")
  echo ""
  echo "Dry run OK — no PR was created or modified."
  echo "  credentials from: $CRED_SOURCE"
  echo "  app id:           $APP_ID"
  echo "  private key:      ${APP_PRIVATE_KEY_FILE:-<inline APP_PRIVATE_KEY>}"
  echo "  installation:     $INSTALL_ID ($REPO_COUNT repo(s))"
  echo "  would author as:  aflow-pr-agent[bot]"
  exit 0
fi

# ── Create the PR as the bot ────────────────────────────────────────────────

if [ -n "$EXISTING_PR" ]; then
  PR_NUMBER=$(echo "$EXISTING_PR" | python3 -c "import sys,json; print(json.load(sys.stdin)['number'])")
  PR_URL=$(echo "$EXISTING_PR" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
  echo "PR #$PR_NUMBER already exists: $PR_URL"

  if [ -n "$TITLE" ] || [ -n "$BODY" ]; then
    EDIT_ARGS=(--repo "$REPO")
    [ -n "$TITLE" ] && EDIT_ARGS+=(--title "$TITLE")
    [ -n "$BODY" ] && EDIT_ARGS+=(--body "$BODY")
    GH_TOKEN="$APP_TOKEN" gh pr edit "$PR_NUMBER" "${EDIT_ARGS[@]}"
    echo "Updated PR title/body"
  fi
else
  if [ -z "$TITLE" ]; then
    echo "Error: --title is required when creating a new PR" >&2
    exit 1
  fi
  echo "Creating PR: $TITLE"

  PR_ARGS=(
    --repo "$REPO"
    --head "$BRANCH"
    --base "$BASE"
    --title "$TITLE"
  )

  if [ -n "$BODY" ]; then
    PR_ARGS+=(--body "$BODY")
  fi

  PR_URL=$(GH_TOKEN="$APP_TOKEN" gh pr create "${PR_ARGS[@]}")
  PR_NUMBER=$(echo "$PR_URL" | grep -o '[0-9]*$')
  echo "Created PR #$PR_NUMBER: $PR_URL"
fi

# ── Request review ───────────────────────────────────────────────────────────

GH_TOKEN="$APP_TOKEN" gh pr edit "$PR_NUMBER" --repo "$REPO" --add-reviewer "$REVIEWER"
echo "Requested review from $REVIEWER"

echo ""
echo "Done! PR #$PR_NUMBER is authored by aflow-pr-agent[bot]."
echo "Your approval will satisfy the required review."
echo "$PR_URL"
