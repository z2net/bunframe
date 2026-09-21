//! Mirrors the generated API into the package: @z2net/bunframe must
//! be self-contained (app projects have no .bffi directory). Run
//! after every `bun run codegen` - wired into the root script.
async function main(): Promise<void> {
  await Bun.write(
    "packages/bunframe/src/core/api.gen.ts",
    Bun.file(".bffi/api.gen.ts"),
  );
  console.info("synced .bffi/api.gen.ts -> packages/bunframe/src/core/api.gen.ts");
}

void main();
