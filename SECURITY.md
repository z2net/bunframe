# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | security fixes on the latest `0.1.x` release |

`0.0.x` releases and older `0.1.x` minors do not receive fixes -
upgrade to the latest patch version.

## Reporting a Vulnerability

- Preferred: GitHub **private vulnerability reporting**
  (Security tab -> Report a vulnerability).
- Email: **contact@z2net.com**

Please include: description, steps to reproduce, potential impact,
affected version.

We aim to acknowledge within 72 hours (24h for reports rated
Critical). Fixes are released as coordinated disclosures - please
do not disclose publicly until a fix ships. Credit is given on
request.

## Scope

- Memory safety bugs in the FFI boundary (the bffi binding)
- Window handle table corruption / type confusion
- IPC bridge injection: a page escaping its window's command
  surface through crafted `postMessage` bodies
- Close-veto bypass: a window closing without the veto callback
  being consulted when one is bound
- Events stream integrity: a consumer observing another window's
  events
- Panic propagation issues / the `catch_unwind` boundary policy
- Malformed wire payloads: integer overflow, allocation DoS via
  declared lengths, unbounded nesting
- Race conditions, use-after-free, callback deadlocks (including
  re-entrant `invoke_wait`)

Out of scope:

- Bugs in Bun itself (report to oven-sh/bun)
- Bugs in the Rust toolchain
- Bugs in the webview stacks (WebView2 / WKWebView / WebKitGTK) -
  report upstream (they are the same dependencies Tauri uses)
- A native module behaving maliciously once loaded: loading a
  cdylib is arbitrary code execution BY DESIGN

## Trust model (short version)

- bunframe provides **panic containment** (release shims convert
  Rust panics into JS errors where possible), NOT **process
  isolation**: the core runs inside the Bun process. Memory
  corruption in native code can take down the host regardless.
- The webview PAGE is untrusted relative to the backend: only the
  bound IPC callback can reach the backend, and only with the
  signature declared at bind time. Keep the page's command surface
  explicit and reviewed.
- The release `panic = "unwind"` profile is REQUIRED: `panic =
  "abort"` breaks the containment policy and aborts the host.
