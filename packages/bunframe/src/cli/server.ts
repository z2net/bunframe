//! The static dev server: serves the frontend directory with
//! TypeScript transpiled on the fly (Bun.Transpiler - the browser
//! never sees raw TS) and hard no-cache headers, so a browser
//! refresh picks up every save.

/** The content types the dev server (and the template) need. */
const MIME: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
}

/** The `..` segment check on the decoded URL path (exact segment
 * match - a file named `v1..2.json` stays legal). */
export function escapesRoot(relative: string): boolean {
  return relative.split("/").some((segment) => segment === ".." || segment === ".");
}

/** The dev fetch handler over `dir` (relative to the process cwd -
 * the CLI always runs there). `.ts` sources are transpiled to JS. */
export function serveDir(dir: string): (request: Request) => Promise<Response> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const prefix = dir.replace(/^\/+|\/+$/g, "");
  return async (request) => {
    const url = new URL(request.url);
    let relative = decodeURIComponent(url.pathname);
    if (relative.endsWith("/")) {
      relative += "index.html";
    }
    relative = relative.replace(/^\/+/, "");
    if (escapesRoot(relative)) {
      return new Response("forbidden", { status: 403 });
    }
    const path = prefix === "" ? relative : `${prefix}/${relative}`;
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return new Response("not found", { status: 404 });
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      const body = transpiler.transformSync(await file.text());
      return new Response(body, {
        headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
    return new Response(file, {
      headers: { "Content-Type": contentType(path), "Cache-Control": "no-cache" },
    });
  };
}
