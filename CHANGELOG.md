# Changelog

## [1.0.0] - 1405-08-13

Initial release: device speech recognition as a platform capability — support check with local/cloud/unknown processing report, explicit permission request (never at startup), single-session listening over the shared flow pattern (partial and final transcription handlers, a handle with stop/cancel and a done promise resolving completed/interrupted/cancelled), device errors mapped to structured codes (`SPEECH_UNSUPPORTED`, `SPEECH_PERMISSION_DENIED`, `SPEECH_NO_SPEECH`, `SPEECH_SERVICE_UNAVAILABLE`, `SPEECH_SESSION_ACTIVE`), the `speech:listening-started`/`speech:listening-stopped` events carrying no text, and a swappable environment adapter (Web Speech API default; unsupported environments degrade to a detectable report, never a crash). `docs/requirements.md` (numbered pey format) is the construction source of truth.
