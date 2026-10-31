// Repo-fixture descartavel: um botao e um teste que nasce vermelho. Usado pelo tracer e pelos testes.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=f@x.local", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

export function criarFixture(raiz: string): string {
  const repo = join(raiz, "fixture");
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","type":"module","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(repo, "checkout.html"), "<button>Enviar</button>\n");
  writeFileSync(
    join(repo, "test/checkout.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { readFileSync } from "node:fs";\n' +
      'test("botao do checkout", () => assert.match(readFileSync("checkout.html", "utf8"), />Enviar pedido</));\n',
  );
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}
