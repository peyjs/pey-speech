// The service-level adapter fake, shared between the service tests and the
// adapter contract suite (a test file must never be imported by another
// test file — that double-runs every test it contains).
export function createFakeAdapter({ supported = true, processing = 'cloud', granted = true } = {}) {
  const calls = [];
  let session = null;
  const adapter = {
    calls,
    isSupported() {
      calls.push('isSupported');
      return { supported, processing };
    },
    async requestPermission() {
      calls.push('requestPermission');
      return { granted };
    },
    start(input) {
      calls.push({ start: input.language });
      let ended = false;
      let lastFinal = null;
      const finish = (report) => {
        if (!ended) {
          ended = true;
          input.end(report);
        }
      };
      const control = {
        stop: ({ flush }) => {
          if (flush && lastFinal !== null) {
            finish({ reason: 'speech', text: lastFinal });
            return;
          }
          finish({ reason: 'cancelled' });
        },
      };
      session = {
        control,
        emitPartial: (text) => input.onPartial?.(text),
        emitFinal: (text) => {
          lastFinal = text;
          input.onFinal?.(text);
        },
        emitNoSpeech: () => finish({ reason: 'no-speech' }),
        emitError: (code) => finish({ reason: 'error', code }),
        emitDeviceEnd: () => finish({ reason: lastFinal !== null ? 'speech' : 'no-speech', text: lastFinal }),
      };
      return control;
    },
    stop(options = { flush: false }) {
      calls.push('stop');
      session?.control?.stop(options);
    },
  };
  return {
    adapter,
    session: () => session,
    calls,
  };
}
