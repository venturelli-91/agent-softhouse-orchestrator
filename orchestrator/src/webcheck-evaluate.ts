// What a browser visit saw (from the collector) against what the repo expects. Pure: no browser, no network.
export type WebReport = {
  url: string;
  vitals: { lcp_ms?: number; cls?: number; inp_ms?: number };
  requests: string[];
  dataLayer: unknown[];
  consoleErrors: string[];
};
export type WebExpect = { gtm?: string[]; ga4?: string[]; ads?: string[]; lcp_ms?: number; cls?: number; inp_ms?: number };

const GOOGLE_HOST = /^(?:[\w-]+\.)*(?:googletagmanager|google-analytics|googleadservices|doubleclick|google)\.com$/;
const host = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};
// ponytail: an id counts as loaded when a request to a Google host carries it as the `id` (gtm.js, gtag/js) or `tid` (collect) parameter; no per-product endpoint parsing.
const loaded = (r: WebReport, id: string) =>
  r.requests.some((u) => {
    if (!GOOGLE_HOST.test(host(u))) return false;
    const q = new URL(u).searchParams;
    return q.get("id") === id || q.get("tid") === id;
  });

export function evaluate(r: WebReport, e: WebExpect): string[] {
  const out: string[] = [];
  for (const [kind, ids] of [["GTM", e.gtm], ["GA4", e.ga4], ["Ads", e.ads]] as const)
    for (const id of ids ?? []) if (!loaded(r, id)) out.push(`${kind} ${id} was never requested on ${r.url}`);
  if (e.gtm?.length && !r.dataLayer.length) out.push(`dataLayer is empty on ${r.url}`);
  for (const [k, max] of [["lcp_ms", e.lcp_ms], ["cls", e.cls], ["inp_ms", e.inp_ms]] as const) {
    if (max === undefined) continue;
    const v = r.vitals[k];
    if (typeof v !== "number" || !Number.isFinite(v)) out.push(`${k} was not measured on ${r.url}`);
    else if (v > max) out.push(`${k} ${v} is over the budget ${max} on ${r.url}`);
  }
  return out;
}
