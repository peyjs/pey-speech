// Shared constants for the pey.speech plugin.

export const PLUGIN_NAME = 'pey.speech';
export const SERVICE_NAME = 'pey.speech.service';

export const ERROR_CODES = Object.freeze({
  UNSUPPORTED: 'SPEECH_UNSUPPORTED',
  PERMISSION_DENIED: 'SPEECH_PERMISSION_DENIED',
  NO_SPEECH: 'SPEECH_NO_SPEECH',
  SERVICE_UNAVAILABLE_RECOGNIZER: 'SPEECH_SERVICE_UNAVAILABLE',
  SESSION_ACTIVE: 'SPEECH_SESSION_ACTIVE',
});

export const SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

export const LISTENING_STARTED_EVENT = 'speech:listening-started';
export const LISTENING_STOPPED_EVENT = 'speech:listening-stopped';

export const DEFAULT_LANGUAGE = 'fa-IR';
export const DEFAULT_ADAPTER = 'AutoSpeechEnvironmentAdapter';
