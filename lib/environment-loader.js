// Loads and validates the configured environment adapter for pey.speech.

import { ERROR_TYPES, createSpeechError } from './error.js';

const ADAPTER_METHODS = ['isSupported', 'requestPermission', 'start', 'stop'];

// The three startup codes a factory's standard error may carry for its
// identity to survive the loader (documented in the reference's adapter
// contract); exported so the doc/code sync test can lock the triple.
// FACTORY in the name: speech-service's own ADAPTER_END_ERROR_CODES is a
// different set (the codes an adapter may report at SESSION end) — the
// same plain name with two meanings was a maintenance trap once this
// became public API.
export const ADAPTER_FACTORY_ERROR_CODES = Object.freeze({
  INITIALIZATION_FAILED: 'SPEECH_ADAPTER_INITIALIZATION_FAILED',
  INVALID: 'SPEECH_ADAPTER_INVALID',
  NOT_FOUND: 'SPEECH_ADAPTER_NOT_FOUND',
});

const DEFAULT_ADAPTER_LOADERS = Object.freeze({
  WebSpeechEnvironmentAdapter: async (adapterConfig) => {
    const { createWebSpeechEnvironmentAdapter } = await import('../adapters/web-speech-environment-adapter.js');
    return createWebSpeechEnvironmentAdapter(adapterConfig);
  },
  CapacitorSpeechEnvironmentAdapter: async (adapterConfig) => {
    const { createCapacitorSpeechEnvironmentAdapter } = await import('../adapters/capacitor-speech-environment-adapter.js');
    return createCapacitorSpeechEnvironmentAdapter(adapterConfig);
  },
  // Auto: the native Capacitor bridge when present (Android build), the
  // Web Speech API otherwise (plain browser) — one config for both worlds.
  AutoSpeechEnvironmentAdapter: async (adapterConfig) => {
    const capacitor = globalThis.Capacitor?.Plugins?.SpeechRecognition ?? null;
    if (capacitor !== null) {
      const { createCapacitorSpeechEnvironmentAdapter } = await import('../adapters/capacitor-speech-environment-adapter.js');
      return createCapacitorSpeechEnvironmentAdapter(adapterConfig);
    }
    const { createWebSpeechEnvironmentAdapter } = await import('../adapters/web-speech-environment-adapter.js');
    return createWebSpeechEnvironmentAdapter(adapterConfig);
  },
});

function startupError(code, message) {
  return createSpeechError(code, message, 'startup');
}

function validateAdapter(adapter) {
  const isValid = adapter !== null
    && typeof adapter === 'object'
    && ADAPTER_METHODS.every((methodName) => typeof adapter[methodName] === 'function');

  if (!isValid) {
    throw startupError(
      ADAPTER_FACTORY_ERROR_CODES.INVALID,
      'Configured environment adapter does not implement the required contract',
    );
  }
}

/**
 * Loads, creates, and validates a configured environment adapter.
 *
 * @param {string} identifier Configured adapter identifier.
 * @param {object} [adapterConfig={}] Adapter-specific configuration.
 * @param {Record<string, Function>} [adapterLoaders] Adapter factories.
 * @returns {Promise<object>} Validated environment adapter instance.
 * @throws {object} Standard startup error for unknown, failed, or invalid adapters.
 */
export async function loadEnvironmentAdapter(
  identifier,
  adapterConfig = {},
  adapterLoaders = DEFAULT_ADAPTER_LOADERS,
) {
  // Registry membership via OWN keys only: plain indexing reads the
  // prototype chain, so a configured `constructor`/`valueOf` would resolve
  // to the INHERITED function and fail validation as INVALID — the wrong
  // meaning for "no adapter with this identifier", which is NOT_FOUND.
  const adapterLoader = typeof identifier === 'string'
    && Object.prototype.hasOwnProperty.call(adapterLoaders, identifier)
    ? adapterLoaders[identifier]
    : undefined;

  if (typeof adapterLoader !== 'function') {
    throw startupError(
      ADAPTER_FACTORY_ERROR_CODES.NOT_FOUND,
      'Configured environment adapter is not supported',
    );
  }

  let adapter;

  try {
    adapter = await adapterLoader(adapterConfig);
  } catch (error) {
    // Pass through ONLY a standard-structured error carrying one of the
    // three codes this plugin actually declares, with VALID field values —
    // a factory is configurable third-party code, and a prefixed-but-
    // undeclared (or structurally broken: a non-standard type, an
    // unparseable timestamp) error maps like any other failure. The gate
    // is FIELD-shaped like the Bonyan error structure itself: a plain
    // object built by a standard factory (including this plugin's own
    // createSpeechError) crosses with its identity intact.
    const declared = error?.code && Object.values(ADAPTER_FACTORY_ERROR_CODES).includes(error.code);
    const structured = declared
      && typeof error.message === 'string'
      && typeof error.source === 'string'
      && ERROR_TYPES.includes(error.type)
      && typeof error.timestamp === 'string'
      && !Number.isNaN(Date.parse(error.timestamp));
    if (structured) {
      throw error;
    }
    throw startupError(
      ADAPTER_FACTORY_ERROR_CODES.INITIALIZATION_FAILED,
      'Configured environment adapter could not be initialized',
    );
  }

  validateAdapter(adapter);
  return adapter;
}
