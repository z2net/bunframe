<!-- Target branch: dev/main (release PRs: dev/main -> main only).
     Title: a Conventional Commit - feat|fix|docs|... (scope): message. -->

## What

<!-- One topic: what does this PR change? -->

## Why

<!-- The problem, or the PLAN.md section it implements. Link issues. -->

## How tested

- [ ] `cargo fmt` / `cargo clippy --all-targets -- -D warnings` / `cargo test`
- [ ] `bun run lint` / `bun run typecheck` / `bun test`
- [ ] `BFFI_E2E=1 bun test` (windowed - required for core surface changes)
- [ ] `bun run codegen` included (when the Rust API surface changed)

## Invariants (core changes only)

- [ ] One EventLoop per process; the quit test stays LAST in the e2e
- [ ] The loop thread owns windows (Commands through the proxy only)
- [ ] The pump contract (callback deliveries happen while JS pumps)
- [ ] Handlers never throw across the boundary (always reply / fail-open)
- [ ] Test-only exports stay OUT of module_def

## Breaking?

<!-- `!` after the type or "BREAKING CHANGE:" in the footer. Name
     what breaks and the migration path. -->
