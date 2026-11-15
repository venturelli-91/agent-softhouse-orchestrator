import { execFileSync, spawn, spawnSync, type ChildProcess, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { resolve } from "node:path";
import type { Env } from "./agent-env.ts";

export type Platform = NodeJS.Platform;

export const isWindows = (p: Platform = process.platform) => p === "win32";

export const shellName = (p: Platform = process.platform) => (isWindows(p) ? "PowerShell" : "Bash");

export const devNullPath = (p: Platform = process.platform) => (isWindows(p) ? "NUL" : "/dev/null");

export const samePath = (a: string, b: string, p: Platform = process.platform) =>
  isWindows(p) ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export function runShimmed(
  line: string, bin: string, args: string[], opts: ExecFileSyncOptionsWithStringEncoding,
  p: Platform = process.platform, exec: typeof execFileSync = execFileSync,
): string {
  return isWindows(p) ? exec(line, { ...opts, shell: true }) : exec(bin, args, opts);
}

export function spawnServe(
  serve: string, cwd: string, env: Env, p: Platform = process.platform, start: typeof spawn = spawn,
): ChildProcess {
  const [bin, ...args] = serve.split(" ").filter(Boolean);
  const win = isWindows(p);
  return start(win ? serve : bin, win ? [] : args, { cwd, env, stdio: "ignore", detached: !win, shell: win, windowsHide: true });
}

export function killTree(
  pid: number, p: Platform = process.platform,
  io: { spawnSync: typeof spawnSync; kill: typeof process.kill } = { spawnSync, kill: process.kill.bind(process) },
): void {
  if (isWindows(p)) io.spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"]);
  else io.kill(-pid, "SIGKILL");
}
