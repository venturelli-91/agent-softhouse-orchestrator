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

const hunk = (...added: string[]) => [`@@ -0,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`)];

test("addedSkips flags unconditional skips added to test files only", () => {
  const diff = [
    "diff --git a/test/cart.test.js b/test/cart.test.js",
    "--- a/test/cart.test.js",
    "+++ b/test/cart.test.js",
    ...hunk('test.skip("total", () => {});', 'test("tax", { skip: process.platform === "win32" }, () => {});', '  it.todo("later");'),
    "diff --git a/tests/test_cart.py b/tests/test_cart.py",
    "--- a/tests/test_cart.py",
    "+++ b/tests/test_cart.py",
    ...hunk('@pytest.mark.skip(reason="flaky")', '@pytest.mark.skipif(sys.platform == "win32", reason="posix")'),
    "diff --git a/src/cart.js b/src/cart.js",
    "--- a/src/cart.js",
    "+++ b/src/cart.js",
    ...hunk("const opts = { skip: true };"),
  ].join("\n");
  assert.deepEqual(addedSkips(diff), [
    'test/cart.test.js: test.skip("total", () => {});',
    'test/cart.test.js: it.todo("later");',
    'tests/test_cart.py: @pytest.mark.skip(reason="flaky")',
  ]);
});

test("an added line that looks like a file header does not hide a skip, and a quoted path is checked as a test file", () => {
  const fake = [
    "diff --git a/test/cart.test.js b/test/cart.test.js",
    "--- a/test/cart.test.js",
    "+++ b/test/cart.test.js",
    ...hunk("++ b/README.md", 'test.skip("total", () => {});'),
    "@@ -3 +4,0 @@",
    "-test.skip(\"old\", () => {});",
  ].join("\n");
  assert.deepEqual(addedSkips(fake), ['test/cart.test.js: test.skip("total", () => {});']);
  const quoted = ['diff --git "a/x\\ty" "b/x\\ty"', '--- "a/x\\ty"', '+++ "b/x\\ty"', ...hunk('test.skip("total", () => {});')].join("\n");
  assert.equal(addedSkips(quoted).length, 1);
});

test("skipAlerts warns only when more tests are skipped than at the base", () => {
  assert.deepEqual(skipAlerts({ pass: 3, skip: 1, fail: 0 }, { pass: 3, skip: 2, fail: 0 }), ["2 tests skipped, the base had 1"]);
  assert.deepEqual(skipAlerts({ pass: 3, skip: 1, fail: 0 }, { pass: 4, skip: 1, fail: 0 }), []);
  assert.deepEqual(skipAlerts(null, { pass: 3, skip: 9, fail: 0 }), []);
});
