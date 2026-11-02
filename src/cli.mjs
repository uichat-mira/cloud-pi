#!/usr/bin/env node
/**
 * Local single-prompt entry point for the Cloud Pi live Agent runtime.
 *
 *   npm run agent -- "Read welcome.md and summarize it"
 *   node --env-file-if-exists=.env src/cli.mjs --json "..."
 *
 * Exits 0 on success, 1 for a failed/timed-out/cancelled run, 2 for invalid
 * configuration. Secrets are never printed; provider errors are redacted.
 */
import { resolve } from "node:path";
import { ConfigError, describeConfig, loadConfig } from "./config.mjs";
import { RuntimeError } from "./errors.mjs";
import { createAgentRuntime } from "./runtime.mjs";
import { LOCAL_READ_TOOL_NAME, createLocalReadTool } from "./tools.mjs";

function parseArgs(argv) {
  const args = { json: false, prompt: [] };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--") continue;
    else args.prompt.push(arg);
  }
  return args;
}

function usage() {
  return [
    "Usage: npm run agent -- [--json] <prompt>",
    "",
    "Environment (see .env.example):",
    "  CLOUD_PI_MODEL_BASE_URL   OpenAI-compatible base URL (required)",
    "  CLOUD_PI_MODEL_API_KEY    provider key (required, never printed)",
    "  CLOUD_PI_MODEL_ID         model id (required)",
    "  CLOUD_PI_TOOL_ROOT        read-only notes directory (default: ./notes)",
    "",
    "Optional limits: CLOUD_PI_RUN_TIMEOUT_MS, CLOUD_PI_MAX_TOOL_CALLS,",
    "CLOUD_PI_MODEL_MAX_OUTPUT_TOKENS, CLOUD_PI_MODEL_CONTEXT_WINDOW.",
  ].join("\n");
}

function formatRun(record, config) {
  const lines = [
    `run_id:      ${record.runId}`,
    `status:      ${record.status}`,
    `provider:    ${record.model.providerId} (${record.model.api})`,
    `model:       ${record.model.modelId}`,
    `base_url:    ${config.baseUrl}`,
    `duration:    ${record.durationMs} ms`,
    `usage:       input=${record.usage.input} output=${record.usage.output} cache_read=${record.usage.cacheRead} total=${record.usage.total}`,
    `tools:       ${record.toolCalls.length === 0 ? "(none)" : ""}`,
  ];
  for (const call of record.toolCalls) {
    const detail = call.reason ?? (call.durationMs !== undefined ? `${call.durationMs} ms` : "");
    lines.push(`  - ${call.name} [${call.status}]${detail ? ` ${detail}` : ""}`);
  }
  if (record.error) lines.push(`error:       ${record.error.code}: ${record.error.message}`);
  lines.push("", "answer:", record.text || "(empty)");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.prompt.length === 0) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const prompt = args.prompt.join(" ");

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`config_error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const toolRoot = process.env.CLOUD_PI_TOOL_ROOT
    ? resolve(process.env.CLOUD_PI_TOOL_ROOT)
    : resolve(process.cwd(), "notes");
  const runtime = await createAgentRuntime({
    config,
    cwd: process.cwd(),
    customTools: [createLocalReadTool({ root: toolRoot })],
    allowedTools: [LOCAL_READ_TOOL_NAME],
  });

  try {
    const record = await runtime.run(prompt);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ config: describeConfig(config), record }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${formatRun(record, config)}\n`);
    }
    return record.status === "succeeded" ? 0 : 1;
  } finally {
    runtime.dispose();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`config_error: ${error.message}\n`);
    process.exitCode = 2;
  } else if (error instanceof RuntimeError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`error: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
