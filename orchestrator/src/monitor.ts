import type { Probe } from "./chaos.ts";
import { deployedIds, getDeployTarget, readDeploy } from "./deploy.ts";
import { type Incident, listIncidents, openIncident, updateIncident } from "./incidents.ts";

export type WatchDeps = {
  probe: Probe;
  makeHotfix: (r: { incident: Incident; repo: string }) => Promise<string>;
  notify: (text: string) => Promise<void>;
};

const isLimit = (e: unknown) => e instanceof Error && /limit/.test(e.message);

export async function watch(home: string, deps: WatchDeps): Promise<Incident[]> {
  for (const id of deployedIds(home)) {
    const symptom = deps.probe(home, id);
    if (symptom === null) {
      for (const i of listIncidents(home)) if (i.ticket === id && i.status !== "closed") updateIncident(home, i.id, { status: "closed" });
      continue;
    }
    let opened: { incident: Incident; created: boolean };
    try {
      opened = openIncident(home, id, symptom);
    } catch (e) {
      if (isLimit(e)) continue;
      throw e;
    }
    const { incident, created } = opened;
    if (created) await deps.notify(`Incident ${incident.id} on ${id}: ${symptom}`);
    if (incident.hotfix) continue;
    try {
      const hotfix = await deps.makeHotfix({ incident, repo: readDeploy(home, id).repo });
      updateIncident(home, incident.id, { hotfix, status: "open", rollback: "proposed" });
    } catch (e) {
      if (!isLimit(e)) throw e;
      updateIncident(home, incident.id, { status: "waiting" });
    }
  }
  return listIncidents(home);
}

export function approveRollback(home: string, incidentId: string): string {
  const incident = listIncidents(home).find((i) => i.id === incidentId);
  if (!incident) throw new Error(`unknown incident: ${incidentId}`);
  if (incident.rollback === "done") throw new Error("already rolled back");
  if (incident.rollback !== "proposed") throw new Error("rollback was not proposed");
  const d = readDeploy(home, incident.ticket);
  const result = getDeployTarget(d.target).rollback({ id: d.id, sha: d.sha, previous: d.previous });
  updateIncident(home, incident.id, { rollback: "done" });
  return result;
}
