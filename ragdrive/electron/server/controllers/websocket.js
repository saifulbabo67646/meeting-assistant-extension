// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import expressWs from 'express-ws';
import app from '../index';
import WebSocket from 'ws';
import os from 'os';
import path from 'path';
// import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import BlockStream from 'block-stream2';
import fs from 'fs';
import { spawn } from 'child_process';

import { randomUUID } from 'crypto';

import { createWavHeader } from '../utils/wav';
import { posixifyFilename, normalizeErrorForLogging } from '../utils/common';
import { getClientIP } from '../utils/headers';
import { getTempPath } from '../utils/path-helper';
import { getWhisperPath } from '../utils/path-helper';
import { getWhisperExecutablePath } from '../whisper/install-whisper-cpp.js';
import { getModelPath } from '../whisper/download-whisper-model.js';
// Import the transcribe function from the whisper module
import { transcribe, convertToCaptions } from '../whisper';

import logger from '../utils/logger'; 

const AWS_REGION = process.env['AWS_REGION'] || 'us-east-1';
const RECORDINGS_BUCKET_NAME = process.env['RECORDINGS_BUCKET_NAME'] || undefined;
const RECORDING_FILE_PREFIX = process.env['RECORDING_FILE_PREFIX'] || 'lma-audio-recordings/';
const CPU_HEALTH_THRESHOLD = parseInt(process.env['CPU_HEALTH_THRESHOLD'] || '50', 10);
const LOCAL_TEMP_DIR = getTempPath();
const WS_LOG_LEVEL = process.env['WS_LOG_LEVEL'] || 'debug';
const WS_LOG_INTERVAL = parseInt(process.env['WS_LOG_INTERVAL'] || '120', 10);
const SHOULD_RECORD_CALL = true//(process.env['SHOULD_RECORD_CALL'] || '') === 'true';

// const s3Client = new S3Client({ region: AWS_REGION });

const socketMap = new Map();

// Create a mini express app for the websocket routes
const router = express.Router();


// Middleware to authenticate requests
// router.use((req, res, next) => {
//     if (!req.url.includes('health')) {
//         const clientIP = getClientIP(req.headers);
//         logger.debug(
//             `[AUTH]: [${clientIP}] - Received middleware for authentication. URI: <${req.url}>, Headers: ${JSON.stringify(req.headers)}`
//         );
        
//         // Setup auth as a middleware instead of a hook
//         // jwtVerifier(req, res, next);
//     } else {
//         next();
//     }
// });

// Health check stats
const healthCheckStats = new Map();

// Health check route
router.get('/health/check', (req, res) => {
    const now = Date.now();
    const cpuUsage = (os.loadavg()[0] / os.cpus().length) * 100;
    const isHealthy = cpuUsage > CPU_HEALTH_THRESHOLD ? false : true;
    const status = isHealthy ? 200 : 503;

    const remoteIp = req.socket.remoteAddress || 'unknown';
    const item = healthCheckStats.get(remoteIp);
    if (!item) {
        logger.debug(
            `[HEALTH CHECK]: [${remoteIp}] - Received First health check from load balancer. URI: <${req.url}>, Headers: ${JSON.stringify(req.headers)} ==> Health Check status - CPU Usage%: ${cpuUsage}, IsHealthy: ${isHealthy}, Status: ${status}`
        );
        healthCheckStats.set(remoteIp, {
            addr: remoteIp,
            tsFirst: now,
            tsLast: now,
            count: 1,
        });
    } else {
        item.tsLast = now;
        ++item.count;
        const elapsed_seconds = Math.round((item.tsLast - item.tsFirst) / 1000);
        if (elapsed_seconds % WS_LOG_INTERVAL === 0) {
            logger.debug(
                `[HEALTH CHECK]: [${remoteIp}] - Received Health check # ${item.count} from load balancer. URI: <${req.url}>, Headers: ${JSON.stringify(req.headers)} ==> Health Check status - CPU Usage%: ${cpuUsage}, IsHealthy: ${isHealthy}, Status: ${status}`
            );
        }
    }

    res.status(status)
        .header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate, proxy-revalidate')
        .send({ 'Http-Status': status, Healthy: isHealthy });
});

// Real-time transcription with Whisper
const startWhisperTranscribe = async (socketCallMap, logger) => {
    const callMetaData = socketCallMap.callMetadata;
    const audioInputStream = socketCallMap.audioInputStream;
    
    logger.info(`[WHISPER]: [${callMetaData.callId}] - Starting Whisper transcription`);
    
    if (!audioInputStream) {
        logger.error(`[WHISPER]: [${callMetaData.callId}] - audioInputStream undefined`);
        return;
    }
    
    // Buffer to collect audio chunks for processing
    let audioBuffer = Buffer.alloc(0);
    const CHUNK_SIZE_MS = 3000; // Process in 3-second chunks
    const BYTES_PER_SAMPLE = 2; // 16-bit audio
    const CHUNK_SIZE_BYTES = (callMetaData.samplingRate * CHUNK_SIZE_MS / 1000) * BYTES_PER_SAMPLE;
    
    // Track current segment for speaker diarization
    let segmentCounter = 0;
    let isProcessing = false;
    let chunkStartTime = Date.now() / 1000; // Start time in seconds
    
    // Process incoming audio data
    audioInputStream.on('data', async (chunk) => {
        logger.debug(`[WHISPER]: [${callMetaData.callId}] - Received audio chunk of size ${chunk.length} bytes`);
        
        // Add chunk to buffer
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
        
        // Process when we have enough audio and not already processing
        if (audioBuffer.length >= CHUNK_SIZE_BYTES && !isProcessing) {
            isProcessing = true;
            
            // Extract chunk for processing
            const audioChunk = audioBuffer.slice(0, CHUNK_SIZE_BYTES);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE_BYTES);
            
            // Calculate timestamps
            const chunkDurationSec = CHUNK_SIZE_MS / 1000;
            const chunkEndTime = chunkStartTime + chunkDurationSec;
            
            try {
                // Process the audio chunk using the transcribe function
                await processAudioChunkWithTranscribe(
                    audioChunk,
                    chunkStartTime,
                    chunkEndTime,
                    callMetaData,
                    segmentCounter,
                    logger
                );
                
                // Update for next chunk
                chunkStartTime = chunkEndTime;
                segmentCounter++;
            } catch (error) {
                logger.error(`[WHISPER]: [${callMetaData.callId}] - Error processing audio chunk: ${error.message}`);
            } finally {
                isProcessing = false;
            }
        }
    });
    
    // Handle end of stream
    audioInputStream.on('end', async () => {
        logger.info(`[WHISPER]: [${callMetaData.callId}] - Audio stream ended`);
        
        // Process any remaining audio
        if (audioBuffer.length > 0 && !isProcessing) {
            isProcessing = true;
            try {
                const chunkEndTime = chunkStartTime + (audioBuffer.length / (callMetaData.samplingRate * BYTES_PER_SAMPLE));
                await processAudioChunkWithTranscribe(
                    audioBuffer,
                    chunkStartTime,
                    chunkEndTime,
                    callMetaData,
                    segmentCounter,
                    logger
                );
            } catch (error) {
                logger.error(`[WHISPER]: [${callMetaData.callId}] - Error processing final audio chunk: ${error.message}`);
            }
        }
    });
};

// Process a chunk of audio with the transcribe function
async function processAudioChunkWithTranscribe(audioChunk, startTime, endTime, callMetaData, segmentCounter, logger) {
    const callId = callMetaData.callId;
    const tempDir = getTempPath();
    const tempWavFile = path.join(tempDir, `${callId}_chunk_${Date.now()}.wav`);
    
    try {
        // Create WAV file from audio chunk
        // Note: Whisper requires 16 kHz audio, but our input is 8 kHz
        // We need to create a WAV header with 16 kHz sample rate
        const originalSampleRate = callMetaData.samplingRate; // 8000
        const targetSampleRate = 16000; // Whisper requires 16 kHz

        // Resample audio from 8 kHz to 16 kHz using linear interpolation
        const resampledAudio = resampleAudio(audioChunk, originalSampleRate, targetSampleRate);
        logger.debug(`[WHISPER]: [${callId}] - Resampled audio from ${originalSampleRate} Hz to ${targetSampleRate} Hz (original size: ${audioChunk.length}, new size: ${resampledAudio.length})`);
        
        // For now, we'll just create a WAV with the correct header but same audio data
        // This won't actually resample the audio, but it will make Whisper process it
        const wavHeader = createWavHeader(targetSampleRate, resampledAudio.length);
        const wavFile = fs.createWriteStream(tempWavFile);
        wavFile.write(wavHeader);
        wavFile.write(resampledAudio);
        await new Promise(resolve => wavFile.end(resolve));
        
        logger.debug(`[WHISPER]: [${callId}] - Created WAV file with sample rate ${targetSampleRate} Hz`);
        
        // Get whisper path
        const whisperPath = getWhisperPath();
        
        // Use the transcribe function that's working in the /whisper/transcribe endpoint
        const result = await transcribe({
            inputPath: tempWavFile,
            whisperPath,
            model: 'base',
            tokenLevelTimestamps: false,
            printOutput: false
        });
        
        // Process transcription results
        if (result && result.transcription) {
            // Convert to captions for easier processing
            const { captions } = convertToCaptions({
                combineTokensWithinMilliseconds: 200,
                transcription: result.transcription,
            });
            
            logger.debug(`[WHISPER]: [${callId}] - Transcription result: ${JSON.stringify(captions)}`);
            
            if (captions && captions.length > 0) {
                // Determine speaker - for simplicity, we'll alternate between caller and agent
                const channelId = segmentCounter % 2 === 0 ? 'ch_0' : 'ch_1';
                const speakerName = channelId === 'ch_0' 
                    ? callMetaData.activeSpeaker 
                    : callMetaData.agentId ?? 'n/a';
                
                for (const caption of captions) {
                    // Check if we have valid timestamps, if not use defaults
                    // Whisper sometimes returns -0.01 for startInSeconds when it can't determine timestamps
                    const hasValidTimestamps = caption.startInSeconds && caption.startInSeconds > 0;
                    
                    // Adjust segment times to be relative to the call start
                    const absoluteStartTime = hasValidTimestamps
                        ? startTime + (caption.startInSeconds)
                        : startTime; // Default to chunk start time if no valid timestamp
                    
                    // For end time, either use the caption end time or estimate based on text length
                    // Estimate about 0.3 seconds per word
                    const wordCount = Math.max(1, caption.text.split(' ').length);
                    const estimatedDuration = wordCount * 0.3;
                    const absoluteEndTime = hasValidTimestamps
                        ? startTime + (caption.startInSeconds + estimatedDuration)
                        : startTime + estimatedDuration; // Default to estimated duration after start if no valid timestamp
                    
                    // Create a unique segment ID with valid timestamps
                    const segmentId = `${speakerName}-${absoluteStartTime.toFixed(2)}-${channelId}`;
                    
                    // Send the transcription segment
                    await writeTranscriptionSegment(
                        segmentId,
                        channelId,
                        speakerName,
                        absoluteStartTime,
                        absoluteEndTime,
                        caption.text,
                        false, // isPartial
                        callMetaData,
                        logger
                    );
                }
            }
        }
    } catch (error) {
        logger.error(`[WHISPER]: [${callId}] - Error in processAudioChunkWithTranscribe: ${error.message}`);
        throw error;
    } finally {
        // Clean up temporary files
        try {
            if (fs.existsSync(tempWavFile)) {
                fs.unlinkSync(tempWavFile);
            }
        } catch (error) {
            logger.error(`[WHISPER]: [${callId}] - Error cleaning up temp files: ${error.message}`);
        }
    }
}

// Function to resample audio using linear interpolation
function resampleAudio(audioBuffer, fromSampleRate, toSampleRate) {
    // For 8-bit audio (1 byte per sample)
    const bytesPerSample = 2; // 16-bit audio (2 bytes per sample)
    
    // Calculate the number of samples in the input buffer
    const inputSamples = audioBuffer.length / bytesPerSample;
    
    // Calculate the number of samples in the output buffer
    const outputSamples = Math.ceil(inputSamples * toSampleRate / fromSampleRate);
    
    // Create output buffer
    const outputBuffer = Buffer.alloc(outputSamples * bytesPerSample);
    
    // Create DataViews for reading/writing samples
    const inputView = new DataView(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength);
    const outputView = new DataView(outputBuffer.buffer, outputBuffer.byteOffset, outputBuffer.byteLength);
    
    // Resample using linear interpolation
    for (let i = 0; i < outputSamples; i++) {
        // Calculate the position in the input buffer
        const inputPos = i * fromSampleRate / toSampleRate;
        
        // Get the two closest input samples
        const inputIndex = Math.floor(inputPos);
        const fraction = inputPos - inputIndex;
        
        // Get the values of the two closest input samples
        let value1 = 0;
        let value2 = 0;
        
        if (inputIndex < inputSamples) {
            value1 = inputView.getInt16(inputIndex * bytesPerSample, true);
        }
        
        if (inputIndex + 1 < inputSamples) {
            value2 = inputView.getInt16((inputIndex + 1) * bytesPerSample, true);
        }
        
        // Interpolate between the two values
        const outputValue = Math.round(value1 * (1 - fraction) + value2 * fraction);
        
        // Write the interpolated value to the output buffer
        outputView.setInt16(i * bytesPerSample, outputValue, true);
    }
    
    return outputBuffer;
}
// Real-time transcription with Whisper
// const startWhisperTranscribe = async (socketCallMap, logger) => {
//     const callMetaData = socketCallMap.callMetadata;
//     const audioInputStream = socketCallMap.audioInputStream;
    
//     logger.info(`[WHISPER]: [${callMetaData.callId}] - Starting Whisper transcription`);
    
//     if (!audioInputStream) {
//         logger.error(`[WHISPER]: [${callMetaData.callId}] - audioInputStream undefined`);
//         return;
//     }
    
//     // Buffer to collect audio chunks for processing
//     let audioBuffer = Buffer.alloc(0);
//     const CHUNK_SIZE_MS = 3000; // Process in 3-second chunks
//     const BYTES_PER_SAMPLE = 2; // 16-bit audio
//     const CHUNK_SIZE_BYTES = (callMetaData.samplingRate * CHUNK_SIZE_MS / 1000) * BYTES_PER_SAMPLE;
    
//     // Initialize speaker tracking
//     if (!callMetaData.channels) {
//         callMetaData.channels = {};
//     }
    
//     // Initialize channels for caller and agent
//     ['ch_0', 'ch_1'].forEach(channelId => {
//         if (!callMetaData.channels[channelId]) {
//             callMetaData.channels[channelId] = {
//                 currentSpeakerName: null,
//                 speakers: [],
//                 startTimes: [],
//             };
//         }
//     });
    
//     // Track current segment for speaker diarization
//     let segmentCounter = 0;
//     let isProcessing = false;
//     let chunkStartTime = Date.now() / 1000; // Start time in seconds
    
//     // Process incoming audio data
//     audioInputStream.on('data', async (chunk) => {
//         logger.debug(`[WHISPER]: [${callMetaData.callId}] - Received audio chunk of size ${chunk.length} bytes`);
        
//         // Add chunk to buffer
//         audioBuffer = Buffer.concat([audioBuffer, chunk]);
        
//         // Process when we have enough audio and not already processing
//         if (audioBuffer.length >= CHUNK_SIZE_BYTES && !isProcessing) {
//             isProcessing = true;
            
//             // Extract chunk for processing
//             const audioChunk = audioBuffer.slice(0, CHUNK_SIZE_BYTES);
//             audioBuffer = audioBuffer.slice(CHUNK_SIZE_BYTES);
            
//             // Calculate timestamps
//             const chunkDurationSec = CHUNK_SIZE_MS / 1000;
//             const chunkEndTime = chunkStartTime + chunkDurationSec;
            
//             try {
//                 await processAudioChunk(
//                     audioChunk,
//                     chunkStartTime,
//                     chunkEndTime,
//                     callMetaData,
//                     segmentCounter,
//                     logger
//                 );
                
//                 // Update for next chunk
//                 chunkStartTime = chunkEndTime;
//                 segmentCounter++;
//             } catch (error) {
//                 logger.error(`[WHISPER]: [${callMetaData.callId}] - Error processing audio chunk: ${error.message}`);
//             } finally {
//                 isProcessing = false;
//             }
//         }
//     });
    
//     // Handle end of stream
//     audioInputStream.on('end', async () => {
//         logger.info(`[WHISPER]: [${callMetaData.callId}] - Audio stream ended`);
        
//         // Process any remaining audio
//         if (audioBuffer.length > 0 && !isProcessing) {
//             isProcessing = true;
//             try {
//                 const chunkEndTime = chunkStartTime + (audioBuffer.length / (callMetaData.samplingRate * BYTES_PER_SAMPLE));
//                 await processAudioChunk(
//                     audioBuffer,
//                     chunkStartTime,
//                     chunkEndTime,
//                     callMetaData,
//                     segmentCounter,
//                     logger
//                 );
//             } catch (error) {
//                 logger.error(`[WHISPER]: [${callMetaData.callId}] - Error processing final audio chunk: ${error.message}`);
//             }
//         }
//     });
// };

// async function processAudioChunk(audioChunk, startTime, endTime, callMetaData, segmentCounter, logger) {
//     const callId = callMetaData.callId;
//     const tempDir = getTempPath();
//     const tempWavFile = path.join(tempDir, `${callId}_chunk_${Date.now()}.wav`);
//     const tempJsonFile = `${tempWavFile}.json`;
    
//     try {
//         // Create WAV file from audio chunk
//         const wavHeader = createWavHeader(audioChunk.length, callMetaData.samplingRate);
//         const wavFile = fs.createWriteStream(tempWavFile);
//         wavFile.write(wavHeader);
//         wavFile.write(audioChunk);
//         await new Promise(resolve => wavFile.end(resolve));
        
//         // Get whisper path and executable
//         const whisperPath = getWhisperPath();
//         // Use the 'main' executable directly since we know it exists
//         const executable = path.join(whisperPath, 'main');
//         const modelName = 'base';
//         const modelPath = path.join(whisperPath, 'ggml-base.bin');
        
//         logger.debug(`[WHISPER]: [${callId}] - Using executable: ${executable}`);
//         logger.debug(`[WHISPER]: [${callId}] - Using model: ${modelPath}`);
        
//         // Run Whisper on the WAV file
//         const result = await new Promise((resolve, reject) => {
//             const args = [
//                 '-f', tempWavFile,
//                 '-ojson', tempJsonFile,
//                 '-m', modelPath,
//                 '-l', 'en'
//             ];
            
//             logger.debug(`[WHISPER]: [${callId}] - Running command: ${executable} ${args.join(' ')}`);
            
//             const whisperProcess = spawn(executable, args, {
//                 cwd: whisperPath // Set the current working directory
//             });
            
//             let stdoutData = '';
//             let stderrData = '';
            
//             whisperProcess.stdout.on('data', (data) => {
//                 const output = data.toString();
//                 stdoutData += output;
//                 logger.debug(`[WHISPER]: [${callId}] - stdout: ${output}`);
//             });
            
//             whisperProcess.stderr.on('data', (data) => {
//                 const output = data.toString();
//                 stderrData += output;
//                 logger.debug(`[WHISPER]: [${callId}] - stderr: ${output}`);
//             });
            
//             whisperProcess.on('close', (code) => {
//                 // Check if the JSON file exists, as whisper sometimes exits with code 0 even on failure
//                 if (fs.existsSync(tempJsonFile)) {
//                     try {
//                         const jsonData = fs.readFileSync(tempJsonFile, 'utf8');
//                         const result = JSON.parse(jsonData);
//                         resolve(result);
//                     } catch (error) {
//                         logger.error(`[WHISPER]: [${callId}] - Error parsing Whisper output: ${error.message}`);
//                         reject(error);
//                     }
//                 } else {
//                     logger.error(`[WHISPER]: [${callId}] - JSON output file not found: ${tempJsonFile}`);
//                     logger.error(`[WHISPER]: [${callId}] - stdout: ${stdoutData}`);
//                     logger.error(`[WHISPER]: [${callId}] - stderr: ${stderrData}`);
//                     reject(new Error(`No transcription was created (process exited with code ${code})`));
//                 }
//             });
            
//             whisperProcess.on('error', (error) => {
//                 logger.error(`[WHISPER]: [${callId}] - Error spawning Whisper process: ${error.message}`);
//                 reject(error);
//             });
//         });
        
//         // Process transcription results
//         if (result && result.segments && result.segments.length > 0) {
//             for (const segment of result.segments) {
//                 // Determine speaker - for simplicity, we'll alternate between caller and agent
//                 // In a real implementation, you might want to use a more sophisticated speaker diarization
//                 const channelId = segmentCounter % 2 === 0 ? 'ch_0' : 'ch_1';
//                 const speakerName = channelId === 'ch_0' 
//                     ? callMetaData.activeSpeaker 
//                     : callMetaData.agentId ?? 'n/a';
                
//                 // Adjust segment times to be relative to the call start
//                 const absoluteStartTime = startTime + segment.start;
//                 const absoluteEndTime = startTime + segment.end;
                
//                 // Create a unique segment ID
//                 const segmentId = `${speakerName}-${absoluteStartTime}-${channelId}`;
                
//                 // Send the transcription segment
//                 await writeTranscriptionSegment(
//                     segmentId,
//                     channelId,
//                     speakerName,
//                     absoluteStartTime,
//                     absoluteEndTime,
//                     segment.text,
//                     false, // isPartial
//                     callMetaData,
//                     logger
//                 );
//             }
//         }
//     } catch (error) {
//         logger.error(`[WHISPER]: [${callId}] - Error in processAudioChunk: ${error.message}`);
//         throw error;
//     } finally {
//         // Clean up temporary files
//         try {
//             if (fs.existsSync(tempWavFile)) {
//                 fs.unlinkSync(tempWavFile);
//             }
//             if (fs.existsSync(tempJsonFile)) {
//                 fs.unlinkSync(tempJsonFile);
//             }
//         } catch (error) {
//             logger.error(`[WHISPER]: [${callId}] - Error cleaning up temp files: ${error.message}`);
//         }
//     }
// }

// Write transcription segment to the client
async function writeTranscriptionSegment(
    segmentId,
    channelId,
    speakerName,
    startTime,
    endTime,
    transcript,
    isPartial,
    callMetadata,
    logger
) {
    const now = new Date().toISOString();
    
    // Create segment event to send to client
    const segmentEvent = {
        type: 'TRANSCRIPT_SEGMENT',
        segmentId,
        channelId,
        speakerName,
        startTime,
        endTime,
        transcript,
        isPartial,
        timestamp: now
    };
    
    // Log the segment
    logger.debug(
        `[WHISPER]: [${callMetadata.callId}] - Transcript segment: ${JSON.stringify(segmentEvent)}`
    );
    
    // Create the AddTranscriptSegmentEvent
    const transcriptSegmentEvent = {
        EventType: 'ADD_TRANSCRIPT_SEGMENT',
        CallId: callMetadata.callId,
        Channel: channelId === 'ch_0' ? 'CALLER' : 'AGENT',
        SegmentId: segmentId,
        StartTime: startTime,
        EndTime: endTime,
        Transcript: transcript,
        IsPartial: isPartial,
        CreatedAt: now,
        UpdatedAt: now,
        Sentiment: undefined,
        TranscriptEvent: undefined,
        UtteranceEvent: undefined,
        Speaker: speakerName,
        AccessToken: callMetadata.accessToken,
        IdToken: callMetadata.idToken,
        RefreshToken: callMetadata.refreshToken,
    };
    
    // In the original implementation, this would be sent to Kinesis
    // For now, we'll just log it
    logger.debug(
        `[${transcriptSegmentEvent.EventType}]: [${callMetadata.callId}] - Generated ${transcriptSegmentEvent.EventType} event: ${JSON.stringify(transcriptSegmentEvent)}`
    );
}

// WebSocket handlers
const registerHandlers = (clientIP, ws, req) => {
    ws.on('message', async (data) => {
        try {
            // Check if the message is binary
            const isBinary = data instanceof Buffer;

            if (isBinary) {
                const audioinput = data;
                await onBinaryMessage(clientIP, ws, audioinput);
            } else {
                // Convert to string if it's not already
                const textData = data instanceof Buffer ? data.toString('utf8') : data;
                logger.debug(`[WEBSOCKET]: [${clientIP}] - Received text message: ${textData}`);
                await onTextMessage(clientIP, ws, textData, req);
            }
        } catch (error) {
            logger.error(`[ON MESSAGE]: [${clientIP}] - Error processing message: ${normalizeErrorForLogging(error)}`);
            process.exit(1);
        }
    });

    ws.on('close', (code) => {
        logger.debug(`[ON WSCLOSE]: [${clientIP}] Received Websocket close message from the client. Closing the connection.`);

        try {
            onWsClose(ws, code);
        } catch (err) {
            logger.error(`[ON WSCLOSE]: [${clientIP}] Error in WS close handler: ${normalizeErrorForLogging(err)}`);
        }
    });

    ws.on('error', (error) => {
        logger.error(`[ON WSERROR]: [${clientIP}] - Websocket error, forcing close: ${normalizeErrorForLogging(error)}`);
        ws.close();
    });
};

const onBinaryMessage = async (clientIP, ws, data) => {
    const socketData = socketMap.get(ws);

    if (
        socketData !== undefined &&
        socketData.audioInputStream !== undefined &&
        socketData.writeRecordingStream !== undefined &&
        socketData.recordingFileSize !== undefined
    ) {
        socketData.audioInputStream.write(data);
        socketData.writeRecordingStream.write(data);
        socketData.recordingFileSize += data.length;
    } else {
        logger.error(`[ON BINARY MESSAGE]: [${clientIP}] - Error: received audio data before metadata. Check logs for errors in START event.`);
    }
};

const onTextMessage = async (clientIP, ws, data, req) => {
    const query = req.query;
    const headers = req.headers;
    const auth = query.authorization || headers.authorization;
    const idToken = query.id_token || headers.id_token;
    const refreshToken = query.refresh_token || headers.refresh_token;

    const match = auth?.match(/^Bearer (.+)$/);
    const callMetaData = JSON.parse(data);
    
    if (!match) {
        logger.error(`[AUTH]: [${clientIP}] - No Bearer token found in header or query string. URI: <${req.url}>, Headers: ${JSON.stringify(req.headers)}`);
        return;
    }

    const accessToken = match[1];

    try {
        logger.debug(`[ON TEXT MESSAGE]: [${clientIP}][${callMetaData.callId}] - Call Metadata received from client: ${data}`);
    } catch (error) {
        logger.error(`[ON TEXT MESSAGE]: [${clientIP}][${callMetaData.callId}] - Error parsing call metadata: ${data} ${normalizeErrorForLogging(error)}`);
        callMetaData.callId = randomUUID();
    }

    callMetaData.accessToken = accessToken;
    callMetaData.idToken = idToken;
    callMetaData.refreshToken = refreshToken;

    if (callMetaData.callEvent === 'START') {
        // generate random metadata if none is provided
        callMetaData.callId = callMetaData.callId || randomUUID();
        callMetaData.fromNumber = callMetaData.fromNumber || 'Customer Phone';
        callMetaData.toNumber = callMetaData.toNumber || 'System Phone';
        callMetaData.activeSpeaker = callMetaData.activeSpeaker ?? callMetaData?.fromNumber ?? 'unknown';
        callMetaData.agentId = callMetaData.agentId || randomUUID();
        callMetaData.shouldRecordCall = SHOULD_RECORD_CALL;

        // @TODO: start call event here
        const tempRecordingFilename = getTempRecordingFileName(callMetaData);
        const writeRecordingStream = fs.createWriteStream(path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
        const recordingFileSize = 0;

        const highWaterMarkSize = (callMetaData.samplingRate / 10) * 2 * 2;
        const audioInputStream = new BlockStream({ size: highWaterMarkSize });
        const socketCallMap = {
            // copy (not reference) callMetaData into socketCallMap
            callMetadata: Object.assign({}, callMetaData),
            audioInputStream: audioInputStream,
            writeRecordingStream: writeRecordingStream,
            recordingFileSize: recordingFileSize,
            startStreamTime: new Date(),
            speakerEvents: [],
            ended: false,
        };
        socketMap.set(ws, socketCallMap);
        // @TODO: start transcribe here
        startWhisperTranscribe(socketCallMap, logger);

    } else if (callMetaData.callEvent === 'SPEAKER_CHANGE') {
        const socketData = socketMap.get(ws);
        logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Received speaker change. Active speaker = ${callMetaData.activeSpeaker}`);

        if (socketData && socketData.callMetadata) {
            // We already know speaker name for the microphone channel (ch_1) - represented in callMetaData.agentId.
            // We should only use SPEAKER_CHANGE to track who is speaking on the incoming meeting channel (ch_0)
            // If the speaker is the same as the agentId, then we should ignore the event.
            const mic_channel_speaker = callMetaData.agentId;
            const activeSpeaker = callMetaData.activeSpeaker;
            if (activeSpeaker !== mic_channel_speaker) {
                logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - active speaker '${activeSpeaker}' assigned to meeting channel (ch_0) as name does not match mic channel (ch_1) speaker '${mic_channel_speaker}'`);
                // set active speaker in the socketData structure being used by startTranscribe results loop.
                socketData.callMetadata.activeSpeaker = callMetaData.activeSpeaker;
            } else {
                logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - active speaker '${activeSpeaker}' not assigned to meeting channel (ch_0) as name matches mic channel (ch_1) speaker '${mic_channel_speaker}'`);
            }
        } else {
            // this is not a valid call metadata
            logger.error(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Invalid call metadata: ${JSON.stringify(callMetaData)}`);
        }
    } else if (callMetaData.callEvent === 'END') {
        const socketData = socketMap.get(ws);
        if (!socketData || !socketData.callMetadata) {
            logger.error(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Received END without starting a call: ${JSON.stringify(callMetaData)}`);
            return;
        }
        logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Received call end event from client, writing it to KDS: ${JSON.stringify(callMetaData)}`);

        if (typeof callMetaData.shouldRecordCall === 'undefined' || callMetaData.shouldRecordCall === null) {
            logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Client did not provide ShouldRecordCall in CallMetaData. Defaulting to CFN parameter EnableAudioRecording = ${SHOULD_RECORD_CALL}`);
            callMetaData.shouldRecordCall = SHOULD_RECORD_CALL;
        } else {
            logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Using client provided ShouldRecordCall parameter in CallMetaData = ${callMetaData.shouldRecordCall}`);
        }
        await endCall(ws, socketData, callMetaData);
    }
};

const onWsClose = async (ws, code) => {
    ws.close(code);
    const socketData = socketMap.get(ws);
    if (socketData) {
        logger.debug(`[ON WSCLOSE]: [${socketData.callMetadata.callId}] - Writing call end event due to websocket close event ${JSON.stringify(socketData.callMetadata)}`);
        await endCall(ws, socketData);
    }
};

const endCall = async (ws, socketData, callMetaData) => {
    if (callMetaData === undefined) {
        callMetaData = socketData.callMetadata;
    }

    if (socketData !== undefined && socketData.ended === false) {
        socketData.ended = true;

        if (callMetaData !== undefined && callMetaData != null) {
            // @TODO: write end call event here
            if (socketData.writeRecordingStream && socketData.recordingFileSize) {
                socketData.writeRecordingStream.end();

                if (callMetaData.shouldRecordCall) {
                    logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Audio Recording enabled. Writing to S3.: ${JSON.stringify(callMetaData)}`);
                    const header = createWavHeader(callMetaData.samplingRate, socketData.recordingFileSize);
                    const tempRecordingFilename = getTempRecordingFileName(callMetaData);
                    const wavRecordingFilename = getWavRecordingFileName(callMetaData);
                    const readStream = fs.createReadStream(path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
                    const writeStream = fs.createWriteStream(path.join(LOCAL_TEMP_DIR, wavRecordingFilename));
                    writeStream.write(header);
                    for await (const chunk of readStream) {
                        writeStream.write(chunk);
                    }
                    writeStream.end();

                    await writeToS3(callMetaData, tempRecordingFilename);
                    await writeToS3(callMetaData, wavRecordingFilename);
                    await deleteTempFile(callMetaData, path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
                    await deleteTempFile(callMetaData, path.join(LOCAL_TEMP_DIR, wavRecordingFilename));

                    const url = new URL(
                        RECORDING_FILE_PREFIX + wavRecordingFilename,
                        `https://${RECORDINGS_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com`
                    );
                    const recordingUrl = url.href;
                    // @TODO: write call recording event here
                } else {
                    logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Audio Recording disabled. Add s3 url event is not written to KDS. : ${JSON.stringify(callMetaData)}`);
                }
            }

            if (socketData.audioInputStream) {
                logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Closing audio input stream: ${JSON.stringify(callMetaData)}`);
                socketData.audioInputStream.end();
                socketData.audioInputStream.destroy();
            }
            if (socketData) {
                logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Deleting websocket from map: ${JSON.stringify(callMetaData)}`);
                socketMap.delete(ws);
            }
        } else {
            logger.error('[END]: Missing Call Meta Data in END event');
        }
    } else {
        if (callMetaData !== undefined && callMetaData != null) {
            logger.error(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Duplicate End call event. Already received the end call event: ${JSON.stringify(callMetaData)}`);
        } else {
            logger.error('[END]: Duplicate End call event. Missing Call Meta Data in END event');
        }
    }
};

const writeToS3 = async (callMetaData, tempFileName) => {
    const sourceFile = path.join(LOCAL_TEMP_DIR, tempFileName);

    let data;
    const fileStream = fs.createReadStream(sourceFile);
    const uploadParams = {
        Bucket: RECORDINGS_BUCKET_NAME,
        Key: RECORDING_FILE_PREFIX + tempFileName,
        Body: fileStream,
    };
    try {
        // data = await s3Client.send(new PutObjectCommand(uploadParams));
        logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Uploaded ${sourceFile} to S3 complete: ${JSON.stringify(data)}`);
    } catch (err) {
        logger.error(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Error uploading ${sourceFile} to S3: ${normalizeErrorForLogging(err)}`);
    } finally {
        fileStream.destroy();
    }
    return data;
};

const getTempRecordingFileName = (callMetaData) => {
    return `${posixifyFilename(callMetaData.callId)}.raw`;
};

const getWavRecordingFileName = (callMetaData) => {
    return `${posixifyFilename(callMetaData.callId)}.wav`;
};

const deleteTempFile = async (callMetaData, sourceFile) => {
    try {
        await fs.promises.unlink(sourceFile);
        logger.debug(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Deleted tmp file ${sourceFile}`);
    } catch (err) {
        logger.error(`[${callMetaData.callEvent}]: [${callMetaData.callId}] - Error deleting tmp file ${sourceFile} : ${normalizeErrorForLogging(err)}`);
    }
};

// Function to setup WebSocket on the main app
export const setupWebSocket = (app) => {
    // Apply expressWs to the main app
    expressWs(app);
    
    // Add WebSocket route to the main app
    app.ws('/api/v1/ws', (ws, req) => {
        const clientIP = getClientIP(req.headers);
        logger.debug(
            `[NEW CONNECTION]: [${clientIP}] - Received new connection request @ /api/v1/ws. URI: <${req.url}>, Headers: ${JSON.stringify(req.headers)}`
        );

        registerHandlers(clientIP, ws, req);
    });
    
    return app;
};

// Export the router instead of starting the server
export default router;
