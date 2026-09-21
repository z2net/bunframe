//! The bunframe native packer: assembles one platform npm package
//! from a built cdylib (the bffi `pack` layout, our suffix
//! convention). Bun-only - no `node:` imports.
//!
//!   bun scripts/pack-native.ts [--src <dll>] [--triple win-x64]
//!                              [--out platform]
//!
//! The package lands in `<out>/bunframe-core-<suffix>/`:
//!   package.json   name @z2net/bunframe-core-<suffix>, os/cpu/libc,
//!                  integrity (sha256 of the binary), repository
//!                  (provenance verifies it against the publishing
//!                  repository - E422 otherwise)
//!   bunframe_core.dll (the artifact-convention file name)
//!   index.js       the `{ path }` entry shim
//!
//! Extend PLATFORMS when a new target ships; the suffix matches the
//! loader's PLATFORM_PACKAGE (@z2net/bunframe-core-win-x64 first).

const PLATFORMS: Record<
  string,
  { os: string; cpu: string; libc?: string; ext: string; prefix: string }
> = {
  "win-x64": { os: "win32", cpu: "x64", ext: "dll", prefix: "" },
  "win-arm64": { os: "win32", cpu: "arm64", ext: "dll", prefix: "" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc", ext: "so", prefix: "lib" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc", ext: "so", prefix: "lib" },
  "linux-x64-musl": { os: "linux", cpu: "x64", libc: "musl", ext: "so", prefix: "lib" },
  "darwin-x64": { os: "darwin", cpu: "x64", ext: "dylib", prefix: "lib" },
  "darwin-arm64": { os: "darwin", cpu: "arm64", ext: "dylib", prefix: "lib" },
};

const REPOSITORY = "https://github.com/z2net/bunframe";
const BASE = "@z2net/bunframe-core";
const DEFAULT_BINARY = "bunframe_core";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const triple = flag(args, "triple") ?? "win-x64";
  const platform = PLATFORMS[triple];
  if (platform === undefined) {
    console.error(`pack: unknown triple ${triple} (shipped: ${Object.keys(PLATFORMS).join(", ")})`);
    return 1;
  }
  const src = flag(args, "src") ?? `target/release/${DEFAULT_BINARY}.${platform.ext}`;
  const outDir = flag(args, "out") ?? "platform";

  const root = JSON.parse(await Bun.file("package.json").text()) as {
    version: string;
    license?: string;
  };
  const file = `${platform.prefix}${DEFAULT_BINARY}.${platform.ext}`;
  const pkgName = `${BASE}-${triple}`;
  const pkgDir = `${outDir.replaceAll("\\", "/").replace(/\/+$/, "")}/bunframe-core-${triple}`;

  const bytes = new Uint8Array(await Bun.file(src).arrayBuffer());
  if (bytes.byteLength === 0) {
    console.error(`pack: the binary is missing or empty: ${src}`);
    return 1;
  }
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const integrity = `sha256-${hasher.digest("hex")}`;

  const pkg = {
    name: pkgName,
    version: root.version,
    description: `bunframe native binary (${triple})`,
    license: root.license ?? "MIT",
    repository: { type: "git", url: REPOSITORY },
    engines: { bun: ">=1.4.2" },
    type: "module",
    main: "index.js",
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc === undefined ? {} : { libc: [platform.libc] }),
    integrity,
  };
  await Bun.write(`${pkgDir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
  await Bun.write(`${pkgDir}/${file}`, bytes);
  await Bun.write(
    `${pkgDir}/index.js`,
    `"use strict";\nmodule.exports = { path: __dirname + ${JSON.stringify(`/${file}`)} };\n`,
  );

  console.info(`packed ${pkgName}@${root.version} -> ${pkgDir} (${file}, ${integrity})`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
