import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { interrupt } from "@langchain/langgraph";
import { orchHome } from "./daily-cap.ts";
import { manualCriteria, MAX_REVISIONS, safeGit, verifyTicket } from "./guardrails.ts";
import { log } from "./graph-kit.ts";
import { promotes, stageOf, type DeployConfig } from "./repo-config.ts";
import type { T } from "./ticket.ts";

// On an escalation these words are not an answer: they would reach the dev as its instruction.
export const isBareApproval = (answer?: string) => answer === undefined || /^(approve|approved|ok|yes|lgtm)$/i.test(answer.trim());

// The deploy view shown to the CEO: exactly today's keys. `withTarget` keeps the target; the pair's production preview drops it.
const deployView = (target: string, c: DeployConfig | null, withTarget = true) => ({
  ...(withTarget ? { target } : {}),
  environment: c?.environment ?? "simulated",
  ...(c ? { command: c.command, rollback: c.rollback, env: c.env, health_url: c.health_url,
    ...(c.checks && { checks: c.checks }),
    ...(c.metrics_url && { metrics_url: c.metrics_url }),
    ...(c.max_error_rate !== undefined && { max_error_rate: c.max_error_rate }) } : {}),
});

// The only merge/deploy and escalation point. Approval only counts if the evidence still holds.
export const ceoApproval = async (t: T): Promise<Partial<T>> => {
  // A healthy staging pause asks whether to deploy to production; anything but "approve" (including `orch reject`'s abort)
  // leaves the ticket on staging. Checked before the abort branch so a reject here is not_promoted, not aborted.
  if (t.status === "promote") {
    const r = interrupt({ type: "promote", ticket: t.id, title: t.title, summary: t.summary, deploy: deployView(t.deploy_target, stageOf(t.deploy_cfg!, true)) }) as string;
    if (r === "approve") return { status: "promoting", promoted: true, history: log(t, "ceo_approval", "promote approved") };
    const answer = r.replace(/^abort:?\s*/, "").trim() || "rejected";
    return { status: "not_promoted", summary: `not promoted: ${answer}`.slice(0, 500), history: log(t, "ceo_approval", "not promoted") };
  }
  const v = t.status === "approval" && t.evidence.length ? verifyTicket(t) : null;
  const reason =
    t.status === "approval"
      ? v?.ok
        ? v.sha === t.approved_sha
          ? null
          : "commit changed since it was published"
        : `invalid evidence: ${v ? v.reason : "no evidence"}`
      : t.status === "dev_failed"
        ? `cap of ${MAX_REVISIONS} attempts reached: ${t.summary}\n${changedWork(t)}`
        : t.status === "no_change"
          ? `the dev found nothing to change: ${t.explanation}`
          : t.status === "host_review"
            ? `the diff changes files that run code on the host (${t.host_pending.join(", ")}): approve allows exactly these versions`
            : `${t.status}: ${t.summary}`;
  const last = t.history.at(-1);
  const manual = manualCriteria(t.worktree, t.criteria, t.criteria_tests);
  const d = t.status === "discovery_questions" ? t.discovery_output : null;
  const stage = t.deploy_cfg ? stageOf(t.deploy_cfg, false) : null;
  const r = interrupt(d ? { type: "discovery", ticket: t.id, title: t.title, problem: d.problem, assumptions: d.assumptions, questions: d.questions } : {
    type: ["no_change", "host_review"].includes(t.status) ? t.status : reason ? "escalation" : "approval",
    reason,
    ticket: t.id,
    title: t.title,
    revisions: t.revisions,
    last_node: last ? `${last.node}: ${last.result}` : "",
    summary: t.summary,
    explanation: t.explanation,
    brief: t.brief,
    evidence: t.evidence,
    ...(t.load_note ? { load: t.load_note } : {}),
    ...(t.status === "host_review" ? { host_diff: hostDiff(t) } : {}),
    ...(t.test_alerts.length ? { test_alerts: t.test_alerts } : {}),
    ...(manual.length ? { manual_criteria: manual } : {}),
    deploy: {
      ...deployView(t.deploy_target, stage),
      ...(promotes(t.deploy_cfg) ? { production: deployView(t.deploy_target, stageOf(t.deploy_cfg, true), false) } : {}),
    },
    active_flags: Object.entries(t.flags)
      .filter(([, active]) => active)
      .map(([k]) => k),
  }) as string;
  const h = (res: string) => log(t, "ceo_approval", res);
  if (/^abort(:|$)/.test(r)) return { status: "aborted", history: h(r === "abort" ? "aborted" : `aborted (${r.slice(6, 300).trim()})`) };
  if (d)
    return {
      status: "rediscover",
      discovery_round: t.discovery_round + 1,
      discovery_answers: [...t.discovery_answers, isBareApproval(r) ? "accept every default" : r],
      history: h("answered"),
    };
  if (t.status === "host_review" && r === "approve")
    return {
      status: "reverify",
      host_approved: [...t.host_approved, ...t.host_pending],
      host_pending: [],
      history: h(`host files approved: ${t.host_pending.join(", ")}`),
    };
  if (!reason) {
    if (r === "approve") return { status: "approved", history: h("approved") };
    const summary = `CEO rejected: ${r}`.slice(0, 500);
    return { status: "dev_failed", revisions: t.revisions + 1, summary, rejections: [...t.rejections, summary], history: h("rejected") };
  }
  // No change needed: approve closes the ticket; any other text is an instruction for the dev (below).
  if (t.status === "no_change" && r === "approve") return { status: "closed", history: h("closed: no change needed") };
  // A failed merge (CI red, PR moved): "retry" runs it again, anything else is an instruction for the dev.
  if (t.history.at(-1)?.node === "merge_pr" && r === "retry") return { status: "approved", history: h("merge retry") };
  // A node that stopped on an error or timeout: "retry" runs just that node again, not the dev.
  // Only for the commit that was reviewed: a new commit in the worktree must go back through the dev and both reviews.
  // The failure text stays out of the retried node's context (and out of the PR body).
  const sameCommit = () =>
    (t.failed_node === "deploy" && t.promoted) || // a promoted deploy runs the approved commit from a fresh checkout; the ticket worktree is gone
    !POST_DEV.includes(t.failed_node) ||
    t.evidence.includes(`commit:${safeGit(t.worktree, "rev-parse", "--short", "HEAD")}`);
  if (r === "retry" && t.status === "escalated" && RETRYABLE.includes(t.failed_node) && sameCommit())
    return { status: "retry", summary: t.summary_before_failure, history: h("retry") };
  // Any other escalation: the CEO instructs the dev (only if criteria already exist).
  if (!t.criteria.length) return { status: "aborted", history: h("aborted") };
  return { status: "dev_failed", revisions: 0, summary: `CEO instructed: ${r}`.slice(0, 500), history: h("resumed") };
};

const LIST_LINES = 40;
const capped = (title: string, out: string) => {
  const lines = out.split("\n").filter(Boolean);
  return lines.length ? `${title}:\n${lines.slice(0, LIST_LINES).join("\n")}${lines.length > LIST_LINES ? `\n[${lines.length - LIST_LINES} more lines]` : ""}` : "";
};
const changedWork = (t: T) =>
  [
    capped("Changed files", safeGit(t.worktree, "diff", "--name-status", `${t.base}..HEAD`)),
    capped("Diff stat", safeGit(t.worktree, "diff", "--stat", `${t.base}..HEAD`)),
    capped("Uncommitted", safeGit(t.worktree, "status", "--porcelain")),
  ]
    .filter(Boolean)
    .join("\n");

// What the CEO approves: the diff of each pending host file (path@blob), as text whatever .gitattributes says, never cut silently.
const HOST_DIFF_CHARS = 20_000;
const hostDiff = (t: T) => {
  const paths = t.host_pending.map((k) => k.slice(0, k.lastIndexOf("@")));
  const diff = safeGit(t.worktree, "--literal-pathspecs", "diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", t.base, "HEAD", "--", ...paths);
  if (diff.length <= HOST_DIFF_CHARS) return diff;
  // The full diff goes to a file of ours, never as a command to paste: a plain git diff would honour the repo's diff drivers.
  const file = join(orchHome(), `host-diff-${t.id}.diff`);
  writeFileSync(file, diff);
  return `${diff.slice(0, HOST_DIFF_CHARS)}\n[TRUNCATED: the full diff is in ${file}]`;
};

const RETRYABLE = ["triage", "discovery", "planner", "dev", "reviewer", "design", "qa", "webcheck", "load", "publish", "deploy"];
const POST_DEV = ["reviewer", "design", "qa", "webcheck", "load", "publish", "deploy"];
