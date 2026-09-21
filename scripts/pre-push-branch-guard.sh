#!/bin/sh
# The branch guard: blocks DIRECT pushes to the protected branches
# (main, dev/main). All work lands via PR: dev/* -> dev/main -> main.
# Emergency bypass for a maintainer: LEFTHOOK=0 git push ...
#
# stdin (git pre-push): "<local-ref> <local-sha> <remote-ref> <remote-sha>"
set -u

ZERO=0000000000000000000000000000000000000000

while read -r _local_ref _local_sha remote_ref remote_sha; do
  [ -n "${remote_ref:-}" ] || continue
  case "$remote_ref" in
    refs/heads/main)
      echo "bunframe: direct push to 'main' is blocked." >&2
      echo "  releases go through a PR: dev/main -> main." >&2
      echo "  emergency bypass: LEFTHOOK=0 git push" >&2
      exit 1
      ;;
    refs/heads/dev/main)
      # Branch CREATION is allowed once (remote_sha = zeros): the
      # first push that seeds dev/main from main.
      if [ "$remote_sha" = "$ZERO" ]; then
        continue
      fi
      echo "bunframe: direct push to 'dev/main' is blocked." >&2
      echo "  push your dev/<topic> branch and open a PR -> dev/main." >&2
      echo "  emergency bypass: LEFTHOOK=0 git push" >&2
      exit 1
      ;;
  esac
done

exit 0
