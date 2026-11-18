// Reproducible behavioral benchmark: drives canonical tickets through the real graph with a fake executor
// (no model, no network, no credentials) and prints a markdown digest of the route, status and revisions.
// Run: node scripts/bench.ts   (from orchestrator/)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createFixture } from "./fixture.ts";
import { buildGraph, config, createWorktree, resume } from "../src/graph.ts";
import { NodeFailure, registerExecutor, type Req } from "../src/run-agent.ts";
import { registerPublisher } from "../src/publish.ts";
import { defaults } from "../tests/helpers/fakes.ts";

// Same shape as the test harness, but standalone (no node:test).
const root = mkdtempSync(join(tmpdir(), "bench-"));
process.env.ORCH_HOME = join(root, "home");
process.env.ORCH_WORK = join(root, "work");
mkdirSync(process.env.ORCH_HOME, { recursive: true });
mkdirSync(process.env.ORCH_WORK, { recursive: true });
process.env.EXECUTOR = "fake";
process.env.PUBLISHER = "fake";
process.env.NOTIFY_URL = "";
process.env.TOKEN_BUDGET_TICKET = "100000";

const overrides: Record<string, (req: Req<unknown>) => unknown> = {};
registerExecutor("fake", {
  async run<T>(req: Req<T>) {
    const raw = (overrides[req.role] ?? defaults[req.role]!)(req as Req<unknown>);
    const output = req.schema.safeParse(raw);
    if (!output.success) throw new NodeFailure(`${req.role}: invalid output`);
    return { output: output.data, usage: { tokens_in: 10, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 } };
  },
});
registerPublisher("fake", {
  publish: (p) => "pr:https://example/pull/1",
  merge: async (m) => `merged:${m.pr}`,
});

const paused = (r: unknown) => (r as { __interrupt__?: { value: unknown }[] }).__interrupt__?.[0]?.value;
const ambiguous = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), clear: false, criteria: [] });

const FAST_TEST = "node test/checkout.test.js";
const CMD_CFG = { command: "node --version", rollback: "node --version", health_url: "http://127.0.0.1:1/health", environment: "staging",
  env: [], timeout_s: 30, max_latency_ms: 2000, verify_minutes: 0 };

type Case = { name: string; extra?: Record<string, unknown>; answers?: string[] };
const cases: Case[] = [
  { name: "clear frontend ticket" },
  { name: "ambiguous ticket (discovery)", answers: ["approve", "approve", "approve"] },
  { name: "command deploy + verify", extra: { deploy_target: "command", deploy_cfg: CMD_CFG } },
];

async function run(c: Case) {
  const repo = createFixture(join(root, c.name.replace(/\W+/g, "-")));
  const extra = c.extra ?? {};
  const entry: Record<string, unknown> = { test: FAST_TEST };
  if (extra.deploy_cfg !== undefined) entry.deploy = extra.deploy_cfg;
  if (extra.webcheck_cfg !== undefined) entry.webcheck = extra.webcheck_cfg;
  if (extra.load_cfg !== undefined) entry.load = extra.load_cfg;
  writeFileSync(join(process.env.ORCH_HOME!, "config.json"), JSON.stringify({ repos: { [resolve(repo)]: entry } }));
  const graph = buildGraph(new MemorySaver());
  const cfg = config("T-1");
  const started = Date.now();
  let r = (await graph.invoke({ id: "T-1", request: "p", ...createWorktree(repo, "T-1", join(root, `${c.name}-wt`)), ...extra }, cfg)) as Awaited<
    ReturnType<typeof graph.invoke>
  > & { history?: { node: string }[] };
  let i = 0;
  while (paused(r)) r = (await graph.invoke(resume((c.answers ?? ["approve", "approve"])[i++] ?? "approve") as never, cfg)) as typeof r;
  const nodes = (r.history ?? []).map((h) => h.node);
  return { name: c.name, status: String(r.status), revisions: Number(r.revisions), ms: Date.now() - started, nodes: nodes.join(" → ") };
}

// "ambiguous" needs its own triage override; the default triage is "clear", so flip it for that case only.
const results = [];
for (const c of cases) {
  if (c.name.startsWith("ambiguous")) overrides.triage = ambiguous;
  else delete overrides.triage;
  results.push(await run(c));
}

console.log("\n## Behavioral benchmark (fake executor, no model)\n");
console.log("| Scenario | Route | Status | Revisions | Time |");
console.log("|---|---|---|---|---|");
for (const r of results) console.log(`| ${r.name} | \`${r.nodes}\` | ${r.status} | ${r.revisions} | ${r.ms} ms |`);
console.log(`\n_${results.length} canonical flows through the real graph. Run again: \`node scripts/bench.ts\`._\n`);

rmSync(root, { recursive: true, force: true });
