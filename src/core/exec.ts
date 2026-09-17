import { spawn } from "node:child_process";
import { ExecSchema, RunChecksSchema, type ExecInput, type RunChecksInput } from "../schemas/tools.js";
import { getConfig } from "./config.js";
import { BoundedOutput } from "./output.js";
import { resolveSafeDir } from "./paths.js";

export interface ExecResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal); // negative pid = whole process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Run a shell command. A non-zero exit code is a result, not an exception. */
export async function exec(rawInput: ExecInput): Promise<ExecResult> {
  const input = ExecSchema.parse(rawInput);
  const config = getConfig();
  const cwd = await resolveSafeDir(input.cwd);
  const timeoutMs = input.timeoutMs ?? config.defaultTimeoutMs;
  const stdout = new BoundedOutput(config.maxOutputBytes);
  const stderr = new BoundedOutput(config.maxOutputBytes);
  const started = Date.now();

  const child = spawn("/bin/sh", ["-c", input.command], {
    cwd,
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", CI: process.env.CI ?? "1", ...input.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group so we can kill children on timeout
  });
  child.stdout.on("data", (c: Buffer) => stdout.push(c));
  child.stderr.on("data", (c: Buffer) => stderr.push(c));

  let timedOut = false;
  let forceKill: NodeJS.Timeout | undefined;
  let giveUp: NodeJS.Timeout | undefined;

  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, "SIGTERM");
        forceKill = setTimeout(() => killGroup(child.pid, "SIGKILL"), 2000);
        // A detached grandchild may keep the pipes open: stop waiting eventually.
        giveUp = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          resolve({ exitCode: null, signal: "SIGKILL" });
        }, 5000);
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal: sig });
      });
    },
  ).finally(() => {
    clearTimeout(forceKill);
    clearTimeout(giveUp);
  });

  return {
    command: input.command,
    cwd,
    exitCode: timedOut ? null : exitCode,
    signal,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    timedOut,
    durationMs: Date.now() - started,
    truncated: stdout.truncated || stderr.truncated,
  };
}

export interface RunChecksResult {
  success: boolean;
  results: ExecResult[];
}

/** Run commands sequentially and report each one. */
export async function runChecks(rawInput: RunChecksInput): Promise<RunChecksResult> {
  const input = RunChecksSchema.parse(rawInput);
  const results: ExecResult[] = [];
  for (const command of input.commands) {
    const result = await exec({ command, cwd: input.cwd, timeoutMs: input.timeoutMs });
    results.push(result);
    if (result.exitCode !== 0 && input.stopOnFailure) break;
  }
  return {
    success: results.length === input.commands.length && results.every((r) => r.exitCode === 0),
    results,
  };
}
