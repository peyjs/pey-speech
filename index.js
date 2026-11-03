// Wires the speech service into Bonyan's two-phase plugin lifecycle.

import { DEFAULT_ADAPTER, SERVICE_NAME } from './lib/constants.js';
import { loadEnvironmentAdapter } from './lib/environment-loader.js';
import { createSpeechService } from './lib/speech-service.js';

const state = { adapter: null, events: null, config: {} };
let lifecycle = null;

/**
 * Prepares the plugin: loads the configured environment adapter and builds
 * the service. Requests no permission and starts no session. An
 * environment without speech support does not fail here — the service
 * reports "unsupported" instead.
 * @param {object} prepareContext Bonyan preparation context.
 * @returns {Promise<Array>} Service registration.
 */
export async function prepare(prepareContext) {
  state.adapter = null;
  state.events = prepareContext.events ?? null;
  state.config = prepareContext.config ?? {};
  const config = state.config;
  state.adapter = await loadEnvironmentAdapter(
    config.adapter ?? DEFAULT_ADAPTER,
    config.adapterConfig ?? {},
  );
  lifecycle = createSpeechService(state);
  prepareContext.onDeactivated = () => lifecycle?.deactivate();
  prepareContext.onShutdown = async () => lifecycle?.deactivate();
  return [{ name: SERVICE_NAME, object: lifecycle.service }];
}

/**
 * Activates the dependency-free speech plugin after settlement.
 *
 * @param {Record<string, object>} services Bound declared dependencies; always empty here.
 * @returns {Promise<void>}
 */
export async function activate(services) {
  void services;
}
