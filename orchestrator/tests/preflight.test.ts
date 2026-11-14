import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv } from "../src/agent-env.ts";
import { budgetExceeded } from "../src/flow-limits.ts";
import { preflight } from "../src/preflight.ts";
import { NodeFailure } from "../src/run-agent.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd, encoding: "utf8" }).trim();
function repo(config?: string) {
  const d = mkdtempSync(join(tmpdir(), "pf-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "a");
  if (config) writeFileSync(join(d, ".orchestrator.json"), config);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  return d;
}
const home = mkdtempSync(join(tmpdir(), "pf-home-"));
const full = { TOKEN_BUDGET_TICKET: "1000", MODEL_DEFAULT: "m", EFFORT_DEFAULT: "low", TURNS_DEFAULT: "5", PUBLISHER: "none" };

test("preflight passes with everything set", () => {
  preflight(repo(), full, home);
});

test("preflight names the config file and field before anything else is read", () => {
  assert.throws(() => preflight(repo('{"test":"npm test; rm -rf /"}'), {}, home), /\.orchestrator\.json: test/);
  assert.throws(() => preflight(repo('{"nope":1}'), {}, home), /\.orchestrator\.json: .*nope/);
  assert.throws(() => preflight(repo("{bad"), {}, home), /\.orchestrator\.json:/);
});

test("preflight names each missing variable", () => {
  const r = repo();
  assert.throws(() => preflight(r, { ...full, TOKEN_BUDGET_TICKET: undefined }, home), /missing env: TOKEN_BUDGET_TICKET/);
  assert.throws(() => preflight(r, { ...full, MODEL_DEFAULT: undefined }, home), /missing env: MODEL_TRIAGE or MODEL_DEFAULT/);
  assert.throws(() => preflight(r, { ...full, EFFORT_DEFAULT: undefined }, home), /missing env: EFFORT_TRIAGE or EFFORT_DEFAULT/);
  assert.throws(() => preflight(r, { ...full, TURNS_DEFAULT: undefined }, home), /missing env: TURNS_TRIAGE or TURNS_DEFAULT/);
  assert.throws(() => preflight(r, { ...full, PUBLISHER: undefined }, home), /missing env: PUBLISHER/);
});

test("a role-specific variable satisfies the check for that role only", () => {
  const { MODEL_DEFAULT: _, ...noDefault } = full;
  const roles = ["TRIAGE", "PLANNER", "DEV", "REVIEWER", "DESIGN", "QA", "DOCS"];
  const env = { ...noDefault, ...Object.fromEntries(roles.map((r) => [`MODEL_${r}`, "m"])) };
  preflight(repo(), env, home);
  assert.throws(() => preflight(repo(), { ...env, MODEL_QA: undefined }, home), /MODEL_QA or MODEL_DEFAULT/);
});

test("a publisher the env ceiling does not allow fails in preflight", () => {
  assert.throws(() => preflight(repo('{"publisher":"github"}'), full, home), /publisher github not allowed by PUBLISHER=none/);
});

test("a custom executor does not need the claude model variables", () => {
  preflight(repo(), { TOKEN_BUDGET_TICKET: "1", PUBLISHER: "none", EXECUTOR: "fake" }, home);
});

test("a late env miss is a NodeFailure so the ticket escalates instead of crashing", () => {
  assert.throws(() => readEnv("MODEL", "dev", {}), NodeFailure);
  assert.throws(() => budgetExceeded([], {}), NodeFailure);
});
