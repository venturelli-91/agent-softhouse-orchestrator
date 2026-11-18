// Commands that set up and tidy the orchestrator itself: init, status, clean.
import { copyFileSync, cpSync, existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { DEFAULT_TEST } from "../../src/commands.ts";
import { runShimmed, samePath } from "../../src/platform.ts";
import { applyTeam, configJson, proposeTeam } from "../../src/team.ts";
import { usedToday } from "../../src/daily-cap.ts";
import { forgetDeploy } from "../../src/deploy.ts";
import { deleteRemoteBranch } from "../../src/git-remote.ts";
import { removeTicketResources, report } from "../../src/graph.ts";
import { log } from "../../src/graph-kit.ts";
import { landedOn } from "../../src/local-merge.ts";
import { assertGitConfigUnchanged, repoOf } from "../../src/guardrails.ts";
import { listIncidents } from "../../src/incidents.ts";
import { unmonitored } from "../../src/probe.ts";
import { isManual, manualIds, readManual } from "../../src/manual.ts";
import { recordMetrics } from "../../src/metrics.ts";
import { bareNodeTest } from "../../src/repo-config.ts";
import { TEAMS } from "../../src/specialties.ts";
import { DONE, runState, ticketFile, ticketIds } from "../../src/ticket-store.ts";
import { type Ctx, die } from "./ctx.ts";
import { demandLines, showDemand } from "./demand.ts";
import { demandIds, forgetDemand, isDemand, readDemand } from "../../src/demand.ts";

export function init(c: Ctx) {
  const repo = resolve(c.positionals[0] ?? c.host);
  const file = join(repo, ".orchestrator.json");
  const team = c.values.team;
  if (team && !Object.hasOwn(TEAMS, team)) die(`unknown team ${team}: ${Object.keys(TEAMS).join(", ")}`);
  if (existsSync(file)) console.log(`${file} already exists${team ? `: set "specialties" there by hand (${TEAMS[team].join(", ")})` : ""}`);
  else {
    const specialties = team && team !== "all" ? { specialties: TEAMS[team] } : {};
    writeFileSync(file, configJson({ test: DEFAULT_TEST, merge: "pr", ...specialties }));
    console.log(`wrote ${file}: set "test" to the repo's test command, then commit it (it is read from the base commit)`);
    if (bareNodeTest(repo)) {
      console.warn(
        'warning: package.json "test" is a bare `node --test`: it will also run orchestrator/tests in every ticket worktree. '
        + 'Point "test" at an npm script that scopes it.',
      );
    }
  }
  if (!existsSync(join(repo, ".claude", "CLAUDE.md")) && !existsSync(join(repo, "CLAUDE.md"))) {
    console.log("no .claude/CLAUDE.md: the dev will have no repo conventions (commit format, style)");
  }
}

// Copies this folder into another repo and prepares it. Never overwrites: an existing orchestrator/ there stops the command.
const NOT_COPIED = new Set(["node_modules", ".env", ".state", ".git", ".github"]);
// Fixed arguments only; on Windows npm and npx are .cmd shims, which need a shell and a single command line.
const run = (bin: string, args: string[], cwd: string) => runShimmed(`${bin} ${args.join(" ")}`, bin, args, { cwd, stdio: "inherit", encoding: "utf8" });

// The host's linter and typechecker would otherwise scan orchestrator/ (own style, stricter @types/node) and break the host's `verify`. Printed, never applied.
const HOST_EXCLUDES = `add these by hand if the repo uses Biome or tsc, or its verify will fail on orchestrator/:
  biome.json     "files": { "includes": [..., "!orchestrator", "!.vscode"] }
  tsconfig.json  "exclude": [..., "orchestrator"]`;

export async function setup(c: Ctx) {
  const target = resolve(c.positionals[0] ?? die("usage: orch setup <repo> [--team <name>] [--no-install] [--yes]"));
  if (!existsSync(join(target, ".git"))) die(`${target} is not the root of a git repo`);
  const dest = join(target, "orchestrator");
  if (existsSync(dest)) die(`${dest} already exists: nothing copied`);
  cpSync(resolve(import.meta.dirname, "../.."), dest, { recursive: true, filter: (src) => !NOT_COPIED.has(basename(src)) });
  copyFileSync(join(dest, ".env.example"), join(dest, ".env"));
  console.log(`copied to ${dest} (.env created from .env.example: set PUBLISHER and the models there)`);
  if (!c.values["no-install"]) {
    run("npm", ["ci"], dest);
    // The browser is a ~150 MB download used only by the webcheck node: ask, and skip when there is nobody to ask.
    const browser = c.values.yes || (stdin.isTTY && (await createInterface({ input: stdin, output: stdout }).question("download Chromium for the webcheck node? [y/N] ")).trim().toLowerCase() === "y");
    if (browser) run("npx", ["playwright", "install", "chromium"], dest);
    else console.log("Chromium skipped: run `npx playwright install chromium` in orchestrator/ before using webcheck");
  }
  init({ ...c, positionals: [target] });
  console.log(HOST_EXCLUDES);
  console.log(`next: commit orchestrator/ and .orchestrator.json in ${target}; webcheck, if wanted, is configured by hand in ORCH_HOME/config.json`);
}

export async function team(c: Ctx) {
  const need = c.positionals[0] ?? die('usage: orch team "<need>" [--repo <path>] [--yes]');
  c.needCap();
  const repo = resolve(c.values.repo ?? c.host);
  const p = await proposeTeam(repo, need);
  console.log(`team: ${p.specialties.join(", ")}\nstack (${p.existing_stack ? "existing" : "recommended"}): ${p.stack}\ntest: ${p.test}\nwhy: ${p.rationale}`);
  for (const a of p.proposed_agents) console.log(`proposed agent (needs your approval, not created): ${a.name}: ${a.responsibility} (${a.why})`);
  const ok = c.values.yes || (await createInterface({ input: stdin, output: stdout }).question("write this to .orchestrator.json? [y/N] ")).trim().toLowerCase() === "y";
  if (!ok) return console.log("nothing written");
  console.log(`wrote ${applyTeam(repo, p)}: commit it (it is read from the base commit)`);
}

export async function status(c: Ctx) {
  const one = c.positionals[0];
  if (one && isManual(c.home, one)) {
    const m = readManual(c.home, one);
    console.log(`${m.id.padEnd(12)} ${m.status.padEnd(16)} manual ${m.title}\ncommand: ${m.command}\ncriteria:`);
    for (const s of m.criteria) console.log(`  - ${s}`);
    for (const h of m.history) console.log(`${h.time} ${h.result}`);
    return;
  }
  if (one && isDemand(c.home, one)) return showDemand(c, one);
  const ids = one ? [one] : ticketIds(c.home);
  for (const id of ids) {
    let { ticket: t, pending } = await c.load(id);
    // An aborted ticket whose commits reached the base branch by another path (a hand cherry-pick) is merged, not lost.
    if (t.status === "aborted" && t.base_branch && landedOn(t.repo || c.host, t.base_branch, id, t.base)) {
      await c.mark(id, { status: "merged", history: log(t, "status", `merged: every commit is already on ${t.base_branch}`) });
      ({ ticket: t, pending } = await c.load(id));
    }
    // Dead: not finished, not waiting for an answer, and no live process (closed session, crash). A launcher that exited is not completion.
    const state = runState(c.home, id, pending, t.status);
    const waiting = pending ? `  <- waiting (${pending.type})` : state === "dead" ? `  <- no process running: orch continue ${id}` : "";
    console.log(`${id.padEnd(12)} ${t.status.padEnd(16)} ${state.padEnd(8)} ${t.priority.padEnd(4)} ${t.title}${waiting}${t.docs_warnings.length ? "  docs!" : ""}`);
    if (c.positionals[0]) {
      console.log(report(t));
      if (pending) console.log(JSON.stringify(pending, null, 1));
    }
  }
  const manuals = one ? [] : manualIds(c.home).map((id) => readManual(c.home, id));
  for (const m of manuals) {
    const waiting = m.status === "open" ? `  <- waiting: orch evidence ${m.id}` : "";
    console.log(`${m.id.padEnd(12)} ${m.status.padEnd(16)} manual ${m.title}${waiting}`);
  }
  const demands = one ? [] : demandLines(c.home);
  for (const l of demands) console.log(l);
  if (!ids.length && !manuals.length && !demands.length) console.log("no tickets");
  if (!one) {
    for (const i of listIncidents(c.home)) {
      console.log(`${i.id.padEnd(16)} ${i.status.padEnd(8)} ${i.ticket} hotfix=${i.hotfix || "-"} rollback=${i.rollback}  ${i.symptom}`);
    }
    for (const id of unmonitored(c.home)) console.log(`${id.padEnd(16)} deployed without a health check: not monitored`);
  }
  if (process.env.TOKEN_CAP_DAILY) console.log(`tokens in the last 24h: ${usedToday()} / ${process.env.TOKEN_CAP_DAILY}`);
}


function step(item: string, fn: () => unknown): boolean {
  try {
    fn();
    console.log(`ok   ${item}`);
    return true;
  } catch (e) {
    console.log(`FAIL ${item}: ${(e as Error).message.split("\n", 1)[0]}`);
    process.exitCode = 1;
    return false;
  }
}

export async function clean(c: Ctx) {
  const usage = "usage: orch clean <id> | --all [--repo <path>] [--force] [--remote]  (--all takes only this repo's tickets and demands; manual tickets are left alone; --force also removes open demands, even if their tickets were kept; --all skips tickets with no recorded repo: clean those by id)";
  const all = c.values.all;
  if (!all && !c.positionals[0]) die(usage);
  const scope = resolve(c.values.repo ?? c.host);
  const ids: string[] = [];
  for (const id of all ? ticketIds(c.home) : [c.positionals[0]!]) {
    if (!all) ids.push(id);
    else {
      try {
        const { repo } = (await c.load(id)).ticket;
        if (repo && samePath(repo, scope)) ids.push(id);
      } catch (e) {
        step(`${id} read`, () => { throw e; });
      }
    }
  }
  for (const id of ids) {
    await c.locked(id, async () => {
      const { ticket: t } = await c.load(id);
      if (!DONE.includes(t.status) && !c.values.force) {
        if (!all) die(`${id} is ${t.status}, not finished (use --force to discard it)`);
        return;
      }
      let repo = t.repo;
      if (!repo && !step(`${id} locate repo`, () => (repo = repoOf(t.worktree)))) return;
      const results = [];
      if (c.values.remote) {
        results.push(step(`${id} remote branch`, () => {
          assertGitConfigUnchanged(repo, t.git_config_hash);
          return deleteRemoteBranch(repo, t.push_remote, id);
        }));
      }
      for (const s of removeTicketResources(repo, t.worktree, id)) {
        results.push(step(`${id} ${s.step}`, () => { if (!s.ok) throw new Error(s.reason); }));
      }
      if (results.includes(false)) return void console.log(`kept ${id}: its state stays so the clean can be retried`);
      if (!step(`${id} state`, () => unlinkSync(ticketFile(c.home, id)))) return;
      const metrics = step(`${id} metrics`, () => recordMetrics(c.home, t));
      step(`${id} deploy record`, () => forgetDeploy(c.home, id));
      step(`${id} deploy log`, () => rmSync(join(c.home, "deploy-logs", `${id}.txt`), { force: true }));
      step(`${id} host diff`, () => rmSync(join(c.home, `host-diff-${id}.diff`), { force: true }));
      step(`${id} load report`, () => rmSync(join(c.home, `load-${id}.json`), { force: true }));
      console.log(metrics ? `cleaned ${id} (${t.status}${all ? "" : `, ${repo}`})` : `${id} removed, but its metrics line was lost`);
    });
  }
  if (!all) return;
  for (const id of demandIds(c.home)) {
    let d: ReturnType<typeof readDemand>;
    try {
      d = readDemand(c.home, id);
    } catch (e) {
      step(`demand ${id} read`, () => { throw e; });
      continue;
    }
    if (!samePath(d.repo, scope)) continue;
    if (d.status !== "closed" && !c.values.force) console.log(`skip demand ${id} (open, use --force)`);
    else step(`demand ${id}`, () => forgetDemand(c.home, id));
  }
}
