// Tests for the Capacitor SpeechRecognition environment adapter (Cap-go
// bridge): contract shape, bridge detection, the GBoard-style logical
// session (segmentResults, readyForNextSession restarts, silence fallback,
// failure-streak cap), stop semantics, and error mapping — all against a
// fake window.Capacitor bridge. No real native plugin is ever touched.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCapacitorSpeechEnvironmentAdapter } from '../../adapters/capacitor-speech-environment-adapter.js';

/**
 * In-memory window.Capacitor bridge substitute (Cap-go API surface).
 * @param {object} [options] Behavior seeds.
 * @returns {object} Fake bridge with call records.
 */
function createFakeBridge(options = {}) {
  const bridge = {
    startReject: options.startReject ?? null,
    permissions: options.permissions ?? { speechRecognition: 'prompt' },
    requestGrants: options.requestGrants ?? true,
    isListening: options.isListening ?? (async () => ({ listening: false })),
    listeners: {},
    startCalls: [],
    stopCalls: 0,
    removed: 0,
    addListener(eventName, handler) {
      bridge.listeners[eventName] = bridge.listeners[eventName] ?? [];
      bridge.listeners[eventName].push(handler);
      return { remove: () => { bridge.removed += 1; } };
    },
    emit(eventName, data) {
      for (const handler of bridge.listeners[eventName] ?? []) {
        handler(data);
      }
    },
    async start(startOptions) {
      bridge.startCalls.push(startOptions);
      if (bridge.startReject !== null) throw bridge.startReject;
      return {};
    },
    async stop() {
      bridge.stopCalls += 1;
    },
    async checkPermissions() {
      return bridge.permissions;
    },
    async requestPermissions() {
      if (bridge.requestGrants) {
        bridge.permissions = { speechRecognition: 'granted' };
      }
      return bridge.permissions;
    },
  };
  return bridge;
}

/**
 * Installs a fake Capacitor global for the duration of one test body.
 * @param {object|null} bridge The bridge to expose (null removes the global).
 * @returns {Function} Restore function — must run before the test ends.
 */
function withCapacitor(bridge) {
  const saved = globalThis.Capacitor;
  if (bridge === null) {
    delete globalThis.Capacitor;
  } else {
    globalThis.Capacitor = { Plugins: { SpeechRecognition: bridge } };
  }
  return () => {
    if (saved === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = saved;
  };
}

/** One macrotask tick — flushes the gate/attempt microtask chain. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('capacitor adapter — contract', () => {
  it('should_implement_the_full_contract_with_and_without_a_bridge', () => {
    for (const bridge of [null, createFakeBridge()]) {
      const restore = withCapacitor(bridge);
      try {
        const adapter = createCapacitorSpeechEnvironmentAdapter();
        for (const method of ['isSupported', 'requestPermission', 'start', 'stop']) {
          assert.equal(typeof adapter[method], 'function', method);
        }
      } finally {
        restore();
      }
    }
  });

  it('should_report_unsupported_processing_unknown_without_a_bridge', () => {
    const restore = withCapacitor(null);
    try {
      const support = createCapacitorSpeechEnvironmentAdapter().isSupported();
      assert.deepEqual(support, { supported: false, processing: 'unknown' });
    } finally {
      restore();
    }
  });

  it('should_report_supported_with_a_bridge', () => {
    const restore = withCapacitor(createFakeBridge());
    try {
      const support = createCapacitorSpeechEnvironmentAdapter().isSupported();
      assert.equal(support.supported, true);
    } finally {
      restore();
    }
  });

  it('should_resolve_the_permission_outcome_when_requested', async () => {
    const restore = withCapacitor(createFakeBridge());
    try {
      const outcome = await createCapacitorSpeechEnvironmentAdapter().requestPermission();
      assert.equal(typeof outcome.granted, 'boolean');
    } finally {
      restore();
    }
  });

  it('should_return_a_session_control_and_end_exactly_once_on_stop', () => {
    const restore = withCapacitor(createFakeBridge());
    try {
      const adapter = createCapacitorSpeechEnvironmentAdapter();
      let endCount = 0;
      const control = adapter.start({
        language: 'fa-IR',
        onPartial: () => {},
        onFinal: () => {},
        end: () => { endCount += 1; },
      });
      assert.equal(typeof control.stop, 'function');
      control.stop({ flush: false });
      control.stop({ flush: false });
      assert.equal(endCount, 1);
    } finally {
      restore();
    }
  });

  it('should_end_with_unsupported_when_started_without_a_bridge', () => {
    const restore = withCapacitor(null);
    try {
      const reports = [];
      createCapacitorSpeechEnvironmentAdapter().start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      assert.equal(reports.length, 1);
      assert.equal(reports[0].code, 'SPEECH_UNSUPPORTED');
    } finally {
      restore();
    }
  });
});

describe('capacitor adapter — logical session', () => {
  it('should_stream_native_accumulated_text_through_partials', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const partials = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter();
      adapter.start({
        language: 'fa-IR', onPartial: (text) => partials.push(text), onFinal: () => {}, end: () => {},
      });
      await tick();

      bridge.emit('partialResults', { accumulatedText: 'امروز', matches: ['امروز'] });
      bridge.emit('partialResults', { accumulatedText: 'امروز هزار تومان', matches: ['هزار تومان'] });
      assert.deepEqual(partials, ['امروز', 'امروز هزار تومان'], 'accumulatedText wins over matches');
    } finally {
      restore();
    }
  });

  it('should_fall_back_to_the_last_match_without_accumulated_text', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const partials = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter();
      adapter.start({
        language: 'fa-IR', onPartial: (text) => partials.push(text), onFinal: () => {}, end: () => {},
      });
      await tick();
      bridge.emit('partialResults', { matches: ['امروز', 'امروز هزار تومان'] });
      assert.deepEqual(partials, ['امروز هزار تومان']);
    } finally {
      restore();
    }
  });

  it('should_deliver_segment_results_as_final_and_restart_on_readiness', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const finals = [];
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({
        restartDelayMs: 0,
        readyWaitMs: 0,
      });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: (text) => finals.push(text),
        end: (report) => reports.push(report),
      });
      await tick();
      assert.equal(bridge.startCalls.length, 1, 'first native segment opens');

      bridge.emit('listeningState', { state: 'stopped', reason: 'silence' });
      bridge.emit('segmentResults', { matches: ['امروز هزار تومان'] });
      bridge.emit('readyForNextSession', {});
      await tick(); await tick();

      assert.equal(bridge.startCalls.length, 2, 'readiness re-opens the segment');
      assert.deepEqual(finals, ['امروز هزار تومان'], 'the definitive segment text');
      assert.deepEqual(reports, [], 'the logical session continues');
    } finally {
      restore();
    }
  });

  it('should_fall_back_to_a_restart_when_ready_for_next_session_never_fires', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({
        restartDelayMs: 0,
        readyWaitMs: 0,
      });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      await tick();
      bridge.emit('listeningState', { state: 'stopped', reason: 'silence' });
      await tick(); await tick(); await tick();
      assert.equal(bridge.startCalls.length, 2, 'the fallback re-open fires');
      assert.deepEqual(reports, []);
    } finally {
      restore();
    }
  });

  it('should_never_double_restart_after_readiness', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const adapter = createCapacitorSpeechEnvironmentAdapter({
        restartDelayMs: 0,
        readyWaitMs: 0,
      });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {}, end: () => {},
      });
      await tick();
      bridge.emit('listeningState', { state: 'stopped', reason: 'silence' });
      bridge.emit('readyForNextSession', {});
      bridge.emit('readyForNextSession', {});
      await tick(); await tick(); await tick();
      assert.equal(bridge.startCalls.length, 2, 'exactly one re-open');
    } finally {
      restore();
    }
  });

  it('should_forward_language_silence_window_and_partial_options', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const adapter = createCapacitorSpeechEnvironmentAdapter({ allowForSilenceMs: 2000 });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {}, end: () => {},
      });
      await tick(); await tick();
      assert.deepEqual(bridge.startCalls[0], {
        language: 'fa-IR',
        partialResults: true,
        maxResults: 5,
        popup: false,
        allowForSilence: 2000,
      });
      adapter.stop({ flush: false });
    } finally {
      restore();
    }
  });

  it('should_deliver_flushed_text_from_partials_and_stop_the_native_session', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter();
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {}, end: (r) => reports.push(r),
      });
      await tick();
      bridge.emit('partialResults', { accumulatedText: 'امروز هزار تومان' });
      adapter.stop({ flush: true });

      assert.equal(reports.length, 1);
      assert.equal(reports[0].reason, 'speech');
      assert.equal(reports[0].text, 'امروز هزار تومان');
      assert.equal(bridge.stopCalls, 1, 'native session torn down');
    } finally {
      restore();
    }
  });

  it('should_cancel_without_delivering_text_on_plain_stop', () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter();
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {}, end: (r) => reports.push(r),
      });
      adapter.stop({ flush: false });
      assert.equal(reports.length, 1);
      assert.equal(reports[0].reason, 'cancelled');
      assert.equal(bridge.stopCalls, 1);
    } finally {
      restore();
    }
  });

  it('should_clean_up_a_stuck_native_session_before_starting', async () => {
    const bridge = createFakeBridge({
      isListening: async () => ({ listening: true }),
    });
    const restore = withCapacitor(bridge);
    try {
      const adapter = createCapacitorSpeechEnvironmentAdapter({ segmentSettleMs: 0 });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {}, end: () => {},
      });
      await tick(); await tick();
      assert.equal(bridge.stopCalls, 1, 'the stuck session is stopped first');
      assert.equal(bridge.startCalls.length, 1, 'then the fresh segment opens');
    } finally {
      restore();
    }
  });
});

describe('capacitor adapter — silence handling', () => {
  it('should_treat_no_speech_error_events_as_quiet_segment_ends', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    const originalWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args);
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({
        restartDelayMs: 0, readyWaitMs: 0, segmentSettleMs: 0,
      });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      await tick(); await tick();
      // The user stays silent: the recognizer reports ordinary no-speech
      // errors with device wording — the logical session must keep going
      // quietly, re-opening segment after segment.
      for (let round = 0; round < 4; round += 1) {
        bridge.emit('error', { message: 'No match' });
        await tick(); await tick();
      }
      assert.ok(bridge.startCalls.length >= 4, 'segments kept re-opening');
      assert.equal(reports.length, 0, 'the session never ended on silence');
      assert.equal(warns.length, 0, 'silence never logs as an error');
      adapter.stop({ flush: false });
    } finally {
      console.warn = originalWarn;
      restore();
    }
  });

  it('should_not_count_a_no_speech_start_rejection_as_a_failure', async () => {
    const bridge = createFakeBridge({
      startReject: { message: "Didn't understand, please try again." },
    });
    const restore = withCapacitor(bridge);
    const originalWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args);
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({
        restartDelayMs: 0, readyWaitMs: 0, segmentSettleMs: 0,
        maxFailureRestarts: 0,
      });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      for (let round = 0; round < 6; round += 1) {
        await tick(); await tick();
      }
      assert.ok(bridge.startCalls.length >= 3, 're-opened past the streak cap');
      assert.equal(reports.length, 0, 'a silent device is not a service failure');
      assert.equal(warns.length, 0, 'no warn spam while the user is silent');
      adapter.stop({ flush: false });
    } finally {
      console.warn = originalWarn;
      restore();
    }
  });

  it('should_settle_after_stopping_a_busy_recognizer_before_reopening', async (t) => {
    // Mocked clock: the settle window is asserted against the clock, not
    // against a real sleep. setImmediate stays real — a macrotask turn that
    // drains the adapter's microtask chain without touching the clock.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const bridge = createFakeBridge({ isListening: async () => ({ listening: true }) });
    const restore = withCapacitor(bridge);
    try {
      const adapter = createCapacitorSpeechEnvironmentAdapter({
        restartDelayMs: 0, readyWaitMs: 0, segmentSettleMs: 40,
      });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {}, end: () => {},
      });
      await flush(); await flush();
      // The teardown wait is honored: the stop happened, the start did not yet.
      assert.equal(bridge.stopCalls, 1, 'the busy recognizer was stopped');
      assert.equal(bridge.startCalls.length, 0, 'no start during the settle window');
      t.mock.timers.tick(40);
      await flush(); await flush();
      assert.equal(bridge.startCalls.length, 1, 'the fresh segment opens after the settle');
      adapter.stop({ flush: false });
    } finally {
      restore();
    }
  });
});

describe('capacitor adapter — failure mapping', () => {
  it('should_end_after_the_failure_streak_with_the_last_known_text', async () => {
    const bridge = createFakeBridge({ startReject: { message: 'Client side error' } });
    const restore = withCapacitor(bridge);
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({
        restartDelayMs: 0,
        maxFailureRestarts: 1,
      });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      await tick(); await tick(); await tick(); await tick();
      assert.equal(bridge.startCalls.length, 2, 'one restart after the first failure');
      assert.equal(reports.length, 1);
      assert.equal(reports[0].code, 'SPEECH_SERVICE_UNAVAILABLE');
    } finally {
      restore();
    }
  });

  it('should_end_immediately_on_a_permission_rejection_without_restarting', async () => {
    const bridge = createFakeBridge({
      startReject: { message: 'Speech recognition permission denied' },
    });
    const restore = withCapacitor(bridge);
    try {
      const reports = [];
      createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0 }).start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      await tick(); await tick();
      assert.equal(bridge.startCalls.length, 1, 'no restart after a permission denial');
      assert.equal(reports.length, 1);
      assert.equal(reports[0].code, 'SPEECH_PERMISSION_DENIED');
    } finally {
      restore();
    }
  });

  it('should_end_when_the_error_event_reports_a_permission_problem', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter();
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      await tick();
      bridge.emit('error', { code: 'PERMISSION_DENIED', message: 'microphone permission denied' });
      await tick();
      assert.equal(reports.length, 1, 'a permission error event ends the session');
      assert.equal(reports[0].code, 'SPEECH_PERMISSION_DENIED');
      adapter.stop({ flush: false });
    } finally {
      restore();
    }
  });

  it('should_only_log_non_permission_error_events', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter();
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {}, end: (r) => reports.push(r),
      });
      await tick();
      bridge.emit('error', { code: 'SPEECH_ERROR', message: 'transient native hiccup' });
      await tick();
      assert.deepEqual(reports, [], 'transient errors never end the logical session');
      adapter.stop({ flush: false });
    } finally {
      restore();
    }
  });
});

describe('capacitor adapter — permissions', () => {
  it('should_grant_when_check_permissions_reports_granted', async () => {
    const restore = withCapacitor(createFakeBridge({
      permissions: { speechRecognition: 'granted' },
    }));
    try {
      const outcome = await createCapacitorSpeechEnvironmentAdapter().requestPermission();
      assert.deepEqual(outcome, { granted: true });
    } finally {
      restore();
    }
  });

  it('should_request_then_recheck_when_prompted', async () => {
    const restore = withCapacitor(createFakeBridge({
      permissions: { speechRecognition: 'prompt' },
    }));
    try {
      const outcome = await createCapacitorSpeechEnvironmentAdapter().requestPermission();
      assert.deepEqual(outcome, { granted: true });
    } finally {
      restore();
    }
  });

  it('should_report_denied_when_the_user_declines', async () => {
    const restore = withCapacitor(createFakeBridge({
      permissions: { speechRecognition: 'denied' },
      requestGrants: false,
    }));
    try {
      const outcome = await createCapacitorSpeechEnvironmentAdapter().requestPermission();
      assert.deepEqual(outcome, { granted: false });
    } finally {
      restore();
    }
  });

  it('should_report_denied_without_a_bridge', async () => {
    const restore = withCapacitor(null);
    try {
      const outcome = await createCapacitorSpeechEnvironmentAdapter().requestPermission();
      assert.deepEqual(outcome, { granted: false });
    } finally {
      restore();
    }
  });
});

describe('capacitor adapter — guarded start dispatch', () => {
  it('should_end_the_session_when_the_bridge_start_throws_synchronously', async () => {
    const bridge = createFakeBridge();
    delete bridge.start;
    const restore = withCapacitor(bridge);
    try {
      const reports = [];
      createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0, maxFailureRestarts: 0 }).start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      await tick(); await tick(); await tick();
      assert.equal(reports.length, 1, 'the broken bridge cannot leave the session open');
      assert.equal(reports[0].code, 'SPEECH_SERVICE_UNAVAILABLE');
    } finally {
      restore();
    }
  });

  it('should_keep_the_session_alive_when_the_bridge_start_returns_a_non_thenable', async () => {
    const bridge = createFakeBridge();
    bridge.start = (...args) => {
      bridge.startCalls.push(args[args.length - 1]);
      return undefined;
    };
    const restore = withCapacitor(bridge);
    try {
      const partials = [];
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0, readyWaitMs: 0 });
      adapter.start({
        language: 'fa-IR', onPartial: (text) => partials.push(text), onFinal: () => {},
        end: (report) => reports.push(report),
      });
      await tick(); await tick();
      bridge.emit('partialResults', { accumulatedText: 'امروز' });
      assert.deepEqual(partials, ['امروز'], 'the odd bridge shape never crashes the session');
      assert.deepEqual(reports, []);
      adapter.stop({ flush: false });
    } finally {
      restore();
    }
  });
});

describe('capacitor adapter — definitive segment capture', () => {
  it('should_never_let_a_segment_result_shorten_the_running_text', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const finals = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0, readyWaitMs: 0 });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: (text) => finals.push(text),
        end: () => {},
      });
      await tick();
      bridge.emit('partialResults', { accumulatedText: 'امروز هزار' });
      // The segment's own result covers only this segment; banking it
      // verbatim would drop the earlier segments' words.
      bridge.emit('segmentResults', { matches: ['هزار'] });
      assert.deepEqual(finals, ['امروز هزار'], 'the running text is preserved');
      adapter.stop({ flush: false });
    } finally {
      restore();
    }
  });

  it('should_bank_the_native_accumulation_when_segment_results_carry_it', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const finals = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0, readyWaitMs: 0 });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: (text) => finals.push(text),
        end: () => {},
      });
      await tick();
      bridge.emit('segmentResults', { matches: ['تومان'], accumulatedText: 'امروز هزار تومان' });
      assert.deepEqual(finals, ['امروز هزار تومان'], 'the accumulation wins');
      adapter.stop({ flush: false });
    } finally {
      restore();
    }
  });

  it('should_bank_a_longer_segment_result_without_an_accumulation', async () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    try {
      const finals = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0, readyWaitMs: 0 });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: (text) => finals.push(text),
        end: () => {},
      });
      await tick();
      bridge.emit('segmentResults', { matches: ['امروز هزار تومان'] });
      assert.deepEqual(finals, ['امروز هزار تومان'], 'the first segment banks verbatim');
      adapter.stop({ flush: false });
    } finally {
      restore();
    }
  });
});

describe('capacitor adapter — transient error streak', () => {
  it('should_end_the_session_after_a_streak_of_error_events_without_text', () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const reports = [];
      createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0, readyWaitMs: 0 }).start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      for (let round = 0; round < 4; round += 1) {
        bridge.emit('error', { code: 'SPEECH_ERROR', message: `transient hiccup ${round}` });
      }
      assert.equal(reports.length, 1, 'error events with no text in between are a hard failure');
      assert.equal(reports[0].code, 'SPEECH_SERVICE_UNAVAILABLE');
    } finally {
      console.warn = originalWarn;
      restore();
    }
  });

  it('should_reset_the_error_streak_when_text_keeps_flowing', () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0, readyWaitMs: 0 });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      // One error, then recognized text, then three more errors: the streak
      // reset in between keeps the session alive (3 is not past the cap of 3).
      bridge.emit('error', { code: 'SPEECH_ERROR', message: 'hiccup' });
      bridge.emit('partialResults', { accumulatedText: 'امروز' });
      bridge.emit('error', { code: 'SPEECH_ERROR', message: 'hiccup' });
      bridge.emit('error', { code: 'SPEECH_ERROR', message: 'hiccup' });
      bridge.emit('error', { code: 'SPEECH_ERROR', message: 'hiccup' });
      assert.deepEqual(reports, [], 'a recognizing device is not failing');
      adapter.stop({ flush: false });
    } finally {
      console.warn = originalWarn;
      restore();
    }
  });

  it('should_not_treat_a_permission_state_probe_as_a_denial', () => {
    const bridge = createFakeBridge();
    const restore = withCapacitor(bridge);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const reports = [];
      const adapter = createCapacitorSpeechEnvironmentAdapter({ restartDelayMs: 0, readyWaitMs: 0 });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {},
        end: (report) => reports.push(report),
      });
      bridge.emit('error', { message: 'failed to query permission state' });
      assert.deepEqual(reports, [], 'mentioning permission is not denying it');
      adapter.stop({ flush: false });
    } finally {
      console.warn = originalWarn;
      restore();
    }
  });
});

describe('capacitor adapter — re-open scheduling', () => {
  it('should_abort_an_in_flight_attempt_when_a_newer_reopen_is_scheduled', async () => {
    // Deterministic suspension: every isListening call parks its resolver in
    // a queue the test controls.
    const resolvers = [];
    const bridge = createFakeBridge({
      isListening: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    const restore = withCapacitor(bridge);
    try {
      const adapter = createCapacitorSpeechEnvironmentAdapter({
        restartDelayMs: 0, readyWaitMs: 0, segmentSettleMs: 0,
      });
      adapter.start({
        language: 'fa-IR', onPartial: () => {}, onFinal: () => {}, end: () => {},
      });
      await tick();
      assert.equal(resolvers.length, 1);
      resolvers.shift()({ listening: false });
      await tick();
      assert.equal(bridge.startCalls.length, 1, 'the first segment opened');

      // The fallback re-open is scheduled, its attempt parks on isListening
      // — and THEN readiness arrives: the newer schedule must supersede the
      // parked attempt, so exactly one re-open lands.
      bridge.emit('listeningState', { state: 'stopped', reason: 'silence' });
      await tick();
      assert.equal(resolvers.length, 1, 'the parked attempt is inside isListening');
      bridge.emit('readyForNextSession', {});
      resolvers.shift()({ listening: false });
      await tick();
      resolvers.shift()({ listening: false });
      await tick(); await tick();
      assert.equal(bridge.startCalls.length, 2, 'exactly one re-open — no double start');
    } finally {
      restore();
    }
  });
});
