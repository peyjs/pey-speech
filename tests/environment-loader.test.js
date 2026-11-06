// Unit tests for lib/environment-loader.js — adapter resolution and
// validation at startup.

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnvironmentAdapter } from '../lib/environment-loader.js';

const LOADERS = {
  Good: async () => ({
    isSupported: () => ({ supported: true, processing: 'local' }),
    requestPermission: async () => ({ granted: true }),
    start: () => ({ stop: () => {} }),
    stop: () => {},
  }),
  Broken: async () => {
    throw new Error('factory exploded');
  },
  CodedFailure: async () => {
    throw Object.assign(new Error('already coded'), { code: 'SPEECH_ADAPTER_INITIALIZATION_FAILED' });
  },
};

test('should_load_and_validate_a_known_adapter_when_configured', async () => {
  const adapter = await loadEnvironmentAdapter('Good', {}, LOADERS);

  assert.equal(adapter.isSupported().supported, true);
});

test('should_reject_startup_with_not_found_when_the_identifier_is_unknown', async () => {
  await assert.rejects(
    () => loadEnvironmentAdapter('NoSuchAdapter', {}, LOADERS),
    (error) => error.code === 'SPEECH_ADAPTER_NOT_FOUND' && error.type === 'startup',
  );
});

test('should_reject_startup_with_not_found_when_the_identifier_is_not_a_string', async () => {
  await assert.rejects(
    () => loadEnvironmentAdapter(42, {}, LOADERS),
    (error) => error.code === 'SPEECH_ADAPTER_NOT_FOUND',
  );
});

test('should_reject_startup_with_initialization_failed_when_the_factory_throws', async () => {
  await assert.rejects(
    () => loadEnvironmentAdapter('Broken', {}, LOADERS),
    (error) => error.code === 'SPEECH_ADAPTER_INITIALIZATION_FAILED' && error.type === 'startup',
  );
});

test('should_keep_a_coded_adapter_failure_when_the_factory_throws_one', async () => {
  await assert.rejects(
    () => loadEnvironmentAdapter('CodedFailure', {}, LOADERS),
    (error) => error.code === 'SPEECH_ADAPTER_INITIALIZATION_FAILED',
  );
});

test('should_reject_startup_with_invalid_when_the_adapter_misses_a_contract_method', async () => {
  const incompleteLoaders = {
    Incomplete: async () => ({
      isSupported: () => ({ supported: true, processing: 'local' }),
      // requestPermission, start and stop are missing.
    }),
  };

  await assert.rejects(
    () => loadEnvironmentAdapter('Incomplete', {}, incompleteLoaders),
    (error) => error.code === 'SPEECH_ADAPTER_INVALID' && error.type === 'startup',
  );
});
