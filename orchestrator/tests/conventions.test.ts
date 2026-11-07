import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConventions } from "../src/repo-config.ts";

test("the repo's CLAUDE.md comes from the base commit, capped", () => {
  const d = mkdtempSync(join(tmpdir(), "conv-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "a");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const noRules = git("rev-parse", "HEAD");
  assert.equal(loadConventions(d, noRules), "");
  writeFileSync(join(d, "CLAUDE.md"), "Commits in Portuguese.");
  git("add", "-A");
  git("commit", "-q", "-m", "rules");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(d, "CLAUDE.md"), "edited after the base");
  assert.equal(loadConventions(d, base), "Commits in Portuguese.");
  assert.equal(loadConventions(d, base, 7), "Commits");
  rmSync(d, { recursive: true, force: true });
});

test("the rules come from .claude/CLAUDE.md on disk first, then the committed root file", () => {
  const d = mkdtempSync(join(tmpdir(), "conv-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, "CLAUDE.md"), "root rules");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  assert.equal(loadConventions(d, base), "root rules");
  mkdirSync(join(d, ".claude"));
  writeFileSync(join(d, ".claude", "CLAUDE.md"), "local rules");
  assert.equal(loadConventions(d, base), "local rules");
  writeFileSync(join(d, ".claude", "CLAUDE.md"), "x".repeat(9000));
  assert.equal(loadConventions(d, base).length, 8000);
  rmSync(d, { recursive: true, force: true });
  const none = mkdtempSync(join(tmpdir(), "conv-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: none });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", "commit", "-q", "--allow-empty", "-m", "b"], { cwd: none });
  assert.equal(loadConventions(none, "HEAD"), "");
  rmSync(none, { recursive: true, force: true });
});
