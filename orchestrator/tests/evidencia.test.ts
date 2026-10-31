import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificarEvidencia } from "../src/guardrails.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd, encoding: "utf8" }).trim();

function repo() {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "package.json"), '{"scripts":{"test":"node -e 0"}}');
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  return { d, base: git(d, "rev-parse", "HEAD") };
}

test("sem commit novo a evidencia e rejeitada", () => {
  const { d, base } = repo();
  const r = verificarEvidencia(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
});

test("diff que toca package.json nao executa npm test no host", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "package.json"), '{"scripts":{"test":"node -e 1"}}');
  git(d, "commit", "-qam", "muda script");
  const r = verificarEvidencia(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { motivo: string }).motivo, /package\.json/);
});

test("commit valido com testes passando gera evidencia verificada", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "add a");
  const r = verificarEvidencia(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, true);
});
