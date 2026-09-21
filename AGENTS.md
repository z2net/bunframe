# AGENTS.md - Rules for AI agents and contributors

This file defines how AI agents and humans work on **bunframe**.

Repository: https://github.com/z2net/bunframe
Contact: contact@z2net.com

---

## 1. What this project is

bunframe is a **desktop application shell for Bun**: native windows
via `wry` (WebView2 / WKWebView / WebKitGTK) driven entirely from
TypeScript. It is the "inverted Tauri" - the backend language is
TypeScript on Bun, the native core is a thin Rust cdylib built with
the [bffi](https://github.com/z2net/bffi-rs) binding framework.

The Rust crate in this repo (`bunframe-core`) is ONLY the native
shell: windows, window events, the close veto and the IPC bridge.
All application backend logic lives in TypeScript on the Bun side.

Read the [Binding GUI guide](https://github.com/z2net/bffi-rs/blob/main/docs/BINDING-GUI.md)
- it documents the threading model this crate implements.

---

## 2. Hard rules

1. **Bun only.** No Node.js or Deno compatibility. Zero `node:`
   imports anywhere.

2. **Bun >= 1.4.2, Rust 1.98.0.** Both pinned; do not bump without
   an explicit decision.

3. **One EventLoop per process (winit 0.30).** The loop thread never
   respawns: once `app_quit()` runs, `window_open` fails with
   `LoopNotRunning` forever. Never add code that recreates the loop.

4. **The loop thread owns windows.** Every window mutation is
   proxied through the `EventLoopProxy` as a `Command` - never touch
   a `Window`/`WebView` from another thread.

5. **The pump contract.** Native deliveries (`invoke_wait` marshals)
   execute only while the JS thread pumps (`loop_pump` / the app
   run loop). No hidden timers, ever - that is a bffi design
   invariant.

6. **Handlers must never throw.** The IPC callback and the
   close-veto callback always answer (reply or fail-open), or the
   loop thread parks for the full timeout. Wrap user-facing
   patterns accordingly.

7. **Copy-by-default across the boundary.** Zero-copy exists in bffi
   (`unsafe_zero_copy`) but this crate does not use it.

8. **Test-only exports stay OUT of `module_def`.** Anything added to
   `ModuleDef` changes `exportsHash` and invalidates the generated
   API. Test helpers are plain `extern "C"` fns next to the ABI
   expansions.

9. **No secrets, no `.env`, no personal AI tooling folders**
   (`.zcode`, `.opencode`, `.claude`, ...). See `.gitignore`.

10. **License: MIT.** Keep the file; new files do not need SPDX
    headers unless stated.

---

## 3. Repository layout

```
bunframe/
├── Cargo.toml              # bunframe-core (cdylib + rlib) + emit-json bin
├── Cargo.lock              # COMMITTED (reproducible release builds)
├── rust-toolchain.toml     # pinned 1.98.0
├── .bffi/
│   ├── bffi.json           # pipeline config (module "bunframe")
│   ├── bffi.api.json       # loader JSON (generated, committed)
│   └── api.gen.ts          # the typed TS API (generated, committed)
├── src/
│   ├── lib.rs              # the whole core: loop thread, window ops,
│   │                       #   events stream, close veto, IPC bridge
│   ├── module_def.rs       # THE descriptor aggregation (ModuleDef)
│   └── bin/emit_json.rs    # writes .bffi/bffi.api.json
├── test/
│   └── bunframe.test.ts    # BFFI_E2E-gated suite (opens REAL windows)
├── package.json            # scripts + pinned dev deps + workspaces
├── lefthook.yml            # git hooks (fmt/clippy/typecheck, commit-msg)
├── AGENTS.md               # this file
└── packages/
    └── bunframe/           # @z2net/bunframe - THE package (one package +
                            # platform binaries):
                            #   .        -> createApp/Window/loader (bun side)
                            #   ./schema -> s descriptors + defineSchema
                            #   ./view   -> the page-side RPC shim (zero-dep)
                            #   ./cli    -> dev / build / init (+ template/)
                            # internal aliases live in package.json "imports"
                            # (#schema, #core, #app/*, #cli/*) - no ../..
```

---

## 4. The architecture (what must not break)

### Threading model

```
 Bun thread (TS backend)                bunframe-loop thread (native)
 ----------------------------------     ----------------------------------
 window_open(config)  --Create-->       winit EventLoop + Window + wry
 window_events(handle)  (stream)        events push stream per window
 window_set_title/...  --Op----->       apply on the loop thread
 window_bind_ipc / _bind_close          ipc handler / veto wired HERE
 run()/loop_pump()  <--marshal jobs--   invoke_wait (IPC + close veto)
 app_quit()  --Quit-->                  loop exits (process teardown)
```

- The loop thread spawns lazily on the first `window_open`.
- `close_window` pushes a `closed` event, completes the events
  stream and drops the registry slot - but NEVER exits the loop
  (winit rule, see hard rule 3).
- `CloseRequested` (title-bar X) consults the close-veto callback:
  `true` allows, `false` pushes `close-denied`; any error or timeout
  FAILS OPEN (the close proceeds). A hung backend must not make a
  window unclosable.

### The events stream

Each window opens a `spawn_push::<String>()` stream at creation.
Events are JSON strings: `{"type":"resized","width":..,"height":..}`,
`{"type":"focused","focused":..}`, `{"type":"close-denied"}`,
`{"type":"closed"}`. The loop thread pushes with `pollster::block_on`
(backpressure blocks the loop - the JS side must keep pulling). JS
pulls through the raw `bffi_stream_next` ABI; status `14` = Pending
(empty right now, retry).

### The IPC bridge

Page: `window.__bffiCall(method, args)` (the injected bootstrap
promise; 2s client-side reject). Native: the ipc handler on the loop
thread calls `invoke_wait(js_handle, [Value::Str(body)], 30s)`, the
JS handler answers through `window_ipc_reply`, the loop thread
resolves the page promise via `evaluate_script`.

### Test-only exports

`bffi_test_close_requested` simulates a title-bar X (dispatches the
veto path on a spawned native thread). It is deliberately NOT in
`module_def` (hard rule 8) and is consumed by the e2e through a
separate one-symbol `dlopen`.

---

## 5. Workflow

### Setup

```sh
rustup toolchain install   # resolves rust-toolchain.toml (1.98.0)
bun install
```

### Common commands

```sh
cargo build --release      # the cdylib (bunframe_core.dll/so/dylib)
cargo test                 # Rust unit tests (no windows needed)
cargo clippy --all-targets -- -D warnings
cargo fmt
bun install                # npm deps
bun run lint               # oxlint
bun run typecheck          # tsc over api.gen.ts + tests
bun test                   # unit-ish JS tests (skips windows)
$env:BFFI_E2E = "1"; bun test    # PowerShell: the REAL windowed e2e
bun run codegen            # emit-json + api.gen.ts regeneration
```

### CI note

`bun test` without `BFFI_E2E` skips every windowed test (the gate is
`test.skipIf(!E2E)`). CI never opens windows. The windowed e2e runs
on a developer machine or a self-hosted runner with a display.

### After changing the Rust API surface

1. `cargo build --release`
2. `cargo run --release --bin emit-json` (rewrites `.bffi/bffi.api.json`)
3. `bunx @z2net/bffi-cli codegen .bffi/bffi.api.json -o .bffi/api.gen.ts`
4. `bun run typecheck` (the generated API is type-checked against
   the tests)

---

## 6. Branching, commits and PRs

Branch model (see [CONTRIBUTING.md](CONTRIBUTING.md)):

- `main` - stable, releases only, NEVER a direct push.
- `dev/main` - the integration branch; everything lands via PR.
- `dev/<topic>` - work branches, cut from `dev/main`, PR-ed into
  `dev/main`; release PRs are `dev/main` -> `main`.
- Direct pushes to `main` / `dev/main` are blocked by the pre-push
  guard (`scripts/pre-push-branch-guard.sh`).

PR titles are Conventional Commits (the squashed-merge subject);
one topic per PR; the PR template gates (tests + invariants) must be
checked honestly. Issues use the `.github/ISSUE_TEMPLATE` templates.

Commit style (enforced by the commit-msg hook):
`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert(scope): message`.
Breaking changes: `!` after the type or `BREAKING CHANGE:` in the
footer. Note: `bench` is NOT an allowed type - benches are `test:`.

---

## 7. Rules for AI agents

1. Read this file fully before changing anything in `src/lib.rs`.
2. Preserve the threading model (hard rule 4) and the pump contract
   (hard rule 5) - these are the two invariants every bug so far
   has violated.
3. New JS-facing functions: write the `#[bffi]` fn, add it to
   `module_def::FUNCTIONS`, regenerate (`bun run codegen`), and
   extend the e2e. Never hand-edit `.bffi/api.gen.ts`.
4. Test-only exports follow hard rule 8 - outside `module_def`,
   mirrored into the RAW table of `test/bunframe.test.ts`.
5. Never make a callback handler able to throw through the
   boundary (hard rule 6).
6. Do not rename existing exports in a patch release; the generated
   API and the registry pages are frozen at publish time.
7. Keep the platform notes honest: Windows-first, macOS unsupported
   yet. Do not claim Linux/macOS support in docs or tests.
8. Run `cargo fmt`, `cargo clippy --all-targets -- -D warnings`,
   `cargo test`, `bun run lint`, `bun run typecheck` before every
   commit (the lefthook pre-push runs `cargo test --workspace`).
9. Docs that render on registries (crates.io/npm) are frozen at
   publish time - fix them in the repo, ship with the next version.
10. Framework rules (M2+): the RPC type contract is
    `packages/schema/src/types.ts` - the envelope, `RpcDef` and the
    inference helpers are frozen, do not drift them. Bun-side RPC
    handlers are SYNC in v0.1.0 (one `invoke_wait` per window at a
    time); validation is Standard Schema, always on, bun side only
    (`@z2net/bunframe-view` stays zero-dep). `app.quit()` is terminal -
    the loop never respawns.
