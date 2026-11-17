import { test } from "node:test";
import assert from "node:assert/strict";
import { isBareApproval } from "../src/ceo-node.ts";
import { pendingDetail } from "../scripts/orch/ctx.ts";

test("a bare approval is no answer to an escalation, a real instruction is", () => {
  for (const a of [undefined, "approve", " Approve ", "ok", "LGTM"]) assert.equal(isBareApproval(a), true, String(a));
  for (const a of ["retry", "abort", "approve the PR but rename the helper"]) assert.equal(isBareApproval(a), false, a);
});

test("a discovery pause notifies the problem and each question numbered with its default", () => {
  const questions = [{ question: "Mobile too?", default: "yes" }, { question: "Deadline?", default: "none" }];
  assert.equal(pendingDetail({ type: "discovery", title: "t", problem: "cart abandon", questions }),
    "cart abandon\n1. Mobile too? (default: yes)\n2. Deadline? (default: none)");
  assert.equal(pendingDetail({ type: "escalation", title: "t", reason: "why", summary: "s" }), "why");
});
