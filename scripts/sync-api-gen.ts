//! Mirrors the generated API into @z2net/bunframe-core: the package must
//! be self-contained (app projects have no .bffi directory). Run
//! after every `bun run codegen` - wired into the root script.
await Bun.write(
  "packages/core/src/api.gen.ts",
  Bun.file(".bffi/api.gen.ts").text(),
);
console.info("synced .bffi/api.gen.ts -> packages/core/src/api.gen.ts");
