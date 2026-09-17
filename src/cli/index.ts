#!/usr/bin/env node
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  applyPatch,
  exec,
  gitDiff,
  gitShow,
  gitStatus,
  listTree,
  readFile,
  runChecks,
  search,
  toToolError,
  ToolError,
  type ExecResult,
  type GitStatusResult,
} from "../core/index.js";

const HELP = `coding-tools <command> [options]

Commands:
  read-file    --path <p> [--cwd <dir>] [--offset <line>] [--limit <n>]
  list-tree    --path <dir> [--depth <n>] [--include-hidden] [--include-ignored]
  search       --cwd <dir> --query <q> [--glob <g>]... [--literal] [--ignore-case] [--max-results <n>]
  apply-patch  --cwd <dir> [--patch-file <f> | --patch <text> | < patch] [--dry-run]
  exec         --cwd <dir> --command <cmd> [--timeout <ms>] [--env KEY=VALUE]...
  run-checks   --cwd <dir> --command <cmd>... [--timeout <ms>] [--stop-on-failure]
  git-status   --cwd <dir>
  git-diff     --cwd <dir> [--staged] [--ref <ref>] [--path <p>]...
  git-show     --cwd <dir> --ref <ref> [--path <p>]

Global:
  --json       Output {"ok":true,"result":...} or {"ok":false,"error":{code,message,details}}.
               When stdin is piped and required options are missing, the input is read
               from stdin as a JSON object (same fields as the MCP tools).
  --help
`;

const options = {
  path: { type: "string", multiple: true },
  cwd: { type: "string" },
  offset: { type: "string" },
  limit: { type: "string" },
  depth: { type: "string" },
  "include-hidden": { type: "boolean" },
  "include-ignored": { type: "boolean" },
  query: { type: "string" },
  glob: { type: "string", multiple: true },
  literal: { type: "boolean" },
  "ignore-case": { type: "boolean" },
  "max-results": { type: "string" },
  patch: { type: "string" },
  "patch-file": { type: "string" },
  "dry-run": { type: "boolean" },
  command: { type: "string", multiple: true },
  timeout: { type: "string" },
  env: { type: "string", multiple: true },
  "stop-on-failure": { type: "boolean" },
  staged: { type: "boolean" },
  ref: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

function num(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ToolError("INVALID_INPUT", `--${name} must be an integer`);
  return n;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    /* fall through */
  }
  throw new ToolError("INVALID_INPUT", "stdin must contain a JSON object");
}

/** The CLI resolves a relative cwd against the shell's working directory; the core requires it absolute. */
function absoluteCwd(input: Record<string, unknown>): Record<string, unknown> {
  return typeof input.cwd === "string" ? { ...input, cwd: path.resolve(input.cwd) } : input;
}

/** Drop undefined values so flags do not erase fields provided through stdin JSON. */
function defined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

async function withStdin(_flags: Flags, fromFlags: Record<string, unknown>, required: string[]) {
  let input = defined(fromFlags);
  if (!required.every((k) => k in input) && !process.stdin.isTTY) {
    const text = await readStdin();
    if (text.trim()) input = { ...parseJsonObject(text), ...input };
  }
  return absoluteCwd(input);
}

async function run(command: string, f: Flags): Promise<{ result: unknown; human: () => string; exitCode?: number }> {
  switch (command) {
    case "read-file": {
      const input = await withStdin(
        f,
        { path: f.path?.[0], cwd: f.cwd ?? process.cwd(), offset: num(f.offset, "offset"), limit: num(f.limit, "limit") },
        ["path"],
      );
      const r = await readFile(input as never);
      return {
        result: r,
        human: () => {
          const width = String(r.endLine).length;
          const body = r.content === "" && r.endLine < r.startLine ? [] : r.content.split("\n");
          const numbered = body.map((l, k) => `${String(r.startLine + k).padStart(width)}\t${l}`).join("\n");
          const footer = r.truncated ? `\n[lines ${r.startLine}-${r.endLine} of ${r.totalLines}; use --offset ${r.endLine + 1}]` : "";
          return numbered + footer;
        },
      };
    }
    case "list-tree": {
      const input = await withStdin(
        f,
        {
          path: f.path?.[0] ?? ".",
          cwd: f.cwd ?? process.cwd(),
          depth: num(f.depth, "depth"),
          includeHidden: f["include-hidden"],
          includeIgnored: f["include-ignored"],
        },
        ["path"],
      );
      const r = await listTree(input as never);
      return { result: r, human: () => r.tree + (r.truncated ? "\n[truncated]" : "") };
    }
    case "search": {
      const input = await withStdin(
        f,
        {
          query: f.query,
          cwd: f.cwd,
          glob: f.glob,
          literal: f.literal,
          caseInsensitive: f["ignore-case"],
          maxResults: num(f["max-results"], "max-results"),
        },
        ["query", "cwd"],
      );
      const r = await search(input as never);
      return {
        result: r,
        human: () =>
          r.matches.map((m) => `${m.path}:${m.line}:${m.column ?? 0}: ${m.text}`).join("\n") +
          (r.truncated ? `\n[truncated at ${r.matches.length} matches]` : r.matches.length ? "" : "No matches"),
      };
    }
    case "apply-patch": {
      let patch = f.patch ?? (f["patch-file"] ? await fsReadFile(f["patch-file"], "utf8") : undefined);
      let input: Record<string, unknown> = defined({ cwd: f.cwd, patch, dryRun: f["dry-run"] });
      if (patch === undefined) {
        const text = await readStdin();
        if (text.trimStart().startsWith("{")) input = { ...parseJsonObject(text), ...input };
        else input.patch = text;
      }
      const r = await applyPatch(absoluteCwd(input) as never);
      return {
        result: r,
        human: () =>
          `${r.dryRun ? "Dry run OK, would change" : "Applied, changed"} ${r.filesChanged.length} file(s):\n` +
          r.filesChanged.map((p) => `  ${p}`).join("\n") +
          `\n\n${r.diff}`,
      };
    }
    case "exec": {
      const env = f.env ? Object.fromEntries(f.env.map((e) => [e.split("=")[0], e.slice(e.indexOf("=") + 1)])) : undefined;
      const input = await withStdin(
        f,
        { command: f.command?.[0], cwd: f.cwd, timeoutMs: num(f.timeout, "timeout"), env },
        ["command", "cwd"],
      );
      const r = await exec(input as never);
      return { result: r, human: () => formatExec(r), exitCode: r.exitCode ?? 124 };
    }
    case "run-checks": {
      const input = await withStdin(
        f,
        { commands: f.command, cwd: f.cwd, timeoutMs: num(f.timeout, "timeout"), stopOnFailure: f["stop-on-failure"] },
        ["commands", "cwd"],
      );
      const r = await runChecks(input as never);
      return {
        result: r,
        exitCode: r.success ? 0 : 1,
        human: () =>
          r.results
            .map((c) => `${c.exitCode === 0 ? "PASS" : "FAIL"} ${c.command} (${c.durationMs}ms)` + (c.exitCode === 0 ? "" : `\n${formatExec(c)}`))
            .join("\n"),
      };
    }
    case "git-status": {
      const input = await withStdin(f, { cwd: f.cwd }, ["cwd"]);
      const r = await gitStatus(input as never);
      return { result: r, human: () => formatStatus(r) };
    }
    case "git-diff": {
      const input = await withStdin(f, { cwd: f.cwd, staged: f.staged, ref: f.ref, paths: f.path }, ["cwd"]);
      const r = await gitDiff(input as never);
      return { result: r, human: () => r.diff + (r.truncated ? "\n[truncated]" : "") };
    }
    case "git-show": {
      const input = await withStdin(f, { cwd: f.cwd, ref: f.ref, path: f.path?.[0] }, ["cwd", "ref"]);
      const r = await gitShow(input as never);
      return { result: r, human: () => r.content + (r.truncated ? "\n[truncated]" : "") };
    }
    default:
      throw new ToolError("INVALID_INPUT", `Unknown command: ${command}. Run coding-tools --help`);
  }
}

function formatExec(r: ExecResult): string {
  const parts = [];
  if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
  if (r.stderr) parts.push(r.stderr.replace(/\n$/, ""));
  const status = r.timedOut ? `timed out after ${r.durationMs}ms` : `exit ${r.exitCode}`;
  parts.push(`[${status}${r.truncated ? ", output truncated" : ""}]`);
  return parts.join("\n");
}

function formatStatus(r: GitStatusResult): string {
  const lines = [`branch: ${r.branch ?? "(detached)"}${r.upstream ? ` -> ${r.upstream} [+${r.ahead}/-${r.behind}]` : ""}`];
  if (r.clean) lines.push("clean");
  for (const s of r.staged) lines.push(`staged    ${s.status} ${s.origPath ? `${s.origPath} -> ` : ""}${s.path}`);
  for (const s of r.modified) lines.push(`modified  ${s.status} ${s.path}`);
  for (const p of r.deleted) lines.push(`deleted     ${p}`);
  for (const p of r.conflicted) lines.push(`conflict    ${p}`);
  for (const p of r.untracked) lines.push(`untracked   ${p}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ options, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  const { values: flags, positionals } = parsed;
  const command = positionals[0];
  if (!command || flags.help) {
    process.stdout.write(HELP);
    process.exit(command || flags.help ? 0 : 2);
  }
  try {
    const { result, human, exitCode } = await run(command, flags);
    process.stdout.write(flags.json ? `${JSON.stringify({ ok: true, result }, null, 2)}\n` : `${human()}\n`);
    process.exitCode = flags.json ? 0 : (exitCode ?? 0);
  } catch (err) {
    const error = toToolError(err);
    if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, error }, null, 2)}\n`);
    else process.stderr.write(`error [${error.code}]: ${error.message}\n${error.details ? `${JSON.stringify(error.details, null, 2)}\n` : ""}`);
    process.exitCode = 1;
  }
}

void main();
