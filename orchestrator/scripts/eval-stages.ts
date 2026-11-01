// Model choice for triage, planner and devops: runs each role on requests with known answers.
// Usage: node --env-file=.env scripts/eval-stages.ts --models modelA,modelB [--reps 3] [--stages triage,planner,devops]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { z } from "zod";
import { NodeFailure, runAgent as run, type Req } from "../src/run-agent.ts";
import { createFixture, git } from "./fixture.ts";

const { values } = parseArgs({
  options: { models: { type: "string" }, reps: { type: "string", default: "1" }, stages: { type: "string", default: "triage,planner,devops" } },
});
if (!values.models) throw new Error("--models a,b required");

// A node failure (turn limit, bad output) is a miss, not a crash of the eval.
async function runAgent<T>(req: Req<T>) {
  try {
    return await run(req);
  } catch (e) {
    if (!(e instanceof NodeFailure)) throw e;
    return { failed: e.message } as const;
  }
}
const flag = z.boolean();
const Flags = z.object({
  touches_security: flag, touches_performance: flag, touches_ai: flag, touches_schema: flag,
  touches_public_api: flag, touches_permissions: flag, touches_external_integration: flag, touches_cost: flag,
});
const Plan = z.object({
  title: z.string(), priority: z.enum(["P0", "P1", "P2", "Bug"]),
  specialty: z.enum(["frontend", "backend", "fullstack", "mobile", "integrations", "ai", "data"]),
  clear: z.boolean(), flags: Flags, criteria: z.array(z.string()), summary: z.string().describe("at most 10 lines"),
});
const PlanQ = Plan.extend({ question: z.string() });
const Dev = z.object({ summary: z.string().describe("at most 10 lines") });

type Exp = { clear: boolean; priority?: string; specialty?: string; flag?: keyof z.infer<typeof Flags> };
const requests: { text: string; exp: Exp }[] = [
  { text: "Change the checkout button label from 'Submit' to 'Submit order'.", exp: { clear: true, specialty: "frontend", priority: "P2" } },
  { text: "Production is down: no customer can log in since the last deploy (POST /login returns 500). Fix it now. Done when POST /login returns 200 for a valid user and the existing login test passes.", exp: { clear: true, priority: "P0" } },
  { text: "Add a nullable birthdate (date) column to the users table and return it as an ISO date string in GET /users/:id. Done when a migration adds the column, the endpoint returns birthdate or null, and a test covers both.", exp: { clear: true, specialty: "backend", flag: "touches_schema" } },
  { text: "Regression: the cart total shows NaN when the cart is empty. Done when an empty cart shows $0.00 and a test covers the empty cart.", exp: { clear: true, priority: "Bug" } },
  { text: "The support chatbot (LLM agent) must remember the customer's name across sessions: store it in the agent's memory after the customer states it and greet by name next session. Done when a test with a fake LLM shows the name being recalled in a new session.", exp: { clear: true, specialty: "ai", flag: "touches_ai" } },
  { text: "Add POST /webhooks/stripe that verifies the Stripe signature and, on payment_intent.succeeded, marks the matching order as paid. Done when a bad signature returns 400, a valid event marks the order paid, and a replayed event is ignored (idempotent).", exp: { clear: true, specialty: "integrations", flag: "touches_external_integration" } },
  { text: "Add a discount to the cart.", exp: { clear: false } },
  { text: "Make the app better.", exp: { clear: false } },
  { text: "We need reports.", exp: { clear: false } },
];

const check = (o: z.infer<typeof Plan>, e: Exp) =>
  o.clear === e.clear && (!e.priority || o.priority === e.priority) && (!e.specialty || o.specialty === e.specialty) && (!e.flag || o.flags[e.flag]);

const repo = createFixture(mkdtempSync(`${tmpdir()}/stages-`));
const reps = Number(values.reps);
const sum = (u: { tokens_in: number; tokens_out: number; cache_read: number; cache_create: number }) => u.tokens_in + u.tokens_out + u.cache_read + u.cache_create;

for (const model of values.models.split(",")) {
  for (const stage of values.stages.split(",")) {
    process.env[`MODEL_${stage.toUpperCase()}`] = model;
    let right = 0, total = 0, tokens = 0, usd = 0;
    const lines: string[] = [];
    if (stage === "triage" || stage === "planner") {
      for (const r of requests) {
        let hits = 0;
        for (let i = 0; i < reps; i++) {
          const planner = stage === "planner";
          const res = await runAgent({
            role: stage, cwd: repo, schema: planner ? PlanQ : Plan,
            files: planner ? ["demand-analyst", "product-manager", "tech-lead"] : ["triage"],
            context: `CEO request: ${r.text}\n\n` + (planner
              ? "If missing information prevents verifiable acceptance criteria, set clear=false and put what is missing in `question`.\n\n"
              : "") + "Answer only in the structured format. `summary`: up to 10 lines.",
          });
          if ("failed" in res) { lines.push(`FAIL "${r.text.slice(0, 40)}": ${res.failed}`); continue; }
          const { output, usage } = res;
          // The planner is only judged on routing and on having criteria when it says clear.
          const ok = check(output, planner ? { clear: r.exp.clear } : r.exp) && (!planner || !output.clear || output.criteria.length >= 2);
          hits += +ok;
          tokens += sum(usage);
          usd += usage.cost_usd;
          if (!ok) lines.push(`MISS "${r.text.slice(0, 40)}" -> clear=${output.clear} ${output.priority}/${output.specialty} criteria=${output.criteria.length}`);
        }
        right += hits;
        total += reps;
      }
    } else {
      // devops must describe a rollback and must not touch the repo (no commits, no branches, clean tree).
      for (let i = 0; i < reps * 3; i++) {
        const before = git(repo, "rev-parse", "HEAD") + git(repo, "branch", "--list") + git(repo, "status", "--porcelain");
        const res = await runAgent({
          role: "devops", cwd: repo, schema: Dev, files: ["devops-sre"],
          context: "Ticket T-1: Change the checkout button label to 'Submit order'\nAcceptance criteria:\n- the button reads 'Submit order'\nThe CEO approved. Simulation: do NOT run a deploy or a merge. Describe status, rollback plan and observability.\n\nAnswer only in the structured format. `summary`: up to 10 lines.",
        });
        if ("failed" in res) { total++; lines.push(`FAIL devops: ${res.failed}`); continue; }
        const { output, usage } = res;
        const after = git(repo, "rev-parse", "HEAD") + git(repo, "branch", "--list") + git(repo, "status", "--porcelain");
        const ok = before === after && /rollback|revert/i.test(output.summary);
        right += +ok;
        total++;
        tokens += sum(usage);
        usd += usage.cost_usd;
        if (!ok) lines.push(`MISS repo ${before === after ? "untouched" : "CHANGED"}; summary: ${output.summary.replaceAll("\n", " ").slice(0, 200)}`);
      }
    }
    console.log(`${model} ${stage}: ${right}/${total} correct, ${tokens} tokens, US$${usd.toFixed(3)}${lines.length ? "\n  " + lines.join("\n  ") : ""}`);
  }
}
