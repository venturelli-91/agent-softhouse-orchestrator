// Local fast-forward merge for solo repos: real git over temp repos, no model.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, git } from "../scripts/fixture.ts";
import { repoOf } from "../src/guardrails.ts";
import { mergeLocal } from "../src/local-merge.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lm-"));
  roots.push(root);
  const repo = createFixture(root);
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "ticket/T-1", wt);
  writeFileSync(join(wt, "feature.txt"), "x\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "dev");
  return { repo, wt, sha: git(wt, "rev-parse", "HEAD") };
}

test("ff-merges main to the approved commit", () => {
  const { repo, sha } = setup();
  assert.match(mergeLocal(repo, "main", sha), /^merged:local@[0-9a-f]{7}$/);
  assert.equal(git(repo, "rev-parse", "main"), sha);
});

test("refuses when main has uncommitted changes", () => {
  const { repo, sha } = setup();
  writeFileSync(join(repo, "checkout.html"), "dirty\n");
  assert.throws(() => mergeLocal(repo, "main", sha), /uncommitted/);
  assert.notEqual(git(repo, "rev-parse", "main"), sha);
});

test("refuses when main moved past the base", () => {
  const { repo, sha } = setup();
  writeFileSync(join(repo, "other.txt"), "y\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main moved");
  const moved = git(repo, "rev-parse", "main");
  assert.throws(() => mergeLocal(repo, "main", sha), /diverged/);
  assert.equal(git(repo, "rev-parse", "main"), moved);
});

test("refuses when another branch is checked out", () => {
  const { repo, sha } = setup();
  git(repo, "checkout", "-q", "-b", "other");
  assert.throws(() => mergeLocal(repo, "main", sha), /branch/);
  assert.throws(() => mergeLocal(repo, "HEAD", sha), /branch/);
});

test("repoOf returns the main checkout from a worktree", () => {
  const { repo, wt } = setup();
  assert.equal(realpathSync(repoOf(wt)), realpathSync(repo));
});

test("refuses to overwrite an ignored file in the main checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "lm-"));
  roots.push(root);
  const repo = createFixture(root);
  writeFileSync(join(repo, ".gitignore"), "local.env\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "ignore");
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "ticket/T-1", wt);
  writeFileSync(join(wt, "local.env"), "from ticket\n");
  git(wt, "add", "-f", "local.env");
  git(wt, "commit", "-q", "-m", "dev");
  writeFileSync(join(repo, "local.env"), "precious\n");
  const base = git(repo, "rev-parse", "main");
  assert.throws(() => mergeLocal(repo, "main", git(wt, "rev-parse", "HEAD")));
  assert.equal(git(repo, "rev-parse", "main"), base);
  assert.equal(readFileSync(join(repo, "local.env"), "utf8"), "precious\n");
});
