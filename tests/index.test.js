// Verifies the entry-point lifecycle wiring and the manifest contract.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepare } from '../index.js';

const MANIFEST_PATH = new URL('../manifest.json', import.meta.url);
const PACKAGE_PATH = new URL('../package.json', import.meta.url);

function createPrepareContext(overrides = {}) {
  return {
    config: {},
    events: {
      publish: () => {},
      subscribe: () => () => {},
    },
    onShutdown: null,
    onDeactivated: null,
    reportCriticalError: () => {},
    ...overrides,
  };
}

test('should_register_service_when_prepare_is_called', async () => {
  const context = createPrepareContext();

  const registrations = await prepare(context);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'pey.speech.service');
  assert.equal(typeof registrations[0].object.getSupport, 'function');
  assert.equal(typeof registrations[0].object.requestPermission, 'function');
  assert.equal(typeof registrations[0].object.listen, 'function');
  assert.equal(typeof registrations[0].object.stop, 'function');
  assert.equal(typeof context.onShutdown, 'function');
  assert.equal(typeof context.onDeactivated, 'function');
});

test('should_load_the_default_adapter_even_when_the_environment_is_unsupported', async () => {
  // Node has no Web Speech API: the adapter loads anyway and reports
  // unsupported — the host app must not break.
  const context = createPrepareContext();
  const registrations = await prepare(context);

  assert.deepEqual(registrations[0].object.getSupport(), { supported: false, processing: 'unknown' });
});

test('should_reject_startup_when_the_configured_adapter_is_unknown', async () => {
  const context = createPrepareContext({ config: { adapter: 'NoSuchAdapter' } });

  await assert.rejects(
    () => prepare(context),
    (error) => error.code === 'SPEECH_ADAPTER_NOT_FOUND' && error.type === 'startup',
  );
});

test('should_match_manifest_contract_when_loaded', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));

  assert.equal(manifest.name, 'pey.speech');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.type, 'platform');
  assert.equal(manifest.adapterType, undefined);
  assert.deepEqual(manifest.dependencies, { required: [], optional: [] });
  assert.equal(manifest.provides.length, 1);
  assert.equal(manifest.provides[0].name, 'pey.speech.service');
  const methodNames = manifest.provides[0].methods.map((method) => method.name);
  assert.deepEqual(methodNames, ['getSupport', 'requestPermission', 'listen', 'stop']);
  assert.deepEqual(manifest.events.map((event) => event.name), ['speech:listening-started', 'speech:listening-stopped']);
  assert.deepEqual(manifest.config, { adapter: 'WebSpeechEnvironmentAdapter', adapterConfig: {}, language: 'fa-IR' });
});
