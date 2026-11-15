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
// stop (or a hard failure streak) ends the logical session. Re-opens are
// token-scheduled and the native start dispatch is serialized — a newer
// schedule supersedes an older one, and at most one native start is ever
// tracked in flight (a start that never settles is abandoned by the
// startTimeoutMs time guard instead of wedging the session).
//
// SIZE NOTE: this file deliberately stays in one piece despite the 200-line
// guideline: it is a single multi-segment state machine over a dozen closure
// bindings. The parts that extract cleanly (error classification, payload
// text extraction) are already standalone pure functions below; cutting the
// state machine out would trade real cohesion for an artificial parameter
// object.

// A permission failure is terminal — but only a genuine denial wording
// counts: "failed to query permission state" mentions permission too and
// must not end the session as a denial. Android's standard
// ERROR_INSUFFICIENT_PERMISSIONS ("Insufficient permissions") carries no
// denial verb, hence `insufficient`.
const PERMISSION_HINT_PATTERN = /permission/;
const PERMISSION_DENIED_PATTERN = /denied|required|missing|not granted|rejected|insufficient/;

// Android's recognizer reports ordinary silence as an error event with
// device-specific wording. Each marker's source wording:
//   'no match'          → ERROR_NO_MATCH ("No match")
//   "didn't understand" → ERROR_SPEECH_TIMEOUT ("Didn't understand, please
//                         try again.")
//   'no speech'         → recognizer variants ("no speech")
// These are segment ENDS, not failures — the logical session just re-opens.
// Nothing that names a real failure (permission, service) may live here.
const NO_SPEECH_ERROR_MARKERS = Object.freeze([
  'no match',
  "didn't understand",
  'no speech',
]);

const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MAX_FAILURE_RESTARTS = 3;
const DEFAULT_ALLOW_FOR_SILENCE_MS = 1500;
const DEFAULT_READY_WAIT_MS = 1500;
// Guard for a native start() that never settles: without it, a wedged
// bridge would hold startPending forever and the logical session would
// hang silently — no end report, no re-open, nothing.
const DEFAULT_START_TIMEOUT_MS = 5000;
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
  const permission = PERMISSION_HINT_PATTERN.test(raw) && PERMISSION_DENIED_PATTERN.test(raw);
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
 *   re-open delay after readiness or a failed start, default 250),
 *   maxFailureRestarts (consecutive failed native starts — or consecutive
 *   native error events with no text in between — tolerated before
 *   surfacing an error, default 3), allowForSilenceMs (Android silence
 *   window per segment, default 1500), readyWaitMs (fallback wait before
 *   re-opening when the readiness signal never fires, default 1500),
 *   segmentSettleMs (wait after stopping a busy recognizer, default 250)
 *   and startTimeoutMs (time guard: a native start that never settles is
 *   abandoned and counted as a failure, default 5000).
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
  const startTimeoutMs = typeof adapterConfig.startTimeoutMs === 'number'
    && adapterConfig.startTimeoutMs > 0
    ? adapterConfig.startTimeoutMs
    : DEFAULT_START_TIMEOUT_MS;

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
      // Consecutive native error events with no text in between: the same
      // "hard failure streak" notion as failed starts, for errors that
      // arrive while no start is pending. Text resets the streak — a device
      // that keeps recognizing is not failing.
      let consecutiveErrorEvents = 0;
      // Monotonic token for scheduled re-opens: a newer schedule supersedes
      // an older one, and a superseded attempt aborts at its next await.
      let restartToken = 0;
      // Serialization of the native start dispatch: an attempt dispatches
      // only while this is false and flips it synchronously, before any
      // await — so a re-open scheduled while a start is still pending skips
      // its own dispatch (the pending start either opens the segment, or
      // its failure handler schedules the next attempt). At most one native
      // start is ever tracked in flight; a start that never settles is
      // abandoned by the startTimeoutMs guard below instead of wedging the
      // session.
      let startPending = false;
      // Identity of the current dispatch: a start that was abandoned by the
      // time guard and settles late (resolve or reject) must not touch the
      // state of the newer dispatch that replaced it.
      let startDispatchId = 0;
      let startGuardTimer = null;
      let restartTimer = null;
      let lastKnownText = null;
      const handles = [];

      // Clears only the re-open scheduling. The start guard of a PENDING
      // start must survive this: a bridge event that schedules a re-open
      // during the pending window must not disarm the watchdog that would
      // rescue a wedged start — the scheduled attempt hits the startPending
      // guard and returns, and with the guard gone too, nothing would ever
      // move again. The guard is cleared only at its legitimate points: the
      // dispatch's own settle, the zombie abandonment inside the guard
      // itself, and finish().
      const clearTimers = () => {
        if (restartTimer !== null) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
      };

      const clearStartGuard = () => {
        if (startGuardTimer !== null) {
          clearTimeout(startGuardTimer);
          startGuardTimer = null;
        }
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
        clearStartGuard();
        removeListeners();
        end(report);
      };

      const setLastKnown = (text) => {
        if (typeof text === 'string' && text.trim() !== '') {
          lastKnownText = text;
          consecutiveErrorEvents = 0;
        }
      };

      const scheduleAttempt = (delay) => {
        clearTimers();
        restartToken += 1;
        const token = restartToken;
        restartTimer = setTimeout(() => {
          restartTimer = null;
          void runAttempt(token);
        }, delay);
      };

      /**
       * Opens the next native segment inside the same logical session. A
       * permission rejection is terminal; any other failure retries up to
       * maxFailureRestarts consecutive times before surfacing.
       * @param {number} token The schedule token that launched this attempt.
       * @returns {Promise<void>}
       */
      const runAttempt = async (token) => {
        if (ended || callerStopped || token !== restartToken) {
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
        if (ended || callerStopped || token !== restartToken || startPending) {
          return;
        }
        // The dispatch is fully guarded: a bridge whose start() throws
        // synchronously (or returns a non-thenable) flows into the same
        // failure mapping as a rejected promise — no unhandled rejection,
        // and the session always keeps its end report. A start that never
        // settles is abandoned by the time guard instead of wedging the
        // session behind startPending forever.
        startPending = true;
        const dispatchId = ++startDispatchId;
        clearStartGuard();
        startGuardTimer = startTimeoutMs > 0
          ? setTimeout(() => {
            startGuardTimer = null;
            if (dispatchId !== startDispatchId || ended || callerStopped || !startPending) {
              return;
            }
            // The zombie start is abandoned: stop tracking it, count the
            // failure, and let the re-open chain continue. Abandonment also
            // invalidates the zombie's dispatch identity — otherwise a late
            // settle landing BEFORE the next dispatch (the zombie's id is
            // still current there) would resolve the failure count away and
            // loop forever, or count the same start twice on reject. The
            // pre-start isListening cleanup deals with a recognizer the
            // zombie may have left listening.
            startPending = false;
            startDispatchId += 1;
            console.warn('[pey.speech] native start never settled — abandoning it');
            consecutiveFailures += 1;
            scheduleAttempt(restartDelayMs);
          }, startTimeoutMs)
          : null;
        Promise.resolve()
          .then(() => bridge.start({
            language,
            partialResults: true,
            maxResults: 5,
            popup: false,
            allowForSilence: allowForSilenceMs,
          }))
          .then(() => {
            if (dispatchId !== startDispatchId) {
              // A zombie's late settle — the newer dispatch owns the state.
              return;
            }
            clearStartGuard();
            startPending = false;
            consecutiveFailures = 0;
          })
          .catch((error) => {
            if (dispatchId !== startDispatchId) {
              // Same: the abandoned start's late rejection is ignored.
              return;
            }
            clearStartGuard();
            startPending = false;
            if (ended || callerStopped) {
              return;
            }
            // No token check here on purpose: a start whose token was
            // superseded while it was pending belongs to a newer schedule
            // that skipped its own dispatch (startPending) — this failure
            // is the only remaining path that keeps the re-open chain
            // alive. (The dispatchId check above filters a zombie's late
            // settle in both windows: after a newer dispatch, and between
            // the watchdog firing and the next dispatch — the abandonment
            // invalidates the zombie's identity.)
            // Some devices reject start() with ordinary silence instead of
            // an error event — same treatment: a quiet segment end, no
            // failure counting.
            if (isNoSpeechError(error)) {
              scheduleAttempt(readyWaitMs);
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
            scheduleAttempt(restartDelayMs);
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
          // words the partials may have missed live here. matches[0] is the
          // ended segment's OWN text, not the accumulation — banking it
          // verbatim could shorten the running text (the earlier segments'
          // words live only in accumulatedText). The native accumulation
          // wins when the payload carries it; otherwise the segment text is
          // banked only when it does not regress the running text.
          const matches = Array.isArray(data?.matches) ? data.matches : [];
          const best = matches.length > 0 ? matches[0] : null;
          if (typeof best === 'string' && best.trim() !== '') {
            const accumulated = typeof data?.accumulatedText === 'string' && data.accumulatedText.trim() !== ''
              ? data.accumulatedText
              : null;
            if (accumulated !== null) {
              setLastKnown(accumulated);
            } else if (lastKnownText === null || best.length >= lastKnownText.length) {
              setLastKnown(best);
            }
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
            scheduleAttempt(readyWaitMs);
            return;
          }
          // Anything else is transient: logged, and the logical session is
          // kept alive with a bounded fallback re-open — but a streak of
          // error events with no text in between is a hard failure, not
          // silence, and ends the session like a failed-start streak does.
          console.warn(`[pey.speech] native error (${data?.code ?? 'unknown'}):`, data?.message ?? data);
          consecutiveErrorEvents += 1;
          if (consecutiveErrorEvents > maxFailureRestarts) {
            finish({
              reason: 'error',
              code: 'SPEECH_SERVICE_UNAVAILABLE',
              text: lastKnownText,
            });
            return;
          }
          scheduleAttempt(readyWaitMs);
        }));
        handles.push(bridge.addListener('listeningState', (data) => {
          // A segment ended (silence/results/error): the bridge reports
          // readiness separately — schedule a fallback re-open in case
          // readyForNextSession never arrives.
          if (data?.state === 'stopped' && !ended && !callerStopped) {
            scheduleAttempt(readyWaitMs);
          }
        }));
        handles.push(bridge.addListener('readyForNextSession', () => {
          // Native teardown finished — the safe moment to re-open. The
          // fresh schedule supersedes any pending fallback (and aborts an
          // in-flight attempt at its next await), so exactly one re-open
          // lands.
          if (!ended && !callerStopped) {
            scheduleAttempt(restartDelayMs);
          }
        }));
      } catch {
        finish({ reason: 'error', code: 'SPEECH_SERVICE_UNAVAILABLE' });
        return { stop: () => {} };
      }

      void runAttempt(++restartToken);

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
