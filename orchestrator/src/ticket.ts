import { z } from "zod";
import { DEFAULT_TEST, TestSpec } from "./commands.ts";
import { DeployConfig, LoadConfig, WebcheckConfig } from "./repo-config.ts";
import { TestCounts } from "./test-report.ts";
import type { Usage } from "./run-agent.ts";
import { SPECIALTIES } from "./specialties.ts";

export { DEV_FILE, SPECIALTIES } from "./specialties.ts";

export const summary = z.string().describe("at most 10 lines");
export const cap = (s: string) => s.split("\n").slice(0, 10).join("\n");
export const FlagsSchema = z.object({
  touches_security: z.boolean(),
  touches_performance: z.boolean(),
  touches_ai: z.boolean(),
  touches_schema: z.boolean(),
  touches_public_api: z.boolean(),
  touches_permissions: z.boolean(),
  touches_external_integration: z.boolean(),
  touches_cost: z.boolean(),
});
const EMPTY_FLAGS = Object.fromEntries(Object.keys(FlagsSchema.shape).map((k) => [k, false])) as z.infer<typeof FlagsSchema>;

// The graph's only state. `request`, `criteria`, `worktree` and `base` are the minimal extras the code needs.
// Every delivery says why it exists, how it was done and where it applies: it goes into the PR and the CEO notification.
const briefField = z.string().min(10).max(600);
export const Brief = z.object({ why: briefField, how: briefField, where: briefField });
// Agent text lands in a PR body and in reviewer prompts: one paragraph per field, no headings, images or live @mentions.
const plain = (s: string) =>
  s
    .replace(/[\s\u0085]+/g, " ")
    .replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/[\\`*_~!#|[\]]/g, "\\$&")
    .replace(/@(?=\w)/g, "@\u200b")
    .trim();
export const briefMarkdown = (b: z.infer<typeof Brief>) => `## Why\n${plain(b.why)}\n\n## How\n${plain(b.how)}\n\n## Where it applies\n${plain(b.where)}`;

export const BLOCKS = ["problem", "success", "users", "scope", "constraints", "example"] as const;
export const DiscoveryQuestion = z.object({
  block: z.enum(BLOCKS),
  question: z.string().min(5),
  why: z.string().min(5),
  default: z.string().min(1),
});
const briefingText = z.string().default("");
export const BriefingFields = z.object({
  problem: briefingText, success: briefingText, users: briefingText, scope_in: briefingText, scope_out: briefingText, constraints: briefingText, example: briefingText,
});
export const DiscoveryOutput = z.object({
  problem: z.string().min(5),
  assumptions: z.array(z.string()).max(10).default([]),
  questions: z.array(DiscoveryQuestion).max(5),
  ready: z.boolean(),
  briefing: BriefingFields,
});
const BRIEFING_HEADINGS: [keyof z.infer<typeof BriefingFields>, string][] = [
  ["problem", "Problem"], ["success", "Success"], ["users", "Users"], ["scope_in", "Scope in"],
  ["scope_out", "Scope out"], ["constraints", "Constraints"], ["example", "Example"],
];
export const briefingMarkdown = (b: z.infer<typeof BriefingFields>, assumed: z.infer<typeof DiscoveryQuestion>[]) =>
  [
    ...BRIEFING_HEADINGS.filter(([k]) => b[k]).map(([k, h]) => `## ${h}\n${plain(b[k])}`),
    ...(assumed.length ? [`## Assumed defaults\n${assumed.map((a) => `- ${plain(a.question)} → ${plain(a.default)}`).join("\n")}`] : []),
  ].join("\n\n");

export const Ticket = z.object({
  id: z.string(),
  request: z.string(),
  worktree: z.string(),
  base: z.string(),
  repo: z.string().default(""),
  git_config_hash: z.string().default(""),
  test: TestSpec.default(DEFAULT_TEST),
  install: z.boolean().default(false),
  setup_ignored: z.array(z.string()).nullable().default(null),
  setup_env: z.array(z.string()).default([]),
  merge: z.enum(["pr", "auto", "local"]).default("pr"),
  publisher: z.string().default(""),
  push_remote: z.string().default("origin"),
  base_repo: z.string().default(""),
  disclosure: z.boolean().default(true),
  base_branch: z.string().default(""),
  approved_sha: z.string().default(""),
  host_pending: z.array(z.string()).default([]),
  host_approved: z.array(z.string()).default([]),
  test_base: TestCounts.nullable().default(null),
  test_alerts: z.array(z.string()).default([]),
  test_last: TestCounts.nullable().default(null),
  project_docs: z.array(z.string()).default([]),
  // `orch adopt`: the tree of the CEO's own changes; the first dev pass only commits it, unchanged.
  adopt_tree: z.string().default(""),
  rules: z.string().default(""),
  title: z.string().default(""),
  priority: z.enum(["P0", "P1", "P2", "Bug"]).default("P2"),
  specialty: z.enum(SPECIALTIES).default("fullstack"),
  specialties: z.array(z.enum(SPECIALTIES)).default([...SPECIALTIES]),
  flags: FlagsSchema.default(EMPTY_FLAGS),
  criteria: z.array(z.string()).default([]),
  status: z.string().default("new"),
  failed_node: z.string().default(""),
  summary_before_failure: z.string().default(""),
  summary: z.string().default(""),
  explanation: z.string().default(""),
  brief: Brief.nullable().default(null),
  tasks: z.array(z.string()).default([]),
  task_done: z.number().default(0),
  briefing: z.string().default(""),
  discovery_round: z.number().default(0),
  discovery_answers: z.array(z.string()).default([]),
  discovery: DiscoveryOutput.nullable().default(null),
  stories: z.array(z.string()).default([]),
  incident: z.string().default(""),
  deploy_target: z.string().default("simulated"),
  deploy_cfg: DeployConfig.nullable().default(null),
  webcheck_cfg: WebcheckConfig.nullable().default(null),
  load_cfg: LoadConfig.nullable().default(null),
  load_note: z.string().default(""),
  author_id: z.string().nullable().default(null),
  reviewer_id: z.string().nullable().default(null),
  design_id: z.string().nullable().default(null),
  qa_id: z.string().nullable().default(null),
  revisions: z.number().default(0),
  evidence: z.array(z.string()).default([]),
  docs_warnings: z.array(z.string()).default([]),
  rejections: z.array(z.string()).default([]),
  history: z.array(z.object({ node: z.string(), time: z.string(), result: z.string(), ms: z.number(), usage: z.custom<Usage>().optional() })).default([]),
});
export type T = z.infer<typeof Ticket>;
