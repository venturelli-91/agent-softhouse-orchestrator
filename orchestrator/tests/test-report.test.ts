import { test } from "node:test";
import assert from "node:assert/strict";
import { addedSkips, parseCounts, skipAlerts } from "../src/test-report.ts";

test("parseCounts reads node --test, pytest and jest summaries and adds up several runs", () => {
  const spec = "ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ skipped 1\nℹ todo 0\n";
  assert.deepEqual(parseCounts(spec + spec.replaceAll("\n", "\r\n")), { pass: 4, skip: 2, fail: 0 });
  assert.deepEqual(parseCounts("ok 1 - a\n# pass 5\n# fail 1\n# skipped 0\n"), { pass: 5, skip: 0, fail: 1 });
  assert.deepEqual(parseCounts("===== 3 passed, 2 skipped, 1 failed, 1 error in 0.42s ====="), { pass: 3, skip: 2, fail: 2 });
  assert.deepEqual(parseCounts("Tests:       1 failed, 1 skipped, 5 passed, 7 total"), { pass: 5, skip: 1, fail: 1 });
  assert.equal(parseCounts("all good\n"), null);
});

test("addedSkips flags unconditional skips added to test files only", () => {
  const diff = [
    "+++ b/test/cart.test.js",
    "+test.skip(\"total\", () => {});",
    "+test(\"tax\", { skip: process.platform === \"win32\" }, () => {});",
    "+  it.todo(\"later\");",
    "+++ b/tests/test_cart.py",
    "+@pytest.mark.skip(reason=\"flaky\")",
    "+@pytest.mark.skipif(sys.platform == \"win32\", reason=\"posix\")",
    "+++ b/src/cart.js",
    "+const opts = { skip: true };",
  ].join("\n");
  assert.deepEqual(addedSkips(diff), [
    "test/cart.test.js: test.skip(\"total\", () => {});",
    "test/cart.test.js: it.todo(\"later\");",
    "tests/test_cart.py: @pytest.mark.skip(reason=\"flaky\")",
  ]);
});

test("skipAlerts warns only when more tests are skipped than at the base", () => {
  assert.deepEqual(skipAlerts({ pass: 3, skip: 1, fail: 0 }, { pass: 3, skip: 2, fail: 0 }), ["2 tests skipped, the base had 1"]);
  assert.deepEqual(skipAlerts({ pass: 3, skip: 1, fail: 0 }, { pass: 4, skip: 1, fail: 0 }), []);
  assert.deepEqual(skipAlerts(null, { pass: 3, skip: 9, fail: 0 }), []);
});
