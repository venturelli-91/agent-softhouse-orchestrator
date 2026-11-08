import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type WebReport } from "../src/webcheck-evaluate.ts";

const ok: WebReport = {
  url: "http://localhost:3000/",
  vitals: { lcp_ms: 1800, cls: 0.02, inp_ms: 120 },
  requests: ["https://www.googletagmanager.com/gtm.js?id=GTM-ABC123", "https://www.google-analytics.com/g/collect?tid=G-XYZ789"],
  dataLayer: [{ event: "gtm.js" }],
  consoleErrors: [],
};

test("a page that meets every expectation has no failures", () => {
  assert.deepEqual(evaluate(ok, { gtm: ["GTM-ABC123"], ga4: ["G-XYZ789"], lcp_ms: 2500, cls: 0.1, inp_ms: 200 }), []);
});

test("a missing tag id, an empty dataLayer and an over-budget vital are each reported", () => {
  const bad = { ...ok, requests: [], dataLayer: [], vitals: { lcp_ms: 4000, cls: 0.02, inp_ms: 120 } };
  const f = evaluate(bad, { gtm: ["GTM-ABC123"], ads: ["AW-1"], lcp_ms: 2500 });
  assert.equal(f.length, 4);
  assert.match(f.join("\n"), /GTM-ABC123 was never requested/);
  assert.match(f.join("\n"), /dataLayer is empty/);
  assert.match(f.join("\n"), /lcp_ms 4000 is over the budget 2500/);
});

test("a budget with no measurement fails closed, and an id on a non-Google host does not count", () => {
  const f = evaluate({ ...ok, vitals: {}, requests: ["https://evil.example/?id=GTM-ABC123"] }, { gtm: ["GTM-ABC123"], inp_ms: 200 });
  assert.match(f.join("\n"), /inp_ms was not measured/);
  assert.match(f.join("\n"), /GTM-ABC123 was never requested/);
});

test("an id only counts when it is the id or tid parameter, not a substring or a page location", () => {
  const near = { ...ok, requests: ["https://www.google-analytics.com/g/collect?tid=G-ABCD&dl=https%3A%2F%2Fx%2F%3Fq%3DG-AB"] };
  assert.match(evaluate(near, { ga4: ["G-AB"] }).join(), /GA4 G-AB was never requested/);
  assert.deepEqual(evaluate(near, { ga4: ["G-ABCD"] }), []);
});

test("a missing Ads id is reported alone, and empty expectations ask for nothing", () => {
  assert.deepEqual(evaluate(ok, { ads: ["AW-1"] }), ["Ads AW-1 was never requested on http://localhost:3000/"]);
  assert.deepEqual(evaluate({ ...ok, dataLayer: [] }, { gtm: [], ga4: [], ads: [] }), []);
});

test("a NaN or null metric is not measured, and a budget of zero is enforced", () => {
  const bad = { ...ok, vitals: { cls: Number.NaN, inp_ms: null as unknown as number, lcp_ms: 1 } };
  const f = evaluate(bad, { cls: 0.1, inp_ms: 200, lcp_ms: 0.5 });
  assert.equal(f.filter((m) => /not measured/.test(m)).length, 2);
  assert.match(f.join(), /lcp_ms 1 is over the budget 0.5/);
  assert.deepEqual(evaluate({ ...ok, vitals: { cls: 0 } }, { cls: 0.0001 }), []);
});
