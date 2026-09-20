# Changelog

All notable changes to bunframe are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the versioning is [SemVer](https://semver.org/) (`0.x` may break at
any minor).

## [0.1.0] - 2026-09-20

The M1 core: a wry (webview) native shell driven entirely from
TypeScript through the [bffi](https://github.com/z2net/bffi-rs)
binding (Bun >= 1.4.2, bffi crate 0.2.1, wry 0.57, winit 0.30).

### Added

- `window_open(WindowConfig)`: 17-field config (url/html, title,
  size + min size, resizable, decorations, transparent, maximized,
  visible, position, devtools, always-on-top, skip-taskbar) - the
  first call spawns the dedicated loop thread.
- The window command set: set_title, set_size, set_resizable,
  set_decorations, set_always_on_top, set_visible, focus, maximize,
  unmaximize, minimize, open_devtools, eval - each proxied onto the
  loop thread.
- The events stream: per-window push stream of JSON events
  (`resized` / `focused` / `close-denied` / `closed`), pulled
  through the raw `bffi_stream_next` ABI (status 14 = retry).
- The close-veto round trip: `window_bind_close(bool(str))` - the
  callback returns `true` to allow, `false` to deny; fail-open on
  error/timeout; simulated programmatically via the test-only
  `bffi_test_close_requested` export.
- The IPC bridge: injected bootstrap promise
  (`window.__bffiCall`), the loop-thread handler parks on
  `invoke_wait` and the JS handler answers through
  `window_ipc_reply`.
- `app_quit` / `window_poll_exit`: the explicit loop teardown
  (winit 0.30 allows one EventLoop per process - the loop never
  respawns after quit).
- Typed errors (`BffiError` derive, codes `0x1001..0x1006`) in the
  module errors table; the generated TS API surfaces them as
  `BunframeError`.
- The e2e suite: five windowed tests (lifecycle + events stream,
  the full command set, close-veto deny/allow, the IPC bridge,
  `app_quit`) behind the `BFFI_E2E=1` gate; Rust unit tests
  (config fallbacks, IPC boxes, escape_js, registry slots) always
  run.

### Platform notes

- Windows-first (WebView2). macOS requires windows on the OS main
  thread - unsupported in M1. Linux (webkit2gtk) untested.
