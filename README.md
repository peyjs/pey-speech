# pey.speech

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

## Purpose

Platform plugin of the Pey ecosystem: device speech recognition behind a swappable environment adapter (the Web Speech API in a plain browser, the device recognizer on Android through the Capacitor bridge — the shipped default adapter picks the right one per environment). Support check, microphone permission, and listening sessions that deliver partial and final transcriptions — interpreting nothing.

## Structure

- `docs/requirements.md` — requirements; the construction source of truth.
- `manifest.json` — plugin contract (identity, service, events, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin names, error codes, defaults.
- `lib/error.js` — standard Bonyan error factory.
- `lib/environment-loader.js` — loads and validates the configured adapter.
- `lib/speech-service.js` — session lifecycle, events, flow pattern.
- `adapters/web-speech-environment-adapter.js` — Web Speech API adapter (plain browser).
- `adapters/capacitor-speech-environment-adapter.js` — Android adapter over the `@capgo/capacitor-speech-recognition` native plugin through the runtime-injected `window.Capacitor` bridge (one logical session over many native segments).
- `tests/` — unit tests (`node:test`, fake adapter only).

## Dependencies

- **Required:** none.
- **Optional:** none.

## See Also

- [docs/requirements.md](docs/requirements.md) for the "what and why", written before the implementation.
- [docs/reference.md](docs/reference.md) for the full API, events, errors, config, business rules, and constraints.
