import { z } from "zod";
import { MAX_FILE_LINES, MAX_LINE_COLS, verifyTicket } from "./guardrails.ts";
import { commands, skipAlerts, type Test } from "./test-report.ts";
import { context, escalate, guarded, log, rulesBlock, sh, ticketData } from "./graph-kit.ts";
import { runAgent } from "./run-agent.ts";
import { Brief, cap, DEV_FILE, summary, type T } from "./ticket.ts";

const DevOutput = z.object({ summary, brief: Brief, no_change: z.string().optional() });

export const devRules = (tests: Test = "npm test", turns?: number) => {
  const test = commands(tests).join(" and ");
  return `Implement in the current worktree, run ${test} and commit (git add/git commit). Do not push. ` +
  `Also fill \`brief\`: why (the problem or goal this solves), how (approach and key decisions), ` +
  `where it applies (modules, endpoints, screens or users affected, and what is deliberately not touched). ` +
  `Modularity is mandatory: every source file you touch must stay within ${MAX_FILE_LINES} lines and ${MAX_LINE_COLS} columns per line; ` +
  `split by responsibility instead of growing a file. The orchestrator rejects the commit otherwise. ` +
  (turns
    ? `You have at most ${turns} turns and uncommitted work is lost value: ` +
      `get a first version passing ${test} and commit it early, then refine and commit again. `
    : "") +
  `If the request needs no code change (a check or review that finds nothing to fix), commit nothing and set \`no_change\` to what you verified and why: the CEO decides. ` +
  `Run the build and the tests exactly as the repo's scripts define them: never set NODE_ENV yourself, CI does not. ` +
  `Shell: one simple command per call (git add, git commit, git status, git diff, git log, ${test}); ` +
  `no ';', '&&' or pipes, they are denied, so on a denial retry with a single command.`;
};
export const DEV_RULES = devRules();

// `orch adopt`: the code is already written by the CEO; the dev pass only turns it into commits, and code compares the trees.
const ADOPT_RULES =
  "The worktree holds changes the CEO already wrote, uncommitted. Do not edit, create, delete, move or format any file: only commit them. " +
  "Split them into atomic commits, one per logical change, each message following the pattern of this repo's `git log` (type, scope, language). " +
  "Shell: one simple command per call (git status, git diff, git log, git add <paths>, git commit). When you finish nothing may remain uncommitted, " +
  "and the committed content must match the working tree byte for byte, or the orchestrator rejects it. Fill `brief` describing the changes as they are.";

// A dev that stopped (turn limit, timeout) leaves uncommitted work in the worktree: tell the next attempt to build on it instead of starting over.
export const partialWork = (porcelain: string) =>
  porcelain.trim()
    ? [
        `The worktree already has uncommitted work from a previous attempt. Continue from it: do not restart, rename or duplicate it. ` +
          `Review it, make it pass and commit.\n${porcelain.split("\n").slice(0, 40).join("\n")}`,
      ]
    : [];

// Commits already in the worktree (a resumed run or a revision): the dev sees them and must describe the whole ticket, not just this pass.
const DIFF_CHARS = 20_000;
export const committedWork = (t: Pick<T, "worktree" | "base" | "tasks">) => {
  const commits = t.tasks.length ? "" : sh(t.worktree, "log", "--format=%h %s", `${t.base}..HEAD`);
  if (!commits) return [];
  const diff = sh(t.worktree, "diff", "--no-ext-diff", "--no-textconv", t.base, "HEAD");
  return [
    `Commits already in this worktree (a previous attempt or revision):\n${commits}\nDiff so far:\n${diff.slice(0, DIFF_CHARS)}\n` +
      "Build on it, do not redo it. `brief` must describe the whole ticket as it stands now (every commit above), never only this pass, and never claim you made no edits.",
  ];
};

const nothingDone = (t: T) =>
  Number(sh(t.worktree, "rev-list", "--count", `${t.base}..HEAD`)) === 0 && !sh(t.worktree, "status", "--porcelain", "--untracked-files=all");

// With several atomic tasks the dev gets one at a time, fresh context each, and must not start the later ones.
export const taskBlock = (t: Pick<T, "tasks" | "task_done">) => {
  if (!t.tasks.length) return [];
  const last = t.task_done === t.tasks.length - 1;
  return [
    [
      `Task ${t.task_done + 1} of ${t.tasks.length}. Do ONLY this task, in one commit that keeps the verification green: ${t.tasks[t.task_done]}`,
      t.task_done
        ? `Already committed by earlier tasks (build on them, do not redo them):\n${t.tasks
            .slice(0, t.task_done)
            .map((x, i) => `${i + 1}. ${x}`)
            .join("\n")}`
        : "",
      last
        ? "This is the last task: `brief` must describe the whole ticket (all tasks), not just this one."
        : `Later tasks, do not start them:\n${t.tasks
            .slice(t.task_done + 1)
            .map((x, i) => `${t.task_done + i + 2}. ${x}`)
            .join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n"),
  ];
};

export const dev = guarded("dev", async (t) => {
  const before = sh(t.worktree, "rev-parse", "HEAD");
  // The CEO approved the host files of this commit: only the verification runs again (host_review sets brief before it pauses).
  const reverify = t.status === "reverify";
  const porcelain = sh(t.worktree, "status", "--porcelain", "--untracked-files=all");
  const { output, usage } = reverify ? { output: { summary: t.summary, brief: t.brief!, no_change: undefined }, usage: undefined } : await runAgent({
    role: "dev",
    files: [DEV_FILE[t.specialty]],
    cwd: t.worktree,
    schema: DevOutput,
    context: t.adopt_tree
      ? context(ticketData(t), ADOPT_RULES, ...committedWork(t), `Uncommitted:\n${porcelain.split("\n").slice(0, 80).join("\n")}`, ...rulesBlock(t))
      : context(
          ticketData(t),
          devRules(t.test, Number(process.env.TURNS_DEV ?? process.env.TURNS_DEFAULT) || undefined),
          ...taskBlock(t),
          ...committedWork(t),
          ...partialWork(porcelain),
          ...rulesBlock(t),
        ),
    test: t.test,
  });
  if (t.adopt_tree && !sh(t.worktree, "status", "--porcelain", "--untracked-files=all") && sh(t.worktree, "rev-parse", "HEAD^{tree}") !== t.adopt_tree)
    return escalate(t, "dev", "the commits changed the adopted content: compare the ticket branch with what you had in the working tree", usage);
  const v = verifyTicket(t);
  if (!v.ok && output.no_change && !t.tasks.length && nothingDone(t))
    return {
      status: "no_change",
      explanation: output.no_change.split("\n").slice(0, 6).join("\n"),
      brief: output.brief,
      summary: cap(output.summary),
      history: log(t, "dev", "no change needed", usage),
    };
  if (!v.ok && v.host)
    return {
      status: "host_review",
      host_pending: v.host,
      brief: output.brief,
      summary: cap(output.summary),
      history: log(t, "dev", `host files need CEO review: ${v.host.join(", ")}`, usage),
    };
  if (!v.ok) {
    const result = `verification failed: ${v.reason.slice(0, 300)}`;
    // Only structural causes (no commit, forbidden path, dirt): a red suite's output tail looks alike even when another test fails.
    // ponytail: numbers (durations, counts) are ignored when comparing; compare failing test names if suites need it too.
    const same = (r?: string) => r?.replace(/\d+/g, "#") === result.replace(/\d+/g, "#");
    if (!commands(t.test).some((c) => v.reason.startsWith(`${c} failed`)) && same(t.history.filter((h) => h.node === "dev").at(-1)?.result))
      return { ...escalate(t, "dev", `the same verification failure twice in a row: ${v.reason}`, usage), brief: output.brief };
    return {
      status: "dev_failed",
      explanation: cap(output.summary),
      brief: output.brief,
      revisions: t.revisions + 1,
      summary: `verification: ${v.reason}`,
      history: log(t, "dev", result, usage),
    };
  }
  if (t.tasks.length && v.sha === before && !reverify)
    return {
      status: "dev_failed",
      explanation: "",
      revisions: t.revisions + 1,
      summary: `task ${t.task_done + 1} produced no new commit`,
      history: log(t, "dev", "task without commit", usage),
    };
  if (t.task_done + 1 < t.tasks.length)
    return {
      status: "dev_next",
      task_done: t.task_done + 1,
      summary: cap(output.summary),
      history: log(t, "dev", `task ${t.task_done + 1}/${t.tasks.length} committed`, usage),
    };
  return {
    status: "review",
    explanation: "",
    brief: output.brief,
    summary: cap(output.summary),
    author_id: v.author,
    evidence: v.evidence,
    test_alerts: skipAlerts(t.test_base, v.counts),
    adopt_tree: "",
    history: log(t, "dev", t.adopt_tree ? "adopted changes committed and verified" : "commit verified", usage),
  };
});
