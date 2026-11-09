import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEV_FILE, SPECIALTIES } from "../src/ticket.ts";

const AGENTS = resolve(import.meta.dirname, "..", "agents");
const prompt = (role: string) => join(AGENTS, `${role}.md`);

// Roles the graph loads by name besides the devs (plan-nodes, review-nodes, docs-node, postmortem, watchdog).
const GRAPH_ROLES = [
  "triage", "demand-analyst", "product-manager", "tech-lead", "code-reviewer", "qa-automation",
  "security", "performance", "evals-engineer", "docs", "knowledge-manager", "watchdog",
];

test("every specialty has a dev prompt, and every role the graph loads has a prompt", () => {
  assert.deepEqual(Object.keys(DEV_FILE).sort(), [...SPECIALTIES].sort());
  const missing = [...Object.values(DEV_FILE), ...GRAPH_ROLES].filter((r) => !existsSync(prompt(r)));
  assert.deepEqual(missing, [], `missing in orchestrator/agents: ${missing.join(", ")}`);
});

test("the framework agents (.claude/agents, a valid AGENTS_DIR) also cover every role the graph loads", () => {
  const dir = resolve(AGENTS, "..", "..", ".claude", "agents");
  const missing = [...Object.values(DEV_FILE), ...GRAPH_ROLES].filter((r) => !existsSync(join(dir, `${r}.md`)));
  assert.deepEqual(missing, [], `missing in .claude/agents: ${missing.join(", ")}`);
});

test("each prompt's front matter name matches its file name", () => {
  for (const role of [...Object.values(DEV_FILE), ...GRAPH_ROLES]) {
    const name = readFileSync(prompt(role), "utf8").match(/^name:\s*(\S+)/m)?.[1];
    assert.equal(name, role, `${role}.md declares name ${name}`);
  }
});
