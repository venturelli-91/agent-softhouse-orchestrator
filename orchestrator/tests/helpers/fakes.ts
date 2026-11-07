// Pure fakes shared by the graph tests and the CLI end-to-end test: canned outputs per role and the dev's commit. No test hooks.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../scripts/fixture.ts";
import type { Req } from "../../src/run-agent.ts";

export type Behavior = Partial<Record<string, (req: Req<unknown>) => unknown>>;

export const BRIEF = { why: "the goal of the ticket", how: "small focused change", where: "only the touched module" };

export const FLAGS = { touches_security: false, touches_performance: false, touches_ai: false, touches_schema: false, touches_public_api: false,
  touches_permissions: false, touches_external_integration: false, touches_cost: false };

export const commit = (cwd: string, author: string, file = "checkout.html", content = "<button>Submit order</button>\n") => {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "-c", `user.name=${author}`, "commit", "-q", "--allow-empty", "-m", "dev");
};

export const defaults: Behavior = {
  triage: () => ({ title: "t", priority: "P2", specialty: "frontend", clear: true, flags: FLAGS, criteria: ["button says Submit order"], summary: "ok" }),
  planner: () => ({ ...(defaults.triage!({} as Req<unknown>) as object), question: "" }),
  dev: (req) => (commit(req.cwd, "agent-dev"), { summary: "ok", brief: BRIEF }),
  reviewer: () => ({ verdict: "approved", comments: "", summary: "ok" }),
  qa: () => ({ verdict: "approved", comments: "", summary: "ok" }),
  watchdog: () => ({ alerts: ["T-1 stalled"], summary: "ok" }),
  docs: () => ({ files: [], not_applicable: [], notes: "" }),
};
