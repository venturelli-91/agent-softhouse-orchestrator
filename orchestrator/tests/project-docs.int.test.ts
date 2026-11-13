// project_docs: the docs node updates the repo's tracked docs on the ticket's branch, before review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../scripts/fixture.ts";
import { knobs, paused, start } from "./helpers/graph-harness.ts";

const pre = (req: { context: string }) => /Phase: pre/.test(req.context);
const docs = (files: { path: string; content: string }[]) => (req: { context: string }) => ({ files: pre(req) ? files : [], not_applicable: [], notes: "" });
const preCalls = () => knobs.docsContexts.filter((c) => /Phase: pre/.test(c));
const warnings = (r: unknown) => ((r as { docs_warnings: string[] }).docs_warnings).filter((w) => w.startsWith("pre: "));
const wt = (r: unknown) => (r as { worktree: string }).worktree;

test("a listed project doc is updated and committed on the ticket branch before review, and the ticket reaches approval", async () => {
  knobs.override.docs = docs([{ path: "README.md", content: "# Fixture\n\n1 test\n" }]);
  const g = await start("T-1", undefined, { project_docs: ["README.md"] });
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(readFileSync(join(wt(g.r), "README.md"), "utf8"), "# Fixture\n\n1 test\n");
  assert.equal(git(wt(g.r), "log", "-1", "--format=%s"), "docs: update README.md");
  assert.equal(git(wt(g.r), "status", "--porcelain"), "");
  assert.equal(preCalls().length, 1);
  assert.match(preCalls()[0], /### README\.md\n\(missing: you may create it\)/);
  assert.ok(knobs.calls.indexOf("reviewer") >= 0);
  assert.ok((g.r.history as { node: string; result: string }[]).some((h) => h.node === "docs" && h.result === "pre: 1 file(s) committed"));
  assert.deepEqual(warnings(g.r), []);
});

test("a path outside project_docs, a secret or protected path are refused, and a missing directory is created", async () => {
  knobs.override.docs = docs([
    { path: "OTHER.md", content: "x\n" },
    { path: "../escape.md", content: "x\n" },
    { path: ".env.md", content: "x\n" },
    { path: "orchestrator/NOTES.md", content: "x\n" },
    { path: "docs/new/NOTES.md", content: "kept\n" },
  ]);
  const g = await start("T-1", undefined, { project_docs: ["README.md", ".env.md", "orchestrator/NOTES.md", "docs/new/NOTES.md"] });
  assert.equal(paused(g.r)?.type, "approval");
  assert.deepEqual(warnings(g.r), [
    "pre: OTHER.md: not in project_docs", "pre: ../escape.md: not in project_docs", "pre: .env.md: secret path", "pre: orchestrator/NOTES.md: protected path",
  ]);
  assert.equal(readFileSync(join(wt(g.r), "docs", "new", "NOTES.md"), "utf8"), "kept\n");
  assert.ok(!existsSync(join(wt(g.r), "OTHER.md")));
  assert.notEqual(git(wt(g.r), "log", "-1", "--format=%s"), "docs: update README.md");
});

test("a symlinked project doc is refused and nothing escapes the worktree", async (t) => {
  knobs.afterFixture = (repo) => {
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "outside.md"), "secret\n");
    try {
      symlinkSync(join(repo, "outside.md"), join(repo, "docs", "link.md"));
    } catch {
      return;
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "link");
  };
  knobs.override.docs = docs([{ path: "docs/link.md", content: "overwritten\n" }]);
  const g = await start("T-1", undefined, { project_docs: ["docs/link.md"] });
  if (!lstatSync(join(wt(g.r), "docs", "link.md"), { throwIfNoEntry: false })?.isSymbolicLink()) return t.skip("cannot create symlinks here");
  assert.match(warnings(g.r)[0], /docs\/link\.md: (symlink in path|not a regular file)/);
  assert.equal(readFileSync(join(wt(g.r), "outside.md"), "utf8"), "secret\n");
});

test("a failing docs agent only adds a pre warning and leaves the tree as the dev left it", async () => {
  knobs.override.docs = (req) => {
    if (pre(req)) throw new Error("boom");
    return { files: [], not_applicable: [], notes: "" };
  };
  const g = await start("T-1", undefined, { project_docs: ["README.md"] });
  assert.equal(paused(g.r)?.type, "approval");
  assert.deepEqual(warnings(g.r), ["pre: boom"]);
  assert.equal(git(wt(g.r), "status", "--porcelain"), "");
});

test("without project_docs the pre phase does not run", async () => {
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(preCalls().length, 0);
});

test("docs that would push the diff over the review limit are rolled back with a warning, and review still runs", async () => {
  knobs.override.docs = docs([{ path: "README.md", content: "x".repeat(150_000) }]);
  const g = await start("T-1", undefined, { project_docs: ["README.md"] });
  assert.equal(paused(g.r)?.type, "approval");
  assert.match(warnings(g.r)[0], /^pre: the docs push the diff over the review limit/);
  assert.equal(git(wt(g.r), "status", "--porcelain"), "");
  assert.ok(!existsSync(join(wt(g.r), "README.md")));
});
