import { test } from "node:test";
import assert from "node:assert/strict";
import { isWindows, killTree, runShimmed, samePath, shellName, devNullPath, spawnServe } from "../src/platform.ts";

test("shell and null device per platform", () => {
  assert.equal(shellName("win32"), "PowerShell");
  assert.equal(shellName("linux"), "Bash");
  assert.equal(devNullPath("win32"), "NUL");
  assert.equal(devNullPath("linux"), "/dev/null");
  assert.equal(isWindows("win32"), true);
  assert.equal(isWindows("linux"), false);
});

test("samePath ignores case only on win32", () => {
  assert.equal(samePath("/A/b", "/a/B", "win32"), true);
  assert.equal(samePath("/A/b", "/a/B", "linux"), false);
  assert.equal(samePath("/a/b", "/a/b", "linux"), true);
});

test("runShimmed goes through a shell with the whole line on win32, plain argv on linux", () => {
  const calls: unknown[][] = [];
  const exec = ((...a: unknown[]) => (calls.push(a), "out")) as never;
  const opts = { cwd: "/w", encoding: "utf8" } as const;
  assert.equal(runShimmed("npm ci -x", "npm", ["ci", "-x"], opts, "win32", exec), "out");
  assert.equal(runShimmed("npm ci -x", "npm", ["ci", "-x"], opts, "linux", exec), "out");
  assert.deepEqual(calls[0], ["npm ci -x", { ...opts, shell: true }]);
  assert.deepEqual(calls[1], ["npm", ["ci", "-x"], opts]);
});

test("spawnServe: one shell line on win32, argv and a process group on linux", () => {
  const calls: unknown[][] = [];
  const start = ((...a: unknown[]) => (calls.push(a), {})) as never;
  const env = { A: "1" };
  spawnServe("npm run dev -p 3000", "/w", env, "win32", start);
  spawnServe("npm run dev -p 3000", "/w", env, "linux", start);
  assert.deepEqual(calls[0], ["npm run dev -p 3000", [], { cwd: "/w", env, stdio: "ignore", detached: false, shell: true, windowsHide: true }]);
  assert.deepEqual(calls[1], ["npm", ["run", "dev", "-p", "3000"], { cwd: "/w", env, stdio: "ignore", detached: true, shell: false, windowsHide: true }]);
});

test("killTree: taskkill /t /f on win32, SIGKILL to the group on linux", () => {
  const seen: unknown[][] = [];
  const io = { spawnSync: ((...a: unknown[]) => seen.push(["spawnSync", ...a])) as never, kill: ((...a: unknown[]) => seen.push(["kill", ...a])) as never };
  killTree(42, "win32", io);
  killTree(42, "linux", io);
  assert.deepEqual(seen, [["spawnSync", "taskkill", ["/pid", "42", "/t", "/f"]], ["kill", -42, "SIGKILL"]]);
});
