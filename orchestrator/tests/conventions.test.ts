import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
