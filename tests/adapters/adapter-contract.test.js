// Shared adapter-contract suite for pey.speech: every environment adapter
// implementation (the real Web Speech adapter here, fakes in the service
// tests) must satisfy the same four-method contract from
// lib/environment-loader.js. Run against each implementation.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebSpeechEnvironmentAdapter } from '../../adapters/web-speech-environment-adapter.js';
import { createCapacitorSpeechEnvironmentAdapter } from '../../adapters/capacitor-speech-environment-adapter.js';
import { createFakeAdapter } from '../fake-service-adapter.js';
import { createContractAdapter } from '../fake-contract-adapter.js';

/**
 * Runs the whole contract suite against one adapter factory.
 * @param {string} kind Suite label.
 * @param {Function} factory Adapter factory.
 */
export function runAdapterContractSuite(kind, factory) {
  test(`[${kind}] should_implement_the_full_contract_when_created`, () => {
    const adapter = factory();

    for (const method of ['isSupported', 'requestPermission', 'start', 'stop']) {
      assert.equal(typeof adapter[method], 'function', method);
    }
  });

  test(`[${kind}] should_report_support_with_a_processing_field_when_asked`, () => {
    const adapter = factory();
    const support = adapter.isSupported();

    assert.equal(typeof support.supported, 'boolean');
    assert.equal(typeof support.processing, 'string');
  });

  test(`[${kind}] should_resolve_the_permission_outcome_when_requested`, async () => {
    const adapter = factory();
    const outcome = await adapter.requestPermission();

    assert.equal(typeof outcome.granted, 'boolean');
  });

  test(`[${kind}] should_return_a_session_control_with_stop_when_started`, () => {
    const adapter = factory();
    let ended = false;
    const control = adapter.start({
      language: 'fa-IR',
      onPartial: () => {},
      onFinal: () => {},
      end: () => {
        ended = true;
      },
    });

    assert.equal(typeof control.stop, 'function');
    // A stop must end the session exactly once, without throwing.
    control.stop({ flush: false });
    assert.equal(ended, true);
    control.stop({ flush: false });
  });

  test(`[${kind}] should_stop_safely_through_the_adapter_level_stop_when_called`, () => {
    const adapter = factory();
    adapter.start({
      language: 'fa-IR',
      onPartial: () => {},
      onFinal: () => {},
      end: () => {},
    });

    assert.doesNotThrow(() => adapter.stop({ flush: false }));
  });
}

runAdapterContractSuite('web-speech', () => createWebSpeechEnvironmentAdapter());
// The Capacitor adapter loads in a plain Node run without a bridge (it
// reports "unsupported" and its start ends synchronously) — the fail-open
// contract, exercised here like every other implementation.
runAdapterContractSuite('capacitor', () => createCapacitorSpeechEnvironmentAdapter());
// The same five contract claims on the BRIDGED path: without this run the
// suite would only ever exercise the early "unsupported" returns and miss
// a real contract violation on the live Android path. A fake bridge stands
// in for the native plugin; it is installed after the no-bridge suite and
// stays for the rest of this file's own test process.
runAdapterContractSuite('capacitor-bridge', () => {
  globalThis.Capacitor = { Plugins: { SpeechRecognition: createBridgeFake() } };
  return createCapacitorSpeechEnvironmentAdapter();
});
runAdapterContractSuite('fake', () => createContractAdapter());

// The service-level fake is a third full implementation of the contract:
// it must satisfy the same suite the real adapter passes.
runAdapterContractSuite('service-fake', () => createFakeAdapter().adapter);

/**
 * Minimal in-memory stand-in for the window.Capacitor SpeechRecognition
 * bridge (only the surface the bridged contract suite touches).
 * @returns {object} Fake bridge.
 */
function createBridgeFake() {
  return {
    listeners: {},
    addListener(eventName, handler) {
      this.listeners[eventName] = this.listeners[eventName] ?? [];
      this.listeners[eventName].push(handler);
      return { remove: () => {} };
    },
    async start() {
      return {};
    },
    async stop() {},
    async isListening() {
      return { listening: false };
    },
    async checkPermissions() {
      return { speechRecognition: 'granted' };
    },
    async requestPermissions() {
      return { speechRecognition: 'granted' };
    },
  };
}
