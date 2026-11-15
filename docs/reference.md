# pey.speech — Reference

Self-contained reference for the `pey.speech` platform plugin. The manifest (`manifest.json`) is always the authoritative contract; this document explains it.

## Purpose

Speech-to-text through the device's own recognizer, behind a swappable environment adapter. The plugin owns the session lifecycle and the event surface; the adapter owns the device. It interprets nothing (no amounts, no dates), stores nothing, and sends nothing anywhere — the device's recognizer may be local or cloud-based, which the plugin reports when it can and never claims otherwise.

## Structure

- `manifest.json` — plugin contract (identity, service, events, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin name, service name, error codes, defaults.
- `lib/error.js` — standard Bonyan error factory.
- `lib/environment-loader.js` — loads and validates the configured adapter.
- `lib/speech-service.js` — session lifecycle, events, flow pattern.
- `adapters/web-speech-environment-adapter.js` — Web Speech API adapter (browser / WebView).
- `adapters/capacitor-speech-environment-adapter.js` — Android adapter over the `@capgo/capacitor-speech-recognition@7` native plugin through the runtime-injected `window.Capacitor` bridge.
- `tests/` — unit tests (`node:test`, fake adapter only).

## Dependencies

- **Required:** none.
- **Optional:** none.

## Environment adapter (internal contract)

Like `pey.filesystem`, the platform type hides the environment behind an internal adapter, selectable by configuration (`config.adapter`) and loaded through a loader registry:

```
isSupported()                                  → { supported: boolean, processing: 'local' | 'cloud' | 'unknown' }
requestPermission()                            → Promise<{ granted: boolean }>
start({ language, onPartial, onFinal, end })   → { stop({ flush }) }
stop({ flush })                                → void   (stops the adapter's active session)
```

`start` hands the session its handlers; `end(report)` is called exactly once per session with `{ reason: 'speech' | 'no-speech' | 'error' | 'cancelled', text?, code? }`. Device errors are mapped to the plugin's codes inside the adapter — nothing raw crosses. The `WebSpeechEnvironmentAdapter` targets the Web Speech API (plain browser). The `CapacitorSpeechEnvironmentAdapter` targets Android through the `@capgo/capacitor-speech-recognition@7` native plugin (device recognizer). It runs ONE logical session over MANY native segments: silence ends a segment, the native layer delivers definitive `segmentResults` and `readyForNextSession` after teardown, the adapter re-opens the next segment and streams the native-accumulated text (GBoard-style dictation); `adapterConfig` tunes `restartDelayMs` (re-open delay after readiness or a failed start), `maxFailureRestarts` (consecutive failed starts — or consecutive error events with no text in between — tolerated before the session ends), `allowForSilenceMs` (silence window per segment), `readyWaitMs` (fallback wait when the readiness signal never fires), `segmentSettleMs` (wait after stopping a busy recognizer before re-opening) and `startTimeoutMs` (time guard: a native start that never settles is abandoned, counted as a failure and the session never hangs, default 5000). Re-opens are token-scheduled and the start dispatch is serialized: a newer re-open supersedes a pending one, and at most one native start is ever tracked in flight. Switched from `@capacitor-community/speech-recognition` over its open restart/stop bugs (upstream issue #127). The `AutoSpeechEnvironmentAdapter` (the shipped default) selects the Capacitor bridge when present and the Web Speech API otherwise, so one adapter config serves both worlds. In an environment without speech support the adapter still loads and reports "unsupported" — the host app must not break.

**Factory errors (the documented pass-through contract):** the configured factory may throw, and the loader keeps the error's identity only when it is a standard field-shaped Bonyan error carrying one of the three startup codes — `SPEECH_ADAPTER_INITIALIZATION_FAILED`, `SPEECH_ADAPTER_INVALID` or `SPEECH_ADAPTER_NOT_FOUND` — with a string `message`, a string `source`, a standard `type` (`startup`/`operational`/`critical`) and a parseable `timestamp` (plain objects count: the shape is field-based, exactly what `createSpeechError` in this plugin builds). ANY other failure — including a prefixed-but-undeclared code or broken field values — maps to `SPEECH_ADAPTER_INITIALIZATION_FAILED` (type `startup`). These three codes are the plugin's startup-error face toward Core.

## Public API

The service `pey.speech.service` provides four methods.

### `getSupport()`

`{ supported, processing }` — `processing` is `'local'` or `'cloud'` when the system says so, `'unknown'` otherwise (the Web Speech API never says). Throws `SERVICE_UNAVAILABLE` after deactivation and `SPEECH_SERVICE_UNAVAILABLE` when the recognizer itself fails while reporting its support.

### `requestPermission()`

Explicitly asks for the microphone/speech permission — never at startup. Resolves `{ granted: true }`, or throws `SPEECH_PERMISSION_DENIED` (refused), `SPEECH_UNSUPPORTED` (no recognizer here), `SPEECH_SERVICE_UNAVAILABLE` (the recognizer itself failed while processing the request) and `SERVICE_UNAVAILABLE` (after deactivation).

### `listen({ language? }, { onPartial, onFinal })`

Starts the one allowed session: `onPartial` delivers interim transcriptions while the user speaks, `onFinal` delivers settled phrases. The language defaults to the configured one and can be overridden per call. Resolves to the session handle — the shared flow pattern:

- `stop()` — finish and deliver: the ending is `completed` with the last final transcription, or `cancelled` when nothing was recognized. After deactivation the session is already closed and this call is a no-op — only the SERVICE-level methods throw `SERVICE_UNAVAILABLE`.
- `cancel()` — stop without a result.
- `done` — never rejects; resolves exactly one of three endings:
  - `{ ending: 'completed', text: string | null }`
  - `{ ending: 'interrupted', error }` — long silence (`SPEECH_NO_SPEECH`), recognizer failure (`SPEECH_SERVICE_UNAVAILABLE`), permission pulled mid-session (`SPEECH_PERMISSION_DENIED`), …
  - `{ ending: 'cancelled' }` — no result delivered.

A second session while one is active throws `SPEECH_SESSION_ACTIVE`. Long silence ends the session on the device's own terms and surfaces as the no-speech code (adapter-dependent: the `WebSpeechEnvironmentAdapter` ends the session on the device's own long-silence terms, while the default Capacitor/Android adapter is segment-based by design — silences re-open the next segment and the logical session stays open until the caller's stop, a permission failure or a hard failure streak).

### `stop()`

Service-level finish of the active session (same as the handle's `stop`). A no-op when nothing is active. When the device stop itself fails, the session is still closed (`done` resolves as a recognizer failure) and `SPEECH_SERVICE_UNAVAILABLE` is thrown. Also throws `SERVICE_UNAVAILABLE` after deactivation.

## Events

| Event | Data | When |
|---|---|---|
| `speech:listening-started` | none | A session actually started. |
| `speech:listening-stopped` | none | A session ended, for any reason. |

These exist only so the UI can show the microphone state; recognized text and audio never travel through them.

## Errors Reference

| Code | Situation | Type |
|---|---|---|
| `SPEECH_UNSUPPORTED` | The environment has no usable recognizer (check support to disable the UI button). | operational |
| `SPEECH_PERMISSION_DENIED` | The permission request was refused, or the permission was pulled mid-session. | operational |
| `SPEECH_NO_SPEECH` | The session ended without hearing speech (long silence). | operational |
| `SPEECH_SERVICE_UNAVAILABLE` | The recognizer service could not run (needs network, missing components, failed to start). | operational |
| `SPEECH_SESSION_ACTIVE` | A second session was requested while one is active. | operational |
| `SERVICE_UNAVAILABLE` | Called after deactivation/shutdown; the running session is cut without a result. | operational |

Raw device errors never leave the adapter; branch on `code`, never on `message`. A code an adapter reports through the session end is honored only when it is one of the codes declared above — anything else (however well-formed) surfaces as `SPEECH_SERVICE_UNAVAILABLE`, so callers never see an undeclared code.

## Config

| Key | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `adapter` | `string` | No | `'AutoSpeechEnvironmentAdapter'` | Environment adapter identifier: `WebSpeechEnvironmentAdapter`, `CapacitorSpeechEnvironmentAdapter`, or `AutoSpeechEnvironmentAdapter`. |
| `adapterConfig` | `object` | No | `{}` | Adapter-specific configuration. |
| `language` | `string` | No | `'fa-IR'` | Default recognition language; per-call override exists. |

## Business Rules

- Startup requests no permission and listens to nothing; permission is requested only by explicit call.
- One session at a time; every session ends with exactly one of the three endings.
- Recognized text and audio never appear in events, errors or logs.
- The plugin never claims more about privacy than it knows: processing locality is reported only when the system says so.
- The plugin does not interpret the transcription and does not guarantee the device recognizer's own handling of audio.

## Constraints

- Deactivation cuts the running session (cancelled) and refuses further calls.
- Raw audio capture is out of scope (a separate `microphone` plugin if ever needed); connecting the plugin itself to a cloud speech service is a later step — the device's own cloud recognizer is the device's business.
