#!/usr/bin/env bash
# Overnight lander: merges finished Fredrin ticket PRs whose merged result
# passes typecheck + lint + tests + build, then deploys main to Fly if it moved.
# GPU-only checks (perf, flicker on SwiftShader) are ignored on purpose; the
# Workers' runner has no GPU, so those fail without meaning anything.
set -uo pipefail
git config user.name "angels-lander"
git config user.email "angels-lander@users.noreply.github.com"

gate() {
  npm run typecheck >/tmp/gate.log 2>&1 || { echo "typecheck failed"; return 1; }
  npx biome check client common server >>/tmp/gate.log 2>&1 || { echo "biome failed"; return 1; }
  # One retry: a couple of wall-clock tests are load-sensitive.
  npx vitest run >>/tmp/gate.log 2>&1 || npx vitest run >>/tmp/gate.log 2>&1 || { echo "tests failed"; return 1; }
  npm run build -w client >>/tmp/gate.log 2>&1 || { echo "build failed"; return 1; }
}

note() { # comment once per head commit
  local n=$1 msg=$2 head
  head=$(gh pr view "$n" --json headRefOid --jq .headRefOid)
  gh pr view "$n" --json comments --jq '.comments[].body' | grep -q "lander: $head" && return
  gh pr comment "$n" --body "🤖 lander: $head — $msg" >/dev/null
}

for n in $(gh pr list --state open --base main --limit 50 --json number,headRefName,isDraft \
    --jq '.[] | select(.isDraft | not) | select(.headRefName | startswith("fredrin-")) | .number' | sort -n); do
  b=$(gh pr view "$n" --json headRefName --jq .headRefName)
  echo "::group::PR #$n ($b)"
  git fetch -q origin main "$b"
  git checkout -q -B land "origin/$b"
  if ! git merge -q --no-edit origin/main; then
    git merge --abort
    note "$n" "merge conflict with main; waiting for a Worker or the planner."
    echo "conflict"; echo "::endgroup::"; continue
  fi
  git diff --quiet "origin/$b" -- package-lock.json || npm ci --no-audit --no-fund >/dev/null 2>&1
  if why=$(gate); then
    git push -q origin "land:$b" && sleep 5 &&
      gh pr merge "$n" --squash --match-head-commit "$(git rev-parse HEAD)" &&
      echo "merged #$n"
  else
    tail -60 /tmp/gate.log
    note "$n" "not merged: $why on the merged result (see the Actions log)."
  fi
  echo "::endgroup::"
done

git fetch -q origin main --tags
main=$(git rev-parse origin/main)
if [ "$(git rev-parse -q --verify refs/tags/deployed 2>/dev/null)" != "$main" ]; then
  git checkout -q "$main"
  flyctl deploy --remote-only --ha=false -a angels-bandits &&
    git tag -f deployed "$main" && git push -q -f origin refs/tags/deployed &&
    echo "deployed $main"
fi
