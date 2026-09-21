//! @z2net/bunframe-cli public surface: the config contract (the template's
//! bunframe.config.ts imports defineConfig from here).

export {
  CONFIG_FILE,
  defineConfig,
  loadConfig,
  resolveConfig,
  type BunframeAppInfo,
  type BunframeBuildConfig,
  type BunframeConfig,
  type BunframeDevConfig,
  type ResolvedConfig,
} from "./config.ts";
