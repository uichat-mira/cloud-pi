/**
 * Pi model-runtime assembly for one OpenAI-compatible endpoint.
 *
 * This is the only place a live credential enters the runtime. The key is
 * registered as a non-persistent runtime credential: it is never written to the
 * agent directory, the session transcript or a log.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RuntimeError } from "./errors.mjs";
import { redactSecrets } from "./config.mjs";

/**
 * Conservative OpenAI-compatible defaults.
 *
 * New API and most compatible gateways accept `max_tokens`, do not understand
 * the `store`/`developer` fields and do not implement `reasoning_effort`.
 * Sending the OpenAI defaults instead produces 400s on those gateways.
 */
export const OPENAI_COMPATIBLE_COMPAT = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
});

/** The declarative Pi provider/model registration for this configuration. */
export function providerRegistration(config) {
  return {
    name: `Cloud Pi (${config.providerId})`,
    baseUrl: config.baseUrl,
    api: config.api,
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        api: config.api,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: config.contextWindow,
        maxTokens: config.maxOutputTokens,
        compat: { ...OPENAI_COMPATIBLE_COMPAT },
      },
    ],
  };
}

/**
 * Create an isolated `ModelRuntime` bound to the configured endpoint.
 *
 * `allowModelNetwork: false` keeps `ModelRuntime.create()` from fetching model
 * catalogs; the only network traffic this runtime performs is the model call
 * itself. The runtime directory is a private temp directory so a developer's
 * `~/.pi` credentials and model catalog are never read or mutated.
 */
export async function createModelRuntime(config) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "cloud-pi-runtime-"));
  let modelRuntime;
  try {
    modelRuntime = await ModelRuntime.create({
      authPath: join(runtimeDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider(config.providerId, providerRegistration(config));
    await modelRuntime.setRuntimeApiKey(config.providerId, config.apiKey);
  } catch (error) {
    rmSync(runtimeDir, { recursive: true, force: true });
    throw new RuntimeError(
      "config_error",
      `Could not assemble the Pi model runtime: ${redactSecrets(String(error?.message ?? error), [config.apiKey])}`,
    );
  }

  const model = modelRuntime.getModel(config.providerId, config.modelId);
  if (!model) {
    rmSync(runtimeDir, { recursive: true, force: true });
    throw new RuntimeError(
      "model_not_found",
      `The assembled Pi model runtime does not expose ${config.providerId}/${config.modelId}`,
    );
  }

  return {
    modelRuntime,
    model,
    runtimeDir,
    dispose() {
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}
