// Provides the pey.speech service: device speech recognition behind the
// environment adapter.
//
// The service owns the session lifecycle and the event surface; the
// adapter owns the device. Recognized text and audio never enter an
// event, an error or a log — results travel only through the caller's
// handlers and the listening handle's result. Startup requests no
// permission and starts no session.

import {
  DEFAULT_LANGUAGE,
  ERROR_CODES,
  LISTENING_STARTED_EVENT,
  LISTENING_STOPPED_EVENT,
  SERVICE_UNAVAILABLE,
} from './constants.js';
import { createSpeechError, isStandardErrorCode } from './error.js';

// Codes an adapter may deliver through end(): the plugin's declared error
// codes plus the global unavailable code. Anything else — however
// well-formed — is undeclared contract (the adapter is configurable
// third-party code) and maps to the safe recognizer failure, so consumers
// never branch on an unknown code.
const ADAPTER_ERROR_CODES = Object.freeze(new Set([...Object.values(ERROR_CODES), SERVICE_UNAVAILABLE]));

/**
 * Publishes an event when the bus exists. Bus failures never fail a call.
 * @param {object} events Event bus or null.
 * @param {string} type Event type.
 * @returns {void}
 */
function publish(events, type) {
  try {
    events?.publish(type);
  } catch {
    // Event bus issues never fail a service call (the plugin has no logger
    // and the requirements forbid failing user calls over a broken bus);
    // the failing publish is therefore silent by documented design — see
    // the bus-thrower test, which locks this behavior.
  }
}

/**
 * Shapes an adapter support report into exactly the shape the manifest
 * declares: a non-object report or a non-boolean `supported` reads as "no
 * usable report" (`{ supported: false, processing: 'unknown' }`), and a
 * `processing` outside the declared set falls back to 'unknown' — the
 * adapter is configurable third-party code and never hands the caller an
 * undeclared shape.
 * @param {unknown} report Raw adapter report.
 * @returns {{supported: boolean, processing: string}} Normalized report.
 */
function normalizeSupportReport(report) {
  const processing = report?.processing === 'local' || report?.processing === 'cloud'
    ? report.processing
    : 'unknown';
  if (report === null || typeof report !== 'object' || typeof report.supported !== 'boolean') {
    return { supported: false, processing: 'unknown' };
  }
  return { supported: report.supported, processing };
}

/**
 * Creates the speech service over a loaded environment adapter.
 * @param {object} state References ({ adapter, events, config }).
 * @returns {{service: object, deactivate: Function}} Service and lifecycle control.
 */
export function createSpeechService(state) {
  const adapter = state.adapter;
  const config = state.config ?? {};
  // Trimmed like the per-call override, so both language paths reach the
  // adapter identically.
  const defaultLanguage = typeof config.language === 'string' && config.language.trim().length > 0
    ? config.language.trim()
    : DEFAULT_LANGUAGE;
  let available = true;
  let active = null;

  function assertAvailable() {
    if (!available) {
      throw createSpeechError(SERVICE_UNAVAILABLE, 'Speech service is unavailable');
    }
  }

  function assertSupported() {
    let report;
    try {
      report = adapter.isSupported();
    } catch {
      // The adapter is configurable third-party code: its raw failure must
      // never cross the boundary (the same guard getSupport applies).
      throw createSpeechError(ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER, 'The recognizer could not report its support');
    }
    if (!report?.supported) {
      // A non-object report (null, undefined) means "no usable support
      // report" and is treated as unsupported, never dereferenced.
      throw createSpeechError(ERROR_CODES.UNSUPPORTED, 'Speech recognition is not supported in this environment');
    }
  }

  return {
    service: {
      /**
       * Reports environment support and, when the system says so, where
       * the processing happens.
       *
       * @returns {{supported: boolean, processing: string}} Support report.
       * @throws {object} SERVICE_UNAVAILABLE after deactivation.
       */
      getSupport() {
        assertAvailable();
        try {
          return normalizeSupportReport(adapter.isSupported());
        } catch {
          // The adapter is configurable third-party code: its raw failure
          // must never cross the boundary as an unstructured error.
          throw createSpeechError(ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER, 'The recognizer could not report its support');
        }
      },

      /**
       * Asks for the required permission explicitly (never at startup).
       *
       * @returns {Promise<{granted: boolean}>} Permission outcome.
       * @throws {object} SPEECH_UNSUPPORTED / SPEECH_PERMISSION_DENIED / SERVICE_UNAVAILABLE.
       */
      async requestPermission() {
        assertAvailable();
        assertSupported();
        let outcome;
        try {
          outcome = await adapter.requestPermission();
        } catch {
          throw createSpeechError(ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER, 'The recognizer could not process the permission request');
        }
        if (!outcome?.granted) {
          throw createSpeechError(ERROR_CODES.PERMISSION_DENIED, 'The required permission was not granted');
        }
        return { granted: true };
      },

      /**
       * Starts one listening session.
       *
       * @param {object} [input] { language? }.
       * @param {object} handlers { onPartial(text), onFinal(text) }.
       * @returns {Promise<{stop: Function, cancel: Function, done: Promise<object>}>} Session handle.
       * @throws {object} SPEECH_UNSUPPORTED / SPEECH_SESSION_ACTIVE / SERVICE_UNAVAILABLE.
       */
      async listen(input, handlers) {
        assertAvailable();
        assertSupported();
        if (active) {
          throw createSpeechError(ERROR_CODES.SESSION_ACTIVE, 'Another listening session is active');
        }
        const onPartial = typeof handlers?.onPartial === 'function' ? handlers.onPartial : null;
        const onFinal = typeof handlers?.onFinal === 'function' ? handlers.onFinal : null;
        const language = typeof input?.language === 'string' && input.language.trim().length > 0
          ? input.language.trim()
          : defaultLanguage;

        let ended = false;
        // The stopped event pairs with a published started one: a session
        // the device aborts inside start() never started, so neither event
        // fires for it — "stopped without started" would hand a
        // microphone-state UI an invalid sequence.
        let started = false;
        let resolveDone;
        const done = new Promise((resolve) => {
          resolveDone = resolve;
        });

        const end = (report) => {
          if (ended) {
            return;
          }
          ended = true;
          active = null;
          if (started) {
            publish(state.events, LISTENING_STOPPED_EVENT);
          }
          if (report?.reason === 'speech') {
            resolveDone({ ending: 'completed', text: typeof report.text === 'string' ? report.text : null });
            return;
          }
          if (report?.reason === 'no-speech') {
            resolveDone({
              ending: 'interrupted',
              error: createSpeechError(ERROR_CODES.NO_SPEECH, 'No speech was heard'),
            });
            return;
          }
          if (report?.reason === 'cancelled') {
            resolveDone({ ending: 'cancelled' });
            return;
          }
          // An adapter is configurable third-party code: its reported code
          // is trusted only when well-formed AND declared by this plugin —
          // otherwise it would crash the error factory (leaving done
          // pending forever) or hand the caller an undeclared code.
          const reportedCode = isStandardErrorCode(report?.code) && ADAPTER_ERROR_CODES.has(report.code)
            ? report.code
            : ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER;
          resolveDone({
            ending: 'interrupted',
            error: createSpeechError(reportedCode, 'The recognizer could not continue'),
          });
        };

        let control;
        try {
          control = adapter.start({ language, onPartial, onFinal, end });
        } catch {
          ended = true;
          active = null;
          throw createSpeechError(ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER, 'The recognizer could not start');
        }

        if (ended) {
          // The adapter failed synchronously inside start() and already
          // reported the end: re-arming `active` here would wedge the
          // session lock forever and publish started after stopped.
          return { stop: () => {}, cancel: () => {}, done };
        }

        // Live binding: the session always stops through the current
        // control, so a later control replacement is honored too.
        active = { stop: (options) => control.stop(options), end: (report) => end(report) };
        started = true;
        publish(state.events, LISTENING_STARTED_EVENT);
        // A device stop that throws cannot deliver a graceful end: the
        // session resolves as a recognizer failure so done never hangs.
        const guardedStop = (flush) => {
          try {
            control.stop({ flush });
          } catch {
            end({ reason: 'error', code: ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER });
          }
        };
        return {
          // The handle owns ITS OWN session's control: a stale handle from
          // a finished session must never cancel a newer one.
          stop: () => guardedStop(true),
          cancel: () => guardedStop(false),
          done,
        };
      },

      /**
       * Finishes the active session and delivers its result (the ending
       * is completed with the last final transcription, or cancelled when
       * nothing was recognized). A no-op when nothing is active.
       *
       * @returns {{ok: boolean}} Confirmation.
       * @throws {object} SERVICE_UNAVAILABLE after deactivation.
       */
      stop() {
        assertAvailable();
        try {
          active?.stop({ flush: true });
        } catch {
          // Same policy as the handle path: a device stop that throws
          // cannot deliver a graceful end, so the session closes here —
          // done resolves and the session lock frees — and the caller
          // still receives the structured failure.
          active?.end?.({ reason: 'error', code: ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER });
          throw createSpeechError(ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER, 'The recognizer could not be stopped');
        }
        return { ok: true };
      },
    },

    deactivate() {
      available = false;
      // The running session is cut without a result; later calls are
      // refused with the standard unavailable code. A broken adapter stop
      // must never reach the Core shutdown cycle (teardown/onShutdown) —
      // and it must still close the session like every other path does, or
      // the caller's done would hang forever.
      try {
        active?.stop({ flush: false });
      } catch {
        // The device stop failed: settle the session as cancelled (no
        // result was delivered) so done resolves and the lock frees. The
        // raw failure itself stays swallowed by design — it can never
        // reach the Core teardown, and the session state is discarded.
        active?.end?.({ reason: 'cancelled' });
      }
      active = null;
    },
  };
}
