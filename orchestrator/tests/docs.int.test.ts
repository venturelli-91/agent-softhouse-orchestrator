import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { coverage, DocsOutput, docsDir, docsMode, ensureLocalOnly, MAX_LINES, snapshot, TOPICS, writeDocs } from "../src/docs.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "docs-"));
  dirs.push(d);
  return d;
};
const out = (files: { path: string; content: string }[], not_applicable: { topic: string; reason: string }[] = []) =>
  DocsOutput.parse({ files, not_applicable });
const lines = (n: number, eol = "\n") => Array.from({ length: n }, (_, i) => `l${i}`).join(eol) + eol;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
process.on("exit", () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("writes a file and creates its parents", () => {
  const repo = tmp();
  const r = writeDocs(repo, out([{ path: "arquitetura/visao.md", content: "# Visao\n" }]), {}, tmp());
  assert.deepEqual(r.written, ["arquitetura/visao.md"]);
  assert.equal(readFileSync(join(docsDir(repo), "arquitetura", "visao.md"), "utf8"), "# Visao\n");
});

test("unsafe or unsupported paths are rejected and nothing is written", () => {
  const repo = tmp();
  for (const path of ["../x.md", "/abs.md", "C:\\x.md", "a/../../x.md", "a\\b.md", "x.txt", "README.md", "a/b/c/d/e.md"]) {
    const r = writeDocs(repo, out([{ path, content: "x\n" }]), {}, tmp());
    assert.deepEqual(r.written, [], path);
    assert.equal(r.warnings.length, 1, path);
  }
  assert.equal(existsSync(join(repo, ".claude", "x.md")), false);
});

test("a symlinked directory under docs is refused", (t) => {
  const repo = tmp();
  const outside = tmp();
  mkdirSync(docsDir(repo), { recursive: true });
  try {
    symlinkSync(outside, join(docsDir(repo), "link"), "junction");
  } catch {
    return t.skip("cannot create symlinks here");
  }
  const r = writeDocs(repo, out([{ path: "link/x.md", content: "x\n" }]), {}, tmp());
  assert.deepEqual(r.written, []);
  assert.equal(existsSync(join(outside, "x.md")), false);
});

test("150 lines pass (LF, CRLF, trailing newline) and 151 is rejected keeping the old file", () => {
  const repo = tmp();
  for (const eol of ["\n", "\r\n"]) assert.equal(writeDocs(repo, out([{ path: "a/ok.md", content: lines(MAX_LINES, eol) }]),
    { "a/ok.md": sha(readIfAny(repo, "a/ok.md")) }, tmp()).written.length, 1);
  const before = readFileSync(join(docsDir(repo), "a", "ok.md"), "utf8");
  const r = writeDocs(repo, out([{ path: "a/ok.md", content: lines(MAX_LINES + 1) }]), { "a/ok.md": sha(before) }, tmp());
  assert.deepEqual(r.written, []);
  assert.equal(r.warnings.length, 1);
  assert.equal(readFileSync(join(docsDir(repo), "a", "ok.md"), "utf8"), before);
});
const readIfAny = (repo: string, p: string) => (existsSync(join(docsDir(repo), p)) ? readFileSync(join(docsDir(repo), p), "utf8") : "");

test("too many files or too many bytes write nothing", () => {
  const repo = tmp();
  assert.throws(() => out(Array.from({ length: 41 }, (_, i) => ({ path: `a/${i}.md`, content: "x\n" }))));
  const big = "x".repeat(60_000);
  const r = writeDocs(repo, out(Array.from({ length: 4 }, (_, i) => ({ path: `a/${i}.md`, content: big }))), {}, tmp());
  assert.deepEqual(r.written, []);
  assert.equal(r.warnings.length, 1);
});

test("a file changed on disk since the agent saw it is skipped, the others are written", () => {
  const repo = tmp();
  mkdirSync(join(docsDir(repo), "a"), { recursive: true });
  writeFileSync(join(docsDir(repo), "a", "mine.md"), "hand edited\n");
  writeFileSync(join(docsDir(repo), "a", "unseen.md"), "never shown\n");
  const r = writeDocs(repo, out([
    { path: "a/mine.md", content: "agent\n" }, { path: "a/unseen.md", content: "agent\n" }, { path: "a/new.md", content: "agent\n" },
  ]), { "a/mine.md": sha("older version\n") }, tmp());
  assert.deepEqual(r.written, ["a/new.md"]);
  assert.equal(r.warnings.length, 2);
  assert.equal(readFileSync(join(docsDir(repo), "a", "mine.md"), "utf8"), "hand edited\n");
});

test("not-applicable entries persist and coverage reports what is missing", () => {
  const repo = tmp();
  assert.equal(coverage(repo).length, TOPICS.length);
  writeDocs(repo, out([{ path: "arquitetura/a.md", content: "x\n" }], [{ topic: "backlog", reason: "no backlog yet" }]), {}, tmp());
  writeDocs(repo, out([{ path: "testes/a.md", content: "x\n" }], [{ topic: "checklist", reason: "single ticket" }]), {}, tmp());
  assert.deepEqual(coverage(repo).sort(), TOPICS.filter((x) => !["arquitetura", "backlog", "testes",
    "checklist"].includes(x)).map((x) => expectWarn(x)).sort());
  for (const topic of TOPICS) writeDocs(repo, out([], [{ topic, reason: "not relevant here" }]), {}, tmp());
  assert.deepEqual(coverage(repo), []);
});
const expectWarn = (topic: string) => coverage(tmp()).find((w) => w.includes(`"${topic}"`))!;

test("the README index is written by code and stays within the line limit", () => {
  const repo = tmp();
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `d${i}/f.md`, content: `# T${i}\n` }));
  writeDocs(repo, out(files.slice(0, 30)), {}, tmp());
  mkdirSync(join(docsDir(repo), "big"), { recursive: true });
  for (let i = 0; i < 400; i++) writeFileSync(join(docsDir(repo), "big", `f${i}.md`), `# F${i}\n`);
  writeDocs(repo, out([], [{ topic: "backlog", reason: "no backlog yet" }]), {}, tmp());
  const idx = readFileSync(join(docsDir(repo), "README.md"), "utf8");
  assert.ok(idx.split("\n").length <= MAX_LINES);
  assert.match(idx, /big/);
  assert.match(idx, /no backlog yet/);
});

test("snapshot shows contents up to the cap and lists the rest in the index only", () => {
  const repo = tmp();
  mkdirSync(join(docsDir(repo), "a"), { recursive: true });
  writeFileSync(join(docsDir(repo), "a", "one.md"), "# One\nbody\n");
  writeFileSync(join(docsDir(repo), "a", "two.md"), `# Two\n${"y".repeat(500)}\n`);
  const s = snapshot(repo, 100);
  assert.deepEqual(Object.keys(s.shown), ["a/one.md"]);
  assert.equal(s.seen["a/one.md"], sha("# One\nbody\n"));
  assert.match(s.index, /a\/one\.md.*One/);
  assert.match(s.index, /a\/two\.md.*Two/);
});

test("snapshot leaves out a file directly under docs, which writeDocs would reject", () => {
  const repo = tmp();
  mkdirSync(join(docsDir(repo), "a"), { recursive: true });
  writeFileSync(join(docsDir(repo), "09-backlog.md"), "# Flat\n");
  writeFileSync(join(docsDir(repo), "a", "one.md"), "# One\n");
  const s = snapshot(repo);
  assert.deepEqual(Object.keys(s.shown), ["a/one.md"]);
  assert.doesNotMatch(s.index, /09-backlog/);
});

const gitRepo = (files: Record<string, string> = {}) => {
  const d = tmp();
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "base");
  return { d, git };
};

test("ensureLocalOnly makes git ignore .claude without touching .gitignore", () => {
  const { d, git } = gitRepo({ "a.txt": "a" });
  assert.equal(ensureLocalOnly(d), null);
  assert.equal(existsSync(docsDir(d)), true);
  writeFileSync(join(docsDir(d), "x.md"), "x\n");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(existsSync(join(d, ".gitignore")), false);
});

test("ensureLocalOnly warns when the repo un-ignores .claude, and does not duplicate the exclude line", () => {
  const { d } = gitRepo({ ".gitignore": "!.claude/\n" });
  const w = ensureLocalOnly(d);
  assert.match(w ?? "", /not ignored/);
  ensureLocalOnly(d);
  const exclude = readFileSync(join(d, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((l) => l === ".claude/").length, 1);
});

test("docsMode: update when docs exist, greenfield without code, scan with code", () => {
  const empty = gitRepo({ ".gitignore": "x\n", "README.md": "r", "orchestrator/x": "x", ".orchestrator.json": "{}" });
  assert.equal(docsMode(empty.d), "greenfield");
  const code = gitRepo({ "src/a.ts": "export {}" });
  assert.equal(docsMode(code.d), "scan");
  mkdirSync(join(docsDir(code.d), "arquitetura"), { recursive: true });
  writeFileSync(join(docsDir(code.d), "arquitetura", "a.md"), "x\n");
  assert.equal(docsMode(code.d), "update");
});

test("a symlinked docs directory is never written through, not even by the index", (t) => {
  const repo = tmp();
  const outside = tmp();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  try {
    symlinkSync(outside, docsDir(repo), "junction");
  } catch {
    return t.skip("cannot create symlinks here");
  }
  const r = writeDocs(repo, out([], [{ topic: "backlog", reason: "no backlog yet" }]), {}, tmp());
  assert.equal(r.warnings.length, 1);
  assert.equal(existsSync(join(outside, "README.md")), false);
  assert.equal(existsSync(join(outside, ".nao-se-aplica.json")), false);
});

test("snapshot does not read through a symlinked file", (t) => {
  const repo = tmp();
  const secret = join(tmp(), "secret.md");
  writeFileSync(secret, "# secret\n");
  mkdirSync(join(docsDir(repo), "a"), { recursive: true });
  try {
    symlinkSync(secret, join(docsDir(repo), "a", "leak.md"), "file");
  } catch {
    return t.skip("cannot create file symlinks here");
  }
  assert.deepEqual(Object.keys(snapshot(repo).shown), []);
});
