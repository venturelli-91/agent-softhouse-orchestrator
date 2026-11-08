import { spawn, spawnSync } from "node:child_process";
import { commandEnv } from "./deploy.ts";
import { guarded, log } from "./graph-kit.ts";
import { type WebcheckConfig } from "./repo-config.ts";
import { type T } from "./ticket.ts";
import { evaluate, type WebReport } from "./webcheck-evaluate.ts";

export type Collector = (cfg: WebcheckConfig, cwd: string, ctx: { id: string; sha: string }) => Promise<WebReport[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UI = ["frontend", "fullstack"];

async function waitUp(url: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`the app did not answer on ${url} in time`);
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

// ponytail: one Chromium page per path, cold cache, desktop viewport; no throttling and no interaction, so INP is only reported if a budget asks and it stays "not measured".
export const playwrightCollector: Collector = async (cfg, cwd, ctx) => {
  const { chromium } = await import("playwright");
  const [bin, ...args] = cfg.serve.split(" ").filter(Boolean);
  const server = spawn(process.platform === "win32" ? cfg.serve : bin, process.platform === "win32" ? [] : args, { cwd, env: commandEnv(cfg.env, { ...ctx, previous: "" }), stdio: "ignore", shell: process.platform === "win32", windowsHide: true });
  const stop = () => (process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"]) : server.kill());
  try {
    await waitUp(cfg.base_url, Date.now() + cfg.timeout_s * 1000);
    const browser = await chromium.launch();
    try {
      const out: WebReport[] = [];
      for (const path of cfg.paths) {
        const page = await browser.newPage();
        const r: WebReport = { url: new URL(path, cfg.base_url).href, vitals: {}, requests: [], dataLayer: [], consoleErrors: [] };
        page.on("request", (q) => r.requests.push(q.url()));
        page.on("console", (m) => m.type() === "error" && r.consoleErrors.push(m.text()));
        await page.goto(r.url, { waitUntil: "load", timeout: cfg.timeout_s * 1000 });
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
  if (!UI.includes(t.specialty)) return { status: "publish", history: log(t, "webcheck", "skipped: not a UI ticket") };
  const cfg = t.webcheck_cfg;
  if (!cfg)
    return { status: "publish", docs_warnings: [...t.docs_warnings, "webcheck skipped: no webcheck configured for this repo"], history: log(t, "webcheck", "skipped: not configured") };
  let reports: WebReport[];
  try {
    reports = await collect(cfg, t.worktree, { id: t.id, sha: t.base });
  } catch (e) {
    return { status: "publish", docs_warnings: [...t.docs_warnings, `webcheck skipped: ${(e as Error).message.split("\n")[0]}`], history: log(t, "webcheck", "skipped: collector failed") };
  }
  const findings = reports.flatMap((r) => evaluate(r, cfg));
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
