# Contributing to bunframe

Thanks for helping build the desktop shell for Bun. Read
[AGENTS.md](AGENTS.md) first - the hard rules and the architecture
invariants live there and apply to every contribution.

## The branch model

```
main          stable. Releases only. NEVER a direct push.
dev/main      the integration branch. Everything lands here via PR.
dev/<topic>   your work branches, cut FROM dev/main, PR-ed INTO dev/main.
```

- Work happens in `dev/<short-topic>` branches (e.g.
  `dev/ipc-pipelining`, `dev/cli-build`).
- A `dev/*` branch merges into **`dev/main` via a Pull Request** -
  never push it directly.
- `main` receives code ONLY through a release PR (`dev/main` ->
  `main`). Direct pushes to `main` and `dev/main` are **blocked** by
  the pre-push guard (`scripts/pre-push-branch-guard.sh`); on GitHub,
  branch protection enforces the same. The only bypass is
  `LEFTHOOK=0 git push ...` for a maintainer emergency - use it like
  a fire exit: once, deliberately, and with a note in the PR.

```sh
git switch dev/main && git pull
git switch -c dev/my-topic     # cut from dev/main
# ... work, commit (Conventional Commits) ...
git push -u origin dev/my-topic
# open a PR -> dev/main
```

## Commit style

Conventional Commits, enforced by the commit-msg hook:

```
feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert(scope): message
```

Breaking changes: `!` after the type or `BREAKING CHANGE:` in the
footer. `bench` is NOT an allowed type - benches are `test:`.

## Pull requests

One topic per PR. The title MUST be a Conventional Commit (same
grammar as above) - it becomes the squashed-merge subject.

Targets:

- `dev/<topic>` -> **`dev/main`** for all work.
- `dev/main` -> **`main`** for release PRs only.

Every PR carries the description (see
`.github/pull_request_template.md`): what, why, how it was tested,
and - for core changes - the invariants checklist.

Gates that must be green before you open (or mark ready) a PR:

```sh
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
bun run lint && bun run typecheck && bun test
$env:BFFI_E2E = "1"; bun test   # windowed e2e, when the core surface changed
```

PRs that change the Rust API surface must include the regenerated
artifacts (`bun run codegen`) - never hand-edit `.bffi/*` or
`packages/core/src/api.gen.ts`.

## Issues

Blank issues are disabled - use the templates:

- **Bug report**: what happened, what you expected, a minimal repro
  (commands + code), the environment (OS, `bun --version`,
  `rustc --version` for core work, the `@bunframe/*` versions) and
  whether the windowed e2e (`BFFI_E2E=1`) reproduces it.
- **Feature request**: the problem first, then the proposal, the
  package it belongs to (`core` / `app` / `view` / `schema` / `cli`),
  alternatives you considered, and whether it is breaking.

One issue = one problem. Search before filing; link duplicates.

## House rules

- Bun only - zero `node:` imports anywhere.
- Windows-first: do not claim Linux/macOS support in docs or tests.
- No secrets, no `.env`, no personal AI tooling folders in commits.
- Registry-rendered docs (crates.io/npm READMEs) are frozen at
  publish time - fix docs in the repo, they ship with the next
  release.
