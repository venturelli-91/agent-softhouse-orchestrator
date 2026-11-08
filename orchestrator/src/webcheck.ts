import { spawn, spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { commandEnv } from "./deploy.ts";
import { checkConfig, guarded, log } from "./graph-kit.ts";
import { repoOf, verifyEvidence } from "./guardrails.ts";
import { loadRepoConfig, type WebcheckConfig } from "./repo-config.ts";
import { NodeFailure } from "./run-agent.ts";
import { UI_SPECIALTIES } from "./specialties.ts";
import { type T } from "./ticket.ts";
import { evaluate, type WebReport } from "./webcheck-evaluate.ts";

export type Collector = (cfg: WebcheckConfig, cwd: string, ctx: { id: string; sha: string }) => Promise<WebReport[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Infrastructure problem (no Playwright, no Chromium): the check cannot run, the ticket goes on with a warning.
export class InfraError extends Error {}
// The ticket's own app misbehaves (serve dies, never answers, page will not load): that is a finding for the dev, not a skip.
export class AppFailure extends Error {}

const answers = (url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.status < 500, () => false);

async function waitUp(url: string, deadline: number, exited: () => string | undefined): Promise<void> {
  for (;;) {
    const why = exited();
    if (why) throw new AppFailure(`the serve command exited before the app answered${why === "exit" ? "" : `: ${why}`}`);
    if (await answers(url)) return;
    if (Date.now() > deadline) throw new AppFailure(`the app did not answer on ${url} in time`);
    await sleep(500);
  }
}

// Runs in the page after load: buffered observers replay what already happened. INP needs real interaction, so it stays unset here.
const VITALS = () =>
  new Promise<{ lcp_ms?: number; cls?: number }>((done) => {
    let lcp: number | undefined;
    let cls = 0;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!(e as unknown as { hadRecentInput: boolean }).hadRecentInput) cls += (e as unknown as { value: number }).value; })).observe({ type: "layout-shift", buffered: true });
    setTimeout(() => done({ lcp_ms: lcp, cls }), 1000);
  });

// ponytail: one Chromium page per path, cold cache, desktop viewport; no throttling and no interaction, so there is no INP.
export const playwrightCollector: Collector = async (cfg, cwd, ctx) => {
  const { chromium } = await import("playwright").catch((e: Error) => {
    throw new InfraError(`playwright is not installed (${e.message.split("\n")[0]})`);
  });
  const [bin, ...args] = cfg.serve.split(" ").filter(Boolean);
  // Something already answering on the port would be checked in place of this ticket's app.
  if (await answers(cfg.base_url)) throw new NodeFailure(`${cfg.base_url} already answers: refusing to check a server this run did not start`);
  const server = spawn(process.platform === "win32" ? cfg.serve : bin, process.platform === "win32" ? [] : args, { cwd, env: commandEnv(cfg.env, { ...ctx, previous: "" }), stdio: "ignore", detached: process.platform !== "win32", shell: process.platform === "win32", windowsHide: true });
  let gone: string | undefined;
  server.on("exit", () => (gone ??= "exit"));
  server.on("error", (e) => (gone = e.message));
  // Cleanup never throws: it must not replace the findings or the error it runs after.
  const stop = () => {
    try {
      if (server.pid === undefined) return;
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"]);
      else process.kill(-server.pid, "SIGKILL");
    } catch {}
  };
  try {
    await waitUp(cfg.base_url, Date.now() + cfg.timeout_s * 1000, () => gone);
    const browser = await chromium.launch().catch((e: Error) => {
      throw new InfraError(`chromium cannot start (${e.message.split("\n")[0]})`);
    });
    try {
      const out: WebReport[] = [];
      for (const path of cfg.paths) {
        const page = await browser.newPage();
        const r: WebReport = { url: new URL(path, cfg.base_url).href, vitals: {}, requests: [], dataLayer: [], consoleErrors: [] };
        page.on("request", (q) => r.requests.push(q.url()));
        page.on("console", (m) => m.type() === "error" && r.consoleErrors.push(m.text()));
        await page.goto(r.url, { waitUntil: "load", timeout: cfg.timeout_s * 1000 }).catch((e: Error) => {
          throw new AppFailure(`${r.url} did not load: ${e.message.split("\n")[0]}`);
        });
        r.vitals = await page.evaluate(VITALS);
        r.dataLayer = await page.evaluate(() => ((window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []).map((x) => JSON.parse(JSON.stringify(x))));
        await page.close();
        out.push(r);
      }
      return out;
    } finally {
      await browser.close();
    }
  } finally {
    stop();
  }
};

let collect: Collector = playwrightCollector;
export const setCollector = (c: Collector) => void (collect = c);

// Not an agent: the browser's findings come from code. A UI ticket without a configured webcheck passes with a warning, never silently.
export const webcheck = guarded("webcheck", async (t: T) => {
  if (!UI_SPECIALTIES.has(t.specialty)) return { status: "publish", history: log(t, "webcheck", "skipped: not a UI ticket") };
  const cfg = t.webcheck_cfg;
  if (!cfg)
    return { status: "publish", docs_warnings: [...t.docs_warnings, "webcheck skipped: no webcheck configured for this repo"], history: log(t, "webcheck", "skipped: not configured") };
  // The app is the ticket's own code and runs on the host: same gates as the deploy and the review, before it starts.
  checkConfig(t);
  const v = t.evidence.length ? verifyEvidence(t.worktree, t.base, t.test, t.install) : { ok: false as const, reason: "no evidence" };
  if (!v.ok) throw new NodeFailure(`invalid evidence: ${v.reason}`);
  if (!isDeepStrictEqual(loadRepoConfig(t.repo || repoOf(t.worktree), t.base).webcheck, cfg))
    throw new NodeFailure("webcheck settings changed since the ticket started; re-run the ticket");
  let reports: WebReport[];
  let appFailure = "";
  try {
    reports = await collect(cfg, t.worktree, { id: t.id, sha: t.base });
  } catch (e) {
    if (e instanceof InfraError)
      return { status: "publish", docs_warnings: [...t.docs_warnings, `webcheck skipped: ${e.message}`], history: log(t, "webcheck", "skipped: collector cannot run") };
    if (!(e instanceof AppFailure)) throw e instanceof NodeFailure ? e : new NodeFailure(`webcheck: ${(e as Error).message.split("\n")[0]}`);
    reports = [];
    appFailure = e.message;
  }
  const findings = [...(appFailure ? [appFailure] : []), ...reports.flatMap((r) => evaluate(r, cfg))];
  if (!findings.length) return { status: "publish", history: log(t, "webcheck", "passed") };
  const comments = findings.slice(0, 10).join("\n");
  return {
    status: "dev_failed",
    revisions: t.revisions + 1,
    summary: comments,
    rejections: [...t.rejections, `webcheck: ${comments}`],
    history: log(t, "webcheck", "rejected"),
  };
});
