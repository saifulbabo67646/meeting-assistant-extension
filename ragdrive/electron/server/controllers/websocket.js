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
import { randomUUID } from 'crypto';

import { createWavHeader } from '../utils/wav';
import { posixifyFilename, normalizeErrorForLogging } from '../utils/common';
import { getClientIP } from '../utils/headers';
import { getTempPath } from '../utils/path-helper';

import logger from '../utils/logger'; 

const AWS_REGION = process.env['AWS_REGION'] || 'us-east-1';
const RECORDINGS_BUCKET_NAME = process.env['RECORDINGS_BUCKET_NAME'] || undefined;
const RECORDING_FILE_PREFIX = process.env['RECORDING_FILE_PREFIX'] || 'lma-audio-recordings/';
const CPU_HEALTH_THRESHOLD = parseInt(process.env['CPU_HEALTH_THRESHOLD'] || '50', 10);
const LOCAL_TEMP_DIR = getTempPath();
const WS_LOG_LEVEL = process.env['WS_LOG_LEVEL'] || 'debug';
const WS_LOG_INTERVAL = parseInt(process.env['WS_LOG_INTERVAL'] || '120', 10);
const SHOULD_RECORD_CALL = (process.env['SHOULD_RECORD_CALL'] || '') === 'true';

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