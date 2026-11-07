import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../scripts/fixture.ts";
import { createWorktree } from "../src/graph.ts";
import { registerExecutor, type Req } from "../src/run-agent.ts";
import { applyTeam, proposeTeam } from "../src/team.ts";

const proposal = { specialties: ["frontend", "backend"], stack: "Next.js + Postgres", existing_stack: true, test: "npm test", rationale: "already there" };
const usage = { tokens_in: 1, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 };
let seen = "";
let sawUntracked = true;
let sawTracked = false;
registerExecutor("fake-team", {
  async run<T>(req: Req<T>) {
    seen = req.context;
    sawUntracked = existsSync(join(req.cwd, "untracked.txt"));
    sawTracked = existsSync(join(req.cwd, ".orchestrator.json"));
    return { output: req.schema.parse(proposal), usage };
  },
});

test("the agents propose a team and stack; applying keeps what the config already had, and the stack reaches the dev rules", async () => {
  process.env.EXECUTOR = "fake-team";
  const d = mkdtempSync(join(tmpdir(), "team-"));
  try {
    git(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, ".orchestrator.json"), JSON.stringify({ merge: "local", test: "node -e 0" }));
    git(d, "add", "-A");
    git(d, "commit", "-qm", "base");
    writeFileSync(join(d, "untracked.txt"), "x");
    const p = await proposeTeam(d, "a checkout page with an orders API");
    assert.match(seen, /checkout page/);
    assert.match(seen, /respect it/);
    assert.equal(sawUntracked, false);
    assert.equal(sawTracked, true);
    applyTeam(d, p);
    assert.deepEqual(JSON.parse(readFileSync(join(d, ".orchestrator.json"), "utf8")), {
      merge: "local", test: "node -e 0", specialties: ["frontend", "backend"], stack: "Next.js + Postgres",
    });
    git(d, "commit", "-qam", "team");
    const wt = createWorktree(d, "T-1", join(d, "..", `${d.split(/[\\/]/).pop()}-wt`));
    assert.deepEqual(wt.specialties, ["frontend", "backend"]);
    assert.match(wt.rules, /Stack decided for this repo: Next\.js \+ Postgres/);
    git(d, "worktree", "remove", "--force", wt.worktree);
  } finally {
    delete process.env.EXECUTOR;
    rmSync(d, { recursive: true, force: true });
  }
});
