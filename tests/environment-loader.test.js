// Unit tests for lib/environment-loader.js — adapter resolution and
// validation at startup.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ADAPTER_FACTORY_ERROR_CODES,
  loadEnvironmentAdapter } from '../lib/environment-loader.js';

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
  PlainStructured: async () => {
    // A standard field-shaped error that is NOT an Error instance — exactly
    // what this plugin's own createSpeechError (and any standard Bonyan
    // factory) produces. The pass-through gate is field-shaped, so this
    // must cross with its identity intact.
    throw {
      code: 'SPEECH_ADAPTER_INVALID',
      message: 'plain structured rejection',
      source: 'vendor.adapter',
      type: 'operational',
      timestamp: '2026-11-11T10:00:00.000Z',
    };
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

test('should_declare_exactly_the_three_pass_through_codes_when_the_adapter_contract_is_locked', () => {
  // The documented pass-through contract (reference, Environment adapter):
  // these three startup codes keep a standard field-shaped error's identity;
  // everything else maps to INITIALIZATION_FAILED. The triple is locked here
  // so the docs and the loader cannot drift apart.
  assert.deepEqual(Object.values(ADAPTER_FACTORY_ERROR_CODES).sort(), [
    'SPEECH_ADAPTER_INITIALIZATION_FAILED',
    'SPEECH_ADAPTER_INVALID',
    'SPEECH_ADAPTER_NOT_FOUND',
  ]);
});

test('should_state_all_three_factory_codes_in_the_reference_when_the_doc_side_of_the_contract_is_read', async () => {
  // Round-11 regression: the round-10 test locked only the CODE side —
  // editing or deleting the reference's paragraph broke nothing, so the
  // claimed "doc/code sync" was one-directional. The DOC side is read here
  // (a deliberate real-file read: the file's content IS the subject):
  // the Factory errors paragraph must name all three codes and the
  // everything-else rule.
  const { readFile } = await import('node:fs/promises');
  const reference = await readFile(new URL('../docs/reference.md', import.meta.url), 'utf8');
  const factorySection = reference.slice(reference.indexOf('Factory errors'));
  assert.ok(factorySection.includes('Factory errors'), 'the Factory errors paragraph exists');
  for (const code of Object.values(ADAPTER_FACTORY_ERROR_CODES)) {
    assert.ok(factorySection.includes(code), `the reference names ${code}`);
  }
  assert.ok(
    factorySection.includes('INITIALIZATION_FAILED') && factorySection.includes('ANY other'),
    'the everything-else-maps-to-INITIALIZATION_FAILED rule is stated',
  );
});

test('should_resolve_a_prototype_inherited_identifier_to_not_found_when_the_registry_is_indexed', async () => {
  // Round-11 regression: plain indexing reads the prototype chain, so a
  // configured `constructor`/`valueOf` resolved to the INHERITED function
  // and failed validation as INVALID — the wrong meaning for "no adapter
  // with this identifier". Registry membership is own-keys only now.
  for (const identifier of ['constructor', 'valueOf', 'hasOwnProperty']) {
    const error = await loadEnvironmentAdapter(identifier, {}, LOADERS).catch((caught) => caught);
    assert.equal(error?.code, 'SPEECH_ADAPTER_NOT_FOUND', identifier);
  }
});

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

test('should_pass_a_fully_structured_adapter_failure_through_with_its_identity_intact_when_the_factory_throws_one', async () => {
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

test('should_pass_a_standard_plain_object_error_through_when_its_fields_are_fully_valid', async () => {
  // The Bonyan error structure is FIELD-shaped (bonyan/error.md): nothing
  // in it requires an Error instance, and this plugin's own factory returns
  // plain objects. instanceof Error was a stricter gate than the standard —
  // a third-party factory reusing createSpeechError used to lose its
  // declared code to the mapping branch.
  await assert.rejects(
    () => loadEnvironmentAdapter('PlainStructured', {}, LOADERS),
    (error) => error.code === 'SPEECH_ADAPTER_INVALID'
      && error.message === 'plain structured rejection'
      && error.source === 'vendor.adapter'
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

test('should_load_the_capacitor_adapter_by_identifier', async () => {
  const adapter = await loadEnvironmentAdapter('CapacitorSpeechEnvironmentAdapter', {});
  for (const method of ['isSupported', 'requestPermission', 'start', 'stop']) {
    assert.equal(typeof adapter[method], 'function', method);
  }
});

test('should_load_the_auto_adapter_and_fall_back_to_web_speech_outside_capacitor', async () => {
  const saved = globalThis.Capacitor;
  delete globalThis.Capacitor;
  try {
    const adapter = await loadEnvironmentAdapter('AutoSpeechEnvironmentAdapter', {});
    for (const method of ['isSupported', 'requestPermission', 'start', 'stop']) {
      assert.equal(typeof adapter[method], 'function', method);
    }
    // No Capacitor bridge in this environment → the Web Speech fallback,
    // whose support signal follows the platform API (absent in Node).
    assert.equal(adapter.isSupported().supported, false);
  } finally {
    if (saved !== undefined) globalThis.Capacitor = saved;
  }
});

test('should_load_the_auto_adapter_through_the_capacitor_bridge_when_present', async () => {
  const saved = globalThis.Capacitor;
  globalThis.Capacitor = { Plugins: { SpeechRecognition: {} } };
  try {
    const adapter = await loadEnvironmentAdapter('AutoSpeechEnvironmentAdapter', {});
    // The Capacitor adapter reports supported whenever the bridge exists.
    assert.equal(adapter.isSupported().supported, true);
  } finally {
    if (saved !== undefined) globalThis.Capacitor = saved;
    else delete globalThis.Capacitor;
  }
});
