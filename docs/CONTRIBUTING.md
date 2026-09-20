# Contributing to bunframe

Thanks for your interest! This document covers the practical rules.
The architecture invariants live in [AGENTS.md](AGENTS.md) - read it
before your first PR.

## Prerequisites

- [Bun](https://bun.sh) >= 1.4.2
- Rust 1.98.0 (pinned by `rust-toolchain.toml`)
- Windows 10/11 with the WebView2 runtime (the e2e opens REAL
  windows)

## Setup

```sh
bun install
cargo build --release
bun run e2e     # BFFI_E2E=1 bun test - opens real windows
```

## Branching

- `main` - production; PRs into `main` are created by the project
  owner.
- Features: `dev/<feature>` branches (kebab-case), cut from and
  merged back into `main` (or `dev/main` when the volume warrants
  the integration branch).

## Commit style

Conventional Commits (enforced by the commit-msg hook):

```
feat: add window_set_position
fix(veto): fail-open also on a revoked veto callback
docs: expand the events stream memo
```

Allowed types: `feat fix docs style refactor perf test build ci
chore revert`. Breaking changes: `!` after the type or
`BREAKING CHANGE:` in the footer.

## Pull requests

- One logical change per PR.
- CI must pass: `bun run ci` (lint + typecheck + fmt + clippy
  `-D warnings` + cargo test + bun test).
- The windowed e2e (`BFFI_E2E=1 bun test`) must pass on your
  machine when the change touches `src/lib.rs` or `test/`.
- Update `CHANGELOG.md` and docs when behavior or the API surface
  changes.
- Read `AGENTS.md` - the architecture invariants there are release
  blockers.

## Code style

- Rust: `cargo fmt` (run before committing); clippy must be clean
  with `-D warnings`.
- TypeScript: strict; `.ts` extensions in relative imports;
  `allowImportingTsExtensions` is on.
- No `node:` imports (Bun-only project).
- Comments explain WHY, not WHAT.
