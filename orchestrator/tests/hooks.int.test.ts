import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

function repo(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "hk-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d });
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(require(\'fs\').existsSync(\'red\')?1:0)"' } }));
  git("add", "-A");
  git("commit", "-qm", "base");
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  return d;
}

test("verify hook: logic without a test or with a red suite blocks the stop; a second stop only warns", () => {
  const cases = {
    docs: repo({ "README.md": "x" }),
    untested: repo({ "src/a.ts": "x" }),
    red: repo({ "src/a.ts": "x", "tests/a.test.ts": "x", red: "" }),
    green: repo({ "src/a.ts": "x", "tests/a.test.ts": "x" }),
  };
  const out = Object.fromEntries(Object.entries(cases).map(([k, d]) => [k, hook("verify.mjs", d, {}).stdout]));
  const again = JSON.parse(hook("verify.mjs", cases.untested, { stop_hook_active: true }).stdout);
  Object.values(cases).forEach((d) => rmSync(d, { recursive: true, force: true }));
  assert.equal(out.docs, "");
  assert.match(JSON.parse(out.untested).reason, /without a test \(src\/a\.ts\)/);
  assert.match(JSON.parse(out.red).reason, /npm test failed/);
  assert.equal(out.green, "");
  assert.ok(!("decision" in again) && /without a test/.test(again.systemMessage));
});

test("verify hook takes the test command from the base commit and refuses a test script the session changed", () => {
  const d = repo({ "src/a.ts": "x", "tests/a.test.ts": "x" });
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('pwned','')\"" } }));
  const out = JSON.parse(hook("verify.mjs", d, {}).stdout);
  const ran = existsSync(join(d, "pwned"));
  rmSync(d, { recursive: true, force: true });
  assert.ok(!("decision" in out) && /test script changed/.test(out.systemMessage));
  assert.equal(ran, false);
});
