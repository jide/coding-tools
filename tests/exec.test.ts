import { describe, expect, it } from "vitest";
import { exec, runChecks } from "../src/core/exec.js";
import { useSandbox } from "./helpers.js";

describe("exec", () => {
  const sb = useSandbox();

  it("runs a command in cwd", async () => {
    const r = await exec({ command: "pwd", cwd: sb.root });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, truncated: false, stdout: `${sb.root}\n` });
  });

  it("returns non-zero exit codes and separate streams", async () => {
    const r = await exec({ command: "echo out; echo err >&2; exit 1", cwd: sb.root });
    expect(r).toMatchObject({ exitCode: 1, stdout: "out\n", stderr: "err\n" });
  });

  it("passes env variables", async () => {
    const r = await exec({ command: 'printf "$FOO"', cwd: sb.root, env: { FOO: "bar" } });
    expect(r.stdout).toBe("bar");
  });

  it("kills the process tree on timeout", async () => {
    const started = Date.now();
    const r = await exec({ command: "sleep 30 & sleep 30; echo never", cwd: sb.root, timeoutMs: 300 });
    expect(r).toMatchObject({ timedOut: true, exitCode: null });
    expect(r.stdout).not.toContain("never");
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("rejects an invalid cwd", async () => {
    await expect(exec({ command: "ls", cwd: sb.outside })).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(exec({ command: "ls", cwd: `${sb.root}/missing` })).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("truncates very large output keeping head and tail", async () => {
    process.env.CODING_TOOLS_MAX_OUTPUT = "10000";
    const r = await exec({ command: "echo START; yes xxxxxxxxxx | head -n 100000; echo END", cwd: sb.root });
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith("START")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("END")).toBe(true);
    expect(r.stdout.length).toBeLessThan(10_200);
  });

  it("runChecks runs commands sequentially", async () => {
    const r = await runChecks({ cwd: sb.root, commands: ["echo a > f", "cat f", "exit 2"] });
    expect(r.success).toBe(false);
    expect(r.results.map((c) => c.exitCode)).toEqual([0, 0, 2]);
    expect(r.results[1].stdout).toBe("a\n");
  });
});
