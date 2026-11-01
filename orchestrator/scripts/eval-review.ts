// Does a cheaper model still catch bad diffs? Runs reviewer and qa on hand-made diffs with known verdicts.
// Usage: node --env-file=.env scripts/eval-review.ts --models modelA,modelB
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runAgent } from "../src/run-agent.ts";

const { values } = parseArgs({ options: { models: { type: "string" } } });
if (!values.models) throw new Error("--models a,b required");

const ticket = `Ticket T-1: Add percentage discount to cart
Acceptance criteria:
- applyDiscount(items, percent) in src/cart.js returns the discounted total in cents, rounded down
- percent outside 0..100 throws RangeError
- tests cover the normal case, rounding and the RangeError
Current summary:
Implemented applyDiscount and tests.`;

const HEAD = `diff --git a/src/cart.js b/src/cart.js
--- a/src/cart.js
+++ b/src/cart.js
@@ -1,3 +1,8 @@
 import { formatPrice } from "./format.js";
 export const total = (items) => items.reduce((s, i) => s + i.cents * i.qty, 0);
`;
const GOOD_CODE = `+export const applyDiscount = (items, percent) => {
+  if (!(percent >= 0 && percent <= 100)) throw new RangeError("percent must be 0..100");
+  return Math.floor((total(items) * (100 - percent)) / 100);
+};
`;
const TESTS = `diff --git a/test/cart.test.js b/test/cart.test.js
--- a/test/cart.test.js
+++ b/test/cart.test.js
@@ -1,3 +1,3 @@
 import { test } from "node:test";
 import assert from "node:assert";
-import { total, summary } from "../src/cart.js";
+import { total, summary, applyDiscount } from "../src/cart.js";
@@ -5,0 +6,3 @@
+test("applyDiscount normal", () => assert.equal(applyDiscount(items, 10), 2025));
+test("applyDiscount rounds down", () => assert.equal(applyDiscount([{ cents: 999, qty: 1 }], 10), 899));
+test("applyDiscount RangeError", () => assert.throws(() => applyDiscount(items, 101), RangeError));
`;

const cases: { name: string; diff: string; expect: "approved" | "rejected" }[] = [
  { name: "good", diff: HEAD + GOOD_CODE + TESTS, expect: "approved" },
  { name: "no tests", diff: HEAD + GOOD_CODE, expect: "rejected" },
  { name: "rounds up (Math.ceil)", diff: HEAD + GOOD_CODE.replace("Math.floor", "Math.ceil") + TESTS, expect: "rejected" },
  { name: "no range check", diff: HEAD + GOOD_CODE.replace(/.*RangeError.*\n/, "") + TESTS, expect: "rejected" },
  {
    name: "scope creep",
    diff: HEAD + GOOD_CODE + TESTS + `diff --git a/src/format.js b/src/format.js
--- a/src/format.js
+++ b/src/format.js
@@ -1 +1 @@
-export const formatPrice = (cents) => \`$\${(cents / 100).toFixed(2)}\`;
+export const formatPrice = (cents) => \`USD \${(cents / 100).toFixed(2)}\`;
`,
    expect: "rejected",
  },
];

const Out = z.object({ verdict: z.enum(["approved", "rejected"]), comments: z.string(), summary: z.string() });
const cwd = mkdtempSync(join(tmpdir(), "eval-"));
const files = { reviewer: ["code-reviewer"], qa: ["qa-automation"] } as const;

for (const model of values.models.split(",")) {
  for (const role of ["reviewer", "qa"] as const) {
    process.env[`MODEL_${role.toUpperCase()}`] = model;
    let right = 0, tokens = 0, usd = 0;
    const marks: string[] = [];
    for (const c of cases) {
      const { output, usage } = await runAgent({
        role, files: [...files[role]], cwd, schema: Out,
        context: `${ticket}\n\nDiff:\n${c.diff}\n\nAnswer only in the structured format. \`summary\`: up to 10 lines.`,
      });
      const ok = output.verdict === c.expect;
      right += +ok;
      tokens += usage.tokens_in + usage.tokens_out + usage.cache_read + usage.cache_create;
      usd += usage.cost_usd;
      marks.push(`${ok ? "ok " : "MISS"} ${c.name} -> ${output.verdict}${ok ? "" : ": " + output.comments.replaceAll("\n", " ").slice(0, 300)}`);
    }
    console.log(`${model} ${role}: ${right}/${cases.length} correct, ${tokens} tokens, US$${usd.toFixed(3)}\n  ${marks.join("\n  ")}`);
  }
}
