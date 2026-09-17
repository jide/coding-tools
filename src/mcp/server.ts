#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  applyPatch,
  exec,
  getConfig,
  gitDiff,
  gitShow,
  gitStatus,
  listTree,
  readFile,
  runChecks,
  search,
  toToolError,
} from "../core/index.js";
import * as S from "../schemas/tools.js";

const server = new McpServer({ name: "local-coding-tools", version: "0.1.0" });

/** Every tool returns its core result as JSON; errors become {code,message,details} with isError. */
function register<Shape extends Record<string, any>>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (input: any) => Promise<unknown>,
): void {
  const callback = async (input: unknown) => {
    try {
      const result = await handler(input);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(toToolError(err), null, 2) }] };
    }
  };
  // The SDK's generic callback typing cannot be inferred from a dynamic shape.
  server.registerTool(name, { description, inputSchema }, callback as never);
}

const roots = () => `Allowed roots: ${getConfig().allowedRoots.join(", ")}.`;

register("read_file", `Read a text file, optionally a line range (1-based). ${roots()}`, S.ReadFileShape, readFile);
register("list_tree", "Compact directory tree (ignores node_modules, .git, dist, ... by default).", S.ListTreeShape, listTree);
register("search", "Search file contents with ripgrep (regex or literal). Returns up to maxResults matches (default 200).", S.SearchShape, search);
register(
  "apply_patch",
  "Apply a multi-file patch atomically. Accepts '*** Begin Patch' format (*** Add File / *** Update File / *** Delete File / *** Move to, @@ hunks with ' ', '-', '+' lines, *** End Patch) or a standard unified diff. Use dryRun to validate. Returns the resulting diff.",
  S.ApplyPatchShape,
  applyPatch,
);
register("exec", "Run a shell command in cwd with a timeout and bounded output. Non-zero exit codes are returned, not thrown.", S.ExecShape, exec);
register("run_checks", "Run several commands sequentially (e.g. tests, typecheck) and report each result.", S.RunChecksShape, runChecks);
register("git_status", "Structured git status (branch, staged, modified, untracked, deleted, conflicted).", S.GitStatusShape, gitStatus);
register("git_diff", "git diff of the working tree (or index with staged=true), optionally limited to paths.", S.GitDiffShape, gitDiff);
register("git_show", "Show a commit, or a file's content at a ref when path is given.", S.GitShowShape, gitShow);

await server.connect(new StdioServerTransport());
