# Changelog

## [1.2.0] - 1405-08-24

### Added

- `CapacitorSpeechEnvironmentAdapter`: Android speech recognition through the `@capgo/capacitor-speech-recognition@7` native plugin via the runtime-injected `window.Capacitor` bridge (device recognizer — no Web Speech dependency). Chosen over `@capacitor-community/speech-recognition` because of its open restart/stop bugs (issue #127) that matched our field findings; Cap-go delivers native segment results, a silence window and readiness signals. Partials stream through the bridge (native `accumulatedText` preferred); permission goes through the plugin's checkPermissions/requestPermissions; permission errors end the session (`SPEECH_PERMISSION_DENIED`), everything else retries up to the failure cap.
- `AutoSpeechEnvironmentAdapter`: selects the Capacitor bridge when present (Android build), the Web Speech API otherwise (plain browser) — one adapter config for both worlds.
- Loader registry entries for both new adapters; manifest config default switched to `AutoSpeechEnvironmentAdapter`.
- Definitive segment capture in the Capacitor adapter: Android fires 'stopped' BEFORE the definitive result — the native `segmentResults` event banks the ended segment's text with the native accumulation (`accumulatedText`) preferred, and a segment result can never shorten the running text (a segment's own result only covers its own words), fixing both the lost tail words and the duplicated-segment text; when no segment result arrives the last partial stands and the session continues.
- GBoard-style session management in the Capacitor adapter: Android's recognizer closes its native session on the first pause (ERROR_NO_MATCH) — the adapter re-opens it and accumulates segment text, so dictation survives silences; a stuck native session is cleaned up before each start (`segmentSettleMs` waits out the async native teardown, default 250); consecutive native failures — failed starts AND error events with no text in between — cap at `maxFailureRestarts` (default 3, tunable via adapterConfig `restartDelayMs`/`readyWaitMs`/`maxFailureRestarts`) before the session surfaces an error. Re-opens are token-scheduled, so a fallback re-open and a readiness re-open can never both land on the recognizer.

## [1.1.0] - 1405-08-22

### Fixed

- **The adapter factory boundary is fail-safe and field-shaped**: only a standard-structured Bonyan error carrying one of the three declared startup codes (`SPEECH_ADAPTER_INITIALIZATION_FAILED` / `_INVALID` / `_NOT_FOUND`) with valid field values crosses with its identity — anything else (prefixed-but-undeclared codes, broken fields, plain objects, non-Error instances) maps to the initialization failure; the contract is documented in the reference's adapter section and locked by a two-way doc/code sync test.
- **The adapter registry resolves through own keys only**: a configured `constructor`/`valueOf`/`hasOwnProperty` is `SPEECH_ADAPTER_NOT_FOUND`, never a forged validation failure.
- **Session lifecycle is leak-proof**: `deactivate` with a throwing device stop still settles the session (`done` resolves `cancelled`, `speech:listening-stopped` fires); a session the device aborts inside `start()` publishes no events; a session locked after a simultaneous failure cannot be double-started; stale handles are never reused; aborted recognitions map to their own ending.
- **Declared contracts match behavior**: `getSupport` shapes the report into exactly `{ supported, processing }`; `requestPermission` reads only a real boolean `true` as granted; `stop` declares `SPEECH_SERVICE_UNAVAILABLE`; `listen` declares `SPEECH_PERMISSION_DENIED`/`SPEECH_NO_SPEECH`; the configured default language is trimmed like the per-call override; the loader's exported code set is named for its meaning (`ADAPTER_FACTORY_ERROR_CODES` vs the service's `ADAPTER_END_ERROR_CODES`).
- All test names follow the standard `should_..._when_...` convention; the doc/code sync test reads the reference itself (87 tests).

## [1.0.1] - 1405-08-15

### Fixed

- A malformed error code in an adapter's end report no longer crashes the error factory (leaving `done` pending forever): the code is shape-checked and falls back to `SPEECH_SERVICE_UNAVAILABLE`.
- Raw adapter failures can no longer cross the boundary: `isSupported`, the session stop (handle, service `stop`) and `deactivate` are all guarded — a throwing device stop resolves `done` as a recognizer failure, and `deactivate` can never break the shutdown cycle.
- `stop` declares `SERVICE_UNAVAILABLE` in the manifest and the reference; the stale `PLUGIN_VERSION` constant and the stale README version badge are gone; the bare `SERVICE_UNAVAILABLE` deactivation code is explicitly locked in the constants test (architecture-wide standard, shared with pey-prefs/pey-chat/pey-llm).
- The adapter contract suite now also runs against the service-level fake; new adapter tests cover the permission grant with track release, `resultIndex` handling with cumulative results, and the undefined-error mapping.
- A recognizer that failed to start synchronously wedged the session lock forever and published `listening-started` after `listening-stopped` — the service now detects the already-ended session and refuses to re-arm it.
- Fixed: a session handle from a finished session could cancel a newer one; each handle now owns its own session control.
- Fixed: the device-error table's deliberate-stop `aborted: null` entry was swallowed by nullish coalescing and reported as a recognizer failure.
- `stop()` now refuses with `SERVICE_UNAVAILABLE` after deactivation (requirement rule 6: every call).
- `SPEECH_SERVICE_UNAVAILABLE` is declared in the manifest for `requestPermission` and `listen`.
- `npm test` discovers the whole tree (`node --test`) — the adapter tests were outside the delivery gate; the shared adapter-contract suite runs against the real Web Speech adapter and a fake; the fake service adapter now implements the full four-method contract.
- New tests: the adapter's supported paths with a fake SpeechRecognition constructor (result distribution, error mapping, flush/cancel, exactly-one-end), loader NOT_FOUND/INVALID/INITIALIZATION_FAILED, and per-source test files (`environment-loader`, `error`, `constants`); `tests/entry.test.js` renamed to `tests/index.test.js` and the adapter test file to `web-speech-environment-adapter.test.js` (54 tests).

## [1.0.0] - 1405-08-13

Initial release: device speech recognition as a platform capability — support check with local/cloud/unknown processing report, explicit permission request (never at startup), single-session listening over the shared flow pattern (partial and final transcription handlers, a handle with stop/cancel and a done promise resolving completed/interrupted/cancelled), device errors mapped to structured codes (`SPEECH_UNSUPPORTED`, `SPEECH_PERMISSION_DENIED`, `SPEECH_NO_SPEECH`, `SPEECH_SERVICE_UNAVAILABLE`, `SPEECH_SESSION_ACTIVE`), the `speech:listening-started`/`speech:listening-stopped` events carrying no text, and a swappable environment adapter (Web Speech API default; unsupported environments degrade to a detectable report, never a crash). `docs/requirements.md` (numbered pey format) is the construction source of truth.
