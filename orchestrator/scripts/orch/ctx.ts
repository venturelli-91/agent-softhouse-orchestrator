// What every orch command shares: parsed args, the state dir, and the helpers that load, drive and lock a ticket.
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { dailyCapReached, orchHome } from "../../src/daily-cap.ts";
import { FileSaver } from "../../src/file-saver.ts";
import { buildGraph, config, report, Ticket } from "../../src/graph.ts";
import { notify } from "../../src/notify.ts";
import { loadPrompt } from "../../src/run-agent.ts";
import { lockTicket, ticketFile } from "../../src/ticket-store.ts";

export const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

type Pending = { type: "approval" | "escalation" | "no_change"; reason: string | null; title: string; summary: string; evidence: string[] };

export function makeCtx(argv: string[], host: string) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      repo: { type: "string" }, id: { type: "string" }, all: { type: "boolean" }, force: { type: "boolean" },
      remote: { type: "boolean" }, clear: { type: "boolean" }, "config-reviewed": { type: "boolean" }, team: { type: "string" }, yes: { type: "boolean" }, "no-install": { type: "boolean" },
    },
  });

  const home = orchHome();
  mkdirSync(home, { recursive: true });

  // One state file per ticket, so commands on different tickets never touch the same file.
  function open(id: string) {
    const saver = new FileSaver(ticketFile(home, id));
    return { saver, graph: buildGraph(saver) };
  }

  async function load(id: string) {
    const { saver, graph } = open(id);
    if (!saver.storage[id]) return die(`no ticket ${id}`);
    const state = await graph.getState(config(id));
    const pending = state.tasks.flatMap((t) => t.interrupts)[0]?.value as Pending | undefined;
    return { ticket: Ticket.parse(state.values), pending };
  }

  // Runs the graph until it ends or pauses for the CEO; a pause is announced outside the terminal too.
  async function drive(id: string, input: unknown) {
    await open(id).graph.invoke(input as never, config(id));
    const { ticket, pending } = await load(id);
    console.log(report(ticket));
    if (pending) {
      console.log(JSON.stringify(pending, null, 1));
      const next = {
        approval: `orch approve ${id}  |  orch request-changes ${id} "<what to change>"  |  orch reject ${id} (close)`,
        no_change: `orch approve ${id} (close the ticket)  |  orch approve ${id} "<what the dev should do instead>"  |  orch reject ${id}`,
        escalation: `orch approve ${id} "<answer>"  |  orch reject ${id} (close)`,
      }[pending.type];
      await notify(`${id} waiting for you (${pending.type}): ${pending.title}\n${pending.reason ?? pending.summary}\n${next}`);
    } else {
      const done = ["simulated_deploy", "aborted", "closed"].includes(ticket.status);
      console.log(`${id}: ${ticket.status}${done ? "" : ` - ${ticket.summary}`}`);
    }
  }

  const needCap = () => {
    const capped = dailyCapReached();
    if (capped) die(capped);
  };
  // Every graph run starts at triage: fail before any worktree or branch exists if AGENTS_DIR is unusable.
  const needPrompts = () => {
    try {
      loadPrompt(["triage"]);
    } catch (e) {
      die((e as Error).message);
    }
  };
  const needPending = async (id: string) => (await load(id)).pending ?? die(`${id} is not waiting for an answer`);

  // Takes the ticket's lock for the duration of one command; a second command on the same id refuses.
  async function locked(id: string, fn: () => Promise<void>) {
    let unlock: () => void;
    try {
      unlock = lockTicket(home, id);
    } catch (e) {
      return die((e as Error).message);
    }
    try {
      await fn();
    } finally {
      unlock();
    }
  }

  return { cmd, values, positionals, host, home, load, drive, needCap, needPrompts, needPending, locked };
}

export type Ctx = ReturnType<typeof makeCtx>;
