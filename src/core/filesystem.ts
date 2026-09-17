import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { ListTreeSchema, ReadFileSchema, type ListTreeInput, type ReadFileInput } from "../schemas/tools.js";
import { getConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { resolveSafePath } from "./paths.js";

export const DEFAULT_READ_LIMIT = 2000;

export interface ReadFileResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

async function resolveExistingFile(p: string, cwd?: string): Promise<string> {
  const resolved = await resolveSafePath(p, cwd);
  const s = await stat(resolved).catch(() => null);
  if (!s) throw new ToolError("FILE_NOT_FOUND", `File not found: ${p}`, { resolved });
  if (!s.isFile()) throw new ToolError("NOT_A_FILE", `Not a regular file: ${p}`, { resolved });
  return resolved;
}

/**
 * Stream the file line by line: only the requested range is kept in memory,
 * the remaining lines are merely counted.
 */
export async function readFile(rawInput: ReadFileInput): Promise<ReadFileResult> {
  const input = ReadFileSchema.parse(rawInput);
  const file = await resolveExistingFile(input.path, input.cwd);
  const startLine = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_READ_LIMIT;
  const maxBytes = getConfig().maxOutputBytes;

  const lines: string[] = [];
  let bytes = 0;
  let totalLines = 0;
  let byteLimitHit = false;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    totalLines++;
    if (totalLines < startLine || lines.length >= limit || byteLimitHit) continue;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > maxBytes && lines.length > 0) {
      byteLimitHit = true;
      continue;
    }
    lines.push(line);
  }

  const endLine = lines.length ? startLine + lines.length - 1 : Math.min(startLine - 1, totalLines);
  return {
    path: file,
    content: lines.join("\n"),
    startLine,
    endLine,
    totalLines,
    truncated: endLine < totalLines && lines.length > 0,
  };
}

export const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage"]);
export const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 5000;

export interface ListTreeResult {
  path: string;
  tree: string;
  entries: number;
  truncated: boolean;
}

export async function listTree(rawInput: ListTreeInput): Promise<ListTreeResult> {
  const input = ListTreeSchema.parse(rawInput);
  const root = await resolveSafePath(input.path, input.cwd);
  const s = await stat(root).catch(() => null);
  if (!s) throw new ToolError("FILE_NOT_FOUND", `Directory not found: ${input.path}`);
  if (!s.isDirectory()) throw new ToolError("NOT_A_DIRECTORY", `Not a directory: ${input.path}`);
  const maxDepth = input.depth ?? DEFAULT_TREE_DEPTH;
  const out: string[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    let entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries = entries
      .filter((e) => input.includeHidden || !e.name.startsWith("."))
      .filter((e) => input.includeIgnored || !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      const indent = "  ".repeat(depth);
      if (entry.isDirectory()) {
        out.push(`${indent}${entry.name}/`);
        if (depth + 1 < maxDepth) await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isSymbolicLink()) {
        out.push(`${indent}${entry.name}@`); // never followed: may point outside the root
      } else {
        out.push(`${indent}${entry.name}`);
      }
    }
  }

  await walk(root, 0);
  return { path: root, tree: out.join("\n"), entries: out.length, truncated };
}
