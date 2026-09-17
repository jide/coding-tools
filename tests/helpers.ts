import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

/** Creates a fresh allowed root per test and points CODING_TOOLS_ROOTS at it. */
export function useSandbox() {
  const ctx = { root: "", outside: "" };
  beforeEach(async () => {
    ctx.root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ct-root-")));
    ctx.outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "ct-outside-")));
    process.env.CODING_TOOLS_ROOTS = ctx.root;
    delete process.env.CODING_TOOLS_MAX_OUTPUT;
  });
  afterEach(async () => {
    await rm(ctx.root, { recursive: true, force: true });
    await rm(ctx.outside, { recursive: true, force: true });
  });
  return ctx;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}
