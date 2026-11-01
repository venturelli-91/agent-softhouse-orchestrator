// Tracer bullet: trivial ticket in a disposable fixture repo, with the real model and an isolated worktree.
import { mkdtempSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture.ts";
import { config, createWorktree, buildGraph, report, resume } from "../src/graph.ts";

const root = mkdtempSync(join(tmpdir(), "orch-"));
const repo = createFixture(root);

const id = "T-001";
const wt = createWorktree(repo, id, join(root, `wt-${id}`));
const graph = buildGraph();
const cfg = config(id);
const request = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "Change the text of the 'Submit' button to 'Submit order' on the checkout screen (checkout.html).";

let r = await graph.invoke({ id, request, ...wt }, cfg);
const paused = (x: unknown) => (x as { __interrupt__?: { value: unknown }[] }).__interrupt__;
if (paused(r)) {
  console.log(JSON.stringify(paused(r)![0].value, null, 1));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("CEO (approve / rejection reason): ")).trim();
  rl.close();
  r = await graph.invoke(resume(answer) as never, cfg);
}
console.log(report(r));
if (r.status !== "simulated_deploy") console.log(`reason (${r.status}): ${r.summary}`);
if (process.argv.includes("--mermaid")) console.log((await graph.getGraphAsync()).drawMermaid());
console.log(`worktree kept at ${root} (remove with rm -rf)`);
if (process.argv.includes("--clean")) rmSync(root, { recursive: true, force: true });
