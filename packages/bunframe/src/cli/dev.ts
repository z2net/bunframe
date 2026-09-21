//! `bunframe dev`: serve the frontend (TS transpiled live) and spawn
//! the backend entry with `BUNFRAME_DEV_URL` set. The browser
//! refresh picks up frontend saves; the backend restart is the
//! author's Ctrl-C + re-run (documented - no hidden watchers).

import { loadConfig } from "./config.ts";
import { serveDir } from "./server.ts";

/** Runs the dev loop until the spawned backend exits. */
export async function dev(
  projectRoot: string,
  options: { port?: number } = {},
): Promise<number> {
  const config = await loadConfig(projectRoot);
  const port = options.port ?? config.dev.port;
  const server = Bun.serve({ port, fetch: serveDir(config.dev.dir) });
  const url = `http://localhost:${server.port}`;
  console.info(`bunframe dev: serving ${config.dev.dir}/ at ${url}`);
  console.info(`bunframe dev: spawning bun ${config.dev.entry}`);

  const child = Bun.spawn({
    cmd: ["bun", "run", config.dev.entry],
    cwd: projectRoot,
    env: { ...process.env, BUNFRAME_DEV_URL: url } as Record<string, string>,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.on("SIGINT", () => {
    child.kill();
  });
  const code = await child.exited;
  server.stop(true);
  return code ?? 0;
}
