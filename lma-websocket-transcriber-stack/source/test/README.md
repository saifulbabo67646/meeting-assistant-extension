# Live Meeting Assistant - Whisper Transcription

This project provides real-time audio transcription for meetings using either local Whisper models or the OpenAI Whisper API.

## Features

- Real-time audio transcription using Whisper
- Support for both local Whisper models and OpenAI Whisper API
- Fallback mechanism (if OpenAI API fails, falls back to local model)
- WebSocket server for real-time communication
- Configurable audio chunk size and processing parameters

## Prerequisites

- Node.js 16+
- Python 3.8+ (for local Whisper model)
- OpenAI API key (optional, for using the OpenAI API)

## Installation

1. Install Node.js dependencies:

```bash
npm install
```

2. Install the local Whisper model (optional, if you want to use local transcription):

```bash
npm run install-whisper
```

3. Create a `.env` file based on the `.env.example` file:

```bash
cp .env.example .env
```

4. Edit the `.env` file to configure your settings, especially:
   - Set `USE_OPENAI_API=true` if you want to use the OpenAI API
   - Add your OpenAI API key if using the API

## Configuration

The application can be configured using environment variables or a `.env` file:

### Server Configuration
- `PORT`: Server port (default: 8080)
- `SERVERHOST`: Server host (default: 127.0.0.1)
- `WS_LOG_LEVEL`: Logging level (default: debug)
- `WS_LOG_INTERVAL`: Log interval in seconds (default: 120)
- `LOCAL_TEMP_DIR`: Directory for temporary files (default: ./temp/)

### Whisper Configuration
- `WHISPER_MODEL`: Whisper model to use (default: base)
- `WHISPER_LANGUAGE`: Language code (default: en)
- `WHISPER_TASK`: Task type (default: transcribe)
- `WHISPER_CHUNK_SIZE`: Size of audio chunks in milliseconds (default: 4000)
- `WHISPER_BINARY_PATH`: Path to the Whisper binary (default: whisper)

### OpenAI API Configuration
- `USE_OPENAI_API`: Whether to use the OpenAI API (default: false)
- `OPENAI_API_KEY`: Your OpenAI API key
- `OPENAI_MODEL`: OpenAI model to use (default: whisper-1)

## Usage

1. Start the server:

```bash
npm run start
```

2. Connect to the WebSocket server at `ws://localhost:8080/api/v1/ws`

3. Send audio data to the server for transcription

## Development

```bash
npm run start:dev
```

## Building for Production

```bash
npm run build
npm run start:prod
```

## License

Apache-2.0
