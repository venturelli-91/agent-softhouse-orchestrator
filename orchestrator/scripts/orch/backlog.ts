// `orch backlog`: list the reviewers' caveats and mark them reviewed (a later ticket, or consciously dropped).
import { readBacklog, reviewBacklog } from "../../src/backlog.ts";
import { type Ctx, die } from "./ctx.ts";

export function backlog(c: Ctx) {
  const [sub, ...rest] = c.positionals;
  if (sub === "review") {
    const numbers = rest.map(Number);
    if (!numbers.length) die("usage: orch backlog review <n...>");
    try {
      for (const i of reviewBacklog(numbers, c.home)) console.log(`reviewed: ${i.ticket} (${i.from}) ${i.caveat}`);
    } catch (e) {
      die((e as Error).message);
    }
    return;
  }
  if (sub !== undefined) die("usage: orch backlog [--all] | orch backlog review <n...>");
  const items = readBacklog(c.home).map((i, n) => ({ ...i, n: n + 1 })).filter((i) => c.values.all || i.status === "open");
  for (const i of items) console.log(`${String(i.n).padStart(3)} ${i.status.padEnd(8)} ${i.ticket.padEnd(12)} ${i.from.padEnd(9)} ${i.caveat}`);
  if (!items.length) console.log(c.values.all ? "backlog is empty" : "no open backlog items");
}
