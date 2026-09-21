//! The `bunframe.config.ts` contract: the author-facing
//! `defineConfig`, the resolved shape with every default applied and
//! the loader the CLI commands share.

/** The app identity block. */
export interface BunframeAppInfo {
  /** The window title / display name. */
  name: string;
  /** The reverse-DNS identifier (packaging metadata; informational
   * in v0.1.0). */
  identifier?: string;
  /** The app version (informational in v0.1.0). */
  version?: string;
}

/** The `bunframe dev` settings. */
export interface BunframeDevConfig {
  /** The frontend directory the dev server serves (default
   * `"frontend"`). TypeScript is transpiled on the fly. */
  dir?: string;
  /** The dev server port (default `5173`). */
  port?: number;
  /** The backend entry the CLI spawns with `BUNFRAME_DEV_URL` set
   * (default `"src/main.ts"`). */
  entry?: string;
}

/** The `bunframe build` settings. */
export interface BunframeBuildConfig {
  /** The frontend directory (default `"frontend"`). */
  frontendDir?: string;
  /** The frontend entry inside `frontendDir` (default
   * `"index.html"`). */
  frontendEntry?: string;
  /** The backend entry bundled for the portable app (default
   * `"src/main.ts"`). */
  entry?: string;
  /** The output directory (default `"dist"`). The layout is
   * `dist/main.js` + `dist/frontend/` + `dist/bin/<cdylib>`. */
  outdir?: string;
  /** The cdylib to ship. Default: resolved like the runtime does
   * (platform package, then the bunframe dev checkout). */
  binary?: string;
}

/** The bunframe.config.ts shape. */
export interface BunframeConfig {
  app: BunframeAppInfo;
  dev?: BunframeDevConfig;
  build?: BunframeBuildConfig;
}

/** Identity for the config file: `export default defineConfig({...})`. */
export function defineConfig(config: BunframeConfig): BunframeConfig {
  return config;
}

/** The config file name the CLI looks for in the project root. */
export const CONFIG_FILE = "bunframe.config.ts";

/** Every default of the resolved config in one place. */
export interface ResolvedConfig {
  app: BunframeAppInfo;
  dev: { dir: string; port: number; entry: string };
  build: {
    frontendDir: string;
    frontendEntry: string;
    entry: string;
    outdir: string;
    binary: string | undefined;
  };
}

/** Merges the author config over the defaults (no mutation). */
export function resolveConfig(config: BunframeConfig): ResolvedConfig {
  return {
    app: config.app,
    dev: {
      dir: config.dev?.dir ?? "frontend",
      port: config.dev?.port ?? 5173,
      entry: config.dev?.entry ?? "src/main.ts",
    },
    build: {
      frontendDir: config.build?.frontendDir ?? config.dev?.dir ?? "frontend",
      frontendEntry: config.build?.frontendEntry ?? "index.html",
      entry: config.build?.entry ?? config.dev?.entry ?? "src/main.ts",
      outdir: config.build?.outdir ?? "dist",
      binary: config.build?.binary,
    },
  };
}

/** Loads `<projectRoot>/bunframe.config.ts` (defaults when absent)
 * and applies the defaults. A BROKEN config file throws - silence
 * here would ship the wrong app. */
export async function loadConfig(projectRoot: string): Promise<ResolvedConfig> {
  const root = projectRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const file = `${root}/${CONFIG_FILE}`;
  let author: BunframeConfig = { app: { name: "my-bunframe-app" } };
  if (await Bun.file(file).exists()) {
    const url = `file:///${file.replace(/^\/+/, "")}`;
    const mod = (await import(url)) as { default?: BunframeConfig };
    if (mod.default !== undefined) {
      author = mod.default;
    }
  }
  return resolveConfig(author);
}
