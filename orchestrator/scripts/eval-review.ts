// Does a cheaper model still catch bad diffs? Runs reviewer and qa on hand-made changes with known verdicts,
// each in its own real git repo (the agents can read the code, like in the graph).
// Usage: node --env-file=.env scripts/eval-review.ts --models modelA,modelB [--reps 3]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runAgent } from "../src/run-agent.ts";
import { git } from "./fixture.ts";

const { values } = parseArgs({ options: { models: { type: "string" }, reps: { type: "string", default: "1" } } });
if (!values.models) throw new Error("--models a,b required");

const ticket = `Ticket T-1: Add percentage discount to cart
Acceptance criteria:
- applyDiscount(items, percent) in src/cart.js returns the discounted total in cents, rounded down
- percent outside 0..100 throws RangeError
- tests cover the normal case, rounding and the RangeError
Current summary:
Implemented applyDiscount and tests.`;

const BASE = {
  "package.json": '{"name":"cart","type":"module","scripts":{"test":"node --test"}}\n',
  "src/format.js": "export const formatPrice = (cents) => `$${(cents / 100).toFixed(2)}`;\n",
  "src/cart.js": 'import { formatPrice } from "./format.js";\nexport const total = (items) => items.reduce((s, i) => s + i.cents * i.qty, 0);\n',
  "test/cart.test.js":
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { total } from "../src/cart.js";\n' +
    "const items = [{ cents: 1000, qty: 1 }, { cents: 1250, qty: 1 }];\n" +
    'test("total", () => assert.equal(total(items), 2250));\n',
};
const CHECK = '  if (!(percent >= 0 && percent <= 100)) throw new RangeError("percent must be 0..100");\n';
const code = (floor = "Math.floor", check = CHECK) =>
  `export const applyDiscount = (items, percent) => {\n${check}  return ${floor}((total(items) * (100 - percent)) / 100);\n};\n`;
const tests =
  'test("applyDiscount normal", () => assert.equal(applyDiscount(items, 10), 2025));\n' +
  'test("applyDiscount rounds down", () => assert.equal(applyDiscount([{ cents: 999, qty: 1 }], 10), 899));\n' +
  'test("applyDiscount RangeError", () => assert.throws(() => applyDiscount(items, 101), RangeError));\n';

type Files = Record<string, string>;
const withDiscount = (c: string, withTests = true): Files => ({
  "src/cart.js": BASE["src/cart.js"] + c,
  ...(withTests && {
    "test/cart.test.js": BASE["test/cart.test.js"].replace("{ total }", "{ total, applyDiscount }") + tests,
  }),
});

const cases: { name: string; files: Files; expect: "approved" | "rejected" }[] = [
  { name: "good", files: withDiscount(code()), expect: "approved" },
  { name: "no tests", files: withDiscount(code(), false), expect: "rejected" },
  { name: "rounds up (Math.ceil)", files: withDiscount(code("Math.ceil")), expect: "rejected" },
  { name: "no range check", files: withDiscount(code("Math.floor", "")), expect: "rejected" },
  {
    name: "scope creep",
    files: { ...withDiscount(code()), "src/format.js": "export const formatPrice = (cents) => `USD ${(cents / 100).toFixed(2)}`;\n" },
    expect: "rejected",
  },
];

// Fresh repo per case: base commit, then the candidate change on top; returns the worktree and the diff against base.
function makeRepo(files: Files) {
  const repo = mkdtempSync(join(tmpdir(), "eval-"));
  const write = (f: Files) => {
    for (const [p, c] of Object.entries(f)) {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), c);
    }
  };
  git(repo, "init", "-q", "-b", "main");
  write(BASE);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  write(files);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  return { repo, diff: git(repo, "diff", "--no-ext-diff", "HEAD~1", "HEAD") };
}

const Out = z.object({ verdict: z.enum(["approved", "rejected"]), comments: z.string(), summary: z.string() });
const files = { reviewer: ["code-reviewer"], qa: ["qa-automation"] } as const;
const reps = Number(values.reps);

for (const model of values.models.split(",")) {
  for (const role of ["reviewer", "qa"] as const) {
    process.env[`MODEL_${role.toUpperCase()}`] = model;
    let right = 0, tokens = 0, usd = 0;
    const marks: string[] = [];
    for (const c of cases) {
      let hits = 0;
      for (let i = 0; i < reps; i++) {
        const { repo, diff } = makeRepo(c.files);
        const { output, usage } = await runAgent({
          role, files: [...files[role]], cwd: repo, schema: Out,
          context: `${ticket}\n\nDiff:\n${diff}\n\nAnswer only in the structured format. \`summary\`: up to 10 lines.`,
        });
        const ok = output.verdict === c.expect;
        hits += +ok;
        tokens += usage.tokens_in + usage.tokens_out + usage.cache_read + usage.cache_create;
        usd += usage.cost_usd;
        if (!ok) marks.push(`MISS ${c.name} -> ${output.verdict}: ${output.comments.replaceAll("\n", " ").slice(0, 300)}`);
      }
      right += hits;
      marks.push(`${c.name}: ${hits}/${reps}`);
    }
    console.log(`${model} ${role}: ${right}/${cases.length * reps} correct, ${tokens} tokens, US$${usd.toFixed(3)}\n  ${marks.join("\n  ")}`);
  }
}
