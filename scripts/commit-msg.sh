#!/bin/sh
# Conventional Commits check (lefthook commit-msg).
# Allowed types: feat fix docs style refactor perf test build ci chore revert.
msg=$(head -1 "$1")
if ! echo "$msg" | grep -qE '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?(!)?: .+'; then
  echo "commit message must follow Conventional Commits:"
  echo "  feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert(scope): message"
  echo "got: $msg"
  exit 1
fi
