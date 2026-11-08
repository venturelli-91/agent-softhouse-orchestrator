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
