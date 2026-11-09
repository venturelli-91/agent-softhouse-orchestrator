import { test } from "node:test";
import assert from "node:assert/strict";
import { isBareApproval } from "../src/ceo-node.ts";

test("a bare approval is no answer to an escalation, a real instruction is", () => {
  for (const a of [undefined, "approve", " Approve ", "ok", "LGTM"]) assert.equal(isBareApproval(a), true, String(a));
  for (const a of ["retry", "abort", "approve the PR but rename the helper"]) assert.equal(isBareApproval(a), false, a);
});
