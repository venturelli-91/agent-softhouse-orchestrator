import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { minimalEnv, PERMISSIONS, SHELL } from "../src/guardrails.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, loadPrompt, NodeFailure, parseOutput, TransientFailure, withRetry } from "../src/run-agent.ts";

const schema = z.object({ ok: z.boolean() });
const env = { MODEL_DEFAULT: "m-x", EFFORT_DEFAULT: "medium", TURNS_DEFAULT: "8", TURNS_QA: "4", MODEL_QA: "m-qa" };
const arg = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

test("review roles are read-only", () => {
  for (const p of ["reviewer", "qa", "triage"] as const) {
    const a = claudeArgs({ role: p, schema }, "sys", env);
    assert.equal(arg(a, "--tools"), "Read,Grep,Glob");
    assert.ok(!PERMISSIONS[p].allow.some((t) => /Write|Edit|Bash/.test(t)));
  }
});

test("dev has no git push, rm -r or .env reading", () => {
  const a = claudeArgs({ role: "dev", schema }, "sys", env);
  const denied = a.slice(a.indexOf("--disallowedTools") + 1);
  for (const t of [`${SHELL}(git push*)`, `${SHELL}(rm *)`, "Read(**/.env*)", "Write(**/.git/**)", `${SHELL}(npx*)`,
    "Read(~/.ssh/**)"]) assert.ok(denied.includes(t), t);
  assert.ok(!PERMISSIONS.dev.allow.some((t) => t.includes("push")));
});

test("model, effort and turns come only from the environment; per-role override", () => {
  const a = claudeArgs({ role: "qa", schema }, "sys", env);
  assert.equal(arg(a, "--model"), "m-qa");
  assert.equal(arg(a, "--max-turns"), "5");
  assert.equal(arg(claudeArgs({ role: "dev", schema }, "sys", env), "--model"), "m-x");
  assert.throws(() => claudeArgs({ role: "dev", schema }, "sys", {}), /missing env/);
});

test("no model name in the code", () => {
  for (const f of readdirSync("src")) assert.doesNotMatch(readFileSync(`src/${f}`, "utf8"), /claude-(opus|sonnet|haiku|fable)|sonnet|haiku|opus/i, f);
});

test("NODE_ENV never reaches the subprocess, so the build agrees with CI", () => {
  assert.equal(minimalEnv("dev", { PATH: "/bin", NODE_ENV: "development" }).NODE_ENV, undefined);
});

test("the subprocess env does not leak credentials and gives git an identity", () => {
  const e = minimalEnv("dev", { PATH: "/bin", ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "x", GITHUB_TOKEN: "x" });
  assert.deepEqual(Object.keys(e).filter((k) => /ANTHROPIC|TOKEN|API_KEY/.test(k)), []);
  assert.equal(e.GIT_AUTHOR_NAME, "agent-dev");
  assert.equal(e.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(e.GIT_CONFIG_KEY_0, "core.hooksPath");
  assert.ok(!PERMISSIONS.dev.allow.includes(`${SHELL}(npm *)`));
  assert.ok(!e.GIT_CONFIG_GLOBAL?.startsWith("\\\\"));
  assert.ok(!PERMISSIONS.dev.allow.includes("Write") && PERMISSIONS.dev.allow.includes("Write(./**)"));
});

test("loadPrompt strips the frontmatter and concatenates", () => {
  const dir = mkdtempSync(join(tmpdir(), "ag-"));
  writeFileSync(join(dir, "a.md"), "---\nname: a\ntools: Read\n---\nYou are A.\n");
  writeFileSync(join(dir, "b.md"), "You are B.\n");
  const p = loadPrompt(["a", "b"], dir);
  assert.match(p, /^You are A\./);
  assert.doesNotMatch(p, /^name:/m);
  assert.match(p, /You are B\./);
});

test("loadPrompt rejects pointer stubs but loads real prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ag-"));
  writeFileSync(join(dir, "dev.md"), "---\nname: dev\n---\nLeia orchestrator/agents/dev.md e siga.\n");
  writeFileSync(join(dir, "real.md"), "You are real.\n");
  assert.throws(() => loadPrompt(["dev"], dir), (e) => e instanceof NodeFailure && e.message.startsWith("AGENTS_DIR=") && e.message.includes(dir));
  assert.equal(loadPrompt(["real"], dir), "You are real.");
});

test("needPrompts dies with the one-line stub message before any side effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ag-"));
  writeFileSync(join(dir, "triage.md"), "Leia orchestrator/agents/triage.md e siga.\n");
  process.env.AGENTS_DIR = dir;
  process.env.ORCH_HOME = join(dir, "home");
  const { makeCtx } = await import("../scripts/orch/ctx.ts");
  const { exit, error } = { exit: process.exit, error: console.error };
  const seen: string[] = [];
  console.error = (m: string) => void seen.push(m);
  process.exit = ((code: number) => { throw new Error(`exit ${code}`); }) as never;
  try {
    assert.throws(() => makeCtx([], dir).needPrompts(), /exit 1/);
  } finally {
    process.exit = exit;
    console.error = error;
    delete process.env.AGENTS_DIR;
    delete process.env.ORCH_HOME;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^AGENTS_DIR=.* holds pointer stubs/);
});

const ok = { is_error: false, subtype: "success", structured_output: { ok: true }, num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 1,
  output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } };

test("valid output becomes a result with usage", () => {
  const r = parseOutput("qa", JSON.stringify(ok), schema, 5);
  assert.deepEqual(r.output, { ok: true });
  assert.equal(r.usage.cache_create, 4);
});

test("invalid output, turn limit, error and garbage are failures", () => {
  const fails = (o: unknown) => assert.throws(() => parseOutput("qa", typeof o === "string" ? o : JSON.stringify(o), schema, 1), NodeFailure);
  fails({ ...ok, structured_output: { ok: "no" } });
  fails({ ...ok, subtype: "error_max_turns", terminal_reason: "max_turns" });
  fails({ ...ok, is_error: true });
  fails("this is not json");
});

test("an API error is transient and retried; a usage limit or a turn limit is not", async () => {
  const kind = (o: unknown) => { try { parseOutput("dev", JSON.stringify(o), schema, 1); } catch (e) { return (e as Error).constructor.name; } };
  assert.equal(kind({ ...ok, is_error: true, terminal_reason: "api_error" }), "TransientFailure");
  assert.equal(kind({ ...ok, is_error: true, terminal_reason: "api_error", result: "You've hit your 5-hour limit" }), "NodeFailure");
  assert.equal(kind({ ...ok, subtype: "error_max_turns", terminal_reason: "max_turns" }), "NodeFailure");

  let tries = 0;
  const flaky = async () => { if (++tries < 3) throw new TransientFailure("busy"); return "done"; };
  assert.equal(await withRetry(flaky, [0, 0]), "done");
  tries = 0;
  await assert.rejects(withRetry(flaky, [0]), TransientFailure);
  tries = 0;
  await assert.rejects(withRetry(async () => { tries++; throw new NodeFailure("no"); }, [0, 0]), NodeFailure);
  assert.equal(tries, 1);
});

test("a run that hit the turn limit still reports what it spent", () => {
  try {
    parseOutput("dev", JSON.stringify({ ...ok, subtype: "error_max_turns", terminal_reason: "max_turns", num_turns: 16 }), schema, 7);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof NodeFailure);
    assert.equal(e.usage?.turns, 16);
    assert.equal(e.usage?.cache_read, 3);
    assert.equal(e.usage?.ms, 7);
  }
});

test("the docs role is read-only, keeps the secrets deny list, and its prompt carries the rules", () => {
  const args = claudeArgs({ role: "docs", schema }, "sys", env);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.ok(!PERMISSIONS.docs.tools.some((t) => t === "Write" || t === "Edit"));
  assert.ok(PERMISSIONS.docs.deny.includes("Read(**/.env*)"));
  const prompt = loadPrompt(["docs"], join(import.meta.dirname, "..", "agents"));
  for (const word of ["150", "CLAUDE.md", "not_applicable", "arquitetura", "backlog", "checklist", "design-patterns", "features", "testes",
    "trade-offs", "comunicacao", "aprendizados"])
    assert.ok(prompt.includes(word), word);
});
