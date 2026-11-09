import assert from "node:assert/strict";
import { test } from "node:test";
import { pathFlags } from "../src/path-flags.ts";

test("sensitive paths add the security and ai reviewers", () => {
  assert.deepEqual(pathFlags(["src/ui/button.tsx"]), { security: false, ai: false });
  assert.equal(pathFlags(["src/auth/session.ts"]).security, true);
  assert.equal(pathFlags(["lib/jwt.ts"]).security, true);
  assert.equal(pathFlags(["config/.env.example"]).security, true);
  assert.equal(pathFlags(["agents/triage.md"]).ai, true);
  assert.equal(pathFlags(["src/prompts/system.ts"]).ai, true);
  assert.equal(pathFlags(["src/author.ts"]).security, false);
});
