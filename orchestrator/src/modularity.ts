// Modularity: every source file a ticket touches must stay within these limits (untouched legacy files are not checked).
import { safeGit } from "./git-safe.ts";

export const MAX_FILE_LINES = 300;
export const MAX_LINE_COLS = 160;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|css|scss|go|rs|java|kt|swift|rb|php|vue|svelte|html|sh|sql|c|h|cpp|cs)$/i;
const MAX_FILE_BYTES = MAX_FILE_LINES * (MAX_LINE_COLS + 2);

// Reads the committed blob (never the worktree file, so symlinks are not followed); a blob too big to comply is refused unread.
export function modularityViolations(wt: string, files: string[]): string[] {
  return files.filter((f) => SOURCE_FILE.test(f)).flatMap((f) => {
    if (Number(safeGit(wt, "cat-file", "-s", `HEAD:${f}`)) > MAX_FILE_BYTES) return [`${f} (over ${MAX_FILE_BYTES} bytes)`];
    const lines = safeGit(wt, "cat-file", "blob", `HEAD:${f}`).split(/\r?\n/);
    const long = lines.filter((l) => l.length > MAX_LINE_COLS).length;
    return lines.length > MAX_FILE_LINES || long ? [`${f} (${lines.length} lines, ${long} over ${MAX_LINE_COLS} cols)`] : [];
  });
}
