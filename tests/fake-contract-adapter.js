// A minimal in-memory environment adapter used as the second
// implementation for the shared adapter-contract suite.

/**
 * Creates a fake adapter over the internal adapter contract: it never
 * hears anything (every session ends as no-speech) but implements all
 * four contract methods.
 * @returns {object} Fake environment adapter.
 */
export function createContractAdapter() {
  let activeEnd = null;

  return {
    isSupported() {
      return { supported: true, processing: 'local' };
    },

    async requestPermission() {
      return { granted: true };
    },

    start({ end }) {
      activeEnd = end;
      return {
        stop: () => {
          if (activeEnd !== null) {
            activeEnd({ reason: 'no-speech' });
            activeEnd = null;
          }
        },
      };
    },

    stop() {
      // The adapter-level stop ends the active session, if any.
      if (activeEnd !== null) {
        activeEnd({ reason: 'no-speech' });
        activeEnd = null;
      }
    },
  };
}
