import { execFile } from "node:child_process";
import path from "node:path";
import {
  GitDiffSchema,
  GitShowSchema,
  GitStatusSchema,
  type GitDiffInput,
  type GitShowInput,
  type GitStatusInput,
} from "../schemas/tools.js";
import { getConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { truncateString } from "./output.js";
import { resolveSafeDir, resolveSafePath } from "./paths.js";

const GIT_ENV = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", "-c", "core.quotepath=off", "-c", "color.ui=false", ...args],
      { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const message = stderr.trim() || err.message;
        if (/not a git repository/i.test(message)) {
          reject(new ToolError("NOT_A_GIT_REPOSITORY", `Not a git repository: ${cwd}`));
        } else {
          reject(new ToolError("GIT_ERROR", message, { args }));
        }
      },
    );
  });
}

async function repoDir(cwd: string): Promise<string> {
  const dir = await resolveSafeDir(cwd);
  await runGit(dir, ["rev-parse", "--git-dir"]);
  return dir;
}

function assertRef(ref: string): void {
  if (ref.startsWith("-") || /[\s\0]/.test(ref)) {
    throw new ToolError("INVALID_INPUT", `Invalid git ref: ${ref}`);
  }
}

export interface GitFileStatus {
  path: string;
  /** Porcelain v1 status letter: M, A, D, R, C, T, U */
  status: string;
  origPath?: string;
}

export interface GitStatusResult {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  modified: GitFileStatus[];
  untracked: string[];
  deleted: string[];
  conflicted: string[];
  clean: boolean;
}

export function parsePorcelainStatus(output: string): GitStatusResult {
  const result: GitStatusResult = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    conflicted: [],
    clean: true,
  };
  const entries = output.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith("## ")) {
      const header = entry.slice(3);
      const noCommits = header.match(/^No commits yet on (.+)$/) ?? header.match(/^Initial commit on (.+)$/);
      if (noCommits) {
        result.branch = noCommits[1];
      } else if (!header.startsWith("HEAD (no branch)")) {
        const m = header.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
        result.branch = m?.[1] ?? header;
        result.upstream = m?.[2] ?? null;
        result.ahead = Number(m?.[3]?.match(/ahead (\d+)/)?.[1] ?? 0);
        result.behind = Number(m?.[3]?.match(/behind (\d+)/)?.[1] ?? 0);
      }
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    result.clean = false;
    if (x === "?" && y === "?") {
      result.untracked.push(file);
      continue;
    }
    if (x === "!") continue;
    let origPath: string | undefined;
    if (x === "R" || x === "C") origPath = entries[++i];
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      result.conflicted.push(file);
      continue;
    }
    if (x !== " ") result.staged.push(origPath ? { path: file, status: x, origPath } : { path: file, status: x });
    if (y === "M" || y === "T") result.modified.push({ path: file, status: y });
    if (x === "D" || y === "D") result.deleted.push(file);
  }
  return result;
}

export async function gitStatus(rawInput: GitStatusInput): Promise<GitStatusResult> {
  const input = GitStatusSchema.parse(rawInput);
  const cwd = await repoDir(input.cwd);
  const out = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
  return parsePorcelainStatus(out);
}

export interface GitDiffResult {
  diff: string;
  truncated: boolean;
}

export async function gitDiff(rawInput: GitDiffInput): Promise<GitDiffResult> {
  const input = GitDiffSchema.parse(rawInput);
  const cwd = await repoDir(input.cwd);
  const args = ["diff", "--no-ext-diff", "--no-color", "--no-textconv"];
  if (input.staged) args.push("--cached");
  if (input.ref) {
    assertRef(input.ref);
    args.push(input.ref);
  }
  args.push("--");
  for (const p of input.paths ?? []) {
    const abs = await resolveSafePath(p, cwd);
    args.push(path.relative(cwd, abs) || ".");
  }
  const { text, truncated } = truncateString(await runGit(cwd, args), getConfig().maxOutputBytes);
  return { diff: text, truncated };
}

export interface GitShowResult {
  ref: string;
  path?: string;
  content: string;
  truncated: boolean;
}

export async function gitShow(rawInput: GitShowInput): Promise<GitShowResult> {
  const input = GitShowSchema.parse(rawInput);
  const cwd = await repoDir(input.cwd);
  assertRef(input.ref);
  let out: string;
  let relPath: string | undefined;
  if (input.path) {
    const abs = await resolveSafePath(input.path, cwd);
    const top = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
    relPath = path.relative(await resolveSafePath(top), abs);
    out = await runGit(cwd, ["show", "--no-ext-diff", "--no-color", `${input.ref}:${relPath}`]);
  } else {
    out = await runGit(cwd, ["show", "--no-ext-diff", "--no-color", "--stat", "--patch", input.ref, "--"]);
  }
  const { text, truncated } = truncateString(out, getConfig().maxOutputBytes);
  return relPath ? { ref: input.ref, path: relPath, content: text, truncated } : { ref: input.ref, content: text, truncated };
}
