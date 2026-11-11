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
  FullyStructured: async () => {
    const error = new Error('adapter rejected its configuration');
    error.code = 'SPEECH_ADAPTER_INVALID';
    error.source = 'vendor.adapter';
    error.type = 'operational';
    error.timestamp = '2026-11-11T10:00:00.000Z';
    throw error;
  },
  BrokenType: async () => {
    const error = new Error('structured-looking but non-standard type');
    error.code = 'SPEECH_ADAPTER_INVALID';
    error.source = 'vendor.adapter';
    error.type = 'banana';
    error.timestamp = '2026-11-11T10:00:00.000Z';
    throw error;
  },
};

test('should_load_and_validate_a_known_adapter_when_configured', async () => {
  const adapter = await loadEnvironmentAdapter('Good', {}, LOADERS);

  assert.equal(adapter.isSupported().supported, true);
});

test('should_map_a_prefixed_but_undeclared_factory_error_to_the_safe_startup_code_when_the_loader_throws_it', async () => {
  // A factory is configurable third-party code: a prefixed-but-undeclared
  // code (or a structurally broken error object) never crosses the boundary
  // as-is — it maps like any other initialization failure.
  const loaders = {
    Sneaky: async () => {
      throw Object.assign(new Error('boom'), { code: 'SPEECH_ADAPTER_HOUSTON_WE_HAVE_A_PROBLEM' });
    },
    Unstructured: async () => {
      // Right code, but missing source/type/timestamp: not standard.
      throw Object.assign(new Error('half-built'), { code: 'SPEECH_ADAPTER_INVALID' });
    },
  };
  for (const identifier of ['Sneaky', 'Unstructured']) {
    await assert.rejects(
      () => loadEnvironmentAdapter(identifier, {}, loaders),
      (error) => error.code === 'SPEECH_ADAPTER_INITIALIZATION_FAILED' && error.type === 'startup',
    );
  }
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

test('should_pass_a_fully_structured_adapter_failure_through_with_its_identity_intact', async () => {
  // The pass-through branch must be distinguishable from the mapping one:
  // the error arrives as a real Error with a declared code AND valid
  // standard field values, and keeps its own source/timestamp identity.
  await assert.rejects(
    () => loadEnvironmentAdapter('FullyStructured', {}, LOADERS),
    (error) => error instanceof Error
      && error.message === 'adapter rejected its configuration'
      && error.code === 'SPEECH_ADAPTER_INVALID'
      && error.source === 'vendor.adapter'
      && error.type === 'operational'
      && error.timestamp === '2026-11-11T10:00:00.000Z',
  );
});

test('should_map_a_structured_looking_failure_when_its_type_is_not_a_standard_value', async () => {
  // Field PRESENCE is not validity: a `type` outside the three standard
  // Bonyan values (same for an unparseable timestamp or a non-Error) maps
  // like any other broken failure instead of crossing the boundary.
  await assert.rejects(
    () => loadEnvironmentAdapter('BrokenType', {}, LOADERS),
    (error) => error.code === 'SPEECH_ADAPTER_INITIALIZATION_FAILED' && error.type === 'startup',
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
