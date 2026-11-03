// Verifies the Web Speech environment adapter's degradation outside a
// browser (no SpeechRecognition) — it must still load and report
// unsupported, never crash.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebSpeechEnvironmentAdapter } from '../../adapters/web-speech-environment-adapter.js';

test('should_report_unsupported_when_no_recognizer_exists', () => {
  const adapter = createWebSpeechEnvironmentAdapter();

  assert.deepEqual(adapter.isSupported(), { supported: false, processing: 'unknown' });
});

test('should_report_permission_denied_when_no_media_devices_exist', async () => {
  const adapter = createWebSpeechEnvironmentAdapter();

  assert.deepEqual(await adapter.requestPermission(), { granted: false });
});

test('should_end_the_session_with_the_unsupported_code_when_started_without_a_recognizer', async () => {
  const adapter = createWebSpeechEnvironmentAdapter();

  let report = null;
  adapter.start({
    language: 'fa-IR',
    onPartial: () => {},
    onFinal: () => {},
    end: (ended) => {
      report = ended;
    },
  });

  assert.deepEqual(report, { reason: 'error', code: 'SPEECH_UNSUPPORTED' });
});
