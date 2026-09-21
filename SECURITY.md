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

---

# The bunframe trust model

Status: v0.1.0 (honest scope). Read this before shipping an app on
bunframe.

## The one rule

**The page is a privileged caller.** Every `rpc.request.*` method the
backend registers is remotely invokable by ANY script running in the
window: the IPC bootstrap hands the page a direct, validated door
into your Bun process. Treat the page like you would treat a local
admin CLI, not like a website.

## What protects you today

- **Schema validation, always on, bun side.** Every request's `args`,
  every handler's response and every message payload is validated
  against the shared schema (Standard Schema: the built-in `s`
  descriptors or zod/valibot/arktype) before it reaches your handler
  or leaves to the page. A page cannot smuggle shapes past
  `app.handle`.
- **Method-level capability.** Only methods registered through
  `app.handle` exist; everything else answers `NOT_FOUND`. The page
  has NO access to the window API, the filesystem, or the process -
  only to the commands you exposed.
- **Sync handlers, one at a time.** A request runs to completion
  before the next one on the same window starts (v0.1.0 contract) -
  no request interleaving inside your backend.
- **Asset roots are jailed.** `asset_root` serves files only from
  the canonicalized directory: `..` segments and canonical-path
  escapes answer 403, misses answer 404.

## What is NOT protected (v0.1.0)

- **No CSP story.** A page can fetch/load remote content if its HTML
  says so; a compromised dependency in your frontend code owns every
  registered command. Pin your frontend deps.
- **No per-origin/per-webview command scoping.** All windows of an
  app share the command registry.
- **No secrets in the page.** Anything the page can request, a user
  with devtools can request too (`window.__bffiCall` is right there).
- **No integrity for the asset directory.** Whatever lands in
  `asset_root` at runtime gets served.

## Guidance

1. Expose NARROW commands: validate not just shapes but values
   (ranges, enums) in the schema; keep handlers side-effect-lean.
2. Never register commands that execute raw paths, raw SQL or raw
   shell from page arguments.
3. Long/loud work belongs in Bun workers - the handler contract is
   sync-per-call by design.
4. In production, serve the frontend from `asset_root` (a directory
   YOU control at build time), not from a dev server URL.
