//! `bunframe build`: bundle the frontend (html entrypoint), bundle
//! the backend for Bun, ship the cdylib - a portable app directory:
//!
//!   dist/main.js        the bundled backend (`bun run dist/main.js`)
//!   dist/frontend/      the bundled page
//!   dist/bin/<cdylib>   the native core the runtime picks up

import { resolveBinary } from "#core";
import { loadConfig } from "./config.ts";

/** Builds the portable app directory; returns the outdir (relative
 * to the project root, which is the process cwd). */
export async function build(
  projectRoot: string,
  options: { outdir?: string } = {},
): Promise<string> {
  const config = await loadConfig(projectRoot);
  const root = projectRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const outdir = options.outdir ?? config.build.outdir;
  const outAbs = `${root}/${outdir}`;

  const frontend = await Bun.build({
    entrypoints: [`${root}/${config.build.frontendDir}/${config.build.frontendEntry}`],
    outdir: `${outAbs}/frontend`,
    target: "browser",
    root: `${root}/${config.build.frontendDir}`,
  });
  if (!frontend.success) {
    for (const issue of frontend.logs) {
      console.error(`bunframe build: frontend: ${String(issue)}`);
    }
    throw new Error("bunframe build: the frontend bundle failed");
  }

  const backend = await Bun.build({
    entrypoints: [`${root}/${config.build.entry}`],
    outdir: outAbs,
    target: "bun",
    naming: "[name].[ext]",
  });
  if (!backend.success) {
    for (const issue of backend.logs) {
      console.error(`bunframe build: backend: ${String(issue)}`);
    }
    throw new Error("bunframe build: the backend bundle failed");
  }

  const binary = resolveBinary(
    config.build.binary !== undefined ? { binary: config.build.binary } : {},
    root,
  );
  const binaryName = binary.replaceAll("\\", "/").split("/").pop() ?? "bunframe_core.dll";
  await Bun.write(`${outAbs}/bin/${binaryName}`, Bun.file(binary));

  console.info(`bunframe build: ${outdir}/main.js + ${outdir}/frontend/ + ${outdir}/bin/${binaryName}`);
  console.info("bunframe build: run it with `bun run dist/main.js`");
  return outdir;
}
