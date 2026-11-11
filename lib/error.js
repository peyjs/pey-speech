// Creates safe Bonyan errors at the pey.speech plugin boundary. Raw
// device errors never cross: only mapped codes with fixed, safe messages.

import { ERROR_CODES, PLUGIN_NAME } from './constants.js';

// The three standard Bonyan error types; exported so the adapter loader's
// pass-through check can validate a third-party error's type value. A
// frozen ARRAY, not a Set: a frozen Set still grows through `.add`, so a
// mutable guard collection would let any importer neuter the gate with one
// call — the frozen array refuses both push and mutation.
export const ERROR_TYPES = Object.freeze(['startup', 'operational', 'critical']);
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Checks whether a code satisfies the standard Bonyan error-code shape.
 * @param {unknown} code Candidate code.
 * @returns {boolean} True when the code is well-formed.
 */
export function isStandardErrorCode(code) {
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code);
}

/**
 * Creates a standard Bonyan error owned by this plugin.
 *
 * @param {string} code Stable machine-readable error code.
 * @param {string} message Safe human-readable message.
 * @param {'startup'|'operational'|'critical'} [type='operational'] Error category.
 * @returns {{code: string, message: string, source: string, type: string, timestamp: string}}
 * @throws {TypeError} When the error type is unsupported.
 */
export function createSpeechError(code, message, type = 'operational') {
  if (!ERROR_CODE_PATTERN.test(code)) {
    throw new TypeError(`Unsupported error code: ${code}`);
  }
  if (!ERROR_TYPES.includes(type)) {
    throw new TypeError(`Unsupported Bonyan error type: ${type}`);
  }

  return {
    code,
    message,
    source: PLUGIN_NAME,
    type,
    timestamp: new Date().toISOString(),
  };
}
