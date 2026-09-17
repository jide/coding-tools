import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSafePath } from "../src/core/paths.js";
import { useSandbox, writeFiles } from "./helpers.js";

describe("resolveSafePath", () => {
  const sb = useSandbox();

  it("accepts an absolute path inside the root", async () => {
    await writeFiles(sb.root, { "a.txt": "x" });
    expect(await resolveSafePath(path.join(sb.root, "a.txt"))).toBe(path.join(sb.root, "a.txt"));
  });

  it("resolves relative paths against cwd", async () => {
    await mkdir(path.join(sb.root, "src"));
    expect(await resolveSafePath("src/b.ts", sb.root)).toBe(path.join(sb.root, "src/b.ts"));
  });

  it("rejects relative paths without cwd", async () => {
    await expect(resolveSafePath("src/b.ts")).rejects.toMatchObject({ code: "PATH_RELATIVE_WITHOUT_CWD" });
  });

  it("rejects ../ escapes", async () => {
    await expect(resolveSafePath("../../etc/passwd", sb.root)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(resolveSafePath(`${sb.root}/../x`)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });

  it("rejects a cwd outside the roots", async () => {
    await expect(resolveSafePath("a", sb.outside)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });

  it("accepts symlinks that stay inside the root", async () => {
    await writeFiles(sb.root, { "real/file.txt": "x" });
    await symlink(path.join(sb.root, "real"), path.join(sb.root, "link"));
    expect(await resolveSafePath("link/file.txt", sb.root)).toBe(path.join(sb.root, "real/file.txt"));
  });

  it("rejects symlinks pointing outside the root, including for new files", async () => {
    await writeFiles(sb.outside, { "secret.txt": "x" });
    await symlink(sb.outside, path.join(sb.root, "outside"));
    await symlink(path.join(sb.outside, "secret.txt"), path.join(sb.root, "secret-link"));
    await expect(resolveSafePath("outside/secret.txt", sb.root)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(resolveSafePath("outside/new/file.txt", sb.root)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(resolveSafePath("secret-link", sb.root)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });

  it("rejects a root-prefix lookalike directory", async () => {
    await expect(resolveSafePath(`${sb.root}-evil/file`)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });
});
