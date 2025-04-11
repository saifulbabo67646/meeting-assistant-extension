// Configuration for Whisper transcription

// Whisper configuration
export const WHISPER_CONFIG = {
  MODEL: process.env['WHISPER_MODEL'] || 'base',
  LANGUAGE: process.env['WHISPER_LANGUAGE'] || 'en',
  TASK: process.env['WHISPER_TASK'] || 'transcribe',
  CHUNK_SIZE: parseInt(process.env['WHISPER_CHUNK_SIZE'] || '4000', 10), // in milliseconds
  BINARY_PATH: process.env['WHISPER_BINARY_PATH'] || 'whisper',
};

// Export configuration
export default {
  WHISPER_CONFIG,
};
