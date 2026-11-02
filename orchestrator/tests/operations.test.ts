// End to end: request -> simulated deploy -> injected failure -> one P0 hotfix, a proposed rollback and a postmortem.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemorySaver } from "@langchain/langgraph";
import { createFixture, git } from "../scripts/fixture.ts";
import { injectFailure, simulatedProbe } from "../src/chaos.ts";
import { recordDeploy, registerDeployTarget } from "../src/deploy.ts";
import { buildGraph, config, createWorktree, resume } from "../src/graph.ts";
import { listIncidents } from "../src/incidents.ts";
import { approveRollback, watch } from "../src/monitor.ts";
import { defaultProbe } from "../src/probe.ts";
import { writePostmortem } from "../src/postmortem.ts";
import { registerPublisher } from "../src/publish.ts";
import { NodeFailure, registerExecutor, type Req } from "../src/run-agent.ts";

const FLAGS = { touches_security: false, touches_performance: false, touches_ai: false, touches_schema: false, touches_public_api: false, touches_permissions: false, touches_external_integration: false, touches_cost: false };
const triage = { title: "t", priority: "P2", specialty: "frontend", clear: true, flags: FLAGS, criteria: ["button says Submit order"], summary: "ok" };
const out: Record<string, (req: Req<unknown>) => unknown> = {
  triage: () => triage,
  dev: (req) => {
    writeFileSync(join(req.cwd, "checkout.html"), "<button>Submit order</button>\n");
    git(req.cwd, "add", "-A");
    git(req.cwd, "-c", "user.name=agent-dev", "commit", "-q", "--allow-empty", "-m", "dev");
    return { summary: "ok" };
  },
  reviewer: () => ({ verdict: "approved", comments: "", summary: "ok" }),
  qa: () => ({ verdict: "approved", comments: "", summary: "ok" }),
};
registerExecutor("ops-fake", {
  async run<T>(req: Req<T>) {
    const parsed = req.schema.safeParse(out[req.role]!(req as Req<unknown>));
    if (!parsed.success) throw new NodeFailure(`${req.role}: invalid output`);
    return { output: parsed.data, usage: { tokens_in: 1, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 } };
  },
});

registerPublisher("ops-pub", { publish: () => "pr:https://example/pull/1", merge: async (m) => `merged:${m.pr}` });

let root = "";
let home = "";
const rollbacks: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ops-"));
  home = join(root, "home");
  process.env.EXECUTOR = "ops-fake";
  process.env.PUBLISHER = "ops-pub";
  process.env.ORCH_HOME = home;
  process.env.TOKEN_BUDGET_TICKET = "100000";
  rollbacks.length = 0;
  registerDeployTarget("prod-like", { sandbox: false, deploy: () => "d", rollback: () => "r" });
  registerDeployTarget("ops-rec", { sandbox: true, deploy: () => "d", rollback: (d) => (rollbacks.push(d.id), "rolled back") });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function deliver(repo: string, id: string, extra: Record<string, unknown> & { deploy_cfg?: object | null } = {}) {
  mkdirSync(home, { recursive: true });
  if (extra.deploy_cfg) writeFileSync(join(home, "config.json"), JSON.stringify({ repos: { [resolve(repo)]: { deploy: extra.deploy_cfg } } }));
  const graph = buildGraph(new MemorySaver());
  await graph.invoke({ id, request: "p", ...createWorktree(repo, id, join(root, id), home), ...extra } as never, config(id));
  const done = await graph.invoke(resume("approve") as never, config(id));
  return { done, graph };
}

test("failure after a deploy: one P0 hotfix, a rollback only on approval, one postmortem", async () => {
  const repo = createFixture(root);
  const { done } = await deliver(repo, "T-1", { deploy_target: "ops-rec" });
  assert.equal(done.status, "deployed", done.summary);

  injectFailure(home, "T-1", "http-500");
  const made: { id: string; state: Record<string, unknown> }[] = [];
  const notes: string[] = [];
  const deps = {
    probe: simulatedProbe,
    notify: async (t: string) => void notes.push(t),
    makeHotfix: async ({ incident, repo: r }: { incident: { id: string }; repo: string }) => {
      const id = `H-${made.length + 1}`;
      const h = await deliver(r, id, { incident: incident.id });
      made.push({ id, state: (await h.graph.getState(config(id))).values });
      return id;
    },
  };
  await watch(home, deps);
  await watch(home, deps);

  assert.equal(listIncidents(home).length, 1);
  assert.equal(made.length, 1);
  assert.equal(notes.length, 1);
  assert.equal(made[0].state.priority, "P0");
  assert.equal(made[0].state.incident, listIncidents(home)[0].id);

  assert.deepEqual(rollbacks, []);
  approveRollback(home, listIncidents(home)[0].id);
  assert.deepEqual(rollbacks, ["T-1"]);

  const incident = listIncidents(home)[0];
  writePostmortem(repo, incident, "text");
  writePostmortem(repo, incident, "text again");
  assert.equal(readdirSync(join(repo, "playbooks")).length, 1);
});

test("chaos is refused on a deploy that is not a sandbox target", () => {
  recordDeploy(home, { id: "T-9", repo: "/r", sha: "a", previous: "b", target: "prod-like", sandbox: false });
  assert.throws(() => injectFailure(home, "T-9", "http-500"), /sandbox/);
  assert.equal(simulatedProbe(home, "T-9"), null);
});

test("a command deploy with a failing health url opens one hotfix and rolls back only on approval", async () => {
  let healthy = true;
  const server = createServer((_q, res) => ((res.statusCode = healthy ? 200 : 503), res.setHeader("connection", "close"), res.end()));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const repo = createFixture(root);
    const health_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    const deploy_cfg = { command: "node --version", rollback: "node --version", health_url, environment: "staging", env: [], timeout_s: 30, max_latency_ms: 30000 };
    const { done } = await deliver(repo, "T-1", { deploy_target: "command", deploy_cfg });
    assert.equal(done.status, "deployed");

    const made: string[] = [];
    const deps = {
      probe: defaultProbe,
      notify: async () => {},
      makeHotfix: async ({ incident, repo: r }: { incident: { id: string }; repo: string }) => {
        const id = `H-${made.length + 1}`;
        await deliver(r, id, { incident: incident.id, deploy_target: "simulated", deploy_cfg: null });
        made.push(id);
        return id;
      },
    };
    await watch(home, deps);
    assert.equal(listIncidents(home).length, 0);
    healthy = false;
    await watch(home, deps);
    await watch(home, deps);
    assert.equal(listIncidents(home).length, 1);
    assert.equal(made.length, 1);
    assert.equal(listIncidents(home)[0].symptom, "http 503");

    const id = listIncidents(home)[0].id;
    assert.match(approveRollback(home, id), /v\d+/);
    assert.throws(() => approveRollback(home, id), /already rolled back/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("chaos is refused on a command deploy", () => {
  const cmd = { rollback: "x", health_url: "http://127.0.0.1:1/h", env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging" as const, git_config_hash: "" };
  recordDeploy(home, { id: "T-8", repo: "/r", sha: "a", previous: "b", target: "command", sandbox: false, cmd });
  assert.throws(() => injectFailure(home, "T-8", "http-500"), /sandbox/);
});
