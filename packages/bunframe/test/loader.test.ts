/**
 * Unit tests of @z2net/bunframe-core: the binary RESOLUTION logic only -
 * hermetic by contract (no dlopen, no windows, no native state).
 */
import { describe, expect, test } from "bun:test";

import { findRoot, resolveBinary } from "#core";

const TMP = (Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp")
  .replaceAll("\\", "/")
  .replace(/\/+$/, "");

function fixtureDir(label: string): string {
  return `${TMP}/opencode/bunframe-core-test-${label}-${crypto.randomUUID()}`;
}

describe("binary resolution", () => {
  test("an explicit path that does not exist throws an honest error", () => {
    expect(() => resolveBinary({ binary: "Z:/definitely/not/here.dll" })).toThrow(
      /not found/,
    );
  });

  test("an explicit existing path wins", async () => {
    const path = `${fixtureDir("explicit")}/custom.dll`;
    await Bun.write(path, "x");
    expect(resolveBinary({ binary: path })).toBe(path);
  });

  test("the root walk-up finds the .bffi/bffi.json marker", async () => {
    const root = fixtureDir("marker");
    await Bun.write(`${root}/.bffi/bffi.json`, "{}");
    expect(findRoot(`${root}/packages/app/src`)).toBe(root);
  });

  test("a walk with no marker returns undefined", () => {
    expect(findRoot(fixtureDir("empty"))).toBeUndefined();
  });

  test("the dev fallback resolves target/release/bunframe_core.dll", async () => {
    const root = fixtureDir("dev");
    await Bun.write(`${root}/.bffi/bffi.json`, "{}");
    await Bun.write(`${root}/target/release/bunframe_core.dll`, "not a real dll");
    expect(resolveBinary({}, root)).toBe(`${root}/target/release/bunframe_core.dll`);
  });

  test("non-win32 resolution is refused with the honest message", async () => {
    const root = fixtureDir("os");
    await Bun.write(`${root}/.bffi/bffi.json`, "{}");
    const original = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      expect(() => resolveBinary({}, root)).toThrow(
        "bunframe v0.1.0 ships windows-x64 only",
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: original,
        configurable: true,
      });
    }
  });

  test("no root and no package fails with the install hint", () => {
    expect(() => resolveBinary({}, `${TMP}/opencode/definitely-missing-root`)).toThrow(
      /bun add @z2net\/bunframe-core-win-x64/,
    );
  });
});
