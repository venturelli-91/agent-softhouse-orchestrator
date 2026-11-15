import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../scripts/fixture.ts";
import { safeGit } from "../src/git-safe.ts";

const repo = () => {
  const d = mkdtempSync(join(tmpdir(), "gq-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "a\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "base");
  return d;
};

test("a probe that fails by design writes nothing to the parent's stderr, and the error carries it", () => {
  const d = repo();
  const src = `import { safeGit } from ${JSON.stringify(new URL("../src/git-safe.ts", import.meta.url).href)};
    try { safeGit(${JSON.stringify(d)}, "rev-parse", "@{u}"); } catch {}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
  assert.throws(() => safeGit(d, "rev-parse", "@{u}"), /no upstream|fatal/i);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.stderr, "");
});

test("a 2 MiB diff does not throw ENOBUFS", () => {
  const d = repo();
  writeFileSync(join(d, "big.txt"), "x".repeat(2 * 1024 * 1024) + "\n");
  git(d, "add", "-A");
  const out = safeGit(d, "diff", "--cached", "--no-ext-diff");
  rmSync(d, { recursive: true, force: true });
  assert.ok(out.length > 2 * 1024 * 1024);
});

test("the dirty probe ignores untracked files and sees tracked changes", () => {
  const d = repo();
  const dirty = () => safeGit(d, "status", "--porcelain", "--untracked-files=no");
  writeFileSync(join(d, "new.txt"), "n\n");
  const untrackedOnly = dirty();
  writeFileSync(join(d, "a.txt"), "changed\n");
  const tracked = dirty();
  rmSync(d, { recursive: true, force: true });
  assert.equal(untrackedOnly, "");
  assert.match(tracked, /a\.txt/);
});
