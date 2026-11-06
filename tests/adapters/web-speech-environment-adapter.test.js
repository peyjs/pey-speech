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

// --- supported paths (fake SpeechRecognition constructor) -----------------

/**
 * Installs a controllable fake SpeechRecognition class on globalThis.
 */
function installFakeRecognizer() {
  const instances = [];
  class FakeSpeechRecognition {
    constructor() {
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      instances.push(this);
    }

    start() {
      this.started = true;
    }

    abort() {
      this.aborted = true;
    }

    emitResult(entries, resultIndex = 0) {
      // The adapter assigns onresult/onerror/onend as properties, so the
      // dispatch reads the own properties.
      this.onresult?.({
        resultIndex,
        results: entries.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal })),
      });
    }

    emitError(name) {
      this.onerror?.({ error: name });
    }

    emitEnd() {
      this.onend?.();
    }
  }
  globalThis.SpeechRecognition = FakeSpeechRecognition;
  return {
    instances,
    first: () => instances[0],
    uninstall: () => {
      delete globalThis.SpeechRecognition;
    },
  };
}

function startSession(adapter, { onPartial, onFinal } = {}) {
  const reports = [];
  const control = adapter.start({
    language: 'fa-IR',
    onPartial,
    onFinal,
    end: (report) => reports.push(report),
  });
  return { control, reports };
}

test('should_report_supported_with_unknown_processing_when_a_recognizer_exists', () => {
  const fake = installFakeRecognizer();
  try {
    const adapter = createWebSpeechEnvironmentAdapter();

    assert.deepEqual(adapter.isSupported(), { supported: true, processing: 'unknown' });
  } finally {
    fake.uninstall();
  }
});

test('should_distribute_partial_and_final_results_when_the_device_reports_them', () => {
  const fake = installFakeRecognizer();
  try {
    const adapter = createWebSpeechEnvironmentAdapter();
    const partials = [];
    const finals = [];
    const { reports } = startSession(adapter, {
      onPartial: (text) => partials.push(text),
      onFinal: (text) => finals.push(text),
    });
    const recognition = fake.first();

    recognition.emitResult([['سلام', false]]);
    recognition.emitResult([['سلام دنیا', true]]);

    assert.deepEqual(partials, ['سلام']);
    assert.deepEqual(finals, ['سلام دنیا']);

    recognition.emitEnd();

    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0], { reason: 'speech', text: 'سلام دنیا' });
  } finally {
    fake.uninstall();
  }
});

test('should_map_device_errors_to_the_plugin_codes_when_the_recognizer_fails', () => {
  const mappings = [
    ['not-allowed', 'SPEECH_PERMISSION_DENIED'],
    ['service-not-allowed', 'SPEECH_PERMISSION_DENIED'],
    ['no-speech', 'SPEECH_NO_SPEECH'],
    ['network', 'SPEECH_SERVICE_UNAVAILABLE'],
    ['unknown-device-error', 'SPEECH_SERVICE_UNAVAILABLE'],
  ];
  for (const [deviceError, expectedCode] of mappings) {
    const fake = installFakeRecognizer();
    try {
      const adapter = createWebSpeechEnvironmentAdapter();
      const { reports } = startSession(adapter);

      fake.first().emitError(deviceError);

      assert.equal(reports.length, 1, deviceError);
      assert.equal(reports[0].code, expectedCode, deviceError);
    } finally {
      fake.uninstall();
    }
  }
});

test('should_treat_the_aborted_error_as_a_deliberate_stop_and_end_through_onend', () => {
  const fake = installFakeRecognizer();
  try {
    const adapter = createWebSpeechEnvironmentAdapter();
    const { reports } = startSession(adapter);
    const recognition = fake.first();

    recognition.emitError('aborted');
    assert.equal(reports.length, 0, 'the aborted error alone must not end the session');

    recognition.emitEnd();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, 'no-speech');
  } finally {
    fake.uninstall();
  }
});

test('should_deliver_the_last_final_when_stopped_with_flush', () => {
  const fake = installFakeRecognizer();
  try {
    const adapter = createWebSpeechEnvironmentAdapter();
    const { control, reports } = startSession(adapter);
    fake.first().emitResult([['متن نهایی', true]]);

    control.stop({ flush: true });

    assert.deepEqual(reports, [{ reason: 'speech', text: 'متن نهایی' }]);
    assert.equal(fake.first().aborted, true, 'the recognizer is aborted on finish');
  } finally {
    fake.uninstall();
  }
});

test('should_cancel_without_a_result_when_stopped_without_flush', () => {
  const fake = installFakeRecognizer();
  try {
    const adapter = createWebSpeechEnvironmentAdapter();
    const { control, reports } = startSession(adapter);
    fake.first().emitResult([['متن نهایی', true]]);

    control.stop({ flush: false });

    assert.deepEqual(reports, [{ reason: 'cancelled' }]);
  } finally {
    fake.uninstall();
  }
});

test('should_report_exactly_one_end_when_the_device_ends_after_a_deliberate_stop', () => {
  const fake = installFakeRecognizer();
  try {
    const adapter = createWebSpeechEnvironmentAdapter();
    const { control, reports } = startSession(adapter);

    control.stop({ flush: false });
    fake.first().emitEnd();

    assert.equal(reports.length, 1, 'the end guard must swallow the late device end');
  } finally {
    fake.uninstall();
  }
});

test('should_end_with_the_service_unavailable_code_when_the_constructor_throws', () => {
  const fake = installFakeRecognizer();
  try {
    const adapter = createWebSpeechEnvironmentAdapter();
    const reports = [];
    // Make the constructor throw.
    globalThis.SpeechRecognition = class {
      constructor() {
        throw new Error('device broke');
      }
    };

    adapter.start({
      language: 'fa-IR',
      onPartial: () => {},
      onFinal: () => {},
      end: (report) => reports.push(report),
    });

    assert.deepEqual(reports, [{ reason: 'error', code: 'SPEECH_SERVICE_UNAVAILABLE' }]);
  } finally {
    fake.uninstall();
  }
});

test('should_end_with_the_service_unavailable_code_when_start_throws', () => {
  const fake = installFakeRecognizer();
  try {
    const adapter = createWebSpeechEnvironmentAdapter();
    const reports = [];
    const recognition = fake.first();
    void recognition;
    // Patch start to throw after construction succeeded.
    Object.defineProperty(globalThis.SpeechRecognition.prototype, 'start', {
      value() {
        throw new Error('start refused');
      },
      configurable: true,
    });

    adapter.start({
      language: 'fa-IR',
      onPartial: () => {},
      onFinal: () => {},
      end: (report) => reports.push(report),
    });

    assert.deepEqual(reports, [{ reason: 'error', code: 'SPEECH_SERVICE_UNAVAILABLE' }]);
  } finally {
    fake.uninstall();
  }
});
