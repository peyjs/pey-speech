# Changelog

## [1.0.1] - 1405-08-15

### Fixed (second review pass)

- A malformed error code in an adapter's end report no longer crashes the error factory (leaving `done` pending forever): the code is shape-checked and falls back to `SPEECH_SERVICE_UNAVAILABLE`.
- Raw adapter failures can no longer cross the boundary: `isSupported`, the session stop (handle, service `stop`) and `deactivate` are all guarded — a throwing device stop resolves `done` as a recognizer failure, and `deactivate` can never break the shutdown cycle.
- `stop` declares `SERVICE_UNAVAILABLE` in the manifest and the reference; the stale `PLUGIN_VERSION` constant and the stale README version badge are gone; the bare `SERVICE_UNAVAILABLE` deactivation code is explicitly locked in the constants test (architecture-wide standard, shared with pey-prefs/pey-chat/pey-llm).
- The adapter contract suite now also runs against the service-level fake; new adapter tests cover the permission grant with track release, `resultIndex` handling with cumulative results, and the undefined-error mapping.

### Fixed

- A recognizer that failed to start synchronously wedged the session lock forever and published `listening-started` after `listening-stopped` — the service now detects the already-ended session and refuses to re-arm it.
- Fixed: a session handle from a finished session could cancel a newer one; each handle now owns its own session control.
- Fixed: the device-error table's deliberate-stop `aborted: null` entry was swallowed by nullish coalescing and reported as a recognizer failure.
- `stop()` now refuses with `SERVICE_UNAVAILABLE` after deactivation (requirement rule 6: every call).
- `SPEECH_SERVICE_UNAVAILABLE` is declared in the manifest for `requestPermission` and `listen`.
- `npm test` discovers the whole tree (`node --test`) — the adapter tests were outside the delivery gate; the shared adapter-contract suite runs against the real Web Speech adapter and a fake; the fake service adapter now implements the full four-method contract.
- New tests: the adapter's supported paths with a fake SpeechRecognition constructor (result distribution, error mapping, flush/cancel, exactly-one-end), loader NOT_FOUND/INVALID/INITIALIZATION_FAILED, and per-source test files (`environment-loader`, `error`, `constants`); `tests/entry.test.js` renamed to `tests/index.test.js` and the adapter test file to `web-speech-environment-adapter.test.js` (54 tests).

## [1.0.0] - 1405-08-13

Initial release: device speech recognition as a platform capability — support check with local/cloud/unknown processing report, explicit permission request (never at startup), single-session listening over the shared flow pattern (partial and final transcription handlers, a handle with stop/cancel and a done promise resolving completed/interrupted/cancelled), device errors mapped to structured codes (`SPEECH_UNSUPPORTED`, `SPEECH_PERMISSION_DENIED`, `SPEECH_NO_SPEECH`, `SPEECH_SERVICE_UNAVAILABLE`, `SPEECH_SESSION_ACTIVE`), the `speech:listening-started`/`speech:listening-stopped` events carrying no text, and a swappable environment adapter (Web Speech API default; unsupported environments degrade to a detectable report, never a crash). `docs/requirements.md` (numbered pey format) is the construction source of truth.
