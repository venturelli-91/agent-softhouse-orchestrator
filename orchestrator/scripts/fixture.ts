// Disposable fixture repo: a button and a test that starts out red. Used by the tracer and the tests.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=f@x.local", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

export function createFixture(root: string): string {
  const repo = join(root, "fixture");
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","type":"module","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(repo, "checkout.html"), "<button>Submit</button>\n");
  writeFileSync(
    join(repo, "test/checkout.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { readFileSync } from "node:fs";\n' +
      'test("checkout button", () => assert.match(readFileSync("checkout.html", "utf8"), />Submit order</));\n',
  );
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}
