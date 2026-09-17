import path from "node:path";
import { describe, expect, it } from "vitest";
import { listTree, readFile } from "../src/core/filesystem.js";
import { useSandbox, writeFiles } from "./helpers.js";

describe("readFile", () => {
  const sb = useSandbox();
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

  it("reads a full file", async () => {
    await writeFiles(sb.root, { "f.txt": lines.join("\n") + "\n" });
    const r = await readFile({ path: path.join(sb.root, "f.txt") });
    expect(r).toMatchObject({ startLine: 1, endLine: 10, totalLines: 10, truncated: false });
    expect(r.content).toBe(lines.join("\n"));
  });

  it("reads a range", async () => {
    await writeFiles(sb.root, { "f.txt": lines.join("\n") });
    const r = await readFile({ path: "f.txt", cwd: sb.root, offset: 3, limit: 2 });
    expect(r).toMatchObject({ content: "line 3\nline 4", startLine: 3, endLine: 4, totalLines: 10, truncated: true });
  });

  it("returns empty content when offset is past EOF", async () => {
    await writeFiles(sb.root, { "f.txt": lines.join("\n") });
    const r = await readFile({ path: "f.txt", cwd: sb.root, offset: 50 });
    expect(r).toMatchObject({ content: "", totalLines: 10, truncated: false });
  });

  it("handles unicode and CRLF", async () => {
    await writeFiles(sb.root, { "u.txt": "héllo 🌍\r\n日本語\r\n" });
    const r = await readFile({ path: "u.txt", cwd: sb.root });
    expect(r.content).toBe("héllo 🌍\n日本語");
    expect(r.totalLines).toBe(2);
  });

  it("errors on missing files and directories", async () => {
    await expect(readFile({ path: "nope", cwd: sb.root })).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(readFile({ path: sb.root })).rejects.toMatchObject({ code: "NOT_A_FILE" });
  });
});

describe("listTree", () => {
  const sb = useSandbox();

  it("lists a compact tree and skips ignored/hidden entries", async () => {
    await writeFiles(sb.root, {
      "package.json": "{}",
      "src/app/page.tsx": "",
      "src/components/Header.tsx": "",
      "node_modules/x/index.js": "",
      ".env": "",
    });
    const r = await listTree({ path: sb.root });
    expect(r.tree).toBe(["src/", "  app/", "    page.tsx", "  components/", "    Header.tsx", "package.json"].join("\n"));
    const all = await listTree({ path: sb.root, depth: 1, includeHidden: true, includeIgnored: true });
    expect(all.tree).toBe(["node_modules/", "src/", ".env", "package.json"].join("\n"));
  });
});
