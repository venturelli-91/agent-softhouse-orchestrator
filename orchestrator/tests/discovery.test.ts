import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { briefingMarkdown, DiscoveryOutput, type DiscoveryQuestion } from "../src/ticket.ts";

const q: z.infer<typeof DiscoveryQuestion> = { block: "scope", question: "Mobile too?", why: "changes the screens", default: "yes" };
const valid = { problem: "checkout drops", questions: [q], ready: false, briefing: {} };

test("discovery output rejects a sixth question", () => {
  assert.equal(DiscoveryOutput.safeParse({ ...valid, questions: Array(6).fill(q) }).success, false);
  assert.equal(DiscoveryOutput.safeParse({ ...valid, questions: Array(5).fill(q) }).success, true);
});

test("a question without why or default is rejected", () => {
  assert.equal(DiscoveryOutput.safeParse({ ...valid, questions: [{ ...q, why: "" }] }).success, false);
  const noDefault = { block: q.block, question: q.question, why: q.why };
  assert.equal(DiscoveryOutput.safeParse({ ...valid, questions: [noDefault] }).success, false);
});

test("briefingMarkdown lists filled fields and assumed defaults", () => {
  const b = DiscoveryOutput.parse({ ...valid, briefing: { problem: "checkout drops", success: "conversion +2%" } }).briefing;
  const md = briefingMarkdown(b, [q]);
  assert.match(md, /## Problem\ncheckout drops/);
  assert.match(md, /## Success\nconversion \+2%/);
  assert.doesNotMatch(md, /## Users/);
  assert.match(md, /## Assumed defaults\n- Mobile too\? → yes/);
  const injected = briefingMarkdown({ ...b, problem: "x\n## Fake" }, []);
  assert.doesNotMatch(injected, /^## Fake/m);
});
