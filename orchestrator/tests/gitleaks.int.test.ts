// The secrets stage: suppression rule and routing with a stubbed scanner, absent-binary skip, and one run against the real gitleaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createFixture, git } from "../scripts/fixture.ts";
import { gitConfigHash } from "../src/guardrails.ts";
import { realScan, secrets, setScanRunner } from "../src/gitleaks.ts";
import { Ticket } from "../src/ticket.ts";
import { InfraError } from "../src/webcheck.ts";
import { answer, knobs, paused, roots, start } from "./helpers/graph-harness.ts";

const CLEAN = async () => [];
// Built at runtime so this file never holds a token-shaped literal.
const TOKEN = ["ghp", "R4nd0mT0k3nV4lu3Abcdefgh1234567890XY"].join("_");

function ticket(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "sc-"));
  roots.push(root);
  const repo = createFixture(root);
  const base = git(repo, "rev-parse", "HEAD");
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), c);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "dev");
  return Ticket.parse({ id: "T-1", request: "p", status: "review", worktree: repo, repo, base, git_config_hash: gitConfigHash(repo) });
}

const hasGitleaks = (() => {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("a dev-written ignore file or config is a finding", async () => {
  setScanRunner(CLEAN);
  const ti = ticket({ "sub/.gitleaksignore": "abc:src/k.js:github-pat:2\n" });
  const ignore = await secrets(ti);
  assert.equal(ignore.status, "dev_failed");
  assert.ok(String(ignore.summary).includes(`git reset --soft ${ti.base}`));
  assert.match(String(ignore.summary), /sub\/\.gitleaksignore/);
  const toml = await secrets(ticket({ ".gitleaks.toml": "[allowlist]\npaths = ['.*']\n" }));
  assert.match(String(toml.summary), /\.gitleaks\.toml/);
  assert.match(toml.rejections!.join(), /^secrets: /);
  const clean = await secrets(ticket({ "src/a.js": "const a = 1;\n" }));
  assert.equal(clean.status, "review");
  const t = ticket({ "src/a.js": "const a = 1;\n" });
  writeFileSync(join(t.worktree, ".gitleaksignore"), "abc:src/k.js:github-pat:2\n");
  const untracked = await secrets(t);
  assert.equal(untracked.status, "dev_failed");
  assert.match(String(untracked.summary), /\.gitleaksignore/);
});

test("without gitleaks on PATH the real scanner is an infrastructure error and the stage passes with a docs warning", async () => {
  const path = process.env.PATH;
  const empty = mkdtempSync(join(tmpdir(), "nopath-"));
  roots.push(empty);
  process.env.PATH = empty;
  try {
    await assert.rejects(realScan(empty, "HEAD", ""), (e: Error) => e instanceof InfraError && /gitleaks not found/.test(e.message));
  } finally {
    process.env.PATH = path;
  }
  setScanRunner(async () => { throw new InfraError("gitleaks not found"); });
  const out = await secrets(ticket({ "src/a.js": "const a = 1;\n" }));
  assert.equal(out.status, "review");
  assert.match(out.docs_warnings!.join(), /secrets skipped: gitleaks not found/);
});

test("the scan covers the commit the docs node adds", async () => {
  const seen: string[] = [];
  setScanRunner(async (wt) => (seen.push(git(wt, "log", "-1", "--format=%s")), []));
  try {
    knobs.override.docs = (req) => ({ files: /Phase: pre/.test(req.context) ? [{ path: "README.md", content: "# Fixture\n" }] : [], notes: "" });
    const g = await start("T-1", new MemorySaver(), { project_docs: ["README.md"] });
    assert.equal(paused(g.r)?.type, "approval");
    assert.deepEqual(seen, ["docs: update README.md"]);
  } finally {
    setScanRunner(CLEAN);
  }
});

test("a finding sends the ticket back to the dev before review; a scanner crash escalates and retry re-runs the stage", async () => {
  let n = 0;
  setScanRunner(async () => (n++ === 0 ? ["checkout.html:2 (github-pat)"] : []));
  try {
    const g = await start("T-2", new MemorySaver());
    assert.equal(paused(g.r)?.type, "approval");
    assert.equal(g.r.revisions, 1);
    assert.match(g.r.rejections.join(), /secrets: [^]*checkout\.html:2 \(github-pat\)/);
    assert.equal(knobs.calls.filter((c) => c === "dev").length, 2);
    const nodes = g.r.history.map((h: { node: string }) => h.node);
    assert.ok(nodes.indexOf("secrets") < nodes.indexOf("reviewer"));
    n = 0;
    knobs.calls = [];
    setScanRunner(async () => { if (n++ === 0) throw new Error("boom"); return []; });
    const c = await start("T-3", new MemorySaver());
    assert.equal(paused(c.r)?.type, "escalation");
    assert.match(String(c.r.summary), /^secrets: /);
    const r = await answer(c, "retry");
    assert.equal(paused(r)?.type, "approval");
    assert.equal(knobs.calls.filter((x) => x === "dev").length, 1);
  } finally {
    setScanRunner(CLEAN);
  }
});

test("the real gitleaks flags a committed token by file and line without the value reaching the state", { skip: !hasGitleaks && "gitleaks not on PATH" }, async () => {
  setScanRunner(realScan);
  try {
    const t = ticket({ "src/k.js": `const a = 1;\nconst t = "${TOKEN}";\n` });
    const out = await secrets(t);
    assert.equal(out.status, "dev_failed");
    assert.match(String(out.summary), /src\/k\.js:2 \(github-pat\)/);
    assert.equal(JSON.stringify(out).includes(TOKEN), false);
    assert.equal(JSON.stringify(out).includes(TOKEN.slice(4, 20)), false);
    assert.equal(git(t.worktree, "status", "--porcelain"), "");
    assert.equal((await secrets(ticket({ "src/a.js": "const a = 1;\n" }))).status, "review");
    const allowAll = "[allowlist]\npaths = ['''.*''']\n";
    writeFileSync(join(t.worktree, ".gitleaks.toml"), allowAll);
    process.env.GITLEAKS_CONFIG_TOML = allowAll;
    assert.match(String((await secrets(t)).summary), /src\/k\.js:2 \(github-pat\)/);
  } finally {
    delete process.env.GITLEAKS_CONFIG_TOML;
    setScanRunner(CLEAN);
  }
});

test("neither a .gitattributes that marks files as binary nor a gitleaks:allow comment hides a committed token", { skip: !hasGitleaks && "gitleaks not on PATH" }, async () => {
  setScanRunner(realScan);
  try {
    const out = await secrets(ticket({ ".gitattributes": "* -diff\n", "src/k.js": `const a = 1;\nconst t = "${TOKEN}"; // gitleaks:allow\n` }));
    assert.equal(out.status, "dev_failed");
    assert.match(String(out.summary), /src\/k\.js:2 \(github-pat\)/);
  } finally {
    setScanRunner(CLEAN);
  }
});
