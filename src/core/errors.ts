export type ErrorCode =
  | "PATH_OUTSIDE_ALLOWED_ROOT"
  | "PATH_RELATIVE_WITHOUT_CWD"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "PATCH_INVALID"
  | "PATCH_CONTEXT_MISMATCH"
  | "PATCH_WRITE_FAILED"
  | "COMMAND_TIMEOUT"
  | "NOT_A_GIT_REPOSITORY"
  | "GIT_ERROR"
  | "INVALID_INPUT"
  | "INTERNAL_ERROR";

export interface ToolErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function isDebug(): boolean {
  const d = process.env.DEBUG ?? "";
  return d.split(",").some((p) => p === "*" || p.startsWith("coding-tools"));
}

/** Convert any thrown value into a stack-free, serializable error. */
export function toToolError(err: unknown): ToolErrorShape {
  if (isDebug() && err instanceof Error) process.stderr.write(`${err.stack}\n`);
  if (err instanceof ToolError) {
    return err.details === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, details: err.details };
  }
  if (err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown }).issues)) {
    const issues = (err as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    return {
      code: "INVALID_INPUT",
      message: issues.map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`).join("; "),
    };
  }
  const nodeErr = err as NodeJS.ErrnoException;
  if (nodeErr?.code === "ENOENT") return { code: "FILE_NOT_FOUND", message: nodeErr.message };
  return { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) };
}
