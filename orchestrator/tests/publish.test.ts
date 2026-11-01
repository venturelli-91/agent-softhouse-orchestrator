import { test } from "node:test";
import assert from "node:assert/strict";
import { RepoConfig } from "../src/repo-config.ts";
import { DISCLOSURE, effectivePublisher, ghPrCreateArgs, matchesPr, prBody, publish, remoteOwner, type Pub } from "../src/publish.ts";

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
  const prev = process.env.PUBLISHER;
  try {
    process.env.PUBLISHER = "github";
    assert.equal(publish(pub, "none"), "pr:none");
  } finally {
    if (prev === undefined) delete process.env.PUBLISHER;
    else process.env.PUBLISHER = prev;
  }
});

test("publish fails closed with no env, with or without a ticket publisher", () => {
  const prev = process.env.PUBLISHER;
  try {
    delete process.env.PUBLISHER;
    assert.throws(() => publish(pub), /missing env: PUBLISHER/);
    assert.throws(() => publish(pub, "github"), /missing env: PUBLISHER/);
    assert.throws(() => publish(pub, "none"), /missing env: PUBLISHER/);
  } finally {
    if (prev !== undefined) process.env.PUBLISHER = prev;
  }
});

test("effectivePublisher only lets a ticket narrow the env", () => {
  assert.throws(() => effectivePublisher("github", undefined), /missing env: PUBLISHER/);
  assert.equal(effectivePublisher("none", "github"), "none");
  assert.equal(effectivePublisher("github", "github"), "github");
  assert.throws(() => effectivePublisher("github", "none"), /publisher github not allowed by PUBLISHER=none/);
  assert.equal(effectivePublisher("", "github"), "github");
});

test("option-like push_remote and base_repo are rejected", () => {
  for (const push_remote of ["--mirror", "-f"]) assert.throws(() => RepoConfig.parse({ push_remote }), push_remote);
  assert.throws(() => RepoConfig.parse({ base_repo: "-x/y" }));
  assert.throws(() => RepoConfig.parse({ base_repo: "x/-y" }));
  assert.doesNotThrow(() => RepoConfig.parse({ push_remote: "my-fork", base_repo: "up/stream" }));
});

test("matchesPr accepts only the pushed sha from the expected owner", () => {
  const pr = { headRefOid: "abc", headRepositoryOwner: { login: "me" } };
  assert.equal(matchesPr(pr, "abc", "me"), true);
  assert.equal(matchesPr(pr, "def", "me"), false);
  assert.equal(matchesPr(pr, "abc", "other"), false);
  assert.equal(matchesPr({ headRefOid: "abc" }, "abc", "me"), true);
  assert.equal(matchesPr({ headRefOid: "def" }, "abc", "me"), false);
});
