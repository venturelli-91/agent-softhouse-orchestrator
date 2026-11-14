import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createFixture, git } from "../scripts/fixture.ts";
import { devNull } from "../src/git-safe.ts";
import { buildGraph, config, createWorktree } from "../src/graph.ts";
import { answer, paused, roots } from "./helpers/graph-harness.ts";

const python = spawnSync("python", ["--version"]).status === 0;

function repoWith(files: Record<string, string>, cfg: object, lock = false) {
  const root = mkdtempSync(join(tmpdir(), "sh-"));
  roots.push(root);
  const repo = createFixture(root);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c);
  if (lock) spawnSync("npm install --package-lock-only --ignore-scripts", { cwd: repo, shell: true });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "files");
  writeFileSync(join(process.env.ORCH_HOME!, "config.json"), JSON.stringify({ repos: { [resolve(repo)]: cfg } }));
  return { repo, wt: join(root, "wt") };
}

async function finish(r: { repo: string; wt: string }) {
  const graph = buildGraph(new MemorySaver());
  const cfg = config("T-1");
  const state = await graph.invoke({ id: "T-1", request: "p", ...createWorktree(r.repo, "T-1", r.wt) }, cfg);
  assert.equal(paused(state)?.type, "approval");
  return (await answer({ graph, cfg } as never, "approve")).status;
}

const PIP = { "test_ok.py": "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        pass\n" };

test("a pip repo goes setup, test and evidence to completion", { skip: !python && "python is not on PATH" }, async () => {
  const r = repoWith(PIP, { test: "python -m unittest", setup: ["python -m pip --version"] });
  assert.equal(await finish(r), "simulated_deploy");
});

test("an npm repo with install: true goes install, test and evidence to completion", async () => {
  assert.equal(await finish(repoWith({}, { install: true }, true)), "simulated_deploy");
});

test("setup runs with a minimal env plus the listed names, hooks off and the worktree as cwd", () => {
  const out = join(mkdtempSync(join(tmpdir(), "sh-out-")), "env.json");
  const dump = `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), env: process.env }));\n`;
  const r = repoWith({ "dump.cjs": dump }, { setup: ["node dump.cjs"], env: ["LISTED_TOKEN"] });
  const names = ["ANTHROPIC_API_KEY", "UNLISTED_SECRET", "LISTED_TOKEN"];
  Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-x", UNLISTED_SECRET: "u", LISTED_TOKEN: "l" });
  try {
    createWorktree(r.repo, "T-1", r.wt);
  } finally {
    for (const k of names) delete process.env[k];
  }
  const { cwd, env } = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(resolve(cwd), resolve(r.wt));
  assert.equal(env.LISTED_TOKEN, "l");
  assert.equal(env.UNLISTED_SECRET, undefined);
  assert.equal(Object.keys(env).some((k) => k.startsWith("ANTHROPIC_")), false);
  assert.equal(env.PIP_CONFIG_FILE, devNull);
  assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath");
  assert.equal(env.GIT_CONFIG_VALUE_0, devNull);
});

test("setup commands run in order, and nothing runs when the config has none", () => {
  const log = join(mkdtempSync(join(tmpdir(), "sh-out-")), "log.txt");
  const step = (n: string) => `require("node:fs").appendFileSync(${JSON.stringify(log)}, "${n}");\n`;
  const r = repoWith({ "a.cjs": step("a"), "b.cjs": step("b") }, { setup: ["node a.cjs", "node b.cjs"] });
  createWorktree(r.repo, "T-1", r.wt);
  assert.equal(readFileSync(log, "utf8"), "ab");
  const none = repoWith({ "a.cjs": step("x") }, {});
  createWorktree(none.repo, "T-2", none.wt);
  assert.equal(readFileSync(log, "utf8"), "ab");
});

test("a setup command that exits non-zero rolls back the worktree and the branch", () => {
  const r = repoWith({ "fail.cjs": "process.exit(3);\n" }, { setup: ["node fail.cjs"] });
  assert.throws(() => createWorktree(r.repo, "T-1", r.wt), /setup failed \(node fail\.cjs\)/);
  assert.equal(existsSync(r.wt), false);
  assert.equal(git(r.repo, "branch", "--list", "ticket/*"), "");
  assert.equal(git(r.repo, "worktree", "list").split("\n").length, 1);
});
