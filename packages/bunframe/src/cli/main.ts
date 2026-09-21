#!/usr/bin/env bun
//! The `bunframe` bin: `dev` | `build` | `init` | `help`.

import { build } from "./build.ts";
import { dev } from "./dev.ts";
import { init } from "./init.ts";

function usage(): void {
  console.info(`bunframe - the desktop shell for Bun apps

usage:
  bunframe dev [--port N]     serve the frontend and spawn the backend
  bunframe build [--out DIR]  bundle frontend + backend + cdylib
  bunframe init [DIR]         scaffold the app template (default: .)
  bunframe help               this text`);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const projectRoot = process.cwd();
  try {
    if (command === "dev") {
      const port = flag(args, "--port");
      const code = await dev(projectRoot, {
        port: port !== undefined ? Number(port) : undefined,
      });
      process.exit(code);
    } else if (command === "build") {
      await build(projectRoot, { outdir: flag(args, "--out") });
    } else if (command === "init") {
      const target = args.find((argument) => !argument.startsWith("--")) ?? ".";
      const copied = await init(target);
      console.info(`bunframe init: scaffolded ${copied.length} files into ${target}`);
      console.info("next: bun install && bunframe dev");
    } else {
      usage();
      process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 1);
    }
  } catch (error) {
    console.error(`bunframe: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
