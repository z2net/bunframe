//! `bunframe init`: scaffold the app template into a directory.

/** Copies every template file into `target` (relative paths kept).
 * Returns the copied relative paths. */
export async function init(target: string): Promise<string[]> {
  const templateDir = `${import.meta.dir}`.replaceAll("\\", "/") + "/template";
  const copied: string[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const relative of glob.scan({ cwd: templateDir, onlyFiles: true, dot: true })) {
    const normalized = relative.replaceAll("\\", "/");
    const destination = `${target.replaceAll("\\", "/").replace(/\/+$/, "")}/${normalized}`;
    await Bun.write(destination, Bun.file(`${templateDir}/${relative}`));
    copied.push(normalized);
  }
  return copied;
}
