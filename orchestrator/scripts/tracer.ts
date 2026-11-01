// Tracer bullet: one ticket with the real model and an isolated worktree, in a disposable fixture or in --repo <path>.
import { mkdtempSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createFixture } from "./fixture.ts";
import { config, createWorktree, buildGraph, report, resume } from "../src/graph.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repo: { type: "string" }, id: { type: "string", default: "T-001" }, mermaid: { type: "boolean" }, clean: { type: "boolean" } },
});
const root = mkdtempSync(join(tmpdir(), "orch-"));
const repo = values.repo ?? createFixture(root);

const id = values.id!;
const wt = createWorktree(repo, id, join(root, `wt-${id}`));
const graph = buildGraph();
const cfg = config(id);
const request = positionals[0] ?? "Change the text of the 'Submit' button to 'Submit order' on the checkout screen (checkout.html).";

let r = await graph.invoke({ id, request, ...wt }, cfg);
const paused = (x: unknown) => (x as { __interrupt__?: { value: unknown }[] }).__interrupt__;
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
while (paused(r)) {
  console.log(JSON.stringify(paused(r)![0].value, null, 1));
  process.stdout.write("CEO (approve / rejection reason): ");
  const next = await lines.next();
  if (next.done) break;
  r = await graph.invoke(resume(next.value.trim()) as never, cfg);
}
process.stdin.destroy();
console.log(report(r));
if (r.status !== "simulated_deploy") console.log(`reason (${r.status}): ${r.summary}`);
if (values.mermaid) console.log((await graph.getGraphAsync()).drawMermaid());
console.log(`worktree kept at ${root} (remove with rm -rf)`);
if (values.clean) rmSync(root, { recursive: true, force: true });
