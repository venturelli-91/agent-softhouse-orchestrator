// `orch demand`: a demand's tasks, its decision log and the blocking checklist that closes it.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readBacklog } from "../../src/backlog.ts";
import {
  addTask, answer, ask, closeDemand, closingChecklist, createDemand, type Demand, demandIds, isDemand, pending, readDemand, type TaskState, waitingDays,
} from "../../src/demand.ts";
import { safeGit } from "../../src/guardrails.ts";
import { isManual, readManual } from "../../src/manual.ts";
import { ticketFile } from "../../src/ticket-store.ts";
import { type Ctx, die } from "./ctx.ts";

const USAGE = `usage: orch demand new "<title>" [--repo <path>] [--id <id>]
       orch demand ask <id> "<question>" --owner <who> [--task <ticket>]
       orch demand answer <id> <n> "<answer>"
       orch demand close <id>`;

const attempt = <R>(fn: () => R): R => {
  try {
    return fn();
  } catch (e) {
    return die((e as Error).message);
  }
};

export async function demand(c: Ctx) {
  const [sub, id, ...rest] = c.positionals;
  if (sub === "new") {
    const title = id?.trim() || die(USAGE);
    const d = attempt(() => createDemand(c.home, { id: c.values.id ?? `D-${Date.now().toString(36)}`, title, repo: resolve(c.values.repo ?? c.host) }));
    return console.log(`${d.id}: created; attach tickets with --demand ${d.id} on orch run, adopt or manual`);
  }
  if (!id || !["ask", "answer", "close"].includes(sub ?? "")) die(USAGE);
  await c.locked(id, async () => {
    if (!isDemand(c.home, id)) die(`no demand ${id}`);
    if (sub === "ask") {
      const question = rest[0]?.trim() || die(USAGE);
      const owner = c.values.owner?.trim() || die(USAGE);
      const d = attempt(() => ask(c.home, id, { question, owner, ...(c.values.task ? { task: c.values.task } : {}) }));
      console.log(`${id}: decision #${d.decisions.length} waiting for ${owner}`);
    } else if (sub === "answer") {
      const n = Number(rest[0]);
      const text = rest[1]?.trim() || die(USAGE);
      attempt(() => answer(c.home, id, n, text));
      console.log(`${id}: decision #${n} answered`);
    } else {
      const d = readDemand(c.home, id);
      const checks = closingChecklist(d, await taskStates(c, d), readBacklog(c.home), safeGit(d.repo, "status", "--porcelain"));
      for (const k of checks) console.log(`${k.ok ? "ok  " : "FAIL"} ${k.item}${k.detail ? `: ${k.detail}` : ""}`);
      const closed = attempt(() => closeDemand(c.home, id, checks)).status === "closed";
      console.log(closed ? `${id}: closed` : `${id}: not closed`);
      if (!closed) process.exitCode = 1;
    }
  });
}

async function taskStates(c: Ctx, d: Demand): Promise<TaskState[]> {
  const out: TaskState[] = [];
  for (const id of d.tasks) {
    if (isManual(c.home, id)) {
      const m = readManual(c.home, id);
      out.push({ id, kind: "manual", status: m.status, evidence: m.history.some((h) => h.result.startsWith("evidence:")) });
    } else if (existsSync(ticketFile(c.home, id))) {
      const { ticket } = await c.load(id);
      out.push({ id, kind: "code", status: ticket.status, evidence: ticket.evidence.length > 0 });
    } else out.push({ id, kind: null });
  }
  return out;
}

// `--demand` on run, adopt and manual: checked before anything is created, attached once the ticket exists.
export function demandOf(c: Ctx): string | undefined {
  const id = c.values.demand;
  if (id === undefined) return undefined;
  if (!attempt(() => isDemand(c.home, id))) die(`no demand ${id}`);
  if (readDemand(c.home, id).status !== "open") die(`demand ${id} is closed`);
  return id;
}

export const attach = (c: Ctx, demandId: string | undefined, ticket: string) =>
  demandId ? c.locked(demandId, async () => void attempt(() => addTask(c.home, demandId, ticket))) : Promise.resolve();

export function demandLines(home: string): string[] {
  return demandIds(home).map((id) => {
    const d = readDemand(home, id);
    const days = waitingDays(d);
    const q = pending(d)[0];
    const state = d.status === "closed" ? "closed" : days === null ? "open" : `waiting ${days.toFixed(1)}d`;
    return `${id.padEnd(12)} ${state.padEnd(16)} demand ${d.title} (${d.tasks.length} tasks)${q ? `  <- #${q.n} (${q.owner}): ${q.question}` : ""}`;
  });
}

export async function showDemand(c: Ctx, id: string) {
  const d = readDemand(c.home, id);
  console.log(demandLines(c.home).find((l) => l.startsWith(`${id} `)));
  for (const t of await taskStates(c, d)) console.log(`  task ${t.id} ${t.kind ? `${t.kind} ${t.status}` : "missing"}`);
  d.decisions.forEach((q, i) => {
    const target = q.task ? ` [${q.task}]` : "";
    const reply = q.answered ? `${q.answer} (${q.answered.slice(0, 10)})` : "waiting";
    console.log(`  #${i + 1} ${q.asked.slice(0, 10)} ${q.owner}${target}: ${q.question} -> ${reply}`);
  });
}
