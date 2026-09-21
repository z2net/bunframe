//! @z2net/bunframe-cli tests: config resolution, the dev server (TS
//! transpiled live, traversal jailed), the portable build layout and
//! the init scaffold. No windows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { build } from "#cli/build.ts";
import { defineConfig, loadConfig, resolveConfig } from "#cli/config.ts";
import { init } from "#cli/init.ts";
import { escapesRoot, serveDir } from "#cli/server.ts";

describe("config", () => {
  test("defineConfig is identity and resolveConfig applies every default", () => {
    const author = defineConfig({ app: { name: "app" } });
    const resolved = resolveConfig(author);
    expect(resolved.app.name).toBe("app");
    expect(resolved.dev).toEqual({ dir: "frontend", port: 5173, entry: "src/main.ts" });
    expect(resolved.build.frontendDir).toBe("frontend");
    expect(resolved.build.frontendEntry).toBe("index.html");
    expect(resolved.build.entry).toBe("src/main.ts");
    expect(resolved.build.outdir).toBe("dist");
    expect(resolved.build.binary).toBeUndefined();
  });

  test("overrides win over defaults; dev.dir seeds build.frontendDir", () => {
    const resolved = resolveConfig(
      defineConfig({
        app: { name: "app" },
        dev: { dir: "ui", port: 3000 },
        build: { outdir: "release" },
      }),
    );
    expect(resolved.dev).toEqual({ dir: "ui", port: 3000, entry: "src/main.ts" });
    expect(resolved.build.frontendDir).toBe("ui");
    expect(resolved.build.outdir).toBe("release");
  });

  test("loadConfig reads bunframe.config.ts; a broken file throws", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bunframe-cfg-"));
    const broken = await mkdtemp(path.join(os.tmpdir(), "bunframe-cfg-"));
    try {
      await writeFile(
        path.join(dir, "bunframe.config.ts"),
        // A plain object on purpose: the temp dir has no node_modules,
        // so importing @z2net/bunframe-cli here would not resolve. Real app
        // projects import { defineConfig } from "@z2net/bunframe/cli".
        `const config = { app: { name: "configured" }, dev: { port: 4321 } };\n` +
          `export default config;\n`,
      );
      const config = await loadConfig(dir);
      expect(config.app.name).toBe("configured");
      expect(config.dev.port).toBe(4321);

      // A separate dir: bun caches modules per URL, so the broken
      // variant must live at its own path to be re-imported.
      await writeFile(path.join(broken, "bunframe.config.ts"), "export default { broken");
      await expect(loadConfig(broken)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(broken, { recursive: true, force: true });
    }
  });
});

describe("dev server", () => {
  test("serves html, transpiles ts live, jails traversal, 404s misses", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bunframe-srv-"));
    try {
      await Bun.write(`${dir}/index.html`, "<!doctype html><html><body>hi</body></html>");
      await Bun.write(`${dir}/app.ts`, "const n: number = 1;\nexport const doubled = n * 2;\n");
      await Bun.write(`${dir}/data.json`, '{"ok":true}');
      const fetch = serveDir(dir);

      const html = await fetch(new Request("http://localhost/"));
      expect(html.status).toBe(200);
      expect(html.headers.get("Content-Type")).toContain("text/html");
      expect(await html.text()).toContain("hi");

      const ts = await fetch(new Request("http://localhost/app.ts"));
      expect(ts.headers.get("Content-Type")).toContain("text/javascript");
      const transpiled = await ts.text();
      expect(transpiled).not.toContain(": number");
      expect(transpiled).toContain("doubled");

      const json = await fetch(new Request("http://localhost/data.json"));
      expect(json.headers.get("Content-Type")).toBe("application/json");

      // The URL parser pre-normalizes dotted segments, so the wire
      // answer is 404; the guard itself is unit-tested below.
      const traversal = await fetch(new Request("http://localhost/%2e%2e/secret"));
      expect(traversal.status).toBe(404);
      expect(await traversal.text()).not.toContain("secret");

      const missing = await fetch(new Request("http://localhost/nope.html"));
      expect(missing.status).toBe(404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("escapesRoot: exact .. segments only", () => {
    expect(escapesRoot("../secret")).toBe(true);
    expect(escapesRoot("a/../../b")).toBe(true);
    expect(escapesRoot("app/index.html")).toBe(false);
    expect(escapesRoot("v1..2.json")).toBe(false);
  });
});

describe("build", () => {
  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
  const cdylib = path.join(repoRoot, "target", "release", "bunframe_core.dll");
  let workDir: string;
  let previousCwd: string;

  beforeAll(async () => {
    previousCwd = process.cwd();
    workDir = await mkdtemp(path.join(os.tmpdir(), "bunframe-app-"));
    process.chdir(workDir);
    // The fixture has no node_modules - the tsconfig paths point the
    // bundler at the workspace sources (a real app project resolves
    // @z2net/bunframe from its installed dependency instead).
    const subpath = (relative: string): string =>
      path.join(repoRoot, "packages", "bunframe", relative).replaceAll("\\", "/");
    await Bun.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "esnext",
          moduleResolution: "bundler",
          paths: {
            "@z2net/bunframe": [subpath("src/index.ts")],
            "@z2net/bunframe/schema": [subpath("src/schema/index.ts")],
            "@z2net/bunframe/view": [subpath("src/view.ts")],
            "@z2net/bunframe/cli": [subpath("src/cli/index.ts")],
          },
        },
      }),
    );
    await Bun.write(
      "bunframe.config.ts",
      `const config = { app: { name: "built-app" }, build: { binary: ${JSON.stringify(cdylib)} } };\n` +
        `export default config;\n`,
    );
    await Bun.write(
      "frontend/index.html",
      '<!doctype html><html><head><title>built-app</title></head><body><div id="app"></div><script type="module" src="./main.ts"></script></body></html>',
    );
    await Bun.write(
      "frontend/main.ts",
      `import { defineRPC } from "@z2net/bunframe/view";\n` +
        `const rpc = defineRPC({});\nvoid rpc;\n`,
    );
    await mkdir("src", { recursive: true });
    await Bun.write(
      "src/main.ts",
      `import { createApp } from "@z2net/bunframe";\nconsole.info(typeof createApp);\n`,
    );
  });

  afterAll(async () => {
    process.chdir(previousCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  test("produces the portable layout: main.js + frontend/ + bin/", async () => {
    const outdir = await build(workDir);
    expect(outdir).toBe("dist");
    const at = (relative: string): string => path.join(workDir, relative);
    const backend = Bun.file(at("dist/main.js"));
    expect(await backend.exists()).toBe(true);
    const backendSource = await backend.text();
    // The backend bundle inlines @z2net/bunframe-app + @z2net/bunframe-core
    // (api.gen.ts shipped inside the package) - self-contained.
    expect(backendSource).toContain("window_open");
    const html = Bun.file(at("dist/frontend/index.html"));
    expect(await html.exists()).toBe(true);
    // The page bundle's file name depends on what Bun inlines vs
    // emits - assert SOME js landed next to the html.
    const emitted: string[] = [];
    for await (const file of new Bun.Glob("*.js").scan({ cwd: at("dist/frontend") })) {
      emitted.push(file);
    }
    expect(emitted.length).toBeGreaterThan(0);
    const shipped = Bun.file(at("dist/bin/bunframe_core.dll"));
    expect(await shipped.exists()).toBe(true);
    expect((await shipped.arrayBuffer()).byteLength).toBeGreaterThan(1024);
  });
});

describe("init", () => {
  test("scaffolds the template including dotfiles", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bunframe-init-"));
    try {
      const copied = await init(dir);
      expect(copied).toContain("package.json");
      expect(copied).toContain("src/main.ts");
      expect(copied).toContain("src/rpc.ts");
      expect(copied).toContain("frontend/index.html");
      expect(copied).toContain("frontend/main.ts");
      expect(copied).toContain(".gitignore");
      const manifest = JSON.parse(await Bun.file(`${dir}/package.json`).text());
      expect(manifest.scripts.dev).toBe("bunframe dev");
      const config = await Bun.file(`${dir}/bunframe.config.ts`).text();
      expect(config).toContain("defineConfig");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

