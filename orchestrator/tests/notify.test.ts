import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.ts";

test("notify is silent without a URL and never throws on a bad one", async () => {
  await notify("x", {});
  await notify("x", { NOTIFY_URL: "http://127.0.0.1:1/none" });
});
