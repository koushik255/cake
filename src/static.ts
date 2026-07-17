import { dirname, fromFileUrl, join, relative, resolve } from "std/path";

const MEDIABUNNY_ROOT = dirname(
  fromFileUrl(import.meta.resolve("mediabunny")),
);
const MEDIABUNNY_SHARED_ROOT = resolve(MEDIABUNNY_ROOT, "../shared");

const MIME_BY_EXTENSION: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

export async function serveStatic(
  pathname: string,
  method = "GET",
): Promise<Response | null> {
  if (pathname === "/player.js") {
    return await serveFile("./public/player.js", Deno.cwd(), method);
  }

  if (
    [
      "/favicon.svg",
      "/favicon.ico",
      "/favicon-96x96.png",
      "/apple-touch-icon.png",
      "/web-app-manifest-192x192.png",
      "/web-app-manifest-512x512.png",
      "/site.webmanifest",
    ].includes(pathname)
  ) {
    return await serveFile(`./public${pathname}`, Deno.cwd(), method);
  }

  if (pathname.startsWith("/vendor/mediabunny/")) {
    const vendorPath = pathname.slice("/vendor/mediabunny/".length);
    if (vendorPath === "node.js") {
      return browserNodeShim(method);
    }

    return await serveFile(
      join(MEDIABUNNY_ROOT, vendorPath),
      MEDIABUNNY_ROOT,
      method,
    );
  }

  if (pathname.startsWith("/vendor/shared/")) {
    const sharedPath = pathname.slice("/vendor/shared/".length);
    return await serveFile(
      join(MEDIABUNNY_SHARED_ROOT, sharedPath),
      MEDIABUNNY_SHARED_ROOT,
      method,
    );
  }

  return null;
}

function browserNodeShim(method: string): Response {
  return new Response(
    method === "HEAD" ? null : [
      "// Browser shim for Mediabunny's package.json browser mapping.",
      "export const fs = undefined;",
      "",
    ].join("\n"),
    {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    },
  );
}

async function serveFile(
  path: string,
  root = Deno.cwd(),
  method = "GET",
): Promise<Response> {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);

  if (rel === "" || rel.startsWith("..")) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const file = await Deno.open(resolvedPath, { read: true });
    const stat = await file.stat();
    const extension = resolvedPath.match(/\.[^.]+$/)?.[0] ?? "";

    return new Response(method === "HEAD" ? null : file.readable, {
      headers: {
        "content-length": String(stat.size),
        "content-type": MIME_BY_EXTENSION[extension] ??
          "application/octet-stream",
        "cache-control": cacheControlFor(resolvedPath),
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not found", { status: 404 });
    }

    throw error;
  }
}

function cacheControlFor(path: string): string {
  return path.includes("/mediabunny/") || path.includes("/shared/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}
