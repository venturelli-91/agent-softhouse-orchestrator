import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareNodeTest, loadConventions } from "../src/repo-config.ts";

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

test("a .claude/CLAUDE.md committed at the base is ignored and the root file is used", () => {
  const d = mkdtempSync(join(tmpdir(), "conv-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(d, ".claude"));
  writeFileSync(join(d, "CLAUDE.md"), "root rules");
  writeFileSync(join(d, ".claude", "CLAUDE.md"), "tracked rules");
  git("add", "-f", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  assert.equal(loadConventions(d, base), "root rules");
  writeFileSync(join(d, ".claude", "CLAUDE.md"), "edited on disk");
  assert.equal(loadConventions(d, base), "root rules");
  rmSync(d, { recursive: true, force: true });
});

test("an unresolvable ref fails closed: the disk copy is not trusted", () => {
  const d = mkdtempSync(join(tmpdir(), "conv-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
  mkdirSync(join(d, ".claude"));
  writeFileSync(join(d, ".claude", "CLAUDE.md"), "local rules");
  assert.equal(loadConventions(d, "no-such-ref"), "");
  rmSync(d, { recursive: true, force: true });
});

test("a symlinked .claude/CLAUDE.md is ignored and the committed root file is used", (t) => {
  const d = mkdtempSync(join(tmpdir(), "conv-"));
  const outside = join(mkdtempSync(join(tmpdir(), "conv-out-")), "secret.md");
  writeFileSync(outside, "secret");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, "CLAUDE.md"), "root rules");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  mkdirSync(join(d, ".claude"));
  try {
    symlinkSync(outside, join(d, ".claude", "CLAUDE.md"), "file");
  } catch {
    return t.skip("cannot create file symlinks here");
  }
  assert.equal(loadConventions(d, git("rev-parse", "HEAD")), "root rules");
});

test("a symlinked .claude directory is ignored and the committed root file is used", (t) => {
  const d = mkdtempSync(join(tmpdir(), "conv-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "conv-else-"));
  writeFileSync(join(elsewhere, "CLAUDE.md"), "planted rules");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, "CLAUDE.md"), "root rules");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  try {
    symlinkSync(elsewhere, join(d, ".claude"), "junction");
  } catch {
    return t.skip("cannot create symlinks here");
  }
  assert.equal(loadConventions(d, git("rev-parse", "HEAD")), "root rules");
});

test("a differently-cased or index-only .claude/CLAUDE.md is not trusted", () => {
  const d = mkdtempSync(join(tmpdir(), "conv-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, "CLAUDE.md"), "root rules");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  mkdirSync(join(d, ".claude"));
  writeFileSync(join(d, ".claude", "CLAUDE.md"), "staged rules");
  assert.equal(loadConventions(d, base), "staged rules");
  git("add", "-f", ".claude/CLAUDE.md");
  assert.equal(loadConventions(d, base), "root rules");
  git("commit", "-q", "-m", "rules");
  git("mv", ".claude/CLAUDE.md", ".claude/claude.md");
  git("commit", "-q", "-m", "case");
  assert.equal(loadConventions(d, git("rev-parse", "HEAD")), "root rules");
  rmSync(d, { recursive: true, force: true });
});

test("a bare node --test script is detected", () => {
  const d = mkdtempSync(join(tmpdir(), "conv-"));
  const at = (test: string) => (writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test } })), bareNodeTest(d));
  assert.equal(at("node --test"), true);
  assert.equal(at("node --test --test-concurrency"), true);
  assert.equal(at("node --test tests"), false);
  assert.equal(at("npm run x"), false);
  rmSync(d, { recursive: true, force: true });
});
