export interface CodingToolsConfig {
  allowedRoots: string[];
  defaultTimeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_CONFIG: CodingToolsConfig = {
  allowedRoots: ["/Users/jide/Projects"],
  defaultTimeoutMs: 120_000,
  maxOutputBytes: 2_000_000,
};

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Read on every call so env changes (tests, wrappers) are honoured. */
export function getConfig(): CodingToolsConfig {
  const roots = process.env.CODING_TOOLS_ROOTS;
  return {
    allowedRoots: roots ? roots.split(":").filter(Boolean) : DEFAULT_CONFIG.allowedRoots,
    defaultTimeoutMs: positiveInt(process.env.CODING_TOOLS_TIMEOUT, DEFAULT_CONFIG.defaultTimeoutMs),
    maxOutputBytes: positiveInt(process.env.CODING_TOOLS_MAX_OUTPUT, DEFAULT_CONFIG.maxOutputBytes),
  };
}
