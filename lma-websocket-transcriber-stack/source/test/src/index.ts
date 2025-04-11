// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { FastifyRequest } from 'fastify';

import WebSocket from 'ws'; // type structure for the websocket object used by fastify/websocket
import os from 'os';
import path from 'path';
import BlockStream from 'block-stream2';

import fs from 'fs';
import { randomUUID } from 'crypto';

import {
    createWavHeader,
    posixifyFilename,
    normalizeErrorForLogging,
    getClientIP,
} from './utils';

// Import Whisper transcription functionality
// import { startWhisperTranscribe } from './calleventdata/whisper';
import { SocketCallData, CallMetaData } from './calleventdata/eventtypes';
import { WebSocket as WSClient } from 'ws';

// Simple configuration with defaults
const LOCAL_TEMP_DIR = process.env['LOCAL_TEMP_DIR'] || './temp/';
const PORT = process.env['PORT'] || 4000;
const WS_LOG_LEVEL = process.env['WS_LOG_LEVEL'] || 'debug';
const WS_LOG_INTERVAL = parseInt(process.env['WS_LOG_INTERVAL'] || '120', 10);
const SHOULD_RECORD_CALL = true; // Always record in local mode

type ChannelSpeakerData = {
    currentSpeakerName: string | null;
    speakers: string[];
    startTimes: number[];
};

const socketMap = new Map<WebSocket, SocketCallData>();

// create fastify server with logging enabled
const server = fastify({
    logger: {
        level: WS_LOG_LEVEL,
        prettyPrint: {
            ignore: 'pid,hostname',
            translateTime: 'SYS:HH:MM:ss.l',
            colorize: false,
            levelFirst: true,
        },
    },
    disableRequestLogging: true,
});

// register the @fastify/websocket plugin with the fastify server
server.register(websocket);

// Setup Route for websocket connection
server.get(
    '/api/v1/ws',
    { websocket: true, logLevel: 'debug' },
    (connection, request) => {
        const clientIP = getClientIP(request.headers);
        server.log.debug(
            `[NEW CONNECTION]: [${clientIP}] - Received new connection request @ /api/v1/ws. URI: <${
                request.url
            }>, Headers: ${JSON.stringify(request.headers)}`
        );

        registerHandlers(clientIP, connection.socket, request); // setup the handler functions for websocket events
    }
);

// Setup Route for health check
server.get('/health/check', { logLevel: 'warn' }, (request, response) => {
    const cpuUsage = (os.loadavg()[0] / os.cpus().length) * 100;
    const isHealthy = cpuUsage > 90 ? false : true;
    const status = isHealthy ? 200 : 503;

    response
        .code(status)
        .header(
            'Cache-Control',
            'max-age=0, no-cache, no-store, must-revalidate, proxy-revalidate'
        )
        .send({ 'Http-Status': status, Healthy: isHealthy });
});

// Setup handlers for websocket events - 'message', 'close', 'error'
const registerHandlers = (
    clientIP: string,
    ws: WebSocket,
    request: FastifyRequest
): void => {
    ws.on('message', async (data, isBinary): Promise<void> => {
        try {
            if (isBinary) {
                const audioinput = Buffer.from(data as Uint8Array);
                await onBinaryMessage(clientIP, ws, audioinput);
            } else {
                await onTextMessage(
                    clientIP,
                    ws,
                    Buffer.from(data as Uint8Array).toString('utf8'),
                    request
                );
            }
        } catch (error) {
            server.log.error(
                `[ON MESSAGE]: [${clientIP}] - Error processing message: ${normalizeErrorForLogging(
                    error
                )}`
            );
        }
    });

    ws.on('close', (code: number) => {
        server.log.debug(
            `[ON WSCLOSE]: [${clientIP}] Received Websocket close message from the client. Closing the connection.`
        );

        try {
            onWsClose(ws, code);
        } catch (err) {
            server.log.error(
                `[ON WSCLOSE]: [${clientIP}] Error in WS close handler: ${normalizeErrorForLogging(
                    err
                )}`
            );
        }
    });

    ws.on('error', (error: Error) => {
        server.log.error(
            `[ON ERROR]: [${clientIP}] Websocket error: ${normalizeErrorForLogging(
                error
            )}`
        );
    });
};

const onBinaryMessage = async (
    clientIP: string,
    ws: WebSocket,
    data: Uint8Array
): Promise<void> => {
    const socketData = socketMap.get(ws);
    if (!socketData || !socketData.callMetadata) {
        server.log.error(`[ON BINARY MESSAGE]: [${clientIP}] - Received binary data without call metadata`);
        return;
    }

    if (
        socketData !== undefined &&
        socketData.audioInputStream !== undefined &&
        socketData.writeRecordingStream !== undefined &&
        socketData.recordingFileSize !== undefined
    ) {
        // Write audio data to the recording file
        socketData.audioInputStream.push(data);
        socketData.writeRecordingStream.write(data);
        socketData.recordingFileSize += data.length;
        
        // server.log.debug(
        //     `[AUDIO]: [${socketData.callMetadata.callId}] - Received ${data.length} bytes of audio data. Total: ${socketData.recordingFileSize} bytes`
        // );

        // Append to audio buffer for transcription
        if (socketData.audioBuffer) {
            socketData.audioBuffer = Buffer.concat([socketData.audioBuffer, data]);
        }

    } else {
        server.log.error(
            `[ON BINARY MESSAGE]: [${clientIP}] - Error: received audio data before metadata. Check logs for errors in START event.`
        );
    }
};

const startWhisperTranscribe = async (socketCallData: SocketCallData, server: FastifyInstance): Promise<void> => {
    // Setup a buffer to collect audio data
    socketCallData.audioBuffer = Buffer.alloc(0);
    socketCallData.lastTranscriptionTime = Date.now();
    
    // Start a periodic task to send audio for transcription
    const transcriptionInterval = setInterval(async () => {
        if (socketCallData.ended) {
            clearInterval(transcriptionInterval);
            return;
        }
        
        if (socketCallData.audioBuffer.length > 0 && 
            Date.now() - socketCallData.lastTranscriptionTime > 3000) { // 3 seconds
            
            try {
                const audioToTranscribe = socketCallData.audioBuffer;
                socketCallData.audioBuffer = Buffer.alloc(0);
                socketCallData.lastTranscriptionTime = Date.now();

                // Create a WAV file with proper headers
                const wavHeader = createWavHeader(socketCallData.callMetadata.samplingRate,
                    audioToTranscribe.length);

                
                
                // Combine header with audio data
                const wavFile = Buffer.concat([wavHeader, audioToTranscribe]);
                const audioBlob = new Blob([wavFile.buffer]);
                
                // Create a form with the audio data
                const form = new FormData();
                form.append('file', audioBlob, 'audio.wav');
                form.append('model', 'Systran/faster-whisper-base');
                form.append('response_format', 'json');
                
                // Send to the transcription API
                const response = await fetch('http://localhost:8000/v1/audio/transcriptions', {
                    method: 'POST',
                    body: form
                });
                
                const result = await response.json() as { text: string };
                
                if (result.text) {
                    server.log.info(`[TRANSCRIBE]: [${socketCallData.callMetadata.callId}] - Transcript: ${result.text}`);
                    
                    // Send transcript to client
                    if (socketCallData.ws && socketCallData.ws.readyState === WebSocket.OPEN) {
                        socketCallData.ws.send(JSON.stringify({
                            event: 'TRANSCRIPT',
                            callId: socketCallData.callMetadata.callId,
                            speaker: socketCallData.callMetadata.activeSpeaker,
                            transcript: result.text
                        }));
                    }
                }
            } catch (error) {
                server.log.error(`[TRANSCRIBE]: [${socketCallData.callMetadata.callId}] - Error transcribing: ${normalizeErrorForLogging(error)}`);
            }
        }
    }, 1000); // Check every second
    
    socketCallData.transcriptionInterval = transcriptionInterval;
};

const onTextMessage = async (
    clientIP: string,
    ws: WebSocket,
    data: string,
    request: FastifyRequest
): Promise<void> => {
    try {
        // Parse the call metadata from the message
        const callMetaData: CallMetaData = JSON.parse(data);
        
        server.log.debug(
            `[ON TEXT MESSAGE]: [${clientIP}][${callMetaData.callId || 'unknown'}] - Call Metadata received from client: ${data}`
        );

        if (callMetaData.callEvent === 'START') {
            // Generate random metadata if none is provided
            callMetaData.callId = callMetaData.callId || randomUUID();
            callMetaData.fromNumber = callMetaData.fromNumber || 'Customer Phone';
            callMetaData.toNumber = callMetaData.toNumber || 'System Phone';
            callMetaData.activeSpeaker = callMetaData.activeSpeaker ?? callMetaData?.fromNumber ?? 'unknown';
            callMetaData.agentId = callMetaData.agentId || randomUUID();
            callMetaData.shouldRecordCall = true;

            server.log.info(
                `[${callMetaData.callEvent}]: [${callMetaData.callId}] - Starting new call recording`
            );

            // Create file for recording
            const tempRecordingFilename = getTempRecordingFileName(callMetaData);
            const writeRecordingStream = fs.createWriteStream(
                path.join(LOCAL_TEMP_DIR, tempRecordingFilename)
            );
            const recordingFileSize = 0;

            // Setup audio stream with appropriate buffer size
            const highWaterMarkSize = (callMetaData.samplingRate / 10) * 2 * 2;
            const audioInputStream = new BlockStream({ size: highWaterMarkSize });
            
            // Store call data in the socket map
            const socketCallMap: SocketCallData = {
                callMetadata: Object.assign({}, callMetaData),
                audioInputStream: audioInputStream,
                writeRecordingStream: writeRecordingStream,
                recordingFileSize: recordingFileSize,
                startStreamTime: new Date(),
                speakerEvents: [],
                ended: false,
            };
            socketMap.set(ws, socketCallMap);
            
            // Start Whisper transcription
            startWhisperTranscribe(socketCallMap, server);
            
            server.log.info(
                `[${callMetaData.callEvent}]: [${callMetaData.callId}] - Call started, ready to receive audio`
            );
        } else if (callMetaData.callEvent === 'SPEAKER_CHANGE') {
            const socketData = socketMap.get(ws);
            server.log.debug(
                `[${callMetaData.callEvent}]: [${callMetaData.callId}] - Received speaker change. Active speaker = ${callMetaData.activeSpeaker}`
            );

            if (socketData && socketData.callMetadata) {
                // Update the active speaker in the call metadata
                socketData.callMetadata.activeSpeaker = callMetaData.activeSpeaker;
                server.log.info(
                    `[${callMetaData.callEvent}]: [${callMetaData.callId}] - Speaker changed to: ${callMetaData.activeSpeaker}`
                );
            } else {
                server.log.error(
                    `[${callMetaData.callEvent}]: [${callMetaData.callId}] - Invalid call metadata for speaker change`
                );
            }
        } else if (callMetaData.callEvent === 'END') {
            const socketData = socketMap.get(ws);
            if (!socketData || !socketData.callMetadata) {
                server.log.error(
                    `[${callMetaData.callEvent}]: [${callMetaData.callId}] - Received END without starting a call`
                );
                return;
            }
            
            server.log.info(
                `[${callMetaData.callEvent}]: [${callMetaData.callId}] - Received call end event from client`
            );
            
            await endCall(ws, socketData, callMetaData);
        }
    } catch (error) {
        server.log.error(
            `[ON TEXT MESSAGE]: [${clientIP}] - Error processing text message: ${data} - ${normalizeErrorForLogging(error)}`
        );
    }
};

const onWsClose = async (ws: WebSocket, code: number): Promise<void> => {
    ws.close(code);
    const socketData = socketMap.get(ws);
    if (socketData) {
        server.log.debug(
            `[ON WSCLOSE]: [${socketData.callMetadata.callId}] - Writing call end event due to websocket close event`
        );
        await endCall(ws, socketData);
    }
};

const endCall = async (
    ws: WebSocket,
    socketData: SocketCallData,
    callMetaData?: CallMetaData
): Promise<void> => {
    if (callMetaData === undefined) {
        callMetaData = socketData.callMetadata;
    }
    // Clear transcription interval if it exists
    if (socketData.transcriptionInterval) {
        clearInterval(socketData.transcriptionInterval);
    }

    if (socketData !== undefined && socketData.ended === false) {
        socketData.ended = true;

        if (callMetaData !== undefined && callMetaData != null) {
            server.log.info(
                `[END]: [${callMetaData.callId}] - Ending call and finalizing recording`
            );
            
            if (socketData.writeRecordingStream && socketData.recordingFileSize) {
                socketData.writeRecordingStream.end();

                server.log.debug(
                    `[END]: [${callMetaData.callId}] - shouldRecordCall: ${callMetaData.shouldRecordCall}`
                );

                if (SHOULD_RECORD_CALL) {
                    server.log.debug(
                        `[END]: [${callMetaData.callId}] - Creating WAV file from raw audio data`
                    );
                    
                    // Create WAV file with proper header
                    const header = createWavHeader(
                        callMetaData.samplingRate,
                        socketData.recordingFileSize
                    );
                    const tempRecordingFilename = getTempRecordingFileName(callMetaData);
                    const wavRecordingFilename = getWavRecordingFileName(callMetaData);
                    
                    // Copy raw audio data to WAV file with header
                    const readStream = fs.createReadStream(
                        path.join(LOCAL_TEMP_DIR, tempRecordingFilename)
                    );
                    const writeStream = fs.createWriteStream(
                        path.join(LOCAL_TEMP_DIR, wavRecordingFilename)
                    );
                    writeStream.write(header);
                    for await (const chunk of readStream) {
                        writeStream.write(chunk);
                    }
                    writeStream.end();
                    
                    server.log.info(
                        `[END]: [${callMetaData.callId}] - Recording saved to ${path.join(LOCAL_TEMP_DIR, wavRecordingFilename)}`
                    );
                    
                    // Clean up temporary raw audio file
                    try {
                        await fs.promises.unlink(path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
                        server.log.debug(
                            `[END]: [${callMetaData.callId}] - Deleted temporary raw audio file`
                        );
                    } catch (err) {
                        server.log.error(
                            `[END]: [${callMetaData.callId}] - Error deleting temporary file: ${normalizeErrorForLogging(err)}`
                        );
                    }
                }
            }

            if (socketData.audioInputStream) {
                server.log.debug(
                    `[END]: [${callMetaData.callId}] - Closing audio input stream`
                );
                socketData.audioInputStream.end();
                socketData.audioInputStream.destroy();
            }
            
            if (socketData) {
                server.log.debug(
                    `[END]: [${callMetaData.callId}] - Removing websocket from active connections`
                );
                socketMap.delete(ws);
            }
        } else {
            server.log.error('[END]: Missing Call Meta Data in END event');
        }
    } else {
        if (callMetaData !== undefined && callMetaData != null) {
            server.log.error(
                `[END]: [${callMetaData.callId}] - Duplicate End call event. Already received the end call event`
            );
        } else {
            server.log.error(
                '[END]: Duplicate End call event. Missing Call Meta Data in END event'
            );
        }
    }
};

const getTempRecordingFileName = (callMetaData: CallMetaData): string => {
    return `${posixifyFilename(callMetaData.callId)}.raw`;
};

const getWavRecordingFileName = (callMetaData: CallMetaData): string => {
    return `${posixifyFilename(callMetaData.callId)}.wav`;
};

// Start the websocket server
server.listen(
    {
        port: Number(PORT),
        host: process.env?.['SERVERHOST'] ?? '127.0.0.1',
    },
    (err) => {
        if (err) {
            server.log.error(
                `[WS SERVER STARTUP]: Error starting websocket server: ${normalizeErrorForLogging(
                    err
                )}`
            );
            process.exit(1);
        }
        server.log.info(
            `[WS SERVER STARTUP]: Websocket server is ready and listening on http://${process.env?.['SERVERHOST'] ?? '127.0.0.1'}:${PORT}`
        );
        server.log.info(`[WS SERVER STARTUP]: Routes: \n${server.printRoutes()}`);
    }
);
