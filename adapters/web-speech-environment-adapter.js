// Web Speech API environment adapter for pey.speech (browser / WebView).
//
// Maps the raw recognizer onto the plugin's internal adapter contract:
// isSupported / requestPermission / start / stop. Device errors are
// translated into the plugin's error codes here — nothing raw leaves the
// adapter. In an environment without the Web Speech API the adapter still
// loads; it just reports "unsupported", so the host app keeps working.

const DEVICE_ERROR_CODES = Object.freeze({
  'not-allowed': 'SPEECH_PERMISSION_DENIED',
  'service-not-allowed': 'SPEECH_PERMISSION_DENIED',
  'no-speech': 'SPEECH_NO_SPEECH',
  network: 'SPEECH_SERVICE_UNAVAILABLE',
  aborted: null, // a deliberate stop, not a failure
});

/**
 * Creates the Web Speech environment adapter.
 *
 * @param {object} [adapterConfig] Adapter-specific configuration (unused today).
 * @returns {object} Environment adapter over the internal contract.
 */
export function createWebSpeechEnvironmentAdapter(adapterConfig = {}) {
  void adapterConfig;

  function recognizerCtor() {
    return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
  }

  return {
    /**
     * Reports support and, when the system says so, where processing
     * happens. The Web Speech API never says, so it stays 'unknown'.
     *
     * @returns {{supported: boolean, processing: string}} Support report.
     */
    isSupported() {
      const supported = recognizerCtor() !== null;
      return { supported, processing: supported ? 'unknown' : 'unknown' };
    },

    /**
     * Asks for microphone access — the closest proxy the platform offers
     * for speech-recognition permission.
     *
     * @returns {Promise<{granted: boolean}>} Permission outcome.
     */
    async requestPermission() {
      const mediaDevices = globalThis.navigator?.mediaDevices;
      if (typeof mediaDevices?.getUserMedia !== 'function') {
        return { granted: false };
      }
      try {
        const stream = await mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks?.() ?? []) {
          track.stop?.();
        }
        return { granted: true };
      } catch {
        return { granted: false };
      }
    },

    /**
     * Starts one recognition session. Exactly one end report arrives
     * through `end`, whatever the path — device end, device error, or a
     * caller stop.
     *
     * @param {object} input { language, onPartial, onFinal, end }.
     * @returns {{stop: (options: {flush: boolean}) => void}} Session control.
     */
    start({ language, onPartial, onFinal, end }) {
      const Ctor = recognizerCtor();
      if (!Ctor) {
        end({ reason: 'error', code: 'SPEECH_UNSUPPORTED' });
        return { stop: () => {} };
      }

      let recognition = null;
      let ended = false;
      let lastFinal = null;

      const finish = (report) => {
        if (ended) {
          return;
        }
        ended = true;
        try {
          recognition?.abort?.();
        } catch {
          // Stopping an already-stopped recognizer is harmless.
        }
        end(report);
      };

      try {
        recognition = new Ctor();
      } catch {
        end({ reason: 'error', code: 'SPEECH_SERVICE_UNAVAILABLE' });
        return { stop: () => {} };
      }

      recognition.lang = language;
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event) => {
        let interim = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) {
            lastFinal = result[0]?.transcript ?? '';
            onFinal?.(lastFinal);
          } else {
            interim += result[0]?.transcript ?? '';
          }
        }
        if (interim.length > 0) {
          onPartial?.(interim);
        }
      };

      recognition.onerror = (event) => {
        const mapped = DEVICE_ERROR_CODES[event?.error] ?? 'SPEECH_SERVICE_UNAVAILABLE';
        if (mapped === null) {
          return; // a deliberate stop lands through onend
        }
        finish({
          reason: mapped === 'SPEECH_NO_SPEECH' ? 'no-speech' : 'error',
          code: mapped,
          text: lastFinal,
        });
      };

      recognition.onend = () => {
        finish({
          reason: lastFinal !== null ? 'speech' : 'no-speech',
          text: lastFinal,
        });
      };

      try {
        recognition.start();
      } catch {
        finish({ reason: 'error', code: 'SPEECH_SERVICE_UNAVAILABLE' });
      }

      return {
        stop: ({ flush }) => {
          if (flush && lastFinal !== null) {
            finish({ reason: 'speech', text: lastFinal });
            return;
          }
          finish({ reason: 'cancelled' });
        },
      };
    },
  };
}
