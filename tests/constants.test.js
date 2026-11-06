// Unit tests for lib/constants.js — the shared contract values.

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LANGUAGE, ERROR_CODES, LISTENING_STARTED_EVENT, LISTENING_STOPPED_EVENT } from '../lib/constants.js';

test('should_default_the_language_to_persian_when_nothing_is_configured', () => {
  assert.equal(DEFAULT_LANGUAGE, 'fa-IR');
});

test('should_name_the_listening_events_in_past_tense_when_declared', () => {
  // bonyan/naming.md: domain events read as what happened.
  assert.equal(LISTENING_STARTED_EVENT, 'speech:listening-started');
  assert.equal(LISTENING_STOPPED_EVENT, 'speech:listening-stopped');
});

test('should_keep_every_speech_error_code_prefixed_when_listed', () => {
  for (const code of Object.values(ERROR_CODES)) {
    assert.match(code, /^SPEECH_[A-Z_]+$/, code);
  }
});
