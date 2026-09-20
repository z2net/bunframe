[bff] Bun-only native binding framework written in Rust.

[bff] Bun-only native binding framework written in Rust - the napi-rs analogue for Bun.

# bunframe

A **desktop application shell for Bun**: native windows via `wry`
(WebView2 / WKWebView / WebKitGTK) driven entirely from TypeScript.
The inverted Tauri - the backend language is TypeScript, the native
core is a thin Rust cdylib built with
[bffi](https://github.com/z2net/bffi-rs).

```
 Bun thread (TS backend)                bunframe-core loop thread (native)
 ----------------------------------     ----------------------------------
 createWindow(config)  --Create-->      winit EventLoop + Window + wry
 ipc.handle(fn)  (JS-bound cb)          events stream (push) + IPC bridge
 run()  (pumps the bffi loop)  <--jobs-- invoke_wait: IPC + close veto
        the page: window.ipc.postMessage -> handler -> eval resolve
```

The framework never hides the pump: `app.run()` drives the bffi event
loop on the JS thread - the one legal place native deliveries execute
(no hidden timers, by design).

## Layout

- `crates? no - the core lives at the repo root`: the `bunframe-core`
  cdylib (this crate) - window/IPC/events surface over wry;
- `.bffi/` - the loader JSON + the generated typed API (committed,
  deterministic render);
- `test/` - the env-gated e2e suite (`BFFI_E2E=1`, opens REAL windows).

## Status

M1 (Windows-first): single- and multi-window, the full window command
set, window events as a push stream, close-veto round trip, the IPC
bridge. Linux/macOS come after the core stabilizes (macOS needs the
window on the OS main thread - documented limitation, see the
[Binding GUI guide](https://github.com/z2net/bffi-rs/blob/main/docs/BINDING-GUI.md)).

## Prerequisites

- [Bun](https://bun.sh) >= 1.4.2
- Rust 1.98.0 (pinned via `rust-toolchain.toml`)
- Windows: WebView2 runtime (preinstalled on Windows 11)

## Run the e2e

```sh
bun install
cargo build --release
$env:BFFI_E2E = "1"; bun test    # PowerShell
```

MIT license.
