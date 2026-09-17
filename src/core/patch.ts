import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { ApplyPatchSchema, type ApplyPatchInput } from "../schemas/tools.js";
import { ToolError } from "./errors.js";
import { resolveSafeDir, resolveSafePath } from "./paths.js";

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** Lines expected in the file (context + removed). */
  oldLines: string[];
  /** Replacement lines (context + added). */
  newLines: string[];
  /** 1-based line hint from a unified diff header. */
  oldStart?: number;
  /** '*** Begin Patch' `@@ some context` line used to locate the hunk. */
  anchor?: string;
  /** Hunk must match at the end of the file. */
  atEof?: boolean;
  /** "\ No newline at end of file" applied to the new side. */
  noNewlineAtEof?: boolean;
}

export type FileOperation =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] };

export interface ApplyPatchResult {
  success: boolean;
  dryRun: boolean;
  filesChanged: string[];
  diff: string;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function invalid(message: string, details?: unknown): never {
  throw new ToolError("PATCH_INVALID", message, details);
}

export function parsePatch(patch: string): FileOperation[] {
  const text = patch.replace(/\r\n/g, "\n");
  const ops = /^\s*\*\*\* Begin Patch/.test(text) ? parseCodexPatch(text) : parseUnifiedDiff(text);
  if (ops.length === 0) invalid("Patch contains no file operations");
  return ops;
}

/** Format: *** Begin Patch / *** Add|Delete|Update File: / *** Move to: / @@ / *** End Patch */
function parseCodexPatch(text: string): FileOperation[] {
  const lines = text.split("\n");
  let i = lines.findIndex((l) => l.trim() === "*** Begin Patch") + 1;
  const ops: FileOperation[] = [];
  let ended = false;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "*** End Patch") {
      ended = true;
      break;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\*\*\* Add File: (.+)$/))) {
      const added: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (!lines[i].startsWith("+")) invalid(`Add File ${m[1]}: every line must start with '+'`, { line: i + 1 });
        added.push(lines[i].slice(1));
        i++;
      }
      ops.push({ kind: "add", path: m[1].trim(), lines: added });
    } else if ((m = line.match(/^\*\*\* Delete File: (.+)$/))) {
      ops.push({ kind: "delete", path: m[1].trim() });
      i++;
    } else if ((m = line.match(/^\*\*\* Update File: (.+)$/))) {
      const op: FileOperation = { kind: "update", path: m[1].trim(), hunks: [] };
      i++;
      const move = lines[i]?.match(/^\*\*\* Move to: (.+)$/);
      if (move) {
        op.moveTo = move[1].trim();
        i++;
      }
      let current: Hunk | undefined;
      while (i < lines.length && !/^\*\*\* (Add File|Delete File|Update File|End Patch)/.test(lines[i])) {
        const l = lines[i];
        if (l.startsWith("@@")) {
          current = { oldLines: [], newLines: [] };
          const anchor = l.slice(2).trim();
          if (anchor) current.anchor = anchor;
          op.hunks.push(current);
        } else if (l === "*** End of File") {
          if (current) current.atEof = true;
        } else {
          if (!current) {
            current = { oldLines: [], newLines: [] };
            op.hunks.push(current);
          }
          if (l.startsWith("+")) current.newLines.push(l.slice(1));
          else if (l.startsWith("-")) current.oldLines.push(l.slice(1));
          else if (l.startsWith(" ") || l === "") {
            // Empty lines are tolerated as empty context (common when whitespace gets stripped).
            const ctx = l.slice(1);
            current.oldLines.push(ctx);
            current.newLines.push(ctx);
          } else {
            invalid(`Update File ${op.path}: unexpected line ${i + 1}: ${JSON.stringify(l)}`);
          }
        }
        i++;
      }
      // Trailing empty context lines are almost always an artefact of the patch text.
      for (const h of op.hunks) {
        while (h.oldLines.length && h.newLines.length && h.oldLines.at(-1) === "" && h.newLines.at(-1) === "") {
          h.oldLines.pop();
          h.newLines.pop();
        }
      }
      op.hunks = op.hunks.filter((h) => h.oldLines.length || h.newLines.length);
      if (op.hunks.length === 0 && !op.moveTo) invalid(`Update File ${op.path}: no hunks`);
      ops.push(op);
    } else if (line.trim() === "") {
      i++;
    } else {
      invalid(`Unexpected line ${i + 1}: ${JSON.stringify(line)}`);
    }
  }
  if (!ended) invalid("Missing '*** End Patch'");
  return ops;
}

function stripDiffPath(raw: string): string | null {
  let p = raw.split("\t")[0].trim();
  if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p);
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/** Standard unified diff (git diff, diff -u), possibly with several files. */
function parseUnifiedDiff(text: string): FileOperation[] {
  const lines = text.split("\n");
  const ops: FileOperation[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i].startsWith("--- ") && lines[i + 1]?.startsWith("+++ "))) {
      i++;
      continue;
    }
    const oldPath = stripDiffPath(lines[i].slice(4));
    const newPath = stripDiffPath(lines[i + 1].slice(4));
    i += 2;
    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i].startsWith("@@")) {
      const header = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!header) invalid(`Malformed hunk header at line ${i + 1}: ${lines[i]}`);
      let oldCount = header[2] === undefined ? 1 : Number(header[2]);
      let newCount = header[4] === undefined ? 1 : Number(header[4]);
      const hunk: Hunk = { oldLines: [], newLines: [], oldStart: Number(header[1]) };
      i++;
      let last: "old" | "new" | "both" = "both";
      while (i < lines.length && (oldCount > 0 || newCount > 0 || lines[i].startsWith("\\"))) {
        const l = lines[i];
        if (l.startsWith("\\")) {
          if (last !== "old") hunk.noNewlineAtEof = true;
        } else if (l.startsWith("+")) {
          hunk.newLines.push(l.slice(1));
          newCount--;
          last = "new";
        } else if (l.startsWith("-")) {
          hunk.oldLines.push(l.slice(1));
          oldCount--;
          last = "old";
        } else if (l.startsWith(" ") || l === "") {
          hunk.oldLines.push(l.slice(1));
          hunk.newLines.push(l.slice(1));
          oldCount--;
          newCount--;
          last = "both";
        } else {
          invalid(`Unexpected line in hunk at line ${i + 1}: ${JSON.stringify(l)}`);
        }
        i++;
      }
      if (oldCount < 0 || newCount < 0) invalid(`Hunk line counts do not match its header near line ${i}`);
      hunks.push(hunk);
    }
    if (oldPath === null && newPath === null) invalid("Both sides of a file diff are /dev/null");
    if (oldPath === null) {
      ops.push({ kind: "add", path: newPath!, lines: hunks.flatMap((h) => h.newLines) });
    } else if (newPath === null) {
      ops.push({ kind: "delete", path: oldPath });
    } else {
      if (hunks.length === 0 && oldPath === newPath) invalid(`No hunks for ${oldPath}`);
      ops.push({ kind: "update", path: oldPath, moveTo: newPath !== oldPath ? newPath : undefined, hunks });
    }
  }
  return ops;
}

/* ------------------------------------------------------------------ */
/* Applying hunks in memory                                            */
/* ------------------------------------------------------------------ */

interface FileText {
  lines: string[];
  eol: "\n" | "\r\n";
  finalNewline: boolean;
}

function splitText(content: string): FileText {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = content.endsWith("\n");
  const body = finalNewline ? content.slice(0, content.endsWith("\r\n") ? -2 : -1) : content;
  return { lines: content === "" ? [] : body.split(/\r?\n/), eol, finalNewline: content === "" || finalNewline };
}

function joinText(t: FileText): string {
  if (t.lines.length === 0) return "";
  return t.lines.join(t.eol) + (t.finalNewline ? t.eol : "");
}

const normalizers: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  // Typographic punctuation that LLMs frequently normalise.
  (s) =>
    s
      .trim()
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”‟]/g, '"')
      .replace(/[‐-―]/g, "-")
      .replace(/ /g, " "),
];

function findSequence(lines: string[], needle: string[], from: number, hint?: number, atEof?: boolean): number {
  if (needle.length === 0) return -1;
  for (const norm of normalizers) {
    const target = needle.map(norm);
    const candidates: number[] = [];
    const matchesAt = (start: number) => target.every((t, k) => norm(lines[start + k]) === t);
    if (atEof) {
      const start = lines.length - needle.length;
      if (start >= from && matchesAt(start)) return start;
      continue;
    }
    for (let start = from; start + needle.length <= lines.length; start++) {
      if (matchesAt(start)) {
        if (hint === undefined) return start;
        candidates.push(start);
      }
    }
    if (candidates.length) {
      // With a line hint (unified diff) choose the closest occurrence.
      return candidates.reduce((best, c) => (Math.abs(c - (hint! - 1)) < Math.abs(best - (hint! - 1)) ? c : best));
    }
  }
  return -1;
}

function applyHunks(filePath: string, original: string, hunks: Hunk[]): string {
  const text = splitText(original);
  const lines = [...text.lines];
  let cursor = 0;
  let offset = 0; // net line delta so far, to adjust unified-diff hints
  hunks.forEach((hunk, index) => {
    if (hunk.anchor) {
      const norm = (s: string) => s.trim();
      const anchorAt = lines.findIndex((l, k) => k >= cursor && norm(l) === norm(hunk.anchor!));
      const fuzzyAt = anchorAt >= 0 ? anchorAt : lines.findIndex((l, k) => k >= cursor && l.includes(hunk.anchor!.trim()));
      if (fuzzyAt < 0) {
        throw new ToolError("PATCH_CONTEXT_MISMATCH", `${filePath}: hunk ${index + 1} anchor not found`, {
          path: filePath,
          hunk: index + 1,
          anchor: hunk.anchor,
        });
      }
      // Anchor line itself may be part of the hunk context, so search from it.
      cursor = fuzzyAt;
    }
    let at: number;
    if (hunk.oldLines.length === 0) {
      // Pure insertion: at the hinted line, or at end of file.
      at = hunk.oldStart !== undefined ? Math.min(Math.max(hunk.oldStart + offset, 0), lines.length) : lines.length;
      if (hunk.oldStart === 0) at = 0;
    } else {
      const hint = hunk.oldStart !== undefined ? hunk.oldStart + offset : undefined;
      at = findSequence(lines, hunk.oldLines, cursor, hint, hunk.atEof);
      if (at < 0) {
        throw new ToolError("PATCH_CONTEXT_MISMATCH", `${filePath}: hunk ${index + 1} does not match the file`, {
          path: filePath,
          hunk: index + 1,
          expected: hunk.oldLines.slice(0, 20).join("\n"),
        });
      }
    }
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines);
    cursor = at + hunk.newLines.length;
    offset += hunk.newLines.length - hunk.oldLines.length;
    if (hunk.noNewlineAtEof && cursor === lines.length) text.finalNewline = false;
  });
  return joinText({ ...text, lines });
}

/* ------------------------------------------------------------------ */
/* Plan → atomic write                                                 */
/* ------------------------------------------------------------------ */

/** Final state per absolute path: string content, or null for deletion. */
type Plan = Map<string, { before: string | null; after: string | null }>;

async function readIfExists(abs: string): Promise<string | null> {
  const s = await stat(abs).catch(() => null);
  if (!s) return null;
  if (!s.isFile()) invalid(`Not a regular file: ${abs}`);
  return readFile(abs, "utf8");
}

async function buildPlan(ops: FileOperation[], cwd: string): Promise<Plan> {
  const plan: Plan = new Map();
  const current = async (abs: string): Promise<string | null> => {
    if (plan.has(abs)) return plan.get(abs)!.after;
    const before = await readIfExists(abs);
    plan.set(abs, { before, after: before });
    return before;
  };
  const set = (abs: string, after: string | null) => {
    plan.get(abs)!.after = after;
  };

  for (const op of ops) {
    const abs = await resolveSafePath(op.path, cwd);
    const content = await current(abs);
    if (op.kind === "add") {
      if (content !== null) invalid(`Cannot add ${op.path}: file already exists`, { path: op.path });
      set(abs, op.lines.length ? op.lines.join("\n") + "\n" : "");
    } else if (content === null) {
      throw new ToolError("FILE_NOT_FOUND", `Cannot ${op.kind} ${op.path}: file does not exist`, { path: op.path });
    } else if (op.kind === "delete") {
      set(abs, null);
    } else {
      const updated = applyHunks(op.path, content, op.hunks);
      if (op.moveTo) {
        const dest = await resolveSafePath(op.moveTo, cwd);
        if (dest !== abs) {
          if ((await current(dest)) !== null) invalid(`Cannot move ${op.path} to ${op.moveTo}: destination exists`);
          set(dest, updated);
          set(abs, null);
          continue;
        }
      }
      set(abs, updated);
    }
  }
  for (const [abs, entry] of plan) if (entry.before === entry.after) plan.delete(abs);
  return plan;
}

function renderDiff(plan: Plan, cwd: string): string {
  return [...plan]
    .map(([abs, { before, after }]) => {
      const rel = path.relative(cwd, abs);
      const d = createTwoFilesPatch(
        before === null ? "/dev/null" : `a/${rel}`,
        after === null ? "/dev/null" : `b/${rel}`,
        before ?? "",
        after ?? "",
        undefined,
        undefined,
        { context: 3 },
      );
      return d.replace(/^=+\n/, "").replace(/^Index:.*\n/, "");
    })
    .join("");
}

async function commit(plan: Plan): Promise<void> {
  const done: { abs: string; before: string | null; mode?: number }[] = [];
  const createdDirs: string[] = [];
  const tmpFiles: string[] = [];
  try {
    // Write every new version to a temp file first (the most likely failure point)...
    const staged: { abs: string; tmp: string | null; before: string | null; mode?: number }[] = [];
    for (const [abs, { before, after }] of plan) {
      const mode = before !== null ? (await lstat(abs)).mode & 0o7777 : undefined;
      if (after === null) {
        staged.push({ abs, tmp: null, before, mode });
        continue;
      }
      const made = await mkdir(path.dirname(abs), { recursive: true });
      if (made) createdDirs.push(made);
      const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(6).toString("hex")}.tmp`);
      tmpFiles.push(tmp);
      await writeFile(tmp, after, "utf8");
      if (mode !== undefined) await chmod(tmp, mode);
      staged.push({ abs, tmp, before, mode });
    }
    // ...then swap them in with renames.
    for (const s of staged) {
      if (s.tmp) await rename(s.tmp, s.abs);
      else await unlink(s.abs);
      done.push(s);
    }
  } catch (err) {
    const rollbackErrors: string[] = [];
    for (const d of done.reverse()) {
      try {
        if (d.before === null) await rm(d.abs, { force: true });
        else {
          await writeFile(d.abs, d.before, "utf8");
          if (d.mode !== undefined) await chmod(d.abs, d.mode);
        }
      } catch (e) {
        rollbackErrors.push(`${d.abs}: ${(e as Error).message}`);
      }
    }
    await Promise.all(tmpFiles.map((t) => rm(t, { force: true }).catch(() => undefined)));
    for (const dir of createdDirs.reverse()) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new ToolError("PATCH_WRITE_FAILED", `Failed to write patch: ${(err as Error).message}`, {
      rolledBack: rollbackErrors.length === 0,
      rollbackErrors: rollbackErrors.length ? rollbackErrors : undefined,
    });
  }
}

/**
 * Parse, validate and simulate the whole patch in memory; only when every
 * operation succeeds are files written (temp files + rename, with rollback).
 */
export async function applyPatch(rawInput: ApplyPatchInput): Promise<ApplyPatchResult> {
  const input = ApplyPatchSchema.parse(rawInput);
  const cwd = await resolveSafeDir(input.cwd);
  const ops = parsePatch(input.patch);
  const plan = await buildPlan(ops, cwd);
  const dryRun = input.dryRun ?? false;

  if (!dryRun) {
    await commit(plan);
    // Report what is actually on disk now.
    for (const [abs, entry] of plan) entry.after = await readIfExists(abs);
  }
  return {
    success: true,
    dryRun,
    filesChanged: [...plan.keys()].map((abs) => path.relative(cwd, abs)),
    diff: renderDiff(plan, cwd),
  };
}
