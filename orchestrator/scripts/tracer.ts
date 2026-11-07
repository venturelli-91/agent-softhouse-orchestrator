// Tracer bullet: one ticket with the real model and an isolated worktree, in a disposable fixture or in --repo <path>.
// --db <file> keeps the state on disk so a paused ticket can be answered later with --resume (same --db and --id).
import { mkdtempSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createFixture } from "./fixture.ts";
import { FileSaver } from "../src/file-saver.ts";
import { config, createWorktree, buildGraph, report, resume } from "../src/graph.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repo: { type: "string" }, db: { type: "string" }, resume: { type: "boolean" }, id: { type: "string", default: "T-001" },
    mermaid: { type: "boolean" }, clean: { type: "boolean" } },
});
const root = mkdtempSync(join(tmpdir(), "orch-"));
const repo = values.repo ?? createFixture(root);

const id = values.id!;
const graph = buildGraph(values.db ? new FileSaver(values.db) : undefined);
const cfg = config(id);
const request = positionals[0] ?? "Change the text of the 'Submit' button to 'Submit order' on the checkout screen (checkout.html).";

type Paused = { __interrupt__?: { value: unknown }[] };
let r: Awaited<ReturnType<typeof graph.invoke>> & Paused;
if (values.resume) {
  const state = await graph.getState(cfg);
  r = { ...state.values, __interrupt__: state.tasks.flatMap((t) => t.interrupts) } as typeof r;
} else {
  r = await graph.invoke({ id, request, ...createWorktree(repo, id, join(root, `wt-${id}`)) }, cfg);
}
const paused = (x: unknown) => (x as Paused).__interrupt__?.length ? (x as Paused).__interrupt__ : undefined;
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
if (values.clean && !paused(r)) rmSync(root, { recursive: true, force: true });
