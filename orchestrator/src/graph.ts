import { Command, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { mergeLocal } from "./local-merge.ts";
import { assertGitConfigUnchanged, gitConfigHash, repoOf, selfApproval, safeGit, MAX_REVISIONS, MAX_ACTIVE_TICKETS, budgetExceeded, RECURSION_LIMIT, activeTickets, tokens, verifyEvidence } from "./guardrails.ts";
import { mergePr, publish } from "./publish.ts";
import { loadConventions, loadRepoConfig } from "./repo-config.ts";
import { NodeFailure, runAgent, type Usage } from "./run-agent.ts";

const SPECIALTIES = ["frontend", "backend", "fullstack", "mobile", "integrations", "ai", "data"] as const;
const DEV_FILE: Record<(typeof SPECIALTIES)[number], string> = {
  frontend: "dev-frontend", backend: "dev-backend", fullstack: "dev-fullstack", mobile: "dev-mobile",
  integrations: "dev-integrations", ai: "ai-engineer", data: "data-engineer",
};
const summary = z.string().describe("at most 10 lines");
const cap = (s: string) => s.split("\n").slice(0, 10).join("\n");
const FlagsSchema = z.object({
  touches_security: z.boolean(), touches_performance: z.boolean(), touches_ai: z.boolean(), touches_schema: z.boolean(),
  touches_public_api: z.boolean(), touches_permissions: z.boolean(), touches_external_integration: z.boolean(), touches_cost: z.boolean(),
});
const EMPTY_FLAGS = Object.fromEntries(Object.keys(FlagsSchema.shape).map((k) => [k, false])) as z.infer<typeof FlagsSchema>;

// The graph's only state. `request`, `criteria`, `worktree` and `base` are the minimal extras the code needs.
export const Ticket = z.object({
  id: z.string(),
  request: z.string(),
  worktree: z.string(),
  base: z.string(),
  repo: z.string().default(""),
  git_config_hash: z.string().default(""),
  test: z.string().default("npm test"),
  merge: z.enum(["pr", "auto", "local"]).default("pr"),
  publisher: z.string().default(""),
  push_remote: z.string().default("origin"),
  base_repo: z.string().default(""),
  disclosure: z.boolean().default(true),
  base_branch: z.string().default(""),
  approved_sha: z.string().default(""),
  rules: z.string().default(""),
  title: z.string().default(""),
  priority: z.enum(["P0", "P1", "P2", "Bug"]).default("P2"),
  specialty: z.enum(SPECIALTIES).default("fullstack"),
  flags: FlagsSchema.default(EMPTY_FLAGS),
  criteria: z.array(z.string()).default([]),
  status: z.string().default("new"),
  failed_node: z.string().default(""),
  summary_before_failure: z.string().default(""),
  summary: z.string().default(""),
  explanation: z.string().default(""),
  briefing: z.string().default(""),
  stories: z.array(z.string()).default([]),
  incident: z.string().default(""),
  author_id: z.string().nullable().default(null),
  reviewer_id: z.string().nullable().default(null),
  qa_id: z.string().nullable().default(null),
  revisions: z.number().default(0),
  evidence: z.array(z.string()).default([]),
  history: z.array(z.object({ node: z.string(), time: z.string(), result: z.string(), ms: z.number(), usage: z.custom<Usage>().optional() })).default([]),
});
type T = z.infer<typeof Ticket>;

const TriageOutput = z.object({
  title: z.string(), priority: z.enum(["P0", "P1", "P2", "Bug"]), specialty: z.enum(SPECIALTIES),
  clear: z.boolean(), flags: FlagsSchema, criteria: z.array(z.string()), summary,
});
// `question` is empty when clear; otherwise it is what the CEO needs to answer.
const PlanOutput = TriageOutput.extend({ question: z.string(), briefing: z.string().default(""), stories: z.array(z.string()).default([]) });
const DevOutput = z.object({ summary });
const ReviewOutput = z.object({ verdict: z.enum(["approved", "rejected"]), comments: z.string(), summary, explanation: z.string().default("") });

const log = (t: T, node: string, result: string, usage?: Usage) =>
  [...t.history, { node, time: new Date().toISOString(), result, ms: usage?.ms ?? 0, usage }];

const sh = safeGit;

// Minimal context: only what the role needs, never the conversation history.
const context = (...parts: string[]) =>
  [...parts, "Answer only in the structured format. `summary`: up to 10 lines, only what the next node needs."].join("\n\n");
const ticketData = (t: T) =>
  `Ticket ${t.id}: ${t.title}\n${t.briefing ? `Briefing:\n${t.briefing}\n` : ""}${t.stories.length ? `Stories:\n${t.stories.map((s) => `- ${s}`).join("\n")}\n` : ""}` +
  `Acceptance criteria:\n${t.criteria.map((c) => `- ${c}`).join("\n")}\nCurrent summary:\n${t.summary}`;
export const devRules = (test = "npm test") =>
  `Implement in the current worktree, run ${test} and commit (git add/git commit). Do not push. ` +
  `Shell: one simple command per call (git add, git commit, git status, git diff, git log, ${test}); no ';', '&&' or pipes, they are denied, so on a denial retry with a single command.`;
export const DEV_RULES = devRules();
export const evidenceNote = (evidence: string[]) =>
  `Evidence checked by the orchestrator in code (not by you): ${evidence.join(", ")}. Do not reject only because you cannot run the tests yourself; judge the diff and the code against the criteria.`;
const diff = (t: T) => sh(t.worktree, "diff", "--no-ext-diff", "--no-textconv", t.base, "HEAD").slice(0, 20_000);

const escalate = (t: T, name: string, reason: string): Partial<T> =>
  ({ status: "escalated", failed_node: name, summary_before_failure: t.summary, summary: `${name}: ${reason}`.split("\n").slice(0, 10).join("\n"), history: log(t, name, `escalated: ${reason}`) });

// An executor failure (error, timeout, invalid output) or an exceeded budget does not break the graph:
// the ticket stops and goes to the CEO via ceo_approval.
const guarded = (name: string, fn: (t: T) => Promise<Partial<T>>) => async (t: T): Promise<Partial<T>> => {
  const overrun = budgetExceeded(t.history.map((h) => h.usage));
  if (overrun) return escalate(t, name, overrun);
  try {
    return await fn(t);
  } catch (e) {
    if (!(e instanceof NodeFailure)) throw e;
    return escalate(t, name, e.message);
  }
};

const triage = guarded("triage", async (t) => {
  const { output, usage } = await runAgent({ role: "triage", files: ["triage"], cwd: t.worktree, schema: TriageOutput, context: context(`CEO request: ${t.request}`) });
  const { clear, summary, ...rest } = output;
  return { ...rest, priority: t.incident ? "P0" as const : rest.priority, criteria: clear ? rest.criteria : [], summary: cap(summary), status: clear ? "dev" : "ambiguous", history: log(t, "triage", clear ? "clear" : "ambiguous", usage) };
});

// demand-analyst -> product-manager -> tech-lead in a single agent turn (tokens: one context only).
// Without closed criteria there is no ticket: the question goes to the CEO and the answer comes back here.
const planner = guarded("planner", async (t) => {
  const { output, usage } = await runAgent({
    role: "planner", files: ["demand-analyst", "product-manager", "tech-lead"], cwd: t.worktree, schema: PlanOutput,
    context: context(`CEO request: ${t.request}`, `Triage (ambiguous request): ${t.summary}`, "If missing information prevents verifiable acceptance criteria, set clear=false and put what is missing in `question`."),
  });
  const { clear, question, ...plan } = output;
  if (!clear || !plan.criteria.length) return { status: "ambiguous", summary: cap(question || plan.summary), history: log(t, "planner", "ambiguous", usage) };
  return { ...plan, priority: t.incident ? "P0" as const : plan.priority, summary: cap(plan.summary), status: "dev", history: log(t, "planner", "clear", usage) };
});

const rulesBlock = (t: T) => (t.rules ? [`Target repo conventions (its CLAUDE.md; follow them, including the commit message format):
${t.rules}`] : []);

const dev = guarded("dev", async (t) => {
  const { output, usage } = await runAgent({
    role: "dev", files: [DEV_FILE[t.specialty]], cwd: t.worktree, schema: DevOutput,
    context: context(ticketData(t), devRules(t.test), ...rulesBlock(t)), test: t.test,
  });
  const v = verifyEvidence(t.worktree, t.base, t.test);
  if (!v.ok) return { status: "dev_failed", explanation: "", revisions: t.revisions + 1, summary: `verification: ${v.reason}`, history: log(t, "dev", `verification failed`, usage) };
  return { status: "review", explanation: "", summary: cap(output.summary), author_id: v.author, evidence: v.evidence, history: log(t, "dev", "commit verified", usage) };
});

function reviewStep(name: "reviewer" | "qa", files: (t: T) => string[], next: string) {
  return guarded(name, async (t) => {
    // Flow rules in code: independence and verified evidence before spending tokens.
    const who = `agent-${name}`;
    const block = selfApproval(t.author_id, who);
    if (block) throw new NodeFailure(block);
    const v = t.evidence.length ? verifyEvidence(t.worktree, t.base, t.test) : { ok: false as const, reason: "no evidence" };
    if (!v.ok) throw new NodeFailure(`invalid evidence: ${v.reason}`);
    const { output, usage } = await runAgent({
      role: name, files: files(t), cwd: t.worktree, schema: ReviewOutput,
      context: context(ticketData(t), evidenceNote(v.evidence), "`explanation`: what changed and why, in plain language a non-programmer follows, up to 6 lines.", ...(name === "reviewer" ? rulesBlock(t) : []), `Diff:\n${diff(t)}`),
    });
    const id = name === "reviewer" ? { reviewer_id: `agent-${name}` } : { qa_id: `agent-${name}` };
    if (output.verdict === "approved") return { ...id, status: next, summary: cap(output.summary), explanation: [t.explanation, output.explanation.trim().split("\n").slice(0, 6).join("\n")].filter(Boolean).join("\n"), history: log(t, name, "approved", usage) };
    return { status: "dev_failed", revisions: t.revisions + 1, summary: output.comments.split("\n").slice(0, 10).join("\n"), history: log(t, name, "rejected", usage) };
  });
}
const reviewer = reviewStep("reviewer", (t) => [
  "code-reviewer",
  ...(t.flags.touches_security ? ["security"] : []),
  ...(t.flags.touches_performance ? ["performance"] : []),
  ...(t.flags.touches_ai ? ["evals-engineer"] : []),
], "qa");
const qa = reviewStep("qa", () => ["qa-automation"], "publish");

const checkConfig = (t: T) => {
  try {
    assertGitConfigUnchanged(t.repo || repoOf(t.worktree), t.git_config_hash);
  } catch (e) {
    throw new NodeFailure((e as Error).message);
  }
};

// Branch push and (draft) PR done by code, not by the agent; only while the evidence still holds.
const publishNode = guarded("publish", async (t) => {
  const v = t.evidence.length ? verifyEvidence(t.worktree, t.base, t.test) : { ok: false as const, reason: "no evidence" };
  if (!v.ok) throw new NodeFailure(`invalid evidence: ${v.reason}`);
  checkConfig(t);
  const body = [t.summary, "Criteria:", ...t.criteria.map((c) => `- ${c}`), `Evidence: ${v.evidence.join(", ")}`].join("\n\n");
  const pr = publish({ cwd: t.repo || t.worktree, id: t.id, sha: v.sha, title: `${t.id}: ${t.title}`, body, remote: t.push_remote, baseRepo: t.base_repo, disclosure: t.disclosure }, t.publisher);
  return { status: "approval", approved_sha: v.sha, evidence: [...v.evidence, pr], history: log(t, "publish", pr) };
});

// Merge/deploy only after the CEO; with no write permission, the agent describes the plan and the rollback.
const devops = guarded("devops", async (t) => {
  const { output, usage } = await runAgent({
    role: "devops", files: ["devops-sre"], cwd: t.worktree, schema: DevOutput,
    context: context(ticketData(t), "The CEO approved. Simulation: do NOT run a deploy or a merge. Describe status, rollback plan and observability."),
  });
  return { status: "simulated_deploy", summary: cap(output.summary), history: log(t, "devops", "simulated deploy", usage) };
});

// Squash-merge by code, only for repos that opted in (merge=auto), after the CEO approved, with the evidence still holding.
const mergeNode = guarded("merge_pr", async (t) => {
  if (t.merge === "pr") return { history: log(t, "merge_pr", "skipped (merge=pr)") };
  const v = verifyEvidence(t.worktree, t.base, t.test);
  if (!v.ok) throw new NodeFailure(`invalid evidence: ${v.reason}`);
  // What the CEO approved is the commit that was published, not whatever HEAD is now.
  if (!t.approved_sha || v.sha !== t.approved_sha) throw new NodeFailure("merge: commit changed since it was published");
  checkConfig(t);
  if (t.merge === "local") {
    try {
      const merged = mergeLocal(t.repo || repoOf(t.worktree), t.base_branch, t.approved_sha);
      return { evidence: [...t.evidence, merged], history: log(t, "merge_pr", merged) };
    } catch (e) {
      throw new NodeFailure(`merge: ${(e as Error).message}`);
    }
  }
  const pr = t.evidence.find((e) => e.startsWith("pr:"))?.slice(3);
  if (!pr || pr === "none") throw new NodeFailure("merge: no PR to merge");
  const merged = await mergePr({ cwd: t.repo || t.worktree, pr, sha: t.approved_sha, baseRepo: t.base_repo }, t.publisher);
  return { evidence: [...t.evidence, merged], history: log(t, "merge_pr", merged) };
});

// The only merge/deploy and escalation point. Approval only counts if the evidence still holds.
const ceoApproval = async (t: T): Promise<Partial<T>> => {
  const v = t.status === "approval" && t.evidence.length ? verifyEvidence(t.worktree, t.base, t.test) : null;
  const reason = t.status === "approval" ? (v?.ok ? (v.sha === t.approved_sha ? null : "commit changed since it was published") : `invalid evidence: ${v ? v.reason : "no evidence"}`)
    : t.status === "dev_failed" ? `cap of ${MAX_REVISIONS} revisions reached: ${t.summary}` : `${t.status}: ${t.summary}`;
  const r = interrupt({
    type: reason ? "escalation" : "approval", reason, ticket: t.id, title: t.title, summary: t.summary, explanation: t.explanation, evidence: t.evidence,
    active_flags: Object.entries(t.flags).filter(([, active]) => active).map(([k]) => k),
  }) as string;
  const h = (res: string) => log(t, "ceo_approval", res);
  if (!reason) {
    if (r === "approve") return { status: "approved", history: h("approved") };
    return { status: "dev_failed", revisions: t.revisions + 1, summary: `CEO rejected: ${r}`.slice(0, 500), history: h("rejected") };
  }
  if (r === "abort") return { status: "aborted", history: h("aborted") };
  // Missing information: the CEO's answer supplements the request and the planner tries again.
  if (t.status === "ambiguous") return { status: "replan", request: `${t.request}\n\nCEO clarification: ${r}`, history: h("clarified") };
  // A failed merge (CI red, PR moved): "retry" runs it again, anything else is an instruction for the dev.
  if (t.history.at(-1)?.node === "merge_pr" && r === "retry") return { status: "approved", history: h("merge retry") };
  // A node that stopped on an error or timeout: "retry" runs just that node again, not the dev.
  // Only for the commit that was reviewed: a new commit in the worktree must go back through the dev and both reviews.
  // The failure text stays out of the retried node's context (and out of the PR body).
  const sameCommit = () => !POST_DEV.includes(t.failed_node) || t.evidence.includes(`commit:${safeGit(t.worktree, "rev-parse", "--short", "HEAD")}`);
  if (r === "retry" && t.status === "escalated" && RETRYABLE.includes(t.failed_node) && sameCommit()) return { status: "retry", summary: t.summary_before_failure, history: h("retry") };
  // Any other escalation: the CEO instructs the dev (only if criteria already exist).
  if (!t.criteria.length) return { status: "aborted", history: h("aborted") };
  return { status: "dev_failed", revisions: 0, summary: `CEO instructed: ${r}`.slice(0, 500), history: h("resumed") };
};

// Review loop: above the cap, or on any escalation/ambiguity, the ticket goes to the CEO.
const route = (ok: string, node: string) => (t: T) =>
  t.status === ok ? node : t.status === "dev_failed" && t.revisions < MAX_REVISIONS ? "dev" : "ceo_approval";
const afterTriage = (t: T) => (t.status === "dev" ? "dev" : t.status === "ambiguous" ? "planner" : "ceo_approval");
const RETRYABLE = ["triage", "planner", "dev", "reviewer", "qa", "publish", "devops"];
const POST_DEV = ["reviewer", "qa", "publish", "devops"];
const afterCeo = (t: T) => (t.status === "retry" ? t.failed_node : t.status === "dev_failed" ? "dev" : t.status === "replan" ? "planner" : t.status === "approved" ? "merge_pr" : END);
const afterMerge = (t: T) => (t.status === "approved" ? "devops" : "ceo_approval");

export function buildGraph(checkpointer = new MemorySaver()) {
  return new StateGraph(Ticket)
    .addNode("triage", triage).addNode("planner", planner).addNode("dev", dev).addNode("reviewer", reviewer).addNode("qa", qa).addNode("publish", publishNode).addNode("ceo_approval", ceoApproval).addNode("merge_pr", mergeNode).addNode("devops", devops)
    .addEdge(START, "triage")
    .addConditionalEdges("triage", afterTriage, ["dev", "planner", "ceo_approval"])
    .addConditionalEdges("planner", route("dev", "dev"), ["dev", "ceo_approval"])
    .addConditionalEdges("dev", route("review", "reviewer"), ["reviewer", "dev", "ceo_approval"])
    .addConditionalEdges("reviewer", route("qa", "qa"), ["qa", "dev", "ceo_approval"])
    .addConditionalEdges("qa", route("publish", "publish"), ["publish", "dev", "ceo_approval"])
    .addConditionalEdges("publish", route("approval", "ceo_approval"), ["ceo_approval"])
    .addConditionalEdges("ceo_approval", afterCeo, ["triage", "planner", "dev", "reviewer", "qa", "publish", "devops", "merge_pr", END])
    .addConditionalEdges("merge_pr", afterMerge, ["devops", "ceo_approval"])
    .addEdge("devops", END)
    .compile({ checkpointer });
}

export const config = (id: string) => ({ configurable: { thread_id: id }, recursionLimit: RECURSION_LIMIT });
export const resume = (answer: string) => new Command({ resume: answer });

export function createWorktree(repo: string, id: string, dir: string, home?: string) {
  if (activeTickets(repo) >= MAX_ACTIVE_TICKETS) throw new Error(`limit of ${MAX_ACTIVE_TICKETS} active tickets reached`);
  const base_branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
  sh(repo, "worktree", "add", "-q", "-b", `ticket/${id}`, dir);
  const base = sh(repo, "rev-parse", "HEAD");
  const { test, merge, publisher, push_remote, base_repo, disclosure } = loadRepoConfig(repo, base, home);
  return { worktree: dir, repo, git_config_hash: gitConfigHash(repo), base, test, merge, publisher: publisher ?? "", push_remote, base_repo, disclosure, base_branch, rules: loadConventions(repo, base) };
}

export function report(t: T): string {
  const lines = t.history.filter((h) => h.usage).map((h) => {
    const c = h.usage!;
    return `${h.node.padEnd(10)} tokens=${tokens(c)} (ctx ${c.cache_create + c.cache_read + c.tokens_in}, output ${c.tokens_out}) turns=${c.turns} ${(c.ms / 1000).toFixed(1)}s US$${c.cost_usd.toFixed(3)}`;
  });
  const total = t.history.reduce((a, h) => ({ tok: a.tok + (h.usage ? tokens(h.usage) : 0), usd: a.usd + (h.usage?.cost_usd ?? 0), ms: a.ms + h.ms }), { tok: 0, usd: 0, ms: 0 });
  return [...lines, `TOTAL ${t.id} status=${t.status} revisions=${t.revisions} tokens=${total.tok} ${(total.ms / 1000).toFixed(1)}s US$${total.usd.toFixed(3)}`].join("\n");
}
