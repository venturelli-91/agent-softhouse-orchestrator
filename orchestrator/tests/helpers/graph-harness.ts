// Shared harness for the graph flow tests: fake executor and publisher, fixture repo, and the state the tests steer.
import { afterEach, beforeEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createFixture, git } from "../../scripts/fixture.ts";
import { gitConfigHash } from "../../src/guardrails.ts";
import { config, createWorktree, buildGraph, resume, Ticket } from "../../src/graph.ts";
import { registerPublisher } from "../../src/publish.ts";
import { NodeFailure, registerExecutor, type Req } from "../../src/run-agent.ts";
import { alerts, watchdog } from "../../src/watchdog.ts";
import { BRIEF, type Behavior, commit, defaults, FLAGS } from "./fakes.ts";

export { BRIEF, type Behavior, commit, defaults, FLAGS };

export const knobs = {
  override: {} as Behavior,
  calls: [] as string[],
  docsCalls: [] as string[],
  docsContexts: [] as string[],
  afterFixture: null as ((repo: string) => void) | null,
  tokensPerCall: 10,
  publications: [] as string[],
  merges: [] as string[],
  mergeError: null as string | null,
};

export const roots: string[] = [];

registerPublisher("fake", {
  publish: (p) => (knobs.publications.push(`${p.id}@${p.sha}`), "pr:https://example/pull/1"),
  merge: async (m) => {
    if (knobs.mergeError) throw new Error(knobs.mergeError);
    knobs.merges.push(`${m.pr}@${m.sha}`);
    return `merged:${m.pr}`;
  },
});

registerExecutor("fake", {
  async run<T>(req: Req<T>) {
    if (req.role === "docs") (knobs.docsCalls.push(req.role), knobs.docsContexts.push(req.context));
    else knobs.calls.push(req.role);
    const raw = (knobs.override[req.role] ?? defaults[req.role]!)(req as Req<unknown>);
    const output = req.schema.safeParse(raw);
    if (!output.success) throw new NodeFailure(`${req.role}: invalid output`);
    return { output: output.data, usage: { tokens_in: knobs.tokensPerCall, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 } };
  },
});

beforeEach(() => {
  process.env.EXECUTOR = "fake";
  const orchRoot = mkdtempSync(join(tmpdir(), "oh-"));
  roots.push(orchRoot);
  process.env.ORCH_HOME = orchRoot;
  process.env.ORCH_WORK = join(orchRoot, "work");
  process.env.PUBLISHER = "fake";
  knobs.publications = [];
  knobs.merges = [];
  knobs.mergeError = null;
  process.env.TOKEN_BUDGET_TICKET = "100000";
  knobs.override = {};
  knobs.calls = [];
  knobs.docsCalls = [];
  knobs.docsContexts = [];
  knobs.afterFixture = null;
  knobs.tokensPerCall = 10;
});

afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

export async function start(id = "T-1", saver: MemorySaver = new MemorySaver(), extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  roots.push(root);
  const repo = createFixture(root);
  knobs.afterFixture?.(repo);
  if ("deploy_cfg" in extra) writeFileSync(join(process.env.ORCH_HOME!, "config.json"),
    JSON.stringify({ repos: { [resolve(repo)]: { deploy: extra.deploy_cfg } } }));
  const graph = buildGraph(saver);
  const cfg = config(id);
  const r = await graph.invoke({ id, request: "p", ...createWorktree(repo, id, join(root, "wt")), ...extra }, cfg);
  return { graph, cfg, r, repo, root };
}

export const paused = (r: unknown) => (r as { __interrupt__?: { value: Record<string, unknown> }[] }).__interrupt__?.[0]?.value;

export const answer = (g: Awaited<ReturnType<typeof start>>, reply: string) => g.graph.invoke(resume(reply) as never, g.cfg);

export const ambiguous = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), clear: false, criteria: [] });

export const approved = () => ({ verdict: "approved", comments: "", summary: "ok" });

export const reviewerFailsOnce = () => {
  let n = 0;
  return () => {
    if (n++ === 0) throw new NodeFailure("boom");
    return approved();
  };
};

export const CMD_CFG = { command: "node --version", rollback: "node --version", health_url: "http://127.0.0.1:1/health", environment: "staging",
  env: [], timeout_s: 30, max_latency_ms: 2000 };

export const writeExternal = (repo: string, deploy: object) => writeFileSync(join(process.env.ORCH_HOME!, "config.json"),
  JSON.stringify({ repos: { [resolve(repo)]: { deploy } } }));

export async function commandTicket(cfgOver: object = {}) {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  roots.push(root);
  const repo = createFixture(root);
  const cfg = { ...CMD_CFG, ...cfgOver };
  writeExternal(repo, cfg);
  const sha = git(repo, "rev-parse", "HEAD");
  const t = Ticket.parse({ id: "T-1", request: "p", worktree: repo, repo, base: sha, approved_sha: sha, git_config_hash: gitConfigHash(repo),
    deploy_target: "command", deploy_cfg: cfg });
  return { t, repo, root, sha };
}

export const DOC_FILE = { files: [{ path: "arquitetura/visao.md", content: "# Visao\n" }], not_applicable: [], notes: "" };
