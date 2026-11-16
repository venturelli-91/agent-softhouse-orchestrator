import { rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { DEFAULT_INSTALL } from "./commands.ts";
import { setupSnapshot } from "./evidence.ts";
import { activeTickets, gitConfigHash, installDeps, MAX_ACTIVE_TICKETS, MAX_REVISIONS, RECURSION_LIMIT, tokens } from "./guardrails.ts";
import { ceoApproval } from "./ceo-node.ts";
import { dev, DEV_RULES, devRules, partialWork, taskBlock } from "./dev-node.ts";
import { sh } from "./graph-kit.ts";
import { samePath } from "./platform.ts";
import { projectDocsNode } from "./project-docs.ts";
import { planner, SPLIT_RULE, triage } from "./plan-nodes.ts";
import { loadConventions, loadPlaybooks, loadRepoConfig } from "./repo-config.ts";

const lessons = (playbooks: string) =>
  playbooks && `Lessons recorded in this repo's playbooks (past failures and decisions; do not repeat them):\n${playbooks}`;
import { DIFF_LIMIT, design, evidenceNote, qa, reviewer } from "./review-nodes.ts";
import { deploy, deployTicket, mergeNode, publishNode } from "./ship-nodes.ts";
import { load } from "./load.ts";
import { webcheck } from "./webcheck.ts";
import { Brief, briefMarkdown, Ticket, type T } from "./ticket.ts";

export { Brief, briefMarkdown, Ticket, DEV_RULES, devRules, partialWork, taskBlock, SPLIT_RULE, DIFF_LIMIT, evidenceNote, deployTicket };

// Review loop: above the cap, or on any escalation/ambiguity, the ticket goes to the CEO.
const route = (ok: string, node: string) => (t: T) =>
  t.status === ok ? node : t.status === "dev_failed" && t.revisions < MAX_REVISIONS ? "dev" : "ceo_approval";
const afterReview = (t: T) => (t.status === "design" ? "design" : route("qa", "qa")(t));
// Adopted changes are already written: an ambiguous triage has nothing left to plan.
const afterTriage = (t: T) => (t.status === "dev" || (t.adopt_tree && t.status === "ambiguous") ? "dev" : t.status === "ambiguous" ? "planner" : "ceo_approval");

const toDev = ["dev_failed", "reverify"];
const afterCeo = (t: T) =>
  t.status === "retry" ? t.failed_node : toDev.includes(t.status) ? "dev" : t.status === "replan" ? "planner" : t.status === "approved" ? "merge_pr" : END;
// A rebase that broke the suite goes back to the dev; a conflict, a new approval or anything else goes to the CEO.
const afterMerge = (t: T) => (t.status === "approved" ? "deploy" : t.status === "dev_failed" && t.revisions < MAX_REVISIONS ? "dev" : "ceo_approval");

export function buildGraph(checkpointer = new MemorySaver()) {
  return new StateGraph(Ticket)
    .addNode("triage", triage)
    .addNode("planner", planner)
    .addNode("dev", dev)
    .addNode("reviewer", reviewer)
    .addNode("design", design)
    .addNode("qa", qa)
    .addNode("webcheck", webcheck)
    .addNode("load", load)
    .addNode("publish", publishNode)
    .addNode("ceo_approval", ceoApproval)
    .addNode("merge_pr", mergeNode)
    .addNode("deploy", deploy)
    .addNode("docs_pre", projectDocsNode)
    .addEdge(START, "triage")
    .addConditionalEdges("triage", afterTriage, ["dev", "planner", "ceo_approval"])
    .addConditionalEdges("planner", route("dev", "dev"), ["dev", "ceo_approval"])
    .addConditionalEdges("dev", (t: T) => (t.status === "dev_next" ? "dev" : route("review", "docs_pre")(t)), ["docs_pre", "dev", "ceo_approval"])
    .addEdge("docs_pre", "reviewer")
    .addConditionalEdges("reviewer", afterReview, ["design", "qa", "dev", "ceo_approval"])
    .addConditionalEdges("design", route("qa", "qa"), ["qa", "dev", "ceo_approval"])
    .addConditionalEdges("qa", route("webcheck", "webcheck"), ["webcheck", "dev", "ceo_approval"])
    .addConditionalEdges("webcheck", route("publish", "load"), ["load", "dev", "ceo_approval"])
    .addConditionalEdges("load", route("publish", "publish"), ["publish", "dev", "ceo_approval"])
    .addConditionalEdges("publish", route("approval", "ceo_approval"), ["ceo_approval", "dev"])
    .addConditionalEdges("ceo_approval", afterCeo, ["triage", "planner", "dev", "reviewer", "design", "qa", "webcheck", "load", "publish", "deploy", "merge_pr", END])
    .addConditionalEdges("merge_pr", afterMerge, ["deploy", "dev", "ceo_approval"])
    .addEdge("deploy", END)
    .compile({ checkpointer });
}

export const config = (id: string) => ({ configurable: { thread_id: id }, recursionLimit: RECURSION_LIMIT });
export const resume = (answer: string) => new Command({ resume: answer });

export type Cleanup = { step: string; ok: boolean; reason?: string };

export function removeTicketResources(repo: string, worktree: string, id: string): Cleanup[] {
  const up = relative(resolve(worktree), resolve(repo));
  if (up === "" || !(up === ".." || up.startsWith(`..${sep}`) || isAbsolute(up)))
    return [{ step: "guard", ok: false, reason: `refusing to remove ${worktree}: it is the repo or contains it` }];
  const attempt = (step: string, fn: () => unknown): Cleanup => {
    try {
      fn();
      return { step, ok: true };
    } catch (e) {
      return { step, ok: false, reason: (e as Error).message.split("\n", 1)[0] };
    }
  };
  return [
    attempt("worktree remove", () => {
      const registered = sh(repo, "worktree", "list", "--porcelain").split("\n").some((l) => l.startsWith("worktree ") && samePath(l.slice(9), worktree));
      if (registered) sh(repo, "worktree", "remove", "--force", worktree);
    }),
    attempt("remove directory", () => rmSync(worktree, { recursive: true, force: true })),
    attempt("worktree prune", () => sh(repo, "worktree", "prune")),
    attempt("branch delete", () => {
      if (sh(repo, "branch", "--list", `ticket/${id}`)) sh(repo, "branch", "-D", `ticket/${id}`);
    }),
  ];
}

export function createWorktree(repo: string, id: string, dir: string, home?: string) {
  if (activeTickets(repo) >= MAX_ACTIVE_TICKETS) throw new Error(`limit of ${MAX_ACTIVE_TICKETS} active tickets reached`);
  const base_branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const base = sh(repo, "rev-parse", "HEAD");
  const { test, merge, publisher, push_remote, base_repo, disclosure, deploy, install: alias, setup: extra, env, specialties, stack, webcheck, load, project_docs } =
    loadRepoConfig(repo, base, home);
  const setup = [...new Set([...(alias ? [DEFAULT_INSTALL] : []), ...extra])];
  const install = setup.includes(DEFAULT_INSTALL);
  const rules = [loadConventions(repo, base), stack && `Stack decided for this repo: ${stack}`, lessons(loadPlaybooks(repo, base))].filter(Boolean).join("\n\n");
  const git_config_hash = gitConfigHash(repo);
  sh(repo, "worktree", "add", "-q", "-b", `ticket/${id}`, dir);
  let setup_ignored: string[] | null = null;
  try {
    for (const c of setup) installDeps(dir, c, env);
    if (setup.some((c) => c !== DEFAULT_INSTALL)) setup_ignored = setupSnapshot(dir, install);
  } catch (e) {
    removeTicketResources(repo, dir, id);
    throw e;
  }
  return {
    worktree: dir,
    repo,
    git_config_hash,
    base,
    test,
    install,
    setup_ignored,
    setup_env: env,
    merge,
    publisher: publisher ?? "",
    push_remote,
    base_repo,
    disclosure,
    base_branch,
    rules,
    deploy_cfg: deploy,
    webcheck_cfg: webcheck,
    load_cfg: load,
    specialties,
    project_docs,
    ...(deploy ? { deploy_target: "command" } : {}),
  };
}

export function report(t: T): string {
  const lines = t.history
    .filter((h) => h.usage)
    .map((h) => {
      const c = h.usage!;
      return (
        `${h.node.padEnd(10)} tokens=${tokens(c)} (ctx ${c.cache_create + c.cache_read + c.tokens_in}, output ${c.tokens_out}) ` +
        `turns=${c.turns} ${(c.ms / 1000).toFixed(1)}s US$${c.cost_usd.toFixed(3)}`
      );
    });
  const total = t.history.reduce((a, h) => ({ tok: a.tok + (h.usage ? tokens(h.usage) : 0), usd: a.usd + (h.usage?.cost_usd ?? 0), ms: a.ms + h.ms }), {
    tok: 0,
    usd: 0,
    ms: 0,
  });
  return [
    ...lines,
    ...t.docs_warnings.map((w) => `docs warning: ${w}`),
    ...t.test_alerts.map((w) => `test warning: ${w}`),
    `TOTAL ${t.id} status=${t.status} revisions=${t.revisions} tokens=${total.tok} ${(total.ms / 1000).toFixed(1)}s US$${total.usd.toFixed(3)}`,
  ].join("\n");
}
