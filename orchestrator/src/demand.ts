// A demand groups its tasks (code and manual tickets) and its decision log until a blocking checklist closes it
// (ORCH_HOME/demands/<id>.json). Task status is never copied here: it is read from each ticket's own store when needed.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BacklogItem } from "./backlog.ts";
import { checkId } from "./ticket-store.ts";

export type Decision = { question: string; owner: string; task?: string; asked: string; answer?: string; answered?: string };
export type Demand = {
  id: string;
  title: string;
  repo: string;
  tasks: string[];
  decisions: Decision[];
  status: "open" | "closed";
  history: { time: string; result: string }[];
};
// What the checklist needs from a task, gathered by the caller from the ticket stores; null = the ticket no longer exists.
export type TaskState = { id: string; kind: "code" | "manual"; status: string; evidence: boolean } | { id: string; kind: null };

const dir = (home: string) => join(home, "demands");

export function demandFile(home: string, id: string): string {
  checkId(id);
  return join(dir(home), `${id}.json`);
}

export const isDemand = (home: string, id: string) => existsSync(demandFile(home, id));
export const readDemand = (home: string, id: string): Demand => JSON.parse(readFileSync(demandFile(home, id), "utf8"));
export const demandIds = (home: string) =>
  existsSync(dir(home)) ? readdirSync(dir(home)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
const write = (home: string, d: Demand, flag = "w") => writeFileSync(demandFile(home, d.id), `${JSON.stringify(d, null, 1)}\n`, { flag });
const logged = (d: Demand, result: string, now: Date) => [...d.history, { time: now.toISOString(), result }];

export function createDemand(home: string, d: Pick<Demand, "id" | "title" | "repo">, now = new Date()): Demand {
  const demand: Demand = { ...d, tasks: [], decisions: [], status: "open", history: [{ time: now.toISOString(), result: "created" }] };
  mkdirSync(dir(home), { recursive: true });
  try {
    write(home, demand, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`demand ${d.id} already exists`);
    throw e;
  }
  return demand;
}

// The mutations below run under the demand's lock (the CLI's `locked`).
function update(home: string, id: string, fn: (d: Demand) => Partial<Demand>): Demand {
  const d = readDemand(home, id);
  if (d.status !== "open") throw new Error(`demand ${id} is ${d.status}`);
  const next = { ...d, ...fn(d) };
  write(home, next);
  return next;
}

export const addTask = (home: string, id: string, ticket: string, now = new Date()) =>
  update(home, id, (d) => ({ tasks: [...d.tasks, ticket], history: logged(d, `task ${ticket}`, now) }));

export const ask = (home: string, id: string, q: Pick<Decision, "question" | "owner" | "task">, now = new Date()) =>
  update(home, id, (d) => {
    if (q.task && !d.tasks.includes(q.task)) throw new Error(`${q.task} is not a task of ${id}`);
    const decision: Decision = { ...q, asked: now.toISOString() };
    return { decisions: [...d.decisions, decision], history: logged(d, `asked #${d.decisions.length + 1} (${q.owner})`, now) };
  });

export const answer = (home: string, id: string, n: number, text: string, now = new Date()) =>
  update(home, id, (d) => {
    const q = d.decisions[n - 1];
    if (!q) throw new Error(`${id} has no decision #${n}`);
    if (q.answered) throw new Error(`${id} decision #${n} was already answered`);
    const decisions = d.decisions.map((x, i) => (i === n - 1 ? { ...x, answer: text, answered: now.toISOString() } : x));
    return { decisions, history: logged(d, `answered #${n}`, now) };
  });

export const pending = (d: Demand) => d.decisions.map((q, i) => ({ ...q, n: i + 1 })).filter((q) => !q.answered);

// Waiting since the oldest unanswered question; null when nothing is pending.
export function waitingDays(d: Demand, now = Date.now()): number | null {
  const oldest = pending(d)[0];
  return oldest ? (now - Date.parse(oldest.asked)) / 86_400_000 : null;
}

const DELIVERED = { code: ["simulated_deploy", "deployed", "merged"], manual: ["closed"] };

export type Check = { item: string; ok: boolean; detail: string };

export function closingChecklist(d: Demand, tasks: TaskState[], backlog: BacklogItem[], dirty: string): Check[] {
  const decided = new Set(d.decisions.filter((q) => q.answered && q.task).map((q) => q.task));
  const delivered = (t: TaskState) => t.kind !== null && DELIVERED[t.kind].includes(t.status);
  const undecided = tasks.filter((t) => !delivered(t) && !decided.has(t.id)).map((t) => `${t.id} ${t.kind ? t.status : "missing"}`);
  const open = pending(d).map((q) => `#${q.n} (${q.owner})`);
  const caveats = backlog.filter((i) => i.status === "open" && d.tasks.includes(i.ticket)).map((i) => `${i.ticket}: ${i.caveat}`);
  const noEvidence = tasks.filter((t) => delivered(t) && !decided.has(t.id) && !(t.kind && t.evidence)).map((t) => t.id);
  const check = (item: string, failures: string[], ok = "") => ({ item, ok: !failures.length, detail: failures.length ? failures.join("; ") : ok });
  return [
    check("tasks closed or decided", tasks.length ? undecided : ["the demand has no tasks"], `${tasks.length} task(s)`),
    check("decisions answered", open),
    check("backlog reviewed (orch backlog)", caveats),
    check("tree clean", dirty ? [`${d.repo} has uncommitted changes`] : []),
    check("evidence present", noEvidence),
  ];
}

export function closeDemand(home: string, id: string, checks: Check[], now = new Date()): Demand {
  const ok = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok).map((c) => c.item).join(", ");
  return update(home, id, (d) => ({ ...(ok ? { status: "closed" as const } : {}), history: logged(d, ok ? "closed" : `close refused: ${failed}`, now) }));
}
