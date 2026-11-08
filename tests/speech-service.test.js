// Verifies the pey.speech service against the acceptance criteria of
// docs/requirements.md — with a fake environment adapter.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ERROR_CODES } from '../lib/constants.js';
import { createSpeechService } from '../lib/speech-service.js';

/**
 * Builds a fake environment adapter: a controllable recognizer whose
 * session the test drives by hand.
 */
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

function createService({ config, adapterOptions } = {}) {
  const published = [];
  const fake = createFakeAdapter(adapterOptions);
  const { service, deactivate } = createSpeechService({
    adapter: fake.adapter,
    events: { publish: (type, data) => published.push({ type, data }) },
    config: config ?? {},
  });
  return { service, deactivate, published, ...fake };
}

function createServiceWithAdapter(adapter, { config, events } = {}) {
  const published = [];
  const { service, deactivate } = createSpeechService({
    adapter,
    events: events ?? { publish: (type, data) => published.push({ type, data }) },
    config: config ?? {},
  });
  return { service, deactivate, published };
}

// --- support and permission ----------------------------------------------

test('should_report_support_and_processing_when_asked', () => {
  const { service } = createService({ adapterOptions: { supported: true, processing: 'cloud' } });

  assert.deepEqual(service.getSupport(), { supported: true, processing: 'cloud' });
});

test('should_report_an_unsupported_environment_without_crashing', async () => {
  const { service } = createService({ adapterOptions: { supported: false, processing: 'unknown' } });

  assert.deepEqual(service.getSupport(), { supported: false, processing: 'unknown' });
  await assert.rejects(() => service.listen({}, { onPartial: () => {} }), (error) => error.code === 'SPEECH_UNSUPPORTED');
});

test('should_report_permission_outcomes_with_their_own_codes', async () => {
  const granted = createService();
  assert.deepEqual(await granted.service.requestPermission(), { granted: true });

  const denied = createService({ adapterOptions: { granted: false } });
  await assert.rejects(() => denied.service.requestPermission(), (error) => error.code === 'SPEECH_PERMISSION_DENIED');

  const unsupported = createService({ adapterOptions: { supported: false } });
  await assert.rejects(() => unsupported.service.requestPermission(), (error) => error.code === 'SPEECH_UNSUPPORTED');
});

// --- listening ------------------------------------------------------------

test('should_deliver_partial_and_final_results_and_complete_with_the_text', async () => {
  const partials = [];
  const finals = [];
  const { service, published, session } = createService();

  const handle = await service.listen({}, {
    onPartial: (text) => partials.push(text),
    onFinal: (text) => finals.push(text),
  });
  session().emitPartial('ده هزار');
  session().emitFinal('ده هزار تومان');
  session().emitDeviceEnd();
  const final = await handle.done;

  assert.deepEqual(partials, ['ده هزار']);
  assert.deepEqual(finals, ['ده هزار تومان']);
  assert.deepEqual(final, { ending: 'completed', text: 'ده هزار تومان' });
  assert.deepEqual(published, [
    { type: 'speech:listening-started', data: undefined },
    { type: 'speech:listening-stopped', data: undefined },
  ]);
});

test('should_complete_through_stop_with_the_last_final_text', async () => {
  const finals = [];
  const { service, session } = createService();

  const handle = await service.listen({}, { onFinal: (text) => finals.push(text) });
  session().emitFinal('ده هزار تومان');
  service.stop();
  const final = await handle.done;

  assert.deepEqual(finals, ['ده هزار تومان']);
  assert.deepEqual(final, { ending: 'completed', text: 'ده هزار تومان' });
});

test('should_cancel_without_a_result_when_cancelled', async () => {
  const finals = [];
  const { service, session } = createService();

  const handle = await service.listen({}, { onFinal: (text) => finals.push(text) });
  handle.cancel();
  const final = await handle.done;

  assert.deepEqual(finals, []);
  assert.deepEqual(final, { ending: 'cancelled' });
});

test('should_report_no_speech_when_long_silence_ends_the_session', async () => {
  const { service, session } = createService();

  const handle = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  session().emitNoSpeech();
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SPEECH_NO_SPEECH');
});

test('should_map_device_errors_to_their_codes_without_raw_details', async () => {
  const { service, session } = createService();

  const handle = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  session().emitError('SPEECH_SERVICE_UNAVAILABLE');
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SPEECH_SERVICE_UNAVAILABLE');
  assert.equal(JSON.stringify(final.error).includes('device'), false);
});

// --- one session at a time ------------------------------------------------

test('should_reject_a_second_session_while_one_is_active_and_free_the_lock_afterwards', async () => {
  const { service, session } = createService();

  const first = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  await assert.rejects(
    () => service.listen({}, { onPartial: () => {} }),
    (error) => error.code === 'SPEECH_SESSION_ACTIVE',
  );
  session().emitFinal('متن');
  session().emitDeviceEnd();
  const final = await first.done;
  assert.equal(final.ending, 'completed');

  const second = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  session().emitFinal('ادامه');
  session().emitDeviceEnd();
  assert.equal((await second.done).ending, 'completed');
});

// --- language -------------------------------------------------------------

test('should_use_the_configured_default_language_and_honor_overrides', async () => {
  const { service, calls, session } = createService({ config: { language: 'fa-IR' } });

  const first = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  session().emitDeviceEnd();
  await first.done;

  const second = await service.listen({ language: 'en-US' }, { onPartial: () => {}, onFinal: () => {} });
  session().emitDeviceEnd();
  await second.done;

  assert.equal(calls.find((call) => typeof call === 'object').start, 'fa-IR');
  const starts = calls.filter((call) => typeof call === 'object').map((call) => call.start);
  assert.deepEqual(starts, ['fa-IR', 'en-US']);
});

// --- lifecycle ------------------------------------------------------------

test('should_cut_the_active_session_without_a_result_when_deactivated', async () => {
  const { service, deactivate } = createService();

  const handle = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  deactivate();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  // getSupport is a synchronous method: it throws in place.
  assert.throws(() => service.getSupport(), (error) => error.code === 'SERVICE_UNAVAILABLE');
  await assert.rejects(() => service.listen({}, { onPartial: () => {} }), (error) => error.code === 'SERVICE_UNAVAILABLE');
});

test('should_never_put_recognized_text_into_events', async () => {
  const { service, published, session } = createService();

  const handle = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  session().emitFinal('متن محرمانه گفتار');
  session().emitDeviceEnd();
  await handle.done;

  assert.equal(JSON.stringify(published).includes('متن محرمانه گفتار'), false);
});

test('should_start_a_new_session_after_a_synchronous_start_failure', async () => {
  let attempts = 0;
  const fake = createFakeAdapter();
  const healthyStart = fake.adapter.start.bind(fake);
  fake.adapter.start = (input) => {
    attempts += 1;
    if (attempts === 1) {
      // Simulate the adapter's sync failure: end fires, dead control returns.
      input.end({ reason: 'error', code: 'SPEECH_SERVICE_UNAVAILABLE' });
      return { stop: () => {} };
    }
    return healthyStart(input);
  };
  const { service } = createServiceWithAdapter(fake.adapter);

  const failed = await service.listen({}, {});
  await failed.done;

  const second = await service.listen({}, {});
  assert.notEqual(second, undefined, 'the session lock must not be wedged');
  second.cancel();
  await second.done;
});

test('should_not_publish_started_after_stopped_when_start_fails_synchronously', async () => {
  const fake = createFakeAdapter();
  fake.adapter.start = (input) => {
    input.end({ reason: 'error', code: 'SPEECH_SERVICE_UNAVAILABLE' });
    return { stop: () => {} };
  };
  const { service, published } = createServiceWithAdapter(fake.adapter);

  const handle = await service.listen({}, {});
  await handle.done;

  const types = published.map((event) => event.type);
  assert.equal(types.filter((type) => type === 'speech:listening-started').length, 0, 'no started after a sync failure');
  assert.equal(types.filter((type) => type === 'speech:listening-stopped').length, 1);
});

test('should_not_let_a_stale_handle_cancel_a_newer_session', async () => {
  const fake = createFakeAdapter();
  const { service } = createServiceWithAdapter(fake.adapter);

  const first = await service.listen({}, {});
  fake.session().emitFinal('نتیجه اول');
  fake.session().emitDeviceEnd();
  await first.done;

  const second = await service.listen({}, {});
  // The stale handle from the finished first session must be a no-op now.
  first.cancel();

  // The second session runs to its own natural end.
  fake.session().emitFinal('نتیجه دوم');
  fake.session().emitDeviceEnd();
  const final = await second.done;

  assert.equal(final.ending, 'completed', 'the second session must survive the stale handle');
  assert.equal(final.text, 'نتیجه دوم');
});

test('should_reject_stop_with_the_standard_error_after_deactivation', async () => {
  const fake = createFakeAdapter();
  const { service, deactivate } = createServiceWithAdapter(fake.adapter);

  deactivate();

  assert.throws(() => service.stop(), (error) => error.code === 'SERVICE_UNAVAILABLE');
});

// --- second review pass: adapter contract hygiene --------------------------

test('should_resolve_done_as_a_recognizer_failure_when_the_adapter_reports_an_invalid_code', async () => {
  const fake = createFakeAdapter();
  const { service } = createServiceWithAdapter(fake.adapter);

  const handle = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  fake.session().emitError('microphone.locked');
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER, 'a malformed adapter code falls back to the safe code');
});

test('should_map_raw_adapter_failures_to_structured_errors_when_isSupported_or_stop_throw', async () => {
  const fake = createFakeAdapter();
  fake.adapter.isSupported = () => {
    throw new Error('raw device boom');
  };
  const { service } = createServiceWithAdapter(fake.adapter);

  // getSupport is a synchronous method: it throws in place.
  assert.throws(
    () => service.getSupport(),
    (error) => error.code === ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER && error.source === 'pey.speech',
  );

  const healthy = createFakeAdapter();
  const failingStop = createServiceWithAdapter(healthy.adapter);
  const stuckHandle = await failingStop.service.listen({}, {});
  // The service stop goes through the SESSION control, not the adapter's
  // own stop method — break exactly that link.
  healthy.session().control.stop = () => {
    throw new Error('raw stop boom');
  };

  // stop() is synchronous as well — and closes the session before
  // reporting the failure, exactly like the handle path does.
  assert.throws(
    () => failingStop.service.stop(),
    (error) => error.code === ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER,
  );
  const stopped = await stuckHandle.done;
  assert.equal(stopped.ending, 'interrupted', 'done never hangs after a failing service stop');
  await failingStop.service.listen({}, {});

  // The same guard covers listen and requestPermission: a throwing
  // isSupported never leaks a raw error through either entry.
  await assert.rejects(
    () => service.listen({}, {}),
    (error) => error.code === ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER,
  );
  await assert.rejects(
    () => service.requestPermission(),
    (error) => error.code === ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER,
  );

  // A non-object support report means "no usable report": treated as
  // unsupported, never dereferenced into a TypeError.
  const nullish = createFakeAdapter();
  nullish.adapter.isSupported = () => null;
  const nullishSession = createServiceWithAdapter(nullish.adapter);
  await assert.rejects(
    () => nullishSession.service.listen({}, {}),
    (error) => error.code === ERROR_CODES.UNSUPPORTED,
  );
});

test('should_map_an_undeclared_but_well_formed_adapter_code_to_the_safe_recognizer_failure_when_the_session_ends', async () => {
  // The manifest declares which codes listen may surface: an adapter code
  // outside that set never reaches the caller, however well-formed.
  const fake = createFakeAdapter();
  const { service } = createServiceWithAdapter(fake.adapter);

  const handle = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  fake.session().emitError('MICROPHONE_HARDWARE_LOCKED');
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER, 'an undeclared code falls back to the safe code');
});

test('should_deactivate_without_throwing_when_the_adapter_stop_fails', async () => {
  // Teardown must never break the Core shutdown cycle, even when the
  // device stop itself throws.
  const fake = createFakeAdapter();
  const { service, deactivate } = createServiceWithAdapter(fake.adapter);
  await service.listen({}, {});
  fake.session().control.stop = () => {
    throw new Error('raw stop boom');
  };

  assert.doesNotThrow(() => deactivate());
});

test('should_resolve_done_as_a_recognizer_failure_when_the_device_stop_throws_at_the_handle', async () => {
  const fake = createFakeAdapter();
  const { service } = createServiceWithAdapter(fake.adapter);

  const handle = await service.listen({}, {});
  fake.session().control.stop = () => {
    throw new Error('raw stop boom');
  };
  handle.cancel();

  const final = await handle.done;
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, ERROR_CODES.SERVICE_UNAVAILABLE_RECOGNIZER, 'done must never hang on a throwing device stop');
});

test('should_still_succeed_when_the_event_bus_throws_on_every_publish', async () => {
  const fake = createFakeAdapter();
  const { service } = createServiceWithAdapter(fake.adapter, {
    events: { publish: () => { throw new Error('bus down'); } },
  });

  const handle = await service.listen({}, { onPartial: () => {}, onFinal: () => {} });
  fake.session().emitFinal('نتیجه');
  fake.session().emitDeviceEnd();
  const final = await handle.done;

  assert.equal(final.ending, 'completed', 'a broken bus must never fail a listening session');
});
