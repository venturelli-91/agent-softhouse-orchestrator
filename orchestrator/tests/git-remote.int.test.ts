import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { behindBy, deleteRemoteBranch } from "../src/git-remote.ts";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
const tmp = () => mkdtempSync(join(tmpdir(), "gremote-"));

function setup() {
  const root = tmp();
  const bare = join(root, "bare.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const a = join(root, "a");
  git(root, "clone", "-q", bare, a);
  git(a, "checkout", "-q", "-b", "main");
  git(a, "commit", "-q", "--allow-empty", "-m", "one");
  git(a, "push", "-q", "-u", "origin", "main");
  return { root, bare, a };
}

test("behindBy is 0, then 2 after another clone pushes", () => {
  const { root, bare, a } = setup();
  assert.equal(behindBy(a), 0);
  const b = join(root, "b");
  git(root, "clone", "-q", bare, b);
  git(b, "commit", "-q", "--allow-empty", "-m", "two");
  git(b, "commit", "-q", "--allow-empty", "-m", "three");
  git(b, "push", "-q");
  assert.equal(behindBy(a), 2);
});

test("behindBy is null with no upstream", () => {
  const dir = tmp();
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  assert.equal(behindBy(dir), null);
});

test("deleteRemoteBranch deletes an existing branch and then reports absent", () => {
  const { a } = setup();
  git(a, "push", "-q", "origin", "HEAD:refs/heads/ticket/T-1");
  assert.equal(deleteRemoteBranch(a, "origin", "T-1"), "deleted");
  assert.equal(deleteRemoteBranch(a, "origin", "T-1"), "absent");
});
