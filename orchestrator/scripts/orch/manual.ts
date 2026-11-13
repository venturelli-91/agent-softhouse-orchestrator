// Manual tickets: the human runs the command and attaches the evidence; no agent and no graph run.
import { resolve } from "node:path";
import { createManual, isManual, recordEvidence } from "../../src/manual.ts";
import { type Ctx, die } from "./ctx.ts";
import { attach, demandOf } from "./demand.ts";

export async function manual(c: Ctx) {
  const usage = 'usage: orch manual "<title>" --command "<cmd>" --criteria "<text>" [--criteria ...] [--expect a.json,b.csv] [--id <id>] [--demand <id>]';
  const title = c.positionals[0]?.trim() || die(usage);
  const command = c.values.command?.trim() || die(usage);
  const criteria = (c.values.criteria ?? []).map((s) => s.trim()).filter(Boolean);
  if (!criteria.length) die(usage);
  const expect = (c.values.expect ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const id = c.values.id ?? `M-${Date.now().toString(36)}`;
  const demand = demandOf(c);
  try {
    createManual(c.home, { id, title, command, criteria, expect });
  } catch (e) {
    die((e as Error).message);
  }
  await attach(c, demand, id);
  console.log(`${id}: run it yourself (the orchestrator never does), then attach the output:
  ${command}
acceptance criteria:
${criteria.map((s) => `  - ${s}`).join("\n")}
then: orch evidence ${id} ${expect.length ? expect.join(" ") : "<files>"} --exit <exit code>`);
}

export async function evidence(c: Ctx) {
  const usage = "usage: orch evidence <id> <files...> --exit <exit code>";
  const [id, ...files] = c.positionals;
  if (!id || !files.length) die(usage);
  const exit = /^-?\d+$/.test(c.values.exit ?? "") ? Number(c.values.exit) : die(usage);
  // `npm run` moves to orchestrator/: paths are relative to where the human typed the command.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  let verdict = { ok: false, result: "" };
  await c.locked(id, async () => {
    if (!isManual(c.home, id)) die(`no manual ticket ${id}`);
    verdict = recordEvidence(c.home, id, files.map((f) => resolve(cwd, f)), exit);
  });
  if (!verdict.ok) die(`${id}: ${verdict.result}`);
  console.log(`${id}: closed - ${verdict.result}`);
}
