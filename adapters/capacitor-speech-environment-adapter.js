// Capacitor SpeechRecognition environment adapter for pey.speech (Android).
//
// Talks to the @capgo/capacitor-speech-recognition native plugin through the
// runtime-injected window.Capacitor bridge (docs/android.md §5/§7 — no
// bundler, no direct npm import: the bridge object is read off globalThis at
// call time, so this module loads in a plain browser too, where it simply
// reports "unsupported" and the app keeps working — same fail-open posture
// as ui/utils/capacitor-back.js).
//
// WHY Cap-go and not @capacitor-community/speech-recognition: the community
// plugin has open, unfixed native bugs that map one-to-one onto our field
// findings (issue #127 — stop() never resolves, a stale recognizer after
// partialResults breaks every restart, and a late listeningState event that
// kills the next session). Cap-go fixes that class of bugs natively: it
// delivers definitive `segmentResults` per segment, emits
// `readyForNextSession` after native teardown, supports a silence window
// (`allowForSilence`), accumulates text itself (`accumulatedText`), can mute
// the recognizer beep, and its `error` event carries structured codes.
//
// SESSION MANAGEMENT: one LOGICAL session over many native segments. The
// native layer ends a segment on silence and reports it; this adapter
// re-opens the next segment when the bridge signals readiness, keeps the
// accumulated text flowing through onPartial/onFinal, and only the caller's
// stop (or a hard failure streak) ends the logical session.

const START_ERROR_PERMISSION_MARKERS = Object.freeze(['denied', 'permission']);

// Android's recognizer reports ordinary silence as an error event with
// device-specific wording (ERROR_NO_MATCH / ERROR_SPEECH_TIMEOUT): "No
// match", "Didn't understand, please try again.". These are segment ENDS,
// not failures — the logical session just re-opens.
const NO_SPEECH_ERROR_MARKERS = Object.freeze([
  'no match',
  "didn't understand",
  'no speech',
  'insufficient',
]);

const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MAX_FAILURE_RESTARTS = 3;
const DEFAULT_ALLOW_FOR_SILENCE_MS = 1500;
const DEFAULT_READY_WAIT_MS = 1500;
// Wait after stopping a busy recognizer before re-opening: the native layer
// tears down asynchronously — an immediate start lands on a dying recognizer
// and fails instantly (the re-entry "Didn't understand" storm).
const DEFAULT_SEGMENT_SETTLE_MS = 250;

/**
 * Reads the injected Capacitor SpeechRecognition bridge, if any.
 * @returns {object|null} The plugin bridge object, or null outside Capacitor.
 */
function capacitorSpeechPlugin() {
  return globalThis.Capacitor?.Plugins?.SpeechRecognition ?? null;
}

/**
 * Maps an untyped native start() rejection or error event onto a
 * session-end error code.
 * @param {unknown} error The caught rejection or error payload.
 * @returns {string} SPEECH_PERMISSION_DENIED or SPEECH_SERVICE_UNAVAILABLE.
 */
function mapStartError(error) {
  const raw = `${error?.message ?? error?.code ?? error ?? ''}`.toLowerCase();
  const permission = START_ERROR_PERMISSION_MARKERS.some((marker) => raw.includes(marker));
  return permission ? 'SPEECH_PERMISSION_DENIED' : 'SPEECH_SERVICE_UNAVAILABLE';
}

/**
 * Whether an untyped native error payload is ordinary silence (no speech
 * matched) rather than a real failure.
 * @param {unknown} error The error payload ({ message } / { code }).
 * @returns {boolean}
 */
function isNoSpeechError(error) {
  const raw = `${error?.message ?? error?.code ?? ''}`.toLowerCase();
  return NO_SPEECH_ERROR_MARKERS.some((marker) => raw.includes(marker));
}

/**
 * Extracts the best text from a Cap-go partial payload: the native
 * accumulation (accumulatedText) wins — it survives segment restarts.
 * @param {object} data partialResults payload ({ matches, accumulatedText }).
 * @returns {string|null} The accumulated text, or null when empty.
 */
function textFromPartial(data) {
  if (typeof data?.accumulatedText === 'string' && data.accumulatedText.trim() !== '') {
    return data.accumulatedText;
  }
  if (Array.isArray(data?.matches)) {
    const latest = data.matches[data.matches.length - 1];
    if (typeof latest === 'string' && latest.trim() !== '') {
      return latest;
    }
  }
  return null;
}

/**
 * Creates the Capacitor SpeechRecognition environment adapter.
 *
 * @param {object} [adapterConfig] Adapter tuning: restartDelayMs (segment
 *   re-open delay, default 250), maxFailureRestarts (consecutive failed
 *   native starts tolerated before surfacing an error, default 3),
 *   allowForSilenceMs (Android silence window per segment, default 1500),
 *   readyWaitMs (fallback wait for readyForNextSession, default 1500) and
 *   segmentSettleMs (wait after stopping a busy recognizer, default 250).
 * @returns {object} Environment adapter over the internal contract.
 */
export function createCapacitorSpeechEnvironmentAdapter(adapterConfig = {}) {
  const restartDelayMs = typeof adapterConfig.restartDelayMs === 'number'
    && adapterConfig.restartDelayMs >= 0
    ? adapterConfig.restartDelayMs
    : DEFAULT_RESTART_DELAY_MS;
  const maxFailureRestarts = typeof adapterConfig.maxFailureRestarts === 'number'
    && adapterConfig.maxFailureRestarts >= 0
    ? adapterConfig.maxFailureRestarts
    : DEFAULT_MAX_FAILURE_RESTARTS;
  const allowForSilenceMs = typeof adapterConfig.allowForSilenceMs === 'number'
    && adapterConfig.allowForSilenceMs > 0
    ? adapterConfig.allowForSilenceMs
    : DEFAULT_ALLOW_FOR_SILENCE_MS;
  const readyWaitMs = typeof adapterConfig.readyWaitMs === 'number'
    && adapterConfig.readyWaitMs >= 0
    ? adapterConfig.readyWaitMs
    : DEFAULT_READY_WAIT_MS;
  const segmentSettleMs = typeof adapterConfig.segmentSettleMs === 'number'
    && adapterConfig.segmentSettleMs >= 0
    ? adapterConfig.segmentSettleMs
    : DEFAULT_SEGMENT_SETTLE_MS;

  // The adapter knows its own active session so the service can stop it
  // without holding the per-session control.
  let activeStop = null;

  return {
    /**
     * Reports support and where processing happens. The bridge's presence is
     * the sync signal; deeper availability surfaces as a start() error.
     * Processing stays 'unknown': Android's recognizer may run on-device or
     * through the device's own service, depending on the OEM.
     *
     * @returns {{supported: boolean, processing: string}} Support report.
     */
    isSupported() {
      const supported = capacitorSpeechPlugin() !== null;
      return { supported, processing: 'unknown' };
    },

    /**
     * Asks for the speech-recognition permission through the native plugin
     * (RECORD_AUDIO on Android), falling back to a check-only read.
     *
     * @returns {Promise<{granted: boolean}>} Permission outcome.
     */
    async requestPermission() {
      const bridge = capacitorSpeechPlugin();
      if (!bridge?.checkPermissions) {
        return { granted: false };
      }
      const granted = async () => {
        try {
          const status = await bridge.checkPermissions();
          return status?.speechRecognition === 'granted';
        } catch {
          return false;
        }
      };
      try {
        if (await granted()) {
          return { granted: true };
        }
        if (typeof bridge.requestPermissions === 'function') {
          await bridge.requestPermissions();
        }
        return { granted: await granted() };
      } catch {
        return { granted: false };
      }
    },

    /**
     * Starts one LOGICAL session. Exactly one end report arrives through
     * `end`, whatever the path — native segments come and go inside it:
     * silence ends a segment, `readyForNextSession` re-opens the next one,
     * the accumulated text keeps flowing through onPartial/onFinal, and
     * only the caller's stop (or a hard failure streak) delivers the final
     * report.
     *
     * @param {object} input { language, onPartial, onFinal, end }.
     * @returns {{stop: (options: {flush: boolean}) => void}} Session control.
     */
    start({ language, onPartial, onFinal, end }) {
      const bridge = capacitorSpeechPlugin();
      if (!bridge) {
        end({ reason: 'error', code: 'SPEECH_UNSUPPORTED' });
        return { stop: () => {} };
      }

      let ended = false;
      let callerStopped = false;
      let consecutiveFailures = 0;
      let restartScheduled = false;
      let lastKnownText = null;
      let startTimer = null;
      let readyTimer = null;
      const handles = [];

      const clearTimers = () => {
        if (startTimer !== null) {
          clearTimeout(startTimer);
          startTimer = null;
        }
        if (readyTimer !== null) {
          clearTimeout(readyTimer);
          readyTimer = null;
        }
        restartScheduled = false;
      };

      const removeListeners = () => {
        for (const handle of handles.splice(0)) {
          try {
            handle.remove?.();
          } catch {
            // Removing an already-removed listener is harmless.
          }
        }
      };

      const finish = (report) => {
        if (ended) {
          return;
        }
        ended = true;
        activeStop = null;
        clearTimers();
        removeListeners();
        end(report);
      };

      const setLastKnown = (text) => {
        if (typeof text === 'string' && text.trim() !== '') {
          lastKnownText = text;
        }
      };

      /**
       * Opens the next native segment inside the same logical session.
       * A permission rejection is terminal; any other failure retries up
       * to maxFailureRestarts consecutive times before surfacing.
       */
      const attempt = async () => {
        if (ended || callerStopped) {
          return;
        }
        if (consecutiveFailures > maxFailureRestarts) {
          console.warn('[pey.speech] recognizer keeps failing — ending the session');
          finish({
            reason: 'error',
            code: 'SPEECH_SERVICE_UNAVAILABLE',
            text: lastKnownText,
          });
          return;
        }
        try {
          const listening = await bridge.isListening?.();
          if (listening?.listening) {
            try {
              await bridge.stop?.();
            } catch {
              // The start attempt below reports its own error.
            }
            // The native layer tears down asynchronously — give it a beat
            // before re-opening, or the new start lands on a dying
            // recognizer and fails instantly.
            if (segmentSettleMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, segmentSettleMs));
            }
          }
        } catch {
          // Nothing to clean up — the start attempt reports its own error.
        }
        if (ended || callerStopped) {
          return;
        }
        restartScheduled = false;
        const startCall = bridge.start({
          language,
          partialResults: true,
          maxResults: 5,
          popup: false,
          allowForSilence: allowForSilenceMs,
        });
        startCall.then(() => {
          consecutiveFailures = 0;
        }).catch((error) => {
          if (ended || callerStopped) {
            return;
          }
          // Some devices reject start() with ordinary silence instead of an
          // error event — same treatment: a quiet segment end, no failure
          // counting.
          if (isNoSpeechError(error)) {
            if (!restartScheduled) {
              restartScheduled = true;
              readyTimer = setTimeout(() => void attempt(), readyWaitMs);
            }
            return;
          }
          const code = mapStartError(error);
          // The native rejection message is the only diagnostic the device
          // gives — keep it on the console behind the mapped code.
          console.warn(`[pey.speech] native segment failed (${code}):`, error?.message ?? error);
          if (code === 'SPEECH_PERMISSION_DENIED') {
            finish({ reason: 'error', code, text: lastKnownText });
            return;
          }
          consecutiveFailures += 1;
          restartScheduled = true;
          startTimer = setTimeout(() => void attempt(), restartDelayMs);
        });
      };

      try {
        handles.push(bridge.addListener('partialResults', (data) => {
          const text = textFromPartial(data);
          if (text !== null) {
            setLastKnown(text);
            onPartial?.(lastKnownText);
          }
        }));
        handles.push(bridge.addListener('segmentResults', (data) => {
          // The definitive result of one ended segment (Android): the tail
          // words the partials may have missed live here.
          const matches = Array.isArray(data?.matches) ? data.matches : [];
          const best = matches.length > 0 ? matches[0] : null;
          if (typeof best === 'string' && best.trim() !== '') {
            setLastKnown(best);
            onFinal?.(lastKnownText);
          }
        }));
        handles.push(bridge.addListener('error', (data) => {
          // A permission error is terminal for the logical session — no
          // amount of retrying grants the permission.
          if (mapStartError(data) === 'SPEECH_PERMISSION_DENIED') {
            finish({ reason: 'error', code: 'SPEECH_PERMISSION_DENIED', text: lastKnownText });
            return;
          }
          // Ordinary silence ("No match" / "Didn't understand, please try
          // again."): a segment end, not a failure — keep the logical
          // session alive with the usual fallback re-open, no warn spam, no
          // failure counting.
          if (isNoSpeechError(data)) {
            if (!ended && !callerStopped && !restartScheduled) {
              restartScheduled = true;
              readyTimer = setTimeout(() => void attempt(), readyWaitMs);
            }
            return;
          }
          // Anything else is transient: logged and left to the segment
          // restart logic.
          console.warn(`[pey.speech] native error (${data?.code ?? 'unknown'}):`, data?.message ?? data);
        }));
        handles.push(bridge.addListener('listeningState', (data) => {
          // A segment ended (silence/results/error): the bridge reports
          // readiness separately — schedule a fallback re-open in case
          // readyForNextSession never arrives.
          if (data?.state === 'stopped' && !ended && !callerStopped && !restartScheduled) {
            restartScheduled = true;
            readyTimer = setTimeout(() => void attempt(), readyWaitMs);
          }
        }));
        handles.push(bridge.addListener('readyForNextSession', () => {
          // Native teardown finished — the safe moment to re-open.
          if (!ended && !callerStopped) {
            clearTimers();
            startTimer = setTimeout(() => void attempt(), restartDelayMs);
          }
        }));
      } catch {
        finish({ reason: 'error', code: 'SPEECH_SERVICE_UNAVAILABLE' });
        return { stop: () => {} };
      }

      void attempt();

      const control = {
        stop: ({ flush }) => {
          callerStopped = true;
          const text = lastKnownText;
          if (flush && text !== null) {
            finish({ reason: 'speech', text });
          } else {
            finish({ reason: 'cancelled' });
          }
          try {
            const stopped = bridge.stop?.();
            stopped?.catch?.(() => {});
          } catch {
            // The session may already be gone — the end report is delivered.
          }
        },
      };
      activeStop = control;
      return control;
    },

    /**
     * Stops the adapter's active session (the service's session-level
     * control also works; this keeps the adapter contract complete).
     *
     * @param {{flush: boolean}} options Whether to deliver the last result.
     * @returns {void}
     */
    stop(options = { flush: false }) {
      activeStop?.stop(options);
    },
  };
}
