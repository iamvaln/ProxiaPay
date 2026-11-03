#!/usr/bin/env bash
# Exit 0 if the tag's commit is reachable from origin/main, 1 otherwise.
# A v* tag can be pushed from any branch; only main is ever released.
# Needs full history (fetch-depth: 0): a shallow clone cannot answer.
set -euo pipefail
tag=${1:?usage: check-tag-on-main.sh <tag>}
commit=$(git rev-parse --verify --quiet "refs/tags/${tag}^{commit}") || { echo "tag $tag does not exist" >&2; exit 1; }
if ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "tag $tag is not on main" >&2
  exit 1
fi
echo "tag $tag is on main"
