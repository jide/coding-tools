import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { SearchSchema, type SearchInput } from "../schemas/tools.js";
import { ToolError } from "./errors.js";
import { resolveSafeDir } from "./paths.js";
import { IGNORED_DIRS } from "./filesystem.js";

export const DEFAULT_MAX_RESULTS = 200;
const MAX_LINE_CHARS = 500;
const MAX_FALLBACK_FILE_BYTES = 5_000_000;

export interface SearchMatch {
  path: string; // relative to cwd
  line: number;
  column?: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  engine: "ripgrep" | "node";
}

function clip(text: string): string {
  const t = text.replace(/\r?\n$/, "");
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…` : t;
}

let rgAvailable: Promise<boolean> | undefined;
function rgBinary(): string {
  return process.env.CODING_TOOLS_RG || "rg";
}
function hasRipgrep(): Promise<boolean> {
  rgAvailable ??= new Promise((resolve) => {
    const p = spawn(rgBinary(), ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  return rgAvailable;
}

export async function search(rawInput: SearchInput, opts: { engine?: "ripgrep" | "node" } = {}): Promise<SearchResult> {
  const input = SearchSchema.parse(rawInput);
  const cwd = await resolveSafeDir(input.cwd);
  const max = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const engine = opts.engine ?? ((await hasRipgrep()) ? "ripgrep" : "node");
  return engine === "ripgrep" ? searchRipgrep(input, cwd, max) : searchNode(input, cwd, max);
}

function searchRipgrep(input: SearchInput, cwd: string, max: number): Promise<SearchResult> {
  // --no-follow is rg's default: symlinks pointing outside the root are not traversed.
  const args = ["--json", "--no-config", "--no-messages"];
  if (input.literal) args.push("--fixed-strings");
  if (input.caseInsensitive) args.push("--ignore-case");
  // Same defaults as the fallback, even outside git repos (rg only honours .gitignore).
  for (const dir of IGNORED_DIRS) args.push("--glob", `!**/${dir}/**`);
  for (const g of input.glob ?? []) args.push("--glob", g);
  args.push("--regexp", input.query, "--", ".");

  return new Promise((resolve, reject) => {
    const child = spawn(rgBinary(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const matches: SearchMatch[] = [];
    let truncated = false;
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (truncated) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "match") return;
      const d = event.data;
      const text: string = d.lines.text ?? "";
      const byteStart: number | undefined = d.submatches?.[0]?.start;
      if (matches.length >= max) {
        truncated = true;
        child.kill();
        return;
      }
      matches.push({
        path: path.normalize(d.path.text ?? ""),
        line: d.line_number,
        column:
          byteStart === undefined ? undefined : Buffer.from(text).subarray(0, byteStart).toString("utf8").length + 1,
        text: clip(text),
      });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 2 && matches.length === 0 && !truncated) {
        reject(new ToolError("INVALID_INPUT", `ripgrep failed: ${stderr.trim() || "unknown error"}`));
      } else {
        resolve({ matches, truncated, engine: "ripgrep" });
      }
    });
  });
}

/** Minimal glob → RegExp: supports **, *, ?, {a,b}. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function makeGlobFilter(globs: string[] | undefined): (rel: string) => boolean {
  const compiled = (globs ?? []).map((g) => {
    const negated = g.startsWith("!");
    const pattern = negated ? g.slice(1) : g;
    return { negated, basenameOnly: !pattern.includes("/"), re: globToRegExp(pattern.replace(/^\//, "")) };
  });
  const includes = compiled.filter((g) => !g.negated);
  const excludes = compiled.filter((g) => g.negated);
  const test = (g: (typeof compiled)[number], rel: string) => g.re.test(g.basenameOnly ? path.basename(rel) : rel);
  return (rel) => (includes.length === 0 || includes.some((g) => test(g, rel))) && !excludes.some((g) => test(g, rel));
}

/** Fallback when ripgrep is not installed. Skips hidden, ignored dirs, binaries, symlinks. */
async function searchNode(input: SearchInput, cwd: string, max: number): Promise<SearchResult> {
  let re: RegExp;
  try {
    const source = input.literal ? input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.query;
    re = new RegExp(source, input.caseInsensitive ? "i" : "");
  } catch (err) {
    throw new ToolError("INVALID_INPUT", `Invalid regular expression: ${(err as Error).message}`);
  }
  const accept = makeGlobFilter(input.glob);
  const matches: SearchMatch[] = [];
  let truncated = false;

  async function scanFile(abs: string, rel: string): Promise<void> {
    const s = await stat(abs);
    if (s.size > MAX_FALLBACK_FILE_BYTES) return;
    const stream = createReadStream(abs, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      if (lineNo === 1 && line.includes("\0")) break; // binary
      const m = re.exec(line);
      if (!m) continue;
      if (matches.length >= max) {
        truncated = true;
        break;
      }
      matches.push({ path: rel, line: lineNo, column: m.index + 1, text: clip(line) });
    }
    rl.close();
    stream.destroy();
  }

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(cwd, abs);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(abs);
      } else if (entry.isFile() && accept(rel)) {
        await scanFile(abs, rel);
      }
    }
  }

  await walk(cwd);
  return { matches, truncated, engine: "node" };
}
