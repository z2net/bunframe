//! The native-core loader: binary resolution (explicit path -> the
//! dev checkout -> the platform package), the typed generated api
//! and the raw lib for the stream/callback ABI.
//!
//! Everything here is SYNCHRONOUS: the dlopen is sync and
//! `Bun.resolveSync` probes file existence - no `node:` fs anywhere.
//! Callback deliveries execute only while the JS thread pumps
//! (`loop_pump` / `app.run()`) - the pump contract, never hidden.

import { dlopen } from "bun:ffi";
import {
  BFFI_DIR,
  CONFIG_FILE,
  buildDeclarations,
  joinOut,
  setJsThread,
  type FfiLib,
} from "@z2net/bffi";
import { createApiFromJson, moduleJson, type Api } from "./api.gen.ts";

/** The full record `window_open` takes (every key, `null` = absent). */
export type NativeWindowConfig = Parameters<Api["window_open"]>[0];

/** Loader options. */
export interface CoreOptions {
  /** Explicit path of the cdylib; skips every resolution step. */
  binary?: string;
}

/** The loaded native core: the typed api plus the raw symbol table. */
export interface BunframeCore {
  /** The typed, generated api (the window/app command surface). */
  api: Api;
  /** The raw symbols: the stream ABI and the callback bind. */
  raw: FfiLib;
}

/** The platform package v0.1.0 ships (win-x64). The family lives in
 * the @z2net scope: @z2net/bunframe-core-{win,linux,darwin}-{x64,arm64}
 * - one token covers them all. */
const PLATFORM_PACKAGE = "@z2net/bunframe-core-win-x64";

/** Sync file-existence probe without `node:` fs: resolveSync on a
 * normalized path throws exactly when the file is missing. */
function existsFile(path: string): boolean {
  try {
    Bun.resolveSync(path.replaceAll("\\", "/"), import.meta.dir);
    return true;
  } catch {
    return false;
  }
}

/** Walks up from `fromDir` (default: this module) looking for the
 * repo marker (`.bffi/bffi.json`); returns the project root, or
 * undefined at the filesystem top. */
export function findRoot(fromDir: string = import.meta.dir): string | undefined {
  let dir = fromDir.replaceAll("\\", "/").replace(/\/+$/, "");
  for (;;) {
    if (existsFile(joinOut(dir, BFFI_DIR, CONFIG_FILE))) {
      return dir;
    }
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (parent === dir || parent === "") {
      return undefined;
    }
    dir = parent;
  }
}

/** The honest failure when no binary can be found. */
function noBinaryError(): Error {
  return new Error(
    "bunframe: no native binary found. In a bunframe checkout run " +
      "`cargo build --release`; in an app project install the platform " +
      `package: \`bun add ${PLATFORM_PACKAGE}\``,
  );
}

/** Best-effort lookup inside the installed platform package: the
 * dll right under the package dir (the package does not exist yet -
 * the naming is a convention, kept tolerant). */
function platformPackageBinary(root: string): string | undefined {
  let pkgJson: string;
  try {
    pkgJson = Bun.resolveSync(`${PLATFORM_PACKAGE}/package.json`, root);
  } catch {
    return undefined;
  }
  const pkgDir = pkgJson.slice(0, pkgJson.lastIndexOf("/"));
  for (const name of ["bunframe_core.dll", "index.dll", "index.node"]) {
    const candidate = joinOut(pkgDir, name);
    if (existsFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
/** The app-local candidates: the layout `bunframe build` produces
 * (`bin/bunframe_core.dll` next to the project/entry dir) plus the
 * flat fallback. Checked before the dev checkout - a built app
 * directory has neither a target/ tree nor the platform package. */
function appLocalBinary(): string | undefined {
  const dirs = new Set<string>([process.cwd().replaceAll("\\", "/")]);
  const entry = process.argv[1];
  if (entry !== undefined) {
    const normalized = entry.replaceAll("\\", "/");
    const cut = normalized.lastIndexOf("/");
    if (cut > 0) {
      dirs.add(normalized.slice(0, cut));
    }
  }
  for (const dir of dirs) {
    for (const relative of ["bin/bunframe_core.dll", "bunframe_core.dll"]) {
      const candidate = joinOut(dir, relative);
      if (existsFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Resolves the cdylib path: an explicit `options.binary` wins (and
 * must exist); else the app-local layout (`bin/` next to the cwd or
 * the entry script - what `bunframe build` ships); else the dev
 * checkout (`<root>/target/release/`, windows-x64 only); else the
 * platform package. Throws with an honest message when nothing is
 * found. */
export function resolveBinary(options: CoreOptions = {}, rootHint?: string): string {
  const explicit = options.binary;
  if (explicit !== undefined) {
    if (!existsFile(explicit)) {
      throw new Error(`bunframe: the native binary was not found at "${explicit}"`);
    }
    return explicit;
  }
  const local = appLocalBinary();
  if (local !== undefined) {
    return local;
  }
  const root = rootHint ?? findRoot();
  if (root === undefined) {
    throw noBinaryError();
  }
  if (process.platform !== "win32") {
    throw new Error("bunframe v0.1.0 ships windows-x64 only");
  }
  const dev = joinOut(root, "target", "release", "bunframe_core.dll");
  if (existsFile(dev)) {
    return dev;
  }
  const packaged = platformPackageBinary(root);
  if (packaged !== undefined) {
    return packaged;
  }
  throw noBinaryError();
}

/** The built-in features the raw declarations are generated with:
 * bunframe-core compiles ALL three bffi built-ins unconditionally
 * (bffi_runtime_abi!, bffi_callback_abi!, bffi_stream_abi! in
 * lib.rs), so the full set is a constant - no config read needed. */
const FULL_FEATURES: Parameters<typeof buildDeclarations>[1] = {
  runtime: true,
  callbacks: true,
  stream: true,
};

/** Loads the native core: resolves the binary, dlopens the typed
 * api, dlopens the raw table and binds this thread for callback
 * deliveries (required BEFORE any callback is bound). Sync - the
 * pump contract stays with the caller (`app.run()`). */
export function createCore(options: CoreOptions = {}): BunframeCore {
  const root = findRoot();
  const binary = resolveBinary(options, root);
  const api = createApiFromJson(binary);
  const raw = dlopen(binary, buildDeclarations(moduleJson, FULL_FEATURES))
    .symbols as unknown as FfiLib;
  setJsThread(raw);
  return { api, raw };
}
