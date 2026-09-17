import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiff, gitShow, gitStatus } from "../src/core/git.js";
import { useSandbox, writeFiles } from "./helpers.js";

describe("git", () => {
  const sb = useSandbox();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: sb.root, encoding: "utf8" });
  const initRepo = async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await writeFiles(sb.root, { "a.txt": "one\n", "b.txt": "two\n" });
    git("add", "-A");
    git("commit", "-qm", "init");
  };

  it("errors outside a repository", async () => {
    await expect(gitStatus({ cwd: sb.root })).rejects.toMatchObject({ code: "NOT_A_GIT_REPOSITORY" });
  });

  it("reports a clean status", async () => {
    await initRepo();
    expect(await gitStatus({ cwd: sb.root })).toMatchObject({
      branch: "main",
      clean: true,
      staged: [],
      modified: [],
      untracked: [],
      deleted: [],
    });
  });

  it("reports modified, untracked, staged and deleted files", async () => {
    await initRepo();
    await writeFile(path.join(sb.root, "a.txt"), "one!\n");
    await writeFiles(sb.root, { "dir/new.txt": "n", "staged.txt": "s" });
    git("add", "staged.txt");
    git("rm", "-q", "b.txt");
    const s = await gitStatus({ cwd: sb.root });
    expect(s.clean).toBe(false);
    expect(s.modified).toEqual([{ path: "a.txt", status: "M" }]);
    expect(s.untracked).toEqual(["dir/new.txt"]);
    expect(s.staged).toEqual([
      { path: "b.txt", status: "D" },
      { path: "staged.txt", status: "A" },
    ]);
    expect(s.deleted).toEqual(["b.txt"]);
  });

  it("produces diffs (worktree, staged, paths)", async () => {
    await initRepo();
    await writeFile(path.join(sb.root, "a.txt"), "one!\n");
    await writeFile(path.join(sb.root, "b.txt"), "two!\n");
    git("add", "b.txt");
    const worktree = await gitDiff({ cwd: sb.root });
    expect(worktree.diff).toContain("+one!");
    expect(worktree.diff).not.toContain("two!");
    expect((await gitDiff({ cwd: sb.root, staged: true })).diff).toContain("+two!");
    expect((await gitDiff({ cwd: sb.root, ref: "HEAD", paths: ["b.txt"] })).diff).not.toContain("a.txt");
    await expect(gitDiff({ cwd: sb.root, paths: ["../x"] })).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });

  it("shows a commit and a file at a ref", async () => {
    await initRepo();
    await writeFile(path.join(sb.root, "a.txt"), "changed\n");
    git("commit", "-qam", "second");
    expect((await gitShow({ cwd: sb.root, ref: "HEAD~1", path: "a.txt" })).content).toBe("one\n");
    expect((await gitShow({ cwd: sb.root, ref: "HEAD" })).content).toContain("+changed");
    await expect(gitShow({ cwd: sb.root, ref: "--output=/tmp/x" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
