import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { orchHome } from "./daily-cap.ts";
import { commandEnv } from "./deploy.ts";
import { checkConfig, guarded, log } from "./graph-kit.ts";
import { repoOf, verifyTicket } from "./guardrails.ts";
import { evaluateLoad, runDriver, type LoadReport } from "./load-driver.ts";
import { startDelayProxy } from "./load-proxy.ts";
import { killTree, shadowsBin, spawnServe } from "./platform.ts";
import { loadRepoConfig, type LoadConfig } from "./repo-config.ts";
import { NodeFailure } from "./run-agent.ts";
import { LOAD_SPECIALTIES } from "./specialties.ts";
import { type T } from "./ticket.ts";
import { answers, AppFailure, InfraError, waitUp } from "./webcheck.ts";

export type LoadOutcome = { findings: string[]; summary: string; report: object };
export type LoadRunner = (cfg: LoadConfig, cwd: string, ctx: { id: string; sha: string }) => Promise<LoadOutcome>;

const RunnerReport = z.object({ requests: z.number().int().min(0), errors: z.number().int().min(0), p95_ms: z.number().min(0) });
const pct = (n: number, d: number) => `${d ? ((n / d) * 100).toFixed(1) : "0.0"}%`;
const stop = (p: ChildProcess) => {
  try {
    if (p.pid !== undefined) killTree(p.pid);
  } catch {}
};

function runCommand(cfg: LoadConfig, cwd: string, env: Record<string, string>, deadline: number): Promise<{ code: number; out: string }> {
  const piped = ((c: string, a: string[], o: object) => spawn(c, a, { ...o, stdio: ["ignore", "pipe", "ignore"] })) as unknown as typeof spawn;
  const child = spawnServe(cfg.runner!, cwd, env, undefined, piped);
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  return new Promise<{ code: number; out: string }>((done, fail) => {
    const timer = setTimeout(() => fail(new NodeFailure(`load runner exceeded timeout_s (${cfg.timeout_s}s)`)), Math.max(0, deadline - Date.now()));
    child.on("error", (e) => (clearTimeout(timer), fail(new InfraError(`load runner cannot start (${e.message})`))));
    child.on("close", (code) => (clearTimeout(timer), done({ code: code ?? -1, out })));
  }).finally(() => stop(child));
}

async function viaRunner(cfg: LoadConfig, cwd: string, env: Record<string, string>, deadline: number): Promise<LoadOutcome> {
  const { code, out } = await runCommand(cfg, cwd, env, deadline);
  if (code !== 0 && code !== 1) throw new NodeFailure(`load runner crashed (exit ${code})`);
  let parsed: z.infer<typeof RunnerReport> | undefined;
  try {
    parsed = RunnerReport.parse(JSON.parse(out.trim().split("\n").at(-1) ?? ""));
  } catch {
    if (code === 0) throw new NodeFailure("load runner printed no valid JSON report on its last line");
  }
  const findings = parsed ? evaluateLoad({ requests: parsed.requests, errors: parsed.errors, baseline_p95_ms: 0 }, cfg) : [];
  if (parsed && parsed.p95_ms > cfg.thresholds.max_fast_p95_ms) findings.push(`runner p95 ${Math.round(parsed.p95_ms)}ms exceeds the ${cfg.thresholds.max_fast_p95_ms}ms limit`);
  if (code === 1 && !findings.length) findings.push("the load runner reported a threshold breach (exit 1)");
  const summary = parsed ? `${parsed.requests} requests, error rate ${pct(parsed.errors, parsed.requests)}, p95 ${Math.round(parsed.p95_ms)}ms (runner)` : "runner breach";
  return { findings, summary, report: { runner: true, exit: code, ...parsed } };
}

// ponytail: one automatic re-run of the whole driver on a breach, because a shared host makes single timings flaky; the second run decides.
async function viaDriver(cfg: LoadConfig, proxy: Awaited<ReturnType<typeof startDelayProxy>> | null, check: () => void): Promise<LoadOutcome> {
  let report: LoadReport = await runDriver(cfg, proxy, check);
  let findings = evaluateLoad(report, cfg);
  if (findings.length && report.recovered !== false) (report = await runDriver(cfg, proxy, check), (findings = evaluateLoad(report, cfg)));
  const slowed = report.slowed_p95_ms === undefined ? "" : ` vs ${Math.round(report.slowed_p95_ms)}ms with the dependency slowed`;
  return { findings, report, summary: `${report.requests} requests, error rate ${pct(report.errors, report.requests)}, fast p95 ${Math.round(report.baseline_p95_ms)}ms baseline${slowed}` };
}

export const realLoad: LoadRunner = async (cfg, cwd, ctx) => {
  const health = new URL(cfg.health_path, cfg.base_url).href;
  if (await answers(health)) throw new NodeFailure(`${cfg.base_url} already answers: refusing to load a server this run did not start`);
  for (const line of [cfg.serve, cfg.runner]) if (line && shadowsBin(cwd, line.split(" ")[0])) throw new NodeFailure(`${line.split(" ")[0]} exists in ${cwd}: refusing to run a binary the working tree could shadow`);
  const deadline = Date.now() + cfg.timeout_s * 1000;
  const dep = cfg.slow_dependency;
  const proxy = dep ? await startDelayProxy(dep.target).catch((e: Error) => { throw new InfraError(`cannot start the delaying proxy (${e.message})`); }) : null;
  let server: ChildProcess | undefined;
  try {
    const env = { ...commandEnv(cfg.env, { ...ctx, previous: "" }), ...(dep && proxy ? { [dep.env]: `http://127.0.0.1:${proxy.port}` } : {}) };
    server = spawnServe(cfg.serve, cwd, env);
    let gone: string | undefined;
    server.on("exit", () => (gone ??= "exit"));
    server.on("error", (e) => (gone = e.message));
    const check = () => {
      if (gone) throw new AppFailure(`the service exited during the load run${gone === "exit" ? "" : `: ${gone}`}`);
      if (Date.now() > deadline) throw new NodeFailure(`load exceeded timeout_s (${cfg.timeout_s}s)`);
    };
    await waitUp(health, deadline, () => gone);
    if (!cfg.runner) return await viaDriver(cfg, proxy, check);
    if (proxy && dep) proxy.delay_ms = dep.delay_ms;
    const rEnv = { ...env, ORCH_LOAD_TARGET: cfg.base_url, ORCH_SLOW_DEP: proxy ? `http://127.0.0.1:${proxy.port}` : "", ORCH_LOAD_DURATION: String(cfg.duration_s) };
    return await viaRunner(cfg, cwd, rEnv, deadline);
  } finally {
    if (server) stop(server);
    await proxy?.close().catch(() => {});
  }
};

let run: LoadRunner = realLoad;
export const setLoadRunner = (r: LoadRunner) => void (run = r);

// Not an agent: zero tokens. Opt-in per repo, so a repo without `load` skips silently (no docs warning).
export const load = guarded("load", async (t: T) => {
  const cfg = t.load_cfg;
  if (!cfg) return { status: "publish", load_note: "", history: log(t, "load", "skipped: not configured") };
  if (!LOAD_SPECIALTIES.has(t.specialty)) return { status: "publish", load_note: "", history: log(t, "load", "skipped: not a service ticket") };
  checkConfig(t);
  const v = t.evidence.length ? verifyTicket(t) : { ok: false as const, reason: "no evidence" };
  if (!v.ok) throw new NodeFailure(`invalid evidence: ${v.reason}`);
  if (!isDeepStrictEqual(loadRepoConfig(t.repo || repoOf(t.worktree), t.base).load, cfg))
    throw new NodeFailure("load settings changed since the ticket started; re-run the ticket");
  let out: LoadOutcome;
  try {
    out = await run(cfg, t.worktree, { id: t.id, sha: t.base });
  } catch (e) {
    if (e instanceof InfraError)
      return { status: "publish", load_note: "", docs_warnings: [...t.docs_warnings, `load skipped: ${e.message}`], history: log(t, "load", "skipped: stage cannot run") };
    if (!(e instanceof AppFailure)) throw e instanceof NodeFailure ? e : new NodeFailure(`load: ${(e as Error).message.split("\n")[0]}`);
    out = { findings: [e.message], summary: "", report: { app_failure: e.message } };
  }
  writeFileSync(join(orchHome(), `load-${t.id}.json`), JSON.stringify(out.report, null, 2));
  if (!out.findings.length) return { status: "publish", load_note: `load passed: ${out.summary}`, history: log(t, "load", "passed") };
  const comments = out.findings.slice(0, 10).join("\n");
  return { status: "dev_failed", revisions: t.revisions + 1, load_note: "", summary: comments, rejections: [...t.rejections, `load: ${comments}`], history: log(t, "load", "rejected") };
});
