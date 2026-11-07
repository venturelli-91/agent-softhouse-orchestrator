// Host-side git over a repo an agent touched, and the integrity checks around it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
// On Windows, os.devNull (a \\.\nul path) is not valid for git; use NUL.
export const devNull = process.platform === "win32" ? "NUL" : "/dev/null";

// Host-side git over a repo the agent touched: no fsmonitor, pager, system config or external diff.
export function safeGit(cwd: string, ...args: string[]): string {
  return run(cwd, {}, args);
}

const run = (cwd: string, extraEnv: NodeJS.ProcessEnv, args: string[]) =>
  execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", `core.hooksPath=${devNull}`, ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_EXTERNAL_DIFF: "", GIT_TERMINAL_PROMPT: "0", ...extraEnv }, encoding: "utf8",
  }).trim();

// Network git on the main checkout: no hooks, and plain `ssh` (env wins over a core.sshCommand an agent could have written).
// Pair it with assertGitConfigUnchanged: the rest of .git/config is only trusted if it still matches the ticket's snapshot.
export const safeRemoteGit = (cwd: string, ...args: string[]): string =>
  run(cwd, { GIT_SSH_COMMAND: "ssh", GIT_ALLOW_PROTOCOL: "file:https:ssh:git" }, ["-c", `core.hooksPath=${devNull}`, ...args]);

// The shared .git/config is writable from a ticket worktree; snapshot it before any agent runs.
export const gitConfigHash = (repo: string): string =>
  createHash("sha256").update(readFileSync(resolve(repo, safeGit(repo, "rev-parse", "--git-path", "config")))).digest("hex");

export function assertGitConfigUnchanged(repo: string, expected: string): void {
  if (expected && gitConfigHash(repo) !== expected) throw new Error(".git/config changed since the ticket started; review it, then re-run the ticket");
}

// The main checkout a ticket worktree was created from.
export const repoOf = (worktree: string): string => dirname(resolve(worktree, safeGit(worktree, "rev-parse", "--git-common-dir")));

// Active tickets = ticket/* worktrees of the target repo (state lives in git itself, no other database).
export function activeTickets(repo: string): number {
  return safeGit(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("branch refs/heads/ticket/")).length;
}
