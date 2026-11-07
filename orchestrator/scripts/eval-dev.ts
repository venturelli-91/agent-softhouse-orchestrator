// Model choice for the dev node: real tickets on a clone of the sandbox repo, scored by hidden acceptance tests
// the dev never sees (its own `npm test` passing is not enough), plus turns, tokens and cost. Local only: no push.
// Usage: node --env-file=.env scripts/eval-dev.ts --repo <sandbox path> --models a,b [--reps 3] [--tickets 1,2]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createWorktree, DEV_RULES } from "../src/graph.ts";
import { verifyEvidence } from "../src/guardrails.ts";
import { NodeFailure, runAgent } from "../src/run-agent.ts";

const { values } = parseArgs({
  options: { repo: { type: "string" }, models: { type: "string" }, reps: { type: "string", default: "3" }, tickets: { type: "string" } },
});
if (!values.repo || !values.models) throw new Error("--repo and --models required");

const head = 'import { test } from "node:test";\nimport assert from "node:assert";\n';
const tickets = [
  {
    title: "Add isEmpty helper",
    criteria: ["src/cart.js exports isEmpty(items) returning true for an empty array and false otherwise", "tests cover both cases"],
    hidden: head
      + 'import { isEmpty } from "../src/cart.js";\ntest("isEmpty", () => { assert.equal(isEmpty([]), true); assert.equal(isEmpty([{ cents: 1, ' +
      'qty: 1 }]), false); });\n',
  },
  {
    title: "Add percentage discount",
    criteria: [
      "src/cart.js exports applyDiscount(items, percent) returning the discounted total in cents, rounded down",
      "a percent outside 0..100 throws RangeError",
      "tests cover the normal case, rounding and the RangeError",
    ],
    hidden: head + 'import { applyDiscount } from "../src/cart.js";\nconst items = [{ cents: 1000, qty: 2 }, { cents: 250, qty: 1 }];\n' +
      'test("discount", () => { assert.equal(applyDiscount(items, 10), 2025); assert.equal(applyDiscount([{ cents: 995, qty: 1 }], 10), 895); ' +
        'assert.equal(applyDiscount(items, 0), 2250); assert.equal(applyDiscount(items, 100), 0); });\n' +
      'test("range", () => { assert.throws(() => applyDiscount(items, 101), RangeError); assert.throws(() => applyDiscount(items, -1), RangeError); });\n',
  },
  {
    title: "Format prices with a thousands separator and a currency",
    criteria: [
      "formatPrice(cents, currency = 'USD') in src/format.js: USD gives '$1,234.56', EUR gives '€1,234.56'",
      "negative amounts render as '-$1.50'",
      "summary(items) in src/cart.js keeps working unchanged and shows the separator for large totals",
      "tests cover USD, EUR, negative and a total over 1,000",
    ],
    hidden: head + 'import { formatPrice } from "../src/format.js";\nimport { summary } from "../src/cart.js";\n' +
      'test("format", () => { assert.equal(formatPrice(123456), "$1,234.56"); assert.equal(formatPrice(123456, "EUR"), "€1,234.56"); ' +
        'assert.equal(formatPrice(-150), "-$1.50"); assert.equal(formatPrice(5), "$0.05"); });\n' +
      'test("summary", () => { assert.equal(summary([{ cents: 100000, qty: 2 }]), "$2,000.00"); assert.equal(summary([{ cents: 1000, qty: 2 }, { ' +
        'cents: 250, qty: 1 }]), "$22.50"); });\n',
  },
  {
    title: "Merge duplicate cart lines",
    criteria: [
      "src/cart.js exports mergeItems(items): lines with the same sku are merged into one, summing qty",
      "the first occurrence keeps its position and its cents; lines without a sku are never merged",
      "the input array is not mutated",
      "tests cover merging, order, no-sku lines and non-mutation",
    ],
    hidden: head + 'import { mergeItems } from "../src/cart.js";\n' +
      'test("merge", () => { const input = [{ sku: "a", cents: 100, qty: 1 }, { sku: "b", cents: 50, qty: 2 }, { sku: "a", cents: 100, qty: 3 }]; ' +
        'const copy = JSON.parse(JSON.stringify(input));\n' +
      '  assert.deepEqual(mergeItems(input), [{ sku: "a", cents: 100, qty: 4 }, { sku: "b", cents: 50, qty: 2 }]); assert.deepEqual(input, copy); });\n' +
      'test("no sku", () => { const input = [{ cents: 10, qty: 1 }, { cents: 10, qty: 1 }]; assert.equal(mergeItems(input).length, 2); });\n',
  },
  {
    title: "Coupon codes",
    criteria: [
      "src/coupons.js exports applyCoupon(items, code, now = new Date()) returning the total in cents after the coupon",
      "codes are case-insensitive and trimmed: 'SAVE10' returns the total after 10% off, with that final total rounded down (995 cents becomes " +
        "895); 'FIVE' takes 500 cents off but never below 0",
      "'OLD20' (total after 20% off, final total rounded down) expired on 2020-01-01: it throws an Error whose message contains 'expired' when now " +
        "is after that date",
      "an unknown code throws an Error whose message contains 'unknown'; no code (undefined or empty) returns the plain total",
      "tests cover each rule",
    ],
    hidden: head + 'import { applyCoupon } from "../src/coupons.js";\nconst items = [{ cents: 1000, qty: 2 }, { cents: 250, qty: 1 }];\n' +
      'test("percent", () => { assert.equal(applyCoupon(items, "SAVE10"), 2025); assert.equal(applyCoupon(items, "  save10 "), 2025); ' +
        'assert.equal(applyCoupon([{ cents: 995, qty: 1 }], "SAVE10"), 895); });\n' +
      'test("fixed", () => { assert.equal(applyCoupon(items, "FIVE"), 1750); assert.equal(applyCoupon([{ cents: 300, qty: 1 }], "five"), 0); });\n' +
      'test("expired", () => { assert.throws(() => applyCoupon(items, "OLD20", new Date("2021-01-01")), /expired/i); ' +
        'assert.equal(applyCoupon(items, "OLD20", new Date("2019-06-01")), 1800); });\n' +
      'test("unknown and none", () => { assert.throws(() => applyCoupon(items, "NOPE"), /unknown/i); assert.equal(applyCoupon(items), 2250); ' +
        'assert.equal(applyCoupon(items, ""), 2250); });\n',
  },
  {
    title: "Paginate cart lines",
    criteria: [
      "src/cart.js exports paginate(items, page, size) returning { items, page, pages, total } where pages = ceil(total / size) and total = items.length",
      "pages are 1-based; a page past the last one returns an empty items array; an empty list has pages = 0",
      "page < 1, non-integer page, size < 1 or non-integer size throws RangeError",
      "the input array is not mutated; tests cover each rule",
    ],
    hidden: head + 'import { paginate } from "../src/cart.js";\nconst l = [1, 2, 3, 4, 5].map((n) => ({ cents: n, qty: 1 }));\n' +
      'test("pages", () => { assert.deepEqual(paginate(l, 1, 2), { items: l.slice(0, 2), page: 1, pages: 3, total: 5 }); ' +
        'assert.deepEqual(paginate(l, 3, 2).items, l.slice(4)); });\n' +
      'test("edges", () => { assert.deepEqual(paginate(l, 4, 2).items, []); assert.deepEqual(paginate([], 1, 2), { items: [], page: 1, pages: 0, ' +
        'total: 0 }); });\n' +
      'test("range", () => { for (const [p, z] of [[0, 2], [1.5, 2], [1, 0], [1, 2.5], [-1, 2]]) assert.throws(() => paginate(l, p, z), RangeError); });\n' +
      'test("no mutation", () => { const c = JSON.stringify(l); paginate(l, 1, 2); assert.equal(JSON.stringify(l), c); });\n',
  },
];

const Out = z.object({ summary: z.string().describe("at most 10 lines") });
const pick = values.tickets?.split(",").map(Number);
const reps = Number(values.reps);
const sum = (u: { tokens_in: number; tokens_out: number; cache_read: number; cache_create: number }) => u.tokens_in + u.tokens_out + u.cache_read
  + u.cache_create;

for (const model of values.models.split(",")) {
  process.env.MODEL_DEV = model;
  let ok = 0, verified = 0, runs = 0, tokens = 0, usd = 0, turns = 0, ms = 0;
  const lines: string[] = [];
  for (const [n, tk] of tickets.entries()) {
    if (pick && !pick.includes(n + 1)) continue;
    for (let i = 0; i < reps; i++) {
      runs++;
      const root = mkdtempSync(join(tmpdir(), "dev-"));
      execFileSync("git", ["clone", "-q", values.repo, join(root, "repo")]);
      const { worktree, base } = createWorktree(join(root, "repo"), `T-${n + 1}`, join(root, "wt"));
      const context = `Ticket T-${n + 1}: ${tk.title}\nAcceptance criteria:\n${tk.criteria.map((c) => `- ${c}`).join("\n")}\nCurrent summary:\n\n\n` +
        DEV_RULES + "\n\nAnswer only in the structured format. `summary`: up to 10 lines, only what the next node needs.";
      let res;
      try {
        res = await runAgent({ role: "dev", files: ["dev-fullstack"], cwd: worktree, schema: Out, context });
      } catch (e) {
        if (!(e instanceof NodeFailure)) throw e;
        lines.push(`FAIL T${n + 1}: ${e.message}`);
        continue;
      }
      tokens += sum(res.usage); usd += res.usage.cost_usd; turns += res.usage.turns; ms += res.usage.ms;
      const v = verifyEvidence(worktree, base);
      verified += +v.ok;
      // Hidden acceptance tests run on the committed result.
      mkdirSync(join(worktree, "hidden"), { recursive: true });
      writeFileSync(join(worktree, "hidden", "acceptance.test.js"), tk.hidden);
      let pass = false, why = "";
      try {
        execFileSync("node", ["--test", "hidden/acceptance.test.js"], { cwd: worktree, stdio: "pipe" });
        pass = true;
      } catch (e) {
        why = String((e as { stdout?: Buffer }).stdout ?? "").split("\n").filter((l) => /not ok|expected|actual|Error/i.test(l)).slice(0, 4).join(" | ");
      }
      ok += +(v.ok && pass);
      if (!(v.ok && pass)) lines.push(`MISS T${n + 1}: evidence ${v.ok ? "ok" : "failed (" + v.reason + ")"}, hidden tests ${pass ? "pass" : "FAIL: "
        + why}; dev said: ${res.output.summary.replaceAll("\n", " ").slice(0, 900)}`);
    }
  }
  const head = `${model} dev: ${ok}/${runs} accepted (${verified} with verified evidence), ${tokens} tokens, ${turns} turns`;
  console.log(`${head}, ${(ms / 1000).toFixed(0)} s, US$${usd.toFixed(3)}${lines.length ? "\n  " + lines.join("\n  ") : ""}`);
}
