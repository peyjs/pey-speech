// Verifies the pey.speech service against the acceptance criteria of
// docs/requirements.md — with a fake environment adapter.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechService } from '../lib/speech-service.js';

/**
 * Builds a fake environment adapter: a controllable recognizer whose
 * session the test drives by hand.
 */
function createFakeAdapter({ supported = true, processing = 'cloud', granted = true } = {}) {
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
      session = {
        emitPartial: (text) => input.onPartial?.(text),
        emitFinal: (text) => {
          lastFinal = text;
          input.onFinal?.(text);
        },
        emitNoSpeech: () => finish({ reason: 'no-speech' }),
        emitError: (code) => finish({ reason: 'error', code }),
        emitDeviceEnd: () => finish({ reason: lastFinal !== null ? 'speech' : 'no-speech', text: lastFinal }),
      };
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
