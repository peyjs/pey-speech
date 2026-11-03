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
import { createSpeechError } from './error.js';

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
    // Event bus issues never fail a service call.
  }
}

/**
 * Creates the speech service over a loaded environment adapter.
 * @param {object} state References ({ adapter, events, config }).
 * @returns {{service: object, deactivate: Function}} Service and lifecycle control.
 */
export function createSpeechService(state) {
  const adapter = state.adapter;
  const config = state.config ?? {};
  const defaultLanguage = typeof config.language === 'string' && config.language.trim().length > 0
    ? config.language
    : DEFAULT_LANGUAGE;
  let available = true;
  let active = null;

  function assertAvailable() {
    if (!available) {
      throw createSpeechError(SERVICE_UNAVAILABLE, 'Speech service is unavailable');
    }
  }

  function assertSupported() {
    if (!adapter.isSupported().supported) {
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
        return adapter.isSupported();
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
          publish(state.events, LISTENING_STOPPED_EVENT);
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
          resolveDone({
            ending: 'interrupted',
            error: createSpeechError(
              typeof report?.code === 'string' ? report.code : ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER,
              'The recognizer could not continue',
            ),
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

        active = { stop: control.stop };
        publish(state.events, LISTENING_STARTED_EVENT);
        return {
          stop: () => active?.stop({ flush: true }),
          cancel: () => active?.stop({ flush: false }),
          done,
        };
      },

      /**
       * Finishes the active session and delivers its result (the ending
       * is completed with the last final transcription, or cancelled when
       * nothing was recognized). A no-op when nothing is active.
       *
       * @returns {{ok: boolean}} Confirmation.
       */
      stop() {
        active?.stop({ flush: true });
        return { ok: true };
      },
    },

    deactivate() {
      available = false;
      // The running session is cut without a result; later calls are
      // refused with the standard unavailable code.
      active?.stop({ flush: false });
      active = null;
    },
  };
}
