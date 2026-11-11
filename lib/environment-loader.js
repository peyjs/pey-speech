// Loads and validates the configured environment adapter for pey.speech.

import { ERROR_TYPES, createSpeechError } from './error.js';

const ADAPTER_METHODS = ['isSupported', 'requestPermission', 'start', 'stop'];

// The three startup codes a factory's standard error may carry for its
// identity to survive the loader (documented in the reference's adapter
// contract); exported so the doc/code sync test can lock the triple.
export const ADAPTER_ERROR_CODES = Object.freeze({
  INITIALIZATION_FAILED: 'SPEECH_ADAPTER_INITIALIZATION_FAILED',
  INVALID: 'SPEECH_ADAPTER_INVALID',
  NOT_FOUND: 'SPEECH_ADAPTER_NOT_FOUND',
});

const DEFAULT_ADAPTER_LOADERS = Object.freeze({
  WebSpeechEnvironmentAdapter: async (adapterConfig) => {
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
      ADAPTER_ERROR_CODES.INVALID,
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
  const adapterLoader = typeof identifier === 'string' ? adapterLoaders[identifier] : undefined;

  if (typeof adapterLoader !== 'function') {
    throw startupError(
      ADAPTER_ERROR_CODES.NOT_FOUND,
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
    const declared = error?.code && Object.values(ADAPTER_ERROR_CODES).includes(error.code);
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
      ADAPTER_ERROR_CODES.INITIALIZATION_FAILED,
      'Configured environment adapter could not be initialized',
    );
  }

  validateAdapter(adapter);
  return adapter;
}
