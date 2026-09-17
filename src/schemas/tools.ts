import { z } from "zod";

/**
 * Raw zod shapes (used by MCP `registerTool`) and wrapped objects (used by
 * the core and the CLI for validation). One source of truth for all inputs.
 */
export const ReadFileShape = {
  path: z.string().min(1).describe("File path (absolute, or relative to cwd)"),
  cwd: z.string().min(1).optional().describe("Base directory for relative paths"),
  offset: z.number().int().positive().optional().describe("1-based first line to return (default 1)"),
  limit: z.number().int().positive().optional().describe("Maximum number of lines (default 2000)"),
};

export const ListTreeShape = {
  path: z.string().min(1).describe("Directory to list"),
  cwd: z.string().min(1).optional(),
  depth: z.number().int().positive().optional().describe("Maximum depth (default 3)"),
  includeHidden: z.boolean().optional().describe("Include dotfiles (default false)"),
  includeIgnored: z.boolean().optional().describe("Include node_modules, .git, dist, ... (default false)"),
};

export const SearchShape = {
  query: z.string().min(1).describe("Regex (or literal string when literal=true)"),
  cwd: z.string().min(1).describe("Directory to search in"),
  glob: z.array(z.string().min(1)).optional().describe('File globs, e.g. ["*.ts", "!*.test.ts"]'),
  literal: z.boolean().optional(),
  caseInsensitive: z.boolean().optional(),
  maxResults: z.number().int().positive().optional().describe("Default 200"),
};

export const ApplyPatchShape = {
  cwd: z.string().min(1).describe("Directory patch paths are relative to"),
  patch: z.string().min(1).describe("'*** Begin Patch' format or a unified diff"),
  dryRun: z.boolean().optional().describe("Validate and compute the diff without writing"),
};

export const ExecShape = {
  command: z.string().min(1).describe("Shell command (run with /bin/sh -c)"),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
};

export const RunChecksShape = {
  cwd: z.string().min(1),
  commands: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().optional().describe("Timeout per command"),
  stopOnFailure: z.boolean().optional(),
};

export const GitStatusShape = {
  cwd: z.string().min(1),
};

export const GitDiffShape = {
  cwd: z.string().min(1),
  staged: z.boolean().optional(),
  paths: z.array(z.string().min(1)).optional(),
  ref: z.string().min(1).optional().describe("Compare the working tree (or index if staged) against this ref"),
};

export const GitShowShape = {
  cwd: z.string().min(1),
  ref: z.string().min(1).describe("Commit-ish, e.g. HEAD, HEAD~1, abc123"),
  path: z.string().min(1).optional().describe("Show this file's content at ref instead of the commit"),
};

export const ReadFileSchema = z.object(ReadFileShape);
export const ListTreeSchema = z.object(ListTreeShape);
export const SearchSchema = z.object(SearchShape);
export const ApplyPatchSchema = z.object(ApplyPatchShape);
export const ExecSchema = z.object(ExecShape);
export const RunChecksSchema = z.object(RunChecksShape);
export const GitStatusSchema = z.object(GitStatusShape);
export const GitDiffSchema = z.object(GitDiffShape);
export const GitShowSchema = z.object(GitShowShape);

export type ReadFileInput = z.infer<typeof ReadFileSchema>;
export type ListTreeInput = z.infer<typeof ListTreeSchema>;
export type SearchInput = z.infer<typeof SearchSchema>;
export type ApplyPatchInput = z.infer<typeof ApplyPatchSchema>;
export type ExecInput = z.infer<typeof ExecSchema>;
export type RunChecksInput = z.infer<typeof RunChecksSchema>;
export type GitStatusInput = z.infer<typeof GitStatusSchema>;
export type GitDiffInput = z.infer<typeof GitDiffSchema>;
export type GitShowInput = z.infer<typeof GitShowSchema>;
