import { z } from "zod";
import { SPECIALTIES, type Specialty } from "./specialties.ts";
import { briefingMarkdown, cap, DiscoveryOutput, FlagsSchema, summary, type T } from "./ticket.ts";
import { context, guarded, log } from "./graph-kit.ts";
import { runAgent } from "./run-agent.ts";

const TriageOutput = z.object({
  title: z.string(),
  priority: z.enum(["P0", "P1", "P2", "Bug"]),
  specialty: z.enum(SPECIALTIES),
  clear: z.boolean(),
  flags: FlagsSchema,
  criteria: z.array(z.string()),
  summary,
  split: z.array(z.string().max(300)).max(8).default([]),
});
const PlanOutput = TriageOutput.extend({ briefing: z.string().default(""), stories: z.array(z.string()).default([]) });

// The repo's own team: only its specialties are valid answers, and the model is told which ones.
const only = (t: T) => z.enum(t.specialties as [Specialty, ...Specialty[]]);
const teamNote = (t: T) => (t.specialties.length < SPECIALTIES.length ? [`Specialties available in this repo: ${t.specialties.join(", ")}.`] : []);

// Divide and conquer: one dev session handles one atomic task. Work that needs more is split into an ordered list of tasks
// that the dev runs one at a time in the same worktree, one commit and one verification each.
export const SPLIT_RULE =
  "`split`: if the work needs more than one small commit (several layers, or roughly more than 10 files), " +
  "break it into ordered atomic tasks, at most 8, one line each, " +
  "every one leaving the verification green and building on the previous; otherwise leave it empty.";
const tasksOf = (split: string[]) => (split.length > 1 ? split : []);

export const triage = guarded("triage", async (t) => {
  const { output, usage } = await runAgent({
    role: "triage",
    files: ["triage"],
    cwd: t.worktree,
    schema: TriageOutput.extend({ specialty: only(t) }),
    context: context(`CEO request: ${t.request}`, ...teamNote(t), SPLIT_RULE),
  });
  const { clear, summary, split, ...rest } = output;
  return {
    ...rest,
    tasks: tasksOf(split),
    task_done: 0,
    priority: t.incident ? ("P0" as const) : rest.priority,
    criteria: clear ? rest.criteria : [],
    summary: cap(summary),
    status: clear ? "dev" : "ambiguous",
    history: log(t, "triage", clear ? "clear" : "ambiguous", usage),
  };
});

// Finds out what the CEO needs before planning: at most two rounds of questions, then the open ones take their defaults.
export const discovery = guarded("discovery", async (t) => {
  const { output, usage } = await runAgent({
    role: "discovery",
    files: ["discovery"],
    cwd: t.worktree,
    schema: DiscoveryOutput,
    context: context(
      `CEO request: ${t.request}`,
      `Triage (unclear request): ${t.summary}`,
      ...t.discovery_answers.map((a, i) => `CEO answers (round ${i + 1}): ${a}`),
    ),
  });
  if (!output.ready && output.questions.length && t.discovery_round < 2)
    return { status: "discovery_questions", discovery_output: output, history: log(t, "discovery", "questions", usage) };
  return {
    status: "planned_input",
    discovery_output: output,
    briefing: briefingMarkdown(output.briefing, output.ready ? [] : output.questions),
    history: log(t, "discovery", output.ready ? "ready" : "defaults assumed", usage),
  };
});

// demand-analyst -> product-manager -> tech-lead in a single agent turn (tokens: one context only).
// Without closed criteria there is no ticket: it escalates to the CEO, who can only abort it.
export const planner = guarded("planner", async (t) => {
  const { output, usage } = await runAgent({
    role: "planner",
    files: ["demand-analyst", "product-manager", "tech-lead"],
    cwd: t.worktree,
    schema: PlanOutput.extend({ specialty: only(t) }),
    context: context(
      `CEO request: ${t.request}`,
      ...(t.briefing ? [`Briefing:\n${t.briefing}`] : []),
      "Acceptance criteria must trace back to the briefing's success and scope.",
      ...teamNote(t),
      SPLIT_RULE,
    ),
  });
  const { clear, split, ...plan } = output;
  if (!clear || !plan.criteria.length) return { status: "ambiguous", summary: cap(plan.summary), history: log(t, "planner", "ambiguous", usage) };
  return {
    ...plan,
    briefing: plan.briefing || t.briefing,
    tasks: tasksOf(split),
    task_done: 0,
    priority: t.incident ? ("P0" as const) : plan.priority,
    summary: cap(plan.summary),
    status: "dev",
    history: log(t, "planner", "clear", usage),
  };
});
