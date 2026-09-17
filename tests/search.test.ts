import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { globToRegExp, search } from "../src/core/search.js";
import { useSandbox, writeFiles } from "./helpers.js";

const hasRg = spawnSync(process.env.CODING_TOOLS_RG || "rg", ["--version"]).status === 0;
const engines = (hasRg ? ["ripgrep", "node"] : ["node"]) as ("ripgrep" | "node")[];

describe.each(engines)("search (%s)", (engine) => {
  const sb = useSandbox();
  const setup = () =>
    writeFiles(sb.root, {
      "src/game.ts": "export function createGame() {}\nuseEffect(() => {});\n",
      "src/view.tsx": "const g = createGame();\n",
      "README.md": "createGame docs\n",
      "node_modules/lib/index.js": "createGame\n",
    });

  it("finds matches with line and column", async () => {
    await setup();
    const r = await search({ query: "createGame", cwd: sb.root }, { engine });
    const found = r.matches.map((m) => `${m.path}:${m.line}:${m.column}`).sort();
    expect(found).toEqual(["README.md:1:1", "src/game.ts:1:17", "src/view.tsx:1:11"]);
    expect(r.truncated).toBe(false);
  });

  it("supports literal queries", async () => {
    await setup();
    const r = await search({ query: "useEffect(", cwd: sb.root, literal: true }, { engine });
    expect(r.matches).toMatchObject([{ path: "src/game.ts", line: 2, text: "useEffect(() => {});" }]);
  });

  it("filters with globs", async () => {
    await setup();
    const r = await search({ query: "createGame", cwd: sb.root, glob: ["*.ts", "*.tsx"] }, { engine });
    expect(r.matches.map((m) => m.path).sort()).toEqual(["src/game.ts", "src/view.tsx"]);
  });

  it("limits results", async () => {
    await writeFiles(sb.root, { "many.txt": "hit\n".repeat(50) });
    const r = await search({ query: "hit", cwd: sb.root, maxResults: 10 }, { engine });
    expect(r.matches).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("rejects a cwd outside the roots", async () => {
    await expect(search({ query: "x", cwd: sb.outside }, { engine })).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });
});

describe("globToRegExp", () => {
  it("handles common patterns", () => {
    expect(globToRegExp("*.{ts,tsx}").test("a.tsx")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a.tsx")).toBe(false);
  });
});
