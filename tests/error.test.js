// Unit tests for lib/error.js — the pey.speech boundary error factory.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechError } from '../lib/error.js';
import { ERROR_CODES } from '../lib/constants.js';

test('should_build_standard_structured_error_when_called_with_code_and_message', () => {
  const error = createSpeechError(ERROR_CODES.NO_SPEECH, 'No speech was heard');

  assert.equal(error.code, 'SPEECH_NO_SPEECH');
  assert.equal(error.source, 'pey.speech');
  assert.equal(error.type, 'operational');
  assert.ok(!Number.isNaN(Date.parse(error.timestamp)));
});

test('should_accept_the_startup_type_when_the_loader_fails', () => {
  const error = createSpeechError('SPEECH_ADAPTER_NOT_FOUND', 'x', 'startup');

  assert.equal(error.type, 'startup');
});

test('should_reject_unsupported_codes_and_types_when_misused', () => {
  assert.throws(() => createSpeechError('lowercase', 'x'), TypeError);
  assert.throws(() => createSpeechError('SPEECH_NO_SPEECH', 'x', 'fatal'), TypeError);
});
