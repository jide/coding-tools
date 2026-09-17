import { chmod, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch, parsePatch } from "../src/core/patch.js";
import { useSandbox, writeFiles } from "./helpers.js";

const read = (root: string, rel: string) => readFile(path.join(root, rel), "utf8");
const exists = (root: string, rel: string) => stat(path.join(root, rel)).then(() => true, () => false);

describe("applyPatch", () => {
  const sb = useSandbox();

  it("applies a simple modification (Begin Patch format)", async () => {
    await writeFiles(sb.root, { "src/foo.ts": "const foo = 1;\nconst bar = 2;\n" });
    const r = await applyPatch({
      cwd: sb.root,
      patch: "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-const foo = 1;\n+const foo = 2;\n*** End Patch\n",
    });
    expect(r.filesChanged).toEqual(["src/foo.ts"]);
    expect(r.diff).toContain("-const foo = 1;\n+const foo = 2;");
    expect(await read(sb.root, "src/foo.ts")).toBe("const foo = 2;\nconst bar = 2;\n");
  });

  it("applies a standard unified diff", async () => {
    await writeFiles(sb.root, { "src/foo.ts": "a\nb\nc\n" });
    await applyPatch({
      cwd: sb.root,
      patch: "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
    });
    expect(await read(sb.root, "src/foo.ts")).toBe("a\nB\nc\n");
  });

  it("applies several hunks, using anchors and line hints", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFiles(sb.root, { "f.txt": body, "g.txt": "x\nsame\nx\nsame\n" });
    await applyPatch({
      cwd: sb.root,
      patch: [
        "*** Begin Patch",
        "*** Update File: f.txt",
        "@@",
        " line 2",
        "-line 3",
        "+LINE 3",
        "@@ line 20",
        "-line 21",
        "+LINE 21",
        "+inserted",
        "*** End Patch",
      ].join("\n"),
    });
    const f = await read(sb.root, "f.txt");
    expect(f).toContain("line 2\nLINE 3\nline 4");
    expect(f).toContain("line 20\nLINE 21\ninserted\nline 22");
    // Unified diff: hint picks the second "same".
    await applyPatch({ cwd: sb.root, patch: "--- a/g.txt\n+++ b/g.txt\n@@ -4,1 +4,1 @@\n-same\n+SAME\n" });
    expect(await read(sb.root, "g.txt")).toBe("x\nsame\nx\nSAME\n");
  });

  it("creates, deletes, moves and updates several files in one patch", async () => {
    await writeFiles(sb.root, { "a.ts": "a\n", "b.ts": "b\n", "old.ts": "keep\nme\n" });
    const r = await applyPatch({
      cwd: sb.root,
      patch: [
        "*** Begin Patch",
        "*** Add File: new/dir/c.ts",
        "+hello",
        "+world",
        "*** Delete File: b.ts",
        "*** Update File: a.ts",
        "@@",
        "-a",
        "+A",
        "*** Update File: old.ts",
        "*** Move to: moved.ts",
        "@@",
        " keep",
        "-me",
        "+you",
        "*** End Patch",
      ].join("\n"),
    });
    expect(r.filesChanged.sort()).toEqual(["a.ts", "b.ts", "moved.ts", "new/dir/c.ts", "old.ts"]);
    expect(await read(sb.root, "new/dir/c.ts")).toBe("hello\nworld\n");
    expect(await exists(sb.root, "b.ts")).toBe(false);
    expect(await exists(sb.root, "old.ts")).toBe(false);
    expect(await read(sb.root, "moved.ts")).toBe("keep\nyou\n");
    expect(await read(sb.root, "a.ts")).toBe("A\n");
    expect(r.diff).toContain("+++ b/new/dir/c.ts");
    expect(r.diff).toContain("--- a/b.ts\n+++ /dev/null");
  });

  it("supports unified diff creation and deletion via /dev/null", async () => {
    await writeFiles(sb.root, { "gone.txt": "bye\n" });
    await applyPatch({
      cwd: sb.root,
      patch: "--- /dev/null\n+++ b/made.txt\n@@ -0,0 +1,2 @@\n+1\n+2\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
    });
    expect(await read(sb.root, "made.txt")).toBe("1\n2\n");
    expect(await exists(sb.root, "gone.txt")).toBe(false);
  });

  it("fails with PATCH_CONTEXT_MISMATCH and changes nothing", async () => {
    await writeFiles(sb.root, { "a.ts": "a\n", "b.ts": "b\n" });
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+A\n*** Update File: b.ts\n@@\n-nope\n+X\n*** End Patch";
    await expect(applyPatch({ cwd: sb.root, patch })).rejects.toMatchObject({ code: "PATCH_CONTEXT_MISMATCH" });
    expect(await read(sb.root, "a.ts")).toBe("a\n");
  });

  it("dry run validates without writing", async () => {
    await writeFiles(sb.root, { "a.ts": "a\n" });
    const r = await applyPatch({
      cwd: sb.root,
      dryRun: true,
      patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+A\n*** Add File: n.ts\n+n\n*** End Patch",
    });
    expect(r).toMatchObject({ success: true, dryRun: true, filesChanged: ["a.ts", "n.ts"] });
    expect(r.diff).toContain("+A");
    expect(await read(sb.root, "a.ts")).toBe("a\n");
    expect(await exists(sb.root, "n.ts")).toBe(false);
  });

  it("rolls back already written files when a later write fails", async () => {
    await writeFiles(sb.root, { "a.ts": "a\n", "locked/keep.txt": "k\n" });
    await chmod(path.join(sb.root, "locked"), 0o555);
    try {
      const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+A\n*** Add File: locked/new.ts\n+x\n*** End Patch";
      await expect(applyPatch({ cwd: sb.root, patch })).rejects.toMatchObject({ code: "PATCH_WRITE_FAILED" });
      expect(await read(sb.root, "a.ts")).toBe("a\n");
      expect(await exists(sb.root, "locked/new.ts")).toBe(false);
    } finally {
      await chmod(path.join(sb.root, "locked"), 0o755);
    }
  });

  it("rejects paths outside the root before touching anything", async () => {
    await writeFiles(sb.root, { "a.ts": "a\n" });
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+A\n*** Add File: ../escape.ts\n+x\n*** End Patch";
    await expect(applyPatch({ cwd: sb.root, patch })).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    expect(await read(sb.root, "a.ts")).toBe("a\n");
  });

  it("preserves CRLF line endings, missing final newline and tolerates trailing whitespace drift", async () => {
    await writeFiles(sb.root, { "w.txt": "one\r\ntwo  \r\nthree", "n.txt": "x\ny" });
    await applyPatch({ cwd: sb.root, patch: "*** Begin Patch\n*** Update File: w.txt\n@@\n one\n-two\n+2\n*** End Patch" });
    expect(await read(sb.root, "w.txt")).toBe("one\r\n2\r\nthree");
    await applyPatch({ cwd: sb.root, patch: "--- a/n.txt\n+++ b/n.txt\n@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+z\n\\ No newline at end of file\n" });
    expect(await read(sb.root, "n.txt")).toBe("x\nz");
  });

  it("rejects malformed patches and adds over existing files", async () => {
    await writeFiles(sb.root, { "a.ts": "a\n" });
    await expect(applyPatch({ cwd: sb.root, patch: "hello" })).rejects.toMatchObject({ code: "PATCH_INVALID" });
    await expect(applyPatch({ cwd: sb.root, patch: "*** Begin Patch\n*** Update File: a.ts\n-a\n+b\n" })).rejects.toMatchObject({ code: "PATCH_INVALID" });
    await expect(applyPatch({ cwd: sb.root, patch: "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch" })).rejects.toMatchObject({ code: "PATCH_INVALID" });
    await expect(applyPatch({ cwd: sb.root, patch: "*** Begin Patch\n*** Delete File: zz.ts\n*** End Patch" })).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("keeps file mode", async () => {
    await writeFiles(sb.root, { "run.sh": "echo a\n" });
    await chmod(path.join(sb.root, "run.sh"), 0o755);
    await applyPatch({ cwd: sb.root, patch: "*** Begin Patch\n*** Update File: run.sh\n@@\n-echo a\n+echo b\n*** End Patch" });
    expect((await stat(path.join(sb.root, "run.sh"))).mode & 0o777).toBe(0o755);
  });
});

describe("parsePatch", () => {
  it("does not confuse removed lines starting with -- in a unified diff", () => {
    const ops = parsePatch("--- a/x.sql\n+++ b/x.sql\n@@ -1,2 +1,1 @@\n--- comment\n select 1;\n");
    expect(ops).toMatchObject([{ kind: "update", path: "x.sql", hunks: [{ oldLines: ["-- comment", "select 1;"], newLines: ["select 1;"] }] }]);
  });
});
