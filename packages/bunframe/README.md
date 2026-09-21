# @z2net/bunframe

The desktop application shell for **Bun**: native wry windows driven
entirely from TypeScript - the inverted Tauri. The backend language
is Bun, the native core is a thin Rust cdylib shipped as platform
packages and resolved automatically.

```sh
bun add @z2net/bunframe
bunx bunframe init my-app && cd my-app
bun install && bun run dev
```

## One package, four doors

| Import | Side | What |
| --- | --- | --- |
| `@z2net/bunframe` | Bun | `createApp`, `Window`, the validated command registry, the run loop |
| `@z2net/bunframe/schema` | both | `s` descriptors + `defineSchema` - runtime schemas double as types |
| `@z2net/bunframe/view` | page | `defineRPC` over the injected bootstrap (zero dependencies) |
| `@z2net/bunframe/cli` | config | `defineConfig` for `bunframe.config.ts` |

The CLI binary ships with the package: `bunframe dev` (live-TS
static server + the backend), `bunframe build` (a portable app
directory), `bunframe init` (the template).

## The shape of an app

```ts
// src/rpc.ts - ONE typed contract, both sides
import { defineSchema, s } from "@z2net/bunframe/schema";

export const rpc = defineSchema({
  bun: {
    requests: {
      greet: {
        params: s.object({ name: s.string() }),
        response: s.object({ message: s.string() }),
      },
    },
  },
});

// src/main.ts - the backend (Bun)
import { createApp } from "@z2net/bunframe";
import { rpc } from "./rpc.ts";

const app = createApp({ rpc, window: { title: "my-app", url: "..." } });
app.handle("greet", ({ name }) => ({ message: `Hello, ${name}!` }));
await app.run();
```

```ts
// frontend/main.ts - the page (any web tech)
import { defineRPC } from "@z2net/bunframe/view";
import type { AppRpc } from "../src/rpc.ts";

const rpc = defineRPC<AppRpc>();
const { message } = await rpc.request.greet({ name: "bunframe" });
```

Validation is Standard Schema (bring zod/valibot/arktype or use the
built-in `s`), always on, on the Bun side.

## Platform notes

Windows-first (WebView2). The prebuilt native binary ships as
`@z2net/bunframe-core-win-x64` and is picked up automatically;
`bunframe build` also bundles it into the portable app directory.
macOS/Linux follow once the core stabilizes.

The pump contract is explicit: `app.run()` drives the loop, handlers
are sync per call, `app.quit()` is terminal. See SECURITY.md for the
trust model.
