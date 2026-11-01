// Sweep of every ticket kept in a --db file: rule-based alerts (free); --llm adds the Watchdog agent.
// Usage: node --env-file=.env scripts/watchdog.ts --db state.json [--llm]
import { parseArgs } from "node:util";
import { FileSaver } from "../src/file-saver.ts";
import { buildGraph, config, Ticket } from "../src/graph.ts";
import { alerts, watchdog } from "../src/watchdog.ts";

const { values } = parseArgs({ options: { db: { type: "string" }, llm: { type: "boolean" } } });
if (!values.db) throw new Error("--db <file> required");

const saver = new FileSaver(values.db);
const graph = buildGraph(saver);
const tickets = [];
for (const id of Object.keys(saver.storage)) tickets.push(Ticket.parse((await graph.getState(config(id))).values));

const found = alerts(tickets);
console.log(found.length ? found.join("\n") : `${tickets.length} ticket(s), no alerts`);
if (values.llm && tickets.length) console.log(JSON.stringify(await watchdog(tickets, process.cwd()), null, 1));
