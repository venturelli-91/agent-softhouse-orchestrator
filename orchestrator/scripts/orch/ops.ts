// Commands for what is already deployed: watch, resolve, chaos, rollback.
import { join } from "node:path";
import { clearFailure, injectFailure, SCENARIOS } from "../../src/chaos.ts";
import { workRoot } from "../../src/daily-cap.ts";
import { deployedIds } from "../../src/deploy.ts";
import { createWorktree } from "../../src/graph.ts";
import { listIncidents } from "../../src/incidents.ts";
import { approveRollback, resolveIncident, watch } from "../../src/monitor.ts";
import { notify } from "../../src/notify.ts";
import { defaultProbe } from "../../src/probe.ts";
import { type Ctx, die } from "./ctx.ts";

export async function watchDeployed(c: Ctx) {
  if (!deployedIds(c.home).length) console.log("nothing is deployed");
  const incidents = await watch(c.home, {
    probe: defaultProbe,
    notify,
    makeHotfix: async ({ incident, repo }) => {
      c.needCap();
      const id = `H-${incident.id.slice(4)}`;
      await c.locked(id, async () => {
        const wt = createWorktree(repo, id, join(workRoot(), "worktrees", id), c.home);
        const request = `Hotfix for ${incident.ticket}: ${incident.symptom}. `
          + "Fix the cause with the smallest safe change; a rollback is proposed separately to the CEO.";
        await c.drive(id, { id, request, incident: incident.id, ...wt });
      });
      return id;
    },
  });
  for (const i of incidents.filter((i) => i.status !== "closed")) {
    const next = i.rollback === "proposed" ? `  -> orch rollback ${i.id}` : "";
    console.log(`${i.id} ${i.status} ${i.ticket} hotfix=${i.hotfix || "-"} rollback=${i.rollback}: ${i.symptom}${next}`);
  }
}

export function resolveByHand(c: Ctx) {
  const incidentId = c.positionals[0] ?? die("usage: orch resolve <incident-id>");
  resolveIncident(c.home, incidentId);
  console.log(`${incidentId} closed`);
}

export async function chaos(c: Ctx) {
  const id = c.positionals[0];
  const scenario = c.positionals[1];
  if (!id || (!scenario && !c.values.clear)) {
    die(`usage: orch chaos <ticket-id> <scenario> | orch chaos <ticket-id> --clear\nscenarios: ${Object.keys(SCENARIOS).join(", ")}`);
  }
  await c.locked(id, async () => {
    if (c.values.clear) clearFailure(c.home, id);
    else injectFailure(c.home, id, scenario);
    console.log(c.values.clear ? `${id}: failure cleared` : `${id}: injected ${scenario}`);
  });
}

export async function rollback(c: Ctx) {
  const incidentId = c.positionals[0] ?? die("usage: orch rollback <incident-id>");
  const incident = listIncidents(c.home).find((i) => i.id === incidentId) ?? die(`no incident ${incidentId}`);
  await c.locked(incident.ticket, async () => console.log(approveRollback(c.home, incidentId, { configReviewed: c.values["config-reviewed"] })));
}
