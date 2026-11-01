import { test } from "node:test";
import assert from "node:assert/strict";
import { DISCLOSURE, ghPrCreateArgs, prBody, publish, remoteOwner, type Pub } from "../src/publish.ts";

const pub: Pub = { cwd: ".", id: "T-1", sha: "abc", title: "T-1: x", body: "b", remote: "origin", baseRepo: "", disclosure: true };

test("prBody appends the disclosure line only when enabled", () => {
  assert.equal(prBody("b", true), `b\n\n---\n${DISCLOSURE}`);
  assert.equal(prBody("b", false), "b");
});

test("remoteOwner parses https and ssh urls", () => {
  assert.equal(remoteOwner("https://github.com/me/x.git"), "me");
  assert.equal(remoteOwner("git@github.com:me/x.git"), "me");
});

test("ghPrCreateArgs without base_repo is the current draft command", () => {
  const a = ghPrCreateArgs(pub, "me");
  assert.ok(a.join(" ").includes("--draft --head ticket/T-1"));
  assert.ok(!a.includes("--repo"));
});

test("with base_repo it targets it from the fork", () => {
  const a = ghPrCreateArgs({ ...pub, baseRepo: "up/stream" }, "me");
  assert.ok(a.join(" ").includes("--repo up/stream"));
  assert.ok(a.includes("me:ticket/T-1"));
});

test("a ticket publisher of none overrides PUBLISHER=github", () => {
  process.env.PUBLISHER = "github";
  assert.equal(publish(pub, "none"), "pr:none");
});
