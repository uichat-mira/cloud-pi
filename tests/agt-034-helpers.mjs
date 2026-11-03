/**
 * Shared harness for the AGT-034 management API tests.
 *
 * The harness builds the real local HTTP server, the real Scheduler and the real
 * Research run store. Only the AGT-027 runtime port / research tool layer are
 * deterministic fixtures (the model/network boundary), exactly as the Issue
 * allows. No test replaces `startResearch`, the executor or the run store.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementApi } from "../src/api/index.mjs";
import { createScheduler } from "../src/scheduler/index.mjs";
import { completedPort, createFakeClock, researchDeps } from "./helpers/scheduler-fixture.mjs";

export async function tempRoot(t, prefix = "cloud-pi-agt-034-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function baseRequest(extra = {}) {
  return {
    topic: "研究最近 48 小时 AI Agent 工程进展",
    goal: "验证本地管理 API 的薄控制面",
    timeRange: "48h",
    ...extra,
  };
}

export function captureLogger() {
  const lines = [];
  return {
    lines,
    info(message) {
      lines.push(String(message));
    },
    warn(message) {
      lines.push(String(message));
    },
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start a real scheduler + real HTTP server on an ephemeral loopback port.
 * Cleanup is registered with `t.after`; explicit `stop()` is also supported for
 * restart tests.
 */
export async function startApiHarness(
  t,
  {
    clock = createFakeClock("2026-11-03T00:00:00Z"),
    port = completedPort(),
    root,
    stateDir,
    runsDir,
    schedulerOptions = {},
    apiOptions = {},
  } = {},
) {
  const base = root ?? (await tempRoot(t));
  const schedulerStateDir = stateDir ?? join(base, "scheduler");
  const researchRunsDir = runsDir ?? join(base, "runs");
  const scheduler = await createScheduler({
    stateDir: schedulerStateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: researchRunsDir, port }),
    ...schedulerOptions,
  });
  const logger = apiOptions.logger ?? captureLogger();
  const api = createManagementApi({
    scheduler,
    runsDir: researchRunsDir,
    env: {},
    host: "127.0.0.1",
    port: 0,
    logger,
    shutdownTimeoutMs: 300,
    ...apiOptions,
  });
  const address = await api.start();

  const request = async (method, path, body, { headers = {}, timeoutMs = 10_000 } = {}) => {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(init.headers, "content-type")) {
        init.headers["content-type"] = "application/json";
      }
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await fetch(new URL(path, address.url), init);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, body: json, text };
  };

  const cleanup = async () => {
    await api.stop().catch(() => {});
    await scheduler.stop({ abortActive: true }).catch(() => {});
  };
  t.after(cleanup);

  return {
    base,
    stateDir: schedulerStateDir,
    runsDir: researchRunsDir,
    scheduler,
    api,
    address,
    logger,
    request,
    stop: cleanup,
  };
}

/** Minimal raw HTTP request for malformed paths / headers that fetch rejects. */
export function rawHttpRequest({ port, method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, body: json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
