import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { envMinimo, PERMISSOES, SHELL } from "../src/guardrails.ts";
import { argsClaude, carregarPrompt } from "../src/run-agent.ts";

const schema = z.object({ ok: z.boolean() });
const env = { MODEL_DEFAULT: "m-x", EFFORT_DEFAULT: "medium", TURNOS_DEFAULT: "8", TURNOS_QA: "4", MODEL_QA: "m-qa" };
const arg = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

test("papeis de revisao sao somente leitura", () => {
  for (const p of ["reviewer", "qa", "triagem"] as const) {
    const a = argsClaude({ papel: p, schema }, "sys", env);
    assert.equal(arg(a, "--tools"), "Read,Grep,Glob");
    assert.ok(!PERMISSOES[p].allow.some((t) => /Write|Edit|Bash/.test(t)));
  }
});

test("dev nao tem git push, rm -r nem leitura de .env", () => {
  const a = argsClaude({ papel: "dev", schema }, "sys", env);
  const negadas = a.slice(a.indexOf("--disallowedTools") + 1);
  for (const t of [`${SHELL}(git push*)`, `${SHELL}(rm *)`, "Read(**/.env*)", "Write(**/.git/**)", `${SHELL}(npx*)`, "Read(~/.ssh/**)"]) assert.ok(negadas.includes(t), t);
  assert.ok(!PERMISSOES.dev.allow.some((t) => t.includes("push")));
});

test("modelo, esforco e turnos vem so do ambiente; override por papel", () => {
  const a = argsClaude({ papel: "qa", schema }, "sys", env);
  assert.equal(arg(a, "--model"), "m-qa");
  assert.equal(arg(a, "--max-turns"), "5");
  assert.equal(arg(argsClaude({ papel: "dev", schema }, "sys", env), "--model"), "m-x");
  assert.throws(() => argsClaude({ papel: "dev", schema }, "sys", {}), /env ausente/);
});

test("nenhum nome de modelo no codigo", () => {
  for (const f of readdirSync("src")) assert.doesNotMatch(readFileSync(`src/${f}`, "utf8"), /claude-(opus|sonnet|haiku|fable)|sonnet|haiku|opus/i, f);
});

test("env do subprocesso nao vaza credenciais e da identidade ao git", () => {
  const e = envMinimo("dev", { PATH: "/bin", ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "x", GITHUB_TOKEN: "x" });
  assert.deepEqual(Object.keys(e).filter((k) => /ANTHROPIC|TOKEN|API_KEY/.test(k)), []);
  assert.equal(e.GIT_AUTHOR_NAME, "agente-dev");
  assert.equal(e.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(e.GIT_CONFIG_KEY_0, "core.hooksPath");
  assert.ok(!PERMISSOES.dev.allow.includes(`${SHELL}(npm *)`));
  assert.notEqual(e.GIT_CONFIG_GLOBAL, "\\.\nul");
  assert.ok(!PERMISSOES.dev.allow.includes("Write") && PERMISSOES.dev.allow.includes("Write(./**)"));
});

test("carregarPrompt remove o frontmatter e concatena", () => {
  const p = carregarPrompt(["triagem"], "../.claude/agents");
  assert.match(p, /^Você é a Triagem/);
  assert.doesNotMatch(p, /^name:/m);
});
