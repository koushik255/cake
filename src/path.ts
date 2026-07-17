import { join, normalize, relative, resolve } from "std/path";

export function resolveInside(root: string, child: string): string | null {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(join(resolvedRoot, child));
  const rel = relative(resolvedRoot, resolvedChild);

  if (
    rel === "" ||
    (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"))
  ) {
    return normalize(resolvedChild);
  }

  return null;
}

export function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}
