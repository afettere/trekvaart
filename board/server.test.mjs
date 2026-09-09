// Spec for the board's HTTP shell. Run: node --test board/server.test.mjs
//
// The composer is where the truth is decided (compose.test.mjs); the server only reads,
// caches and serves. So this checks the shell: the page and the JSON are served, the JSON is
// what the reader returned, a reader failure is a 500 and not a blank board, the cache holds
// for the refresh window, and nothing but GET is answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, "page.html");

function listen(reader, refreshSeconds = 60) {
  const server = startServer({ listen: "127.0.0.1:0", refreshSeconds, reader, pagePath });
  return new Promise((resolve) => server.on("listening", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test("serves the page at / and the composed view at /api/board", async () => {
  const view = { readAt: "2026-09-09T21:31:00Z", attention: [], flights: [], spend: { leftUsd: 1 }, sweeper: [], box: {}, errors: {} };
  const { server, base } = await listen(() => view);
  try {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /Trekvaart <span>board<\/span>/);
    const api = await fetch(base + "/api/board");
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), view);
    assert.equal((await fetch(base + "/nope")).status, 404);
    assert.equal((await fetch(base + "/api/board", { method: "POST" })).status, 405);
  } finally {
    server.close();
  }
});

test("the reader runs once per refresh window, not once per request", async () => {
  let calls = 0;
  const { server, base } = await listen(() => ({ calls: ++calls }), 60);
  try {
    await fetch(base + "/api/board");
    await fetch(base + "/api/board");
    const third = await (await fetch(base + "/api/board")).json();
    assert.equal(third.calls, 1);
  } finally {
    server.close();
  }
});

test("a reader that throws is a 500 naming the error, never an empty board", async () => {
  const { server, base } = await listen(() => {
    throw new Error("ceiling.json unreadable");
  });
  try {
    const res = await fetch(base + "/api/board");
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /ceiling\.json unreadable/);
  } finally {
    server.close();
  }
});
