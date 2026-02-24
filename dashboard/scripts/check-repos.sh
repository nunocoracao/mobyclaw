#!/bin/bash
# check-repos.sh - Monitor repos for new activity since last check
# Usage: check-repos.sh [MOBY_DIR] [repo1] [repo2] ...
# Returns summary of new PRs/issues/releases

MOBY_DIR="${1:-/data/.mobyclaw}"
shift
REPOS="${@:-docker/cagent nunocoracao/mobyclaw}"

STATE_DIR="$MOBY_DIR/state"
mkdir -p "$STATE_DIR"

check_repo() {
    local repo="$1"
    local state_file="$STATE_DIR/last-check-$(echo $repo | tr '/' '-')"
    local since=""

    if [ -f "$state_file" ]; then
        since=$(cat "$state_file")
    else
        since=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
    fi

    echo "=== $repo (since $since) ==="

    # New PRs
    local prs=$(curl -s "https://api.github.com/repos/$repo/pulls?state=all&sort=created&direction=desc&per_page=10" 2>/dev/null)
    local new_prs=$(echo "$prs" | jq -r --arg since "$since" '.[] | select(.created_at > $since) | "  PR #\(.number): \(.title) (@\(.user.login)) [\(.state)]"' 2>/dev/null)

    if [ -n "$new_prs" ]; then
        echo "New PRs:"
        echo "$new_prs"
    fi

    # New issues (not PRs)
    local issues=$(curl -s "https://api.github.com/repos/$repo/issues?state=all&sort=created&direction=desc&per_page=10" 2>/dev/null)
    local new_issues=$(echo "$issues" | jq -r --arg since "$since" '.[] | select(.pull_request == null and .created_at > $since) | "  Issue #\(.number): \(.title) (@\(.user.login)) [\(.state)]"' 2>/dev/null)

    if [ -n "$new_issues" ]; then
        echo "New Issues:"
        echo "$new_issues"
    fi

    # New releases
    local releases=$(curl -s "https://api.github.com/repos/$repo/releases?per_page=3" 2>/dev/null)
    local new_releases=$(echo "$releases" | jq -r --arg since "$since" '.[] | select(.created_at > $since) | "  Release \(.tag_name): \(.name // "no title")"' 2>/dev/null)

    if [ -n "$new_releases" ]; then
        echo "New Releases:"
        echo "$new_releases"
    fi

    if [ -z "$new_prs" ] && [ -z "$new_issues" ] && [ -z "$new_releases" ]; then
        echo "  No new activity"
    fi

    # Update timestamp
    date -u +%Y-%m-%dT%H:%M:%SZ > "$state_file"
    echo ""
}

for repo in $REPOS; do
    check_repo "$repo"
done
