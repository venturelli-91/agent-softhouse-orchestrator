import type { Probe } from "./chaos.ts";
import { assertGitConfigUnchanged, gitConfigHash } from "./guardrails.ts";
import { commandTarget, deployedIds, getDeployTarget, readDeploy, recordDeploy } from "./deploy.ts";
import { type Incident, listIncidents, openIncident, updateIncident } from "./incidents.ts";

export type WatchDeps = {
  probe: Probe;
  makeHotfix: (r: { incident: Incident; repo: string }) => Promise<string>;
  notify: (text: string) => Promise<void>;
};

// an unreachable or timing-out service says nothing about the code: skip the hotfix dev (it burns tokens) and propose only the rollback
const INFRA_ONLY = /^(unreachable|timeout)\b/;
const isLimit = (e: unknown) => e instanceof Error && /limit/.test(e.message);

export async function watch(home: string, deps: WatchDeps): Promise<Incident[]> {
  for (const id of deployedIds(home)) {
    const symptom = await deps.probe(home, id);
    if (symptom === null) {
      for (const i of listIncidents(home)) if (i.ticket === id && i.status !== "closed") updateIncident(home, i.id, { status: "closed" });
      continue;
    }
    let opened: { incident: Incident; created: boolean };
    try {
      const live = listIncidents(home).find((i) => i.ticket === id && i.status !== "closed");
      opened = live ? { incident: live.symptom === symptom ? live : updateIncident(home, live.id, { symptom }), created: false } : openIncident(home, id, symptom);
    } catch (e) {
      if (isLimit(e)) continue;
      throw e;
    }
    const { incident, created } = opened;
    if (created) await deps.notify(`Incident ${incident.id} on ${id}: ${symptom}`);
    if (incident.hotfix) continue;
    if (INFRA_ONLY.test(symptom)) {
      updateIncident(home, incident.id, { status: "open", rollback: "proposed" });
      continue;
    }
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

export function resolveIncident(home: string, incidentId: string): void {
  if (!listIncidents(home).some((i) => i.id === incidentId)) throw new Error(`unknown incident: ${incidentId}`);
  updateIncident(home, incidentId, { status: "closed" });
}

export function approveRollback(home: string, incidentId: string, opts: { configReviewed?: boolean } = {}): string {
  const incident = listIncidents(home).find((i) => i.id === incidentId);
  if (!incident) throw new Error(`unknown incident: ${incidentId}`);
  if (incident.rollback === "done") throw new Error("already rolled back");
  if (incident.rollback !== "proposed") throw new Error("rollback was not proposed");
  const d = readDeploy(home, incident.ticket);
  if (d.cmd) {
    const expected = opts.configReviewed ? gitConfigHash(d.repo) : d.cmd.git_config_hash;
    try {
      assertGitConfigUnchanged(d.repo, expected);
    } catch {
      throw new Error(`.git/config changed since the deploy; review it, then run: orch rollback ${incidentId} --config-reviewed`);
    }
    if (opts.configReviewed) recordDeploy(home, { ...d, cmd: { ...d.cmd, git_config_hash: expected } });
  }
  const target = d.cmd ? commandTarget({ command: "", ...d.cmd }, d.repo, d.previous) : getDeployTarget(d.target);
  const result = target.rollback({ id: d.id, sha: d.sha, previous: d.previous });
  updateIncident(home, incident.id, { rollback: "done" });
  return result;
}
