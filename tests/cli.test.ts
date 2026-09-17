import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useSandbox, writeFiles } from "./helpers.js";

const CLI = path.resolve(__dirname, "../dist/cli/index.js");

describe.skipIf(!existsSync(CLI))("cli (built)", () => {
  const sb = useSandbox();
  const run = (args: string[], input?: string) =>
    spawnSync("node", [CLI, ...args], { input, encoding: "utf8", env: { ...process.env, CODING_TOOLS_ROOTS: sb.root } });

  it("returns stable JSON for success and errors", async () => {
    await writeFiles(sb.root, { "a.ts": "a\n" });
    const ok = JSON.parse(run(["read-file", "--path", path.join(sb.root, "a.ts"), "--json"]).stdout);
    expect(ok).toMatchObject({ ok: true, result: { content: "a", totalLines: 1 } });
    const bad = run(["read-file", "--path", "/etc/hosts", "--json"]);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_ALLOWED_ROOT" } });
  });

  it("applies a patch from stdin (raw and JSON)", async () => {
    await writeFiles(sb.root, { "a.ts": "a\n" });
    const raw = run(["apply-patch", "--cwd", sb.root], "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch\n");
    expect(raw.status).toBe(0);
    const json = run(["apply-patch", "--json"], JSON.stringify({ cwd: sb.root, patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-b\n+c\n" }));
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, result: { filesChanged: ["a.ts"] } });
    expect(execFileSync("cat", [path.join(sb.root, "a.ts")], { encoding: "utf8" })).toBe("c\n");
  });

  it("propagates exec exit codes in human mode", () => {
    const r = run(["exec", "--cwd", sb.root, "--command", "echo hi; exit 4"]);
    expect(r.status).toBe(4);
    expect(r.stdout).toContain("hi");
  });
});
