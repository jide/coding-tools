# local-coding-tools

Small, typed coding primitives for LLM agents working on local repositories:
**read, search, list, patch, exec, git**. One core, two front-ends:

```text
src/core/     business logic (paths, filesystem, search, patch, exec, git)
src/schemas/  zod input schemas shared by core, CLI and MCP
src/cli/      `coding-tools` executable (for Desktop Commander / terminals)
src/mcp/      `coding-tools-mcp` stdio MCP server
```

## Installation

Requirements: macOS, Node.js >= 20, pnpm, git. [ripgrep](https://github.com/BurntSushi/ripgrep)
is recommended (`brew install ripgrep`); without it `search` falls back to a slower Node implementation.

```bash
cd /Users/jide/Projects/coding-tools
pnpm install
pnpm build
pnpm link --global   # exposes `coding-tools` and `coding-tools-mcp`
pnpm test
```

## Configuration

| Variable                  | Default                | Meaning                                             |
| ------------------------- | ---------------------- | --------------------------------------------------- |
| `CODING_TOOLS_ROOTS`      | `/Users/jide/Projects` | `:`-separated allowed roots                         |
| `CODING_TOOLS_TIMEOUT`    | `120000`               | Default `exec` timeout (ms)                         |
| `CODING_TOOLS_MAX_OUTPUT` | `2000000`              | Max bytes per output stream / diff / file content   |
| `CODING_TOOLS_RG`         | `rg`                   | ripgrep binary                                      |
| `DEBUG=coding-tools:*`    | —                      | Print stack traces to stderr                        |

```bash
CODING_TOOLS_ROOTS=/Users/jide/Projects:/tmp/coding-work coding-tools git-status --cwd /tmp/coding-work/repo
```

## Security

Every path (file paths, `cwd`, patch targets, git pathspecs) goes through `resolveSafePath`:

1. relative paths require an explicit `cwd` (itself validated);
2. symlinks are resolved with `realpath` — for files that do not exist yet, the deepest existing ancestor is resolved;
3. the **real** destination must be inside an allowed root (roots are realpath'd too, so `/tmp` → `/private/tmp` works);
4. otherwise `PATH_OUTSIDE_ALLOWED_ROOT` is raised.

So `../../etc`, `/Users/jide/Projects-evil`, and `repo/outside -> /etc` are all rejected.
`list_tree` and the Node search fallback never follow symlinks; ripgrep does not follow them by default.

`exec` runs arbitrary shell commands: the root check only constrains its working directory, not what the command does.

## Tools

| MCP name      | CLI command    | Purpose                                                        |
| ------------- | -------------- | -------------------------------------------------------------- |
| `read_file`   | `read-file`    | Line range of a file (streamed, 1-based `offset`, `limit`)     |
| `list_tree`   | `list-tree`    | Compact tree, default depth 3, skips `node_modules .git .next dist build coverage` |
| `search`      | `search`       | ripgrep search, regex or `literal`, `glob`, `maxResults` (200) |
| `apply_patch` | `apply-patch`  | Atomic multi-file patch, `dryRun`                              |
| `exec`        | `exec`         | Shell command with timeout, process-group kill, bounded output |
| `run_checks`  | `run-checks`   | Sequential commands, one result each                           |
| `git_status`  | `git-status`   | Branch, staged, modified, untracked, deleted, conflicted       |
| `git_diff`    | `git-diff`     | Worktree / `staged` / vs `ref`, optional `paths`               |
| `git_show`    | `git-show`     | Commit at `ref`, or file content at `ref` with `path`          |

Input fields are identical between MCP and CLI JSON (see `src/schemas/tools.ts`).

### apply_patch

Two formats are accepted.

```diff
*** Begin Patch
*** Update File: src/foo.ts
@@ function setup
-const foo = 1;
+const foo = 2;
*** Add File: src/new.ts
+export const x = 1;
*** Delete File: src/old.ts
*** Update File: src/a.ts
*** Move to: src/b.ts
@@
 context
-old
+new
*** End Patch
```

- `@@ text` optionally anchors the hunk after the line matching `text`.
- `*** End of File` forces the previous hunk to match at the end of the file.
- Hunks are located by content (exact, then ignoring trailing / surrounding whitespace, then typographic quotes/dashes), in order.

Or a standard unified diff (`git diff`, `diff -u`), including `/dev/null` for creation/deletion, renames and
`\ No newline at end of file`; `@@ -l,n` line numbers are used as hints to choose between identical contexts.

Guarantees: the whole patch is parsed, all paths validated and all hunks applied **in memory** first.
Nothing is written unless everything succeeds. Writes go to temp files then `rename`; if a write fails,
already written files are restored (`PATCH_WRITE_FAILED`, `details.rolledBack`). CRLF line endings,
missing final newlines and file modes are preserved. The returned `diff` is recomputed from disk.

### exec

Commands run with `/bin/sh -c` in their own process group. On timeout the group gets `SIGTERM` then
`SIGKILL`; the result has `timedOut: true, exitCode: null`. Non-zero exit codes are returned, not thrown.
When output exceeds the limit, the head and the tail are kept (`truncated: true`).
`GIT_PAGER=cat`, `PAGER=cat` and `CI=1` (unless set) are injected.

## CLI usage

```bash
coding-tools search --cwd /Users/jide/Projects/foo --query createGame
coding-tools search --cwd /Users/jide/Projects/foo --query 'useEffect(' --literal --glob '*.ts' --glob '*.tsx'
coding-tools read-file --path /Users/jide/Projects/foo/src/game.ts --offset 100 --limit 80
coding-tools list-tree --path /Users/jide/Projects/foo --depth 2
coding-tools apply-patch --cwd /Users/jide/Projects/foo < change.patch
coding-tools apply-patch --cwd /Users/jide/Projects/foo --dry-run --patch-file change.patch
coding-tools git-status --cwd /Users/jide/Projects/foo
coding-tools git-diff --cwd /Users/jide/Projects/foo --staged --path src/foo.ts
coding-tools git-show --cwd /Users/jide/Projects/foo --ref HEAD~1 --path src/foo.ts
coding-tools exec --cwd /Users/jide/Projects/foo --command "pnpm test" --timeout 300000
coding-tools run-checks --cwd /Users/jide/Projects/foo --command "pnpm test" --command "pnpm typecheck"
```

Relative `--cwd` / `--path` values are resolved against the shell's working directory.

**JSON mode.** Add `--json` to any command. Output is always one of:

```json
{ "ok": true, "result": { } }
{ "ok": false, "error": { "code": "PATCH_CONTEXT_MISMATCH", "message": "...", "details": { } } }
```

In JSON mode the process exits 0 on success and 1 on tool errors (a failing command in `exec` is still `ok: true`;
check `result.exitCode`). In human mode `exec` exits with the command's exit code.

**JSON input.** When stdin is piped and required options are missing, stdin is parsed as a JSON object with the
MCP field names (flags override it). `apply-patch` reads stdin as a raw patch, or as JSON if it starts with `{`:

```bash
echo '{"cwd": "/Users/jide/Projects/foo", "patch": "*** Begin Patch\n..."}' | coding-tools apply-patch --json
echo '{"cwd": "/Users/jide/Projects/foo", "command": "pnpm test", "timeoutMs": 60000}' | coding-tools exec --json
```

### With Desktop Commander

Call the CLI through Desktop Commander's command tool, preferring `--json`:

```bash
coding-tools git-status --cwd /Users/jide/Projects/foo --json
coding-tools apply-patch --cwd /Users/jide/Projects/foo < /tmp/change.patch
```

Typical loop: `git-status` → `search` → `read-file` → `apply-patch` (write the patch to `/tmp/change.patch`,
or pipe JSON) → `git-diff` → `exec pnpm test` → patch again.

## MCP usage

```json
{
  "mcpServers": {
    "local-coding-tools": {
      "command": "node",
      "args": ["/Users/jide/Projects/coding-tools/dist/mcp/server.js"],
      "env": {
        "CODING_TOOLS_ROOTS": "/Users/jide/Projects"
      }
    }
  }
}
```

(or `"command": "coding-tools-mcp"` after `pnpm link --global`). Transport: stdio. Each tool returns the
core result as JSON text plus `structuredContent`; errors are returned with `isError: true` and the
`{code, message, details}` body.

## Error codes

`PATH_OUTSIDE_ALLOWED_ROOT`, `PATH_RELATIVE_WITHOUT_CWD`, `FILE_NOT_FOUND`, `NOT_A_FILE`, `NOT_A_DIRECTORY`,
`PATCH_INVALID`, `PATCH_CONTEXT_MISMATCH`, `PATCH_WRITE_FAILED`, `NOT_A_GIT_REPOSITORY`, `GIT_ERROR`,
`INVALID_INPUT`, `INTERNAL_ERROR`. Timeouts and truncation are reported as result fields
(`timedOut`, `truncated`) rather than errors, so partial output is never lost.
