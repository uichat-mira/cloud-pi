/**
 * Start/stop lifecycle for the management API.
 *
 * The server must stop accepting new requests, let an already-entered short
 * control request finish within a bound, and force-close work that exceeds that
 * bound. It must also be safe to stop twice and refuse to restart a stopped
 * instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagementApi } from "../src/api/index.mjs";
import { delay, startApiHarness, tempRoot } from "./agt-034-helpers.mjs";

test("T-lifecycle: start/stop is idempotent and refuses restart after stop", async (t) => {
  const harness = await startApiHarness(t);
  const url = `${harness.address.url}/health`;
  assert.equal(harness.api.listening, true);
  assert.equal((await fetch(url)).status, 200);

  const first = await harness.api.stop();
  assert.equal(first.stopped, true);
  assert.equal(harness.api.listening, false);
  assert.equal(harness.api.address, null);
  const second = await harness.api.stop();
  assert.equal(second.stopped, true);

  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));

  await assert.rejects(harness.api.start(), (error) => error.code === "conflict");
});

test("T-lifecycle: stop drains an in-flight short control request", async (t) => {
  const root = await tempRoot(t);
  let enteredResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const scheduler = {
    async listSchedules() {
      enteredResolve();
      await delay(80);
      return [];
    },
  };
  const api = createManagementApi({
    scheduler,
    runsDir: root,
    host: "127.0.0.1",
    port: 0,
    shutdownTimeoutMs: 1_000,
  });
  const address = await api.start();
  t.after(() => api.stop());

  const pending = fetch(`${address.url}/schedules`);
  await entered;
  const startedAt = Date.now();
  const result = await api.stop();
  const elapsed = Date.now() - startedAt;
  const response = await pending;

  assert.equal(response.status, 200);
  assert.equal(result.forced, false);
  assert.ok(elapsed >= 50, `stop must let the request drain (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 1_500, `stop must stay bounded (elapsed ${elapsed}ms)`);
});

test("T-lifecycle: stop force-closes work that exceeds the drain bound", async (t) => {
  const root = await tempRoot(t);
  let enteredResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const scheduler = {
    listSchedules() {
      enteredResolve();
      return new Promise(() => {}); // never settles
    },
  };
  const api = createManagementApi({
    scheduler,
    runsDir: root,
    host: "127.0.0.1",
    port: 0,
    shutdownTimeoutMs: 120,
  });
  const address = await api.start();
  t.after(() => api.stop());

  const pending = fetch(`${address.url}/schedules`).then(
    (response) => ({ responded: true, response }),
    () => ({ responded: false }),
  );
  await entered;
  const startedAt = Date.now();
  const result = await api.stop();
  const elapsed = Date.now() - startedAt;
  const outcome = await pending;

  assert.equal(result.forced, true);
  assert.equal(outcome.responded, false);
  assert.ok(elapsed >= 100, `stop must wait for the bound (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 2_000, `stop must not hang (elapsed ${elapsed}ms)`);
  assert.equal(api.listening, false);
});

test("T-lifecycle: stop racing the initial bind owns and closes the listener", async (t) => {
  const root = await tempRoot(t);
  const api = createManagementApi({
    scheduler: { listSchedules: () => [] },
    runsDir: root,
    host: "127.0.0.1",
    port: 0,
    shutdownTimeoutMs: 200,
  });
  const starting = api.start();
  const stopped = await api.stop();
  const address = await starting;

  assert.equal(stopped.stopped, true);
  assert.equal(api.listening, false);
  assert.equal(api.address, null);
  await assert.rejects(fetch(`${address.url}/health`, { signal: AbortSignal.timeout(500) }));
});
