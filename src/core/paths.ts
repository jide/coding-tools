import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config.js";
import { ToolError } from "./errors.js";

/**
 * Resolve symlinks of the longest existing prefix of `p`, then re-append the
 * non-existing tail. This lets us validate paths of files about to be created.
 */
async function realpathLoose(p: string): Promise<string> {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return p;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function allowedRealRoots(): Promise<string[]> {
  return Promise.all(getConfig().allowedRoots.map((r) => realpathLoose(path.resolve(r))));
}

/**
 * Resolve `p` (relative to `cwd` if relative), follow symlinks, and ensure the
 * real destination lives inside an allowed root. `cwd` is itself validated.
 * Works for paths that do not exist yet (their existing ancestors are checked).
 */
export async function resolveSafePath(p: string, cwd?: string): Promise<string> {
  if (typeof p !== "string" || p.length === 0) {
    throw new ToolError("INVALID_INPUT", "Path must be a non-empty string");
  }
  if (p.includes("\0")) throw new ToolError("INVALID_INPUT", "Path contains a NUL byte");
  let absolute: string;
  if (path.isAbsolute(p)) {
    absolute = path.normalize(p);
  } else {
    if (!cwd) {
      throw new ToolError("PATH_RELATIVE_WITHOUT_CWD", `Relative path "${p}" requires an explicit cwd`);
    }
    absolute = path.resolve(await resolveSafePath(cwd), p);
  }
  const real = await realpathLoose(absolute);
  const roots = await allowedRealRoots();
  if (!roots.some((root) => isInside(real, root))) {
    throw new ToolError("PATH_OUTSIDE_ALLOWED_ROOT", `Path "${p}" resolves outside the allowed roots`, {
      resolved: real,
      allowedRoots: getConfig().allowedRoots,
    });
  }
  return real;
}

/** resolveSafePath + must be an existing directory. */
export async function resolveSafeDir(cwd: string): Promise<string> {
  const dir = await resolveSafePath(cwd);
  const s = await stat(dir).catch(() => null);
  if (!s) throw new ToolError("FILE_NOT_FOUND", `Directory not found: ${cwd}`);
  if (!s.isDirectory()) throw new ToolError("NOT_A_DIRECTORY", `Not a directory: ${cwd}`);
  return dir;
}
