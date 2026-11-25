import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOKS = resolve(import.meta.dirname, "..", "..", ".claude", "hooks");
const hook = (name: string, root: string, input: object) =>
  spawnSync(process.execPath, [join(HOOKS, name)], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

test("guard hook blocks secrets, git internals and its own files, also behind Win32 spellings; lets source files through", () => {
  const root = mkdtempSync(join(tmpdir(), "hk-"));
  const run = (file_path: string) => hook("guard.mjs", root, { tool_name: "Edit", tool_input: { file_path } }).status;
  const r = {
    env: run(".env.local"), key: run(join(root, "certs", "a.pem")), git: run(".git/hooks/pre-commit"),
    self: run(".claude/hooks/verify.mjs"), settings: run(".claude/settings.local.json"),
    dots: run(".env. "), stream: run(".git:x/config"), src: run("src/a.ts"),
    user: run(join(tmpdir(), "home", ".claude", "settings.json")), device: run(String.raw`\\?\C:\x\a.ts`), short: run("CLAUDE~1/hooks/x.mjs"),
  };
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(r, { env: 2, key: 2, git: 2, self: 2, settings: 2, dots: 2, stream: 2, src: 0, user: 2, device: 2, short: 2 });
});

test("verify hook reads only this session's edits: asks for a test and a test run after the last logic edit, ignores unmerged commits, never runs the suite", () => {
  const root = mkdtempSync(join(tmpdir(), "hk-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: root });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('ran','')"` } }));
  git("add", "-A");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/HEAD", "HEAD");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "old.ts"), "x");
  git("add", "-A");
  git("commit", "-qm", "unmerged logic from an earlier session");
  const edit = (...p: string[]) => ({ name: "Edit", input: { file_path: join(root, ...p) } });
  const bash = (command: string) => ({ name: "Bash", input: { command } });
  let clock = 0;
  const lines = (uses: object[]) =>
    uses.map((u) => JSON.stringify({ type: "assistant", timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString(), message: { content: [{ type: "tool_use", ...u }] } }));
  // Subagent tool calls live in <transcript>/subagents/agent-*.jsonl; they are stamped after the main ones unless subFirst.
  const run = (name: string, uses: object[], sub: object[] = [], extra = {}, subFirst = false) => {
    const transcript_path = join(root, `${name}.jsonl`);
    const early = subFirst ? lines(sub) : [];
    writeFileSync(transcript_path, [JSON.stringify({ type: "user", message: { content: "say tool_use" } }), ...lines(uses)].join("\n"));
    if (sub.length) {
      mkdirSync(join(root, name, "subagents"), { recursive: true });
      writeFileSync(join(root, name, "subagents", "agent-1.jsonl"), (subFirst ? early : lines(sub)).join("\n"));
    }
    return hook("verify.mjs", root, { transcript_path, ...extra }).stdout;
  };
  const spec = edit("tests", "a.test.ts");
  const out = {
    none: run("none", [bash("git log")]),
    read: run("read", [{ name: "Read", input: { file_path: join(root, "src", "old.ts") } }]),
    outside: run("outside", [edit("..", "other-repo", "src", "x.ts")]),
    docs: run("docs", [edit("README.md")]),
    untested: run("untested", [edit("src", "ação €.ts")]),
    tested: run("tested", [edit("src", "a.ts"), spec]),
    ran: run("ran", [edit("src", "a.ts"), spec, bash("cd x && make test")]),
    editedAfterRun: run("after", [spec, bash("docker compose run --rm api pytest"), edit("src", "a.ts")]),
    subUntested: run("sub-untested", [{ name: "Agent", input: { prompt: "x" } }], [edit("src", "a.ts")]),
    subRan: run("sub-ran", [], [edit("src", "a.ts"), spec, bash("npm test")]),
    subThenMainRan: run("sub-main", [bash("npm test")], [edit("src", "a.ts"), spec], {}, true),
    again: run("again", [edit("src", "a.ts")], [], { stop_hook_active: true }),
  };
  const ran = existsSync(join(root, "ran"));
  rmSync(root, { recursive: true, force: true });
  assert.equal(out.none, "");
  assert.equal(out.read, "");
  assert.equal(out.outside, "");
  assert.equal(out.docs, "");
  assert.match(JSON.parse(out.subUntested).reason, /without a test \(src\/a\.ts\)/);
  assert.equal(out.subRan, "");
  assert.equal(out.subThenMainRan, "");
  assert.match(JSON.parse(out.untested).reason, /without a test \(src\/ação €\.ts\)/);
  assert.match(JSON.parse(out.tested).reason, /run the repo's test command with Bash/);
  assert.equal(out.ran, "");
  assert.match(JSON.parse(out.editedAfterRun).reason, /run the repo's test command with Bash/);
  assert.equal(out.again, "");
  assert.equal(ran, false);
});
