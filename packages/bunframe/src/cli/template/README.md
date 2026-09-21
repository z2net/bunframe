# my-bunframe-app

A bunframe desktop app: the backend runs on Bun (`src/`), the
frontend is any web tech (`frontend/`), and ONE typed RPC schema
(`src/rpc.ts`) drives both sides.

```sh
bun install
bunframe dev        # dev server + the window
bunframe build      # portable app dir in dist/
bun run dist/main.js
```

- `src/rpc.ts` - the shared RPC schema (types + validation source)
- `src/main.ts` - the backend: createApp + `app.handle`
- `frontend/main.ts` - the page: defineRPC + `rpc.request`
