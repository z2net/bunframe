# The bunframe native shell: a memo on the window/IPC/events surface.

## What this core provides

`bunframe-core` is a cdylib built with the
[bffi](https://github.com/z2net/bffi-rs) macros: a wry webview
shell whose surface is generated into `.bffi/api.gen.ts` and
consumed from TypeScript on Bun. See the architecture skill at
`.opencode/skill/bunframe-architecture/SKILL.md` and the full
threading guide in
[bffi-rs docs/BINDING-GUI.md](https://github.com/z2net/bffi-rs/blob/main/docs/BINDING-GUI.md).

## The window lifecycle

```ts
import { createApiFromJson } from "./.bffi/api.gen.ts";

const api = createApiFromJson("target/release/bunframe_core.dll");
const handle = api.window_open({
  url: "https://example.com",   // or html: "<h1>hi</h1>"
  title: "My app",
  width: 1024,
  height: 768,
});

const events = api.window_events(handle);   // events stream handle
api.window_set_title(handle, "renamed");
api.window_eval(handle, "console.log(1)");
api.app_quit();                              // final teardown
```

## Events (push stream)

`window_events` returns a stream handle. Pull through the raw
stream ABI (`bffi_stream_next(handle, max, out)`): status `0` =
a TAG_SEQ chunk of JSON event strings, `14` = Pending (retry),
`0`-handle = the stream ended (the window closed). Events:
`resized`, `focused`, `close-denied`, `closed`.

## The close veto

```ts
import { bindJsCallback } from "@z2net/bffi";

const veto = bindJsCallback(api ? rawLib : lib,
  { ret: "bool", params: ["string"] },
  (event) => JSON.parse(event).type === "close-requested"
    ? confirm("Close?")   // false denies; true allows
    : true,
);
api.window_bind_close(handle, veto.handle);
```

The veto round trip parks the loop thread for up to 10s - the JS
side must pump (`loop_pump`). Fail-open: any error allows the
close.

## The IPC bridge

The injected bootstrap gives the page `window.__bffiCall(method,
args): Promise`. Bind a `unit(str)` callback through
`window_bind_ipc`; the handler receives the JSON body and answers
through `window_ipc_reply(handle, json)` - the reply MUST be valid
JSON (it is embedded into the resolve script verbatim). The
handler must never throw: an unanswered call parks the loop thread
for 30s.

## Invariants (break = bug)

- One EventLoop per process: `app_quit` is final; `window_open`
  after it reports `LoopNotRunning`.
- The loop thread owns windows: mutations are proxied commands.
- The JS thread pumps: marshal deliveries execute only during
  `loop_pump` / the app run loop.
