#!/usr/bin/env node
/**
 * Cloud-Pi live research CLI (AGT-028).
 *
 *   node scripts/research.mjs --topic "…" [--goal …] [--time-range 48h] \
 *     [--max-searches 6] [--max-pages 10] [--max-runtime-ms 480000] \
 *     [--runs-dir .work/research-runs] [--search-provider auto] \
 *     [--runtime-module /abs/path/to/agt-027-runtime.mjs]
 *
 *   node scripts/research.mjs --read <runId> [--runs-dir …]
 *
 * Exit codes: 0 success (completed / completed_with_errors, or a successful
 * read), 1 failed run / read error, 2 usage or invalid request, 3 agent runtime
 * unavailable (AGT-027 not wired — the live path fails closed).
 *
 * `--read` is fully offline: it only reads a persisted run directory. The live
 * path loads the AGT-027 runtime port and the real research tools; it never
 * reads credentials itself and never prints them.
 */
import { join } from "node:path";
import { ENV, TIME_RANGE } from "../src/research/contracts.mjs";
import { RuntimeUnavailableError, loadAgentRuntimePort } from "../src/research/port.mjs";
import { executeResearch, readResearchRun, RunValidationError } from "../src/research/index.mjs";
import { RunStoreError, resolveRunsRoot } from "../src/research/run-store.mjs";

const SEARCH_PROVIDERS = new Set(["auto", "hackernews", "bing-rss", "bing-html", "searxng"]);

const USAGE = `Cloud-Pi research CLI (AGT-028)

Live run:
  node scripts/research.mjs --topic <topic> [options]
    --goal <text>              research goal (optional)
    --time-range <window>      one of: ${Object.values(TIME_RANGE).join(", ")} (default: any)
    --max-searches <n>         search budget (contract max 12)
    --max-pages <n>            page-read budget (contract max 20)
    --max-runtime-ms <n>       global deadline (contract max 900000)
    --runs-dir <dir>           artifact root (default: $${ENV.RUNS_DIR} or .work/research-runs)
    --search-provider <name>   auto | hackernews | bing-rss | bing-html | searxng
    --runtime-module <spec>    AGT-027 runtime module (default: $${ENV.AGENT_RUNTIME_MODULE})

Read a persisted run (offline):
  node scripts/research.mjs --read <runId> [--runs-dir <dir>]

Exit codes: 0 success, 1 failed, 2 usage/invalid request, 3 runtime unavailable.`;

class UsageError extends Error {}

const VALUE_FLAGS = Object.freeze({
  "--topic": "topic",
  "--goal": "goal",
  "--time-range": "timeRange",
  "--max-searches": "maxSearches",
  "--max-pages": "maxPages",
  "--max-runtime-ms": "maxRuntimeMs",
  "--runs-dir": "runsDir",
  "--search-provider": "searchProvider",
  "--runtime-module": "runtimeModule",
  "--read": "readRunId",
});

function parsePositiveInt(flag, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} expects a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const [flag, inlineValue] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!(flag in VALUE_FLAGS)) {
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    }
    const key = VALUE_FLAGS[flag];
    let value = inlineValue;
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${flag} requires a value`);
      }
      index += 1;
    }
    if (value === "") throw new UsageError(`${flag} requires a non-empty value`);
    if (key === "maxSearches" || key === "maxPages" || key === "maxRuntimeMs") {
      options[key] = parsePositiveInt(flag, value);
    } else {
      options[key] = value;
    }
  }
  if (options.searchProvider && !SEARCH_PROVIDERS.has(options.searchProvider)) {
    throw new UsageError(
      `--search-provider expects one of ${[...SEARCH_PROVIDERS].join(", ")}, got ${JSON.stringify(options.searchProvider)}`,
    );
  }
  return options;
}

function artifactLines(record, rootDir) {
  const dir = join(rootDir, record.runId);
  return [
    `run_id: ${record.runId}`,
    `status: ${record.status}`,
    `created_at: ${record.createdAt}`,
    `runs_dir: ${dir}`,
    `report: ${record.paths?.report ? join(dir, record.paths.report) : "(none)"}`,
    `sources: ${record.paths?.sources ? join(dir, record.paths.sources) : "(none)"}`,
  ];
}

async function readRun(options) {
  const rootDir = resolveRunsRoot({ rootDir: options.runsDir });
  let loaded;
  try {
    loaded = await readResearchRun(options.readRunId, { rootDir });
  } catch (error) {
    if (error instanceof RunStoreError) {
      console.error(`error: ${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
  for (const line of artifactLines(loaded.run, rootDir)) console.log(line);
  return 0;
}

async function runLive(options) {
  const runtimeModule = options.runtimeModule ?? process.env[ENV.AGENT_RUNTIME_MODULE];
  let runtimePort;
  try {
    runtimePort = await loadAgentRuntimePort({ moduleSpecifier: runtimeModule });
  } catch (error) {
    if (error instanceof RuntimeUnavailableError) {
      console.error(`runtime_unavailable: ${error.message}`);
      return 3;
    }
    throw error;
  }

  const limits = {};
  if (options.maxSearches !== undefined) limits.maxSearches = options.maxSearches;
  if (options.maxPages !== undefined) limits.maxPages = options.maxPages;
  if (options.maxRuntimeMs !== undefined) limits.maxRuntimeMs = options.maxRuntimeMs;

  let searchTool;
  let readPageTool;
  try {
    const [searchModule, readModule] = await Promise.all([
      import("../src/research/tools/search.mjs"),
      import("../src/research/tools/read-page.mjs"),
    ]);
    const provider = options.searchProvider ?? process.env[ENV.SEARCH_PROVIDER];
    searchTool = searchModule.createWebSearchTool({ limits, ...(provider ? { provider } : {}) });
    readPageTool = readModule.createReadPageTool({ limits });
  } catch (error) {
    console.error(`error: cannot load the research tool layer: ${error?.message ?? error}`);
    return 1;
  }

  const rootDir = resolveRunsRoot({ rootDir: options.runsDir });
  const record = await executeResearch(
    {
      topic: options.topic,
      goal: options.goal ?? "",
      timeRange: options.timeRange ?? TIME_RANGE.ANY,
      limits,
    },
    { runtimePort, toolLayer: { tools: [searchTool, readPageTool] }, rootDir, env: process.env },
  );

  for (const line of artifactLines(record, rootDir)) console.log(line);
  if (record.runtime?.usage?.source === "unknown") {
    console.log("usage: unknown (agent runtime did not report token usage)");
  }
  const succeeded =
    record.status === "completed" || record.status === "completed_with_errors";
  return succeeded ? 0 : 1;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.readRunId) return readRun(options);
  if (!options.topic) {
    console.error("error: --topic is required for a live run (or use --read <runId>)");
    console.error(USAGE);
    return 2;
  }

  try {
    return await runLive(options);
  } catch (error) {
    if (error instanceof RunValidationError) {
      console.error(`invalid_request: ${error.message}`);
      return 2;
    }
    if (error instanceof RuntimeUnavailableError) {
      console.error(`runtime_unavailable: ${error.message}`);
      return 3;
    }
    if (error instanceof RunStoreError) {
      console.error(`error: ${error.code}: ${error.message}`);
      return 1;
    }
    console.error(`error: ${error?.message ?? error}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`error: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
}

export { main };
