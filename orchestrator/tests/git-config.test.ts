import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGitConfigUnchanged, gitConfigHash, safeRemoteGit } from "../src/guardrails.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "gcfg-"));
  git(dir, "init", "-q");
  return dir;
};

test("a change to .git/config is detected, an unchanged one and an empty snapshot are not", () => {
  const dir = repo();
  const h = gitConfigHash(dir);
  assert.equal(gitConfigHash(dir), h);
  assertGitConfigUnchanged(dir, h);
  assertGitConfigUnchanged(dir, "");
  git(dir, "config", "core.sshCommand", "evil");
  assert.throws(() => assertGitConfigUnchanged(dir, h), /\.git\/config changed/);
});

test("safeRemoteGit ignores a core.sshCommand and does not run the pre-push hook", () => {
  const root = mkdtempSync(join(tmpdir(), "gcfg-"));
  const bare = join(root, "bare.git");
  git(root, "init", "-q", "--bare", bare);
  const dir = repo();
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x");
  const marker = join(root, "ran");
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  writeFileSync(join(dir, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch "${marker.replaceAll("\\", "/")}"\n`);
  chmodSync(join(dir, ".git", "hooks", "pre-push"), 0o755);
  git(dir, "config", "core.sshCommand", "false");
  safeRemoteGit(dir, "push", "--", bare, "HEAD:refs/heads/t");
  git(root, "--git-dir", bare, "rev-parse", "--verify", "refs/heads/t");
  assert.equal(existsSync(marker), false);
});
