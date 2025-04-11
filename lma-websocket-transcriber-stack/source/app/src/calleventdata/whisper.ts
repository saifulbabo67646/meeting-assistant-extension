// Whisper-based transcription implementation
import { FastifyInstance } from 'fastify';
import stream from 'stream';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { SocketCallData, AddTranscriptSegmentEvent } from './eventtypes';
import { normalizeErrorForLogging } from '../utils';

// Interface for Whisper transcription result
interface WhisperTranscriptionResult {
  text: string;
  segments: WhisperSegment[];
}

interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
  speaker?: string;
}

// Configuration for Whisper
const WHISPER_MODEL = process.env['WHISPER_MODEL'] || 'base';
const WHISPER_LANGUAGE = process.env['WHISPER_LANGUAGE'] || 'en';
const WHISPER_TASK = process.env['WHISPER_TASK'] || 'transcribe';
const WHISPER_CHUNK_SIZE = parseInt(process.env['WHISPER_CHUNK_SIZE'] || '4000', 10); // in milliseconds
const WHISPER_BINARY_PATH = process.env['WHISPER_BINARY_PATH'] || 'whisper';
const LOCAL_TEMP_DIR = process.env['LOCAL_TEMP_DIR'] || '/tmp/';

// Function to start Whisper transcription
export const startWhisperTranscribe = async (
  socketCallMap: SocketCallData,
  server: FastifyInstance
) => {
  const callMetaData = socketCallMap.callMetadata;
  const audioInputStream = socketCallMap.audioInputStream;
  let currentAudioChunk: Buffer[] = [];
  let currentChunkDuration = 0;
  let chunkStartTime = Date.now() / 1000; // Start time in seconds
  let isProcessing = false;
  let isFirstChunk = true;
  let segmentCounter = 0;
  
  server.log.info(
    `[WHISPER]: [${callMetaData.callId}] - Starting Whisper transcription with model ${WHISPER_MODEL}`
  );

  if (!audioInputStream) {
    server.log.error(
      `[WHISPER]: [${callMetaData.callId}] - audioInputStream undefined`
    );
    return;
  }

  // Initialize channel data if it doesn't exist
  if (!callMetaData.channels) {
    callMetaData.channels = {};
  }

  // Initialize channels for caller and agent
  ['ch_0', 'ch_1'].forEach(channelId => {
    if (!callMetaData.channels[channelId]) {
      callMetaData.channels[channelId] = {
        currentSpeakerName: null,
        speakers: [],
        startTimes: [],
      };
    }
  });

  // Process audio chunks
  audioInputStream.on('data', async (chunk: Buffer) => {
    // Calculate chunk duration based on audio format (16-bit PCM, 2 bytes per sample)
    const chunkDurationMs = (chunk.length / 2) / (callMetaData.samplingRate / 1000);
    currentAudioChunk.push(chunk);
    currentChunkDuration += chunkDurationMs;

    // Process when we have enough audio data and not already processing
    if (currentChunkDuration >= WHISPER_CHUNK_SIZE && !isProcessing) {
      isProcessing = true;
      const audioToProcess = Buffer.concat(currentAudioChunk);
      const chunkEndTime = chunkStartTime + (currentChunkDuration / 1000);
      
      // Reset for next chunk
      currentAudioChunk = [];
      const processingStartTime = chunkStartTime;
      chunkStartTime = chunkEndTime;
      currentChunkDuration = 0;

      try {
        await processAudioChunk(
          audioToProcess, 
          processingStartTime, 
          chunkEndTime,
          callMetaData.samplingRate,
          isFirstChunk,
          socketCallMap,
          server
        );
        isFirstChunk = false;
      } catch (error) {
        server.log.error(
          `[WHISPER]: [${callMetaData.callId}] - Error processing audio chunk: ${normalizeErrorForLogging(error)}`
        );
      } finally {
        isProcessing = false;
      }
    }
  });

  // Handle end of stream
  audioInputStream.on('end', async () => {
    server.log.info(
      `[WHISPER]: [${callMetaData.callId}] - Audio stream ended`
    );
    
    // Process any remaining audio
    if (currentAudioChunk.length > 0 && !isProcessing) {
      isProcessing = true;
      const audioToProcess = Buffer.concat(currentAudioChunk);
      const chunkEndTime = chunkStartTime + (currentChunkDuration / 1000);
      
      try {
        await processAudioChunk(
          audioToProcess, 
          chunkStartTime, 
          chunkEndTime,
          callMetaData.samplingRate,
          isFirstChunk,
          socketCallMap,
          server
        );
      } catch (error) {
        server.log.error(
          `[WHISPER]: [${callMetaData.callId}] - Error processing final audio chunk: ${normalizeErrorForLogging(error)}`
        );
      }
    }
  });

  // Process a chunk of audio with Whisper
  async function processAudioChunk(
    audioChunk: Buffer,
    startTime: number,
    endTime: number,
    sampleRate: number,
    isFirstChunk: boolean,
    socketCallMap: SocketCallData,
    server: FastifyInstance
  ) {
    const callId = socketCallMap.callMetadata.callId;
    const tempWavFile = path.join(LOCAL_TEMP_DIR, `${callId}_chunk_${Date.now()}.wav`);
    const tempJsonFile = path.join(LOCAL_TEMP_DIR, `${callId}_chunk_${Date.now()}.json`);
    
    try {
      // Create WAV file from audio chunk
      await createWavFile(audioChunk, tempWavFile, sampleRate);
      
      // Run Whisper on the WAV file
      const transcriptionResult = await runWhisperOnFile(tempWavFile, tempJsonFile, server, callId);
      
      if (!transcriptionResult || !transcriptionResult.segments || transcriptionResult.segments.length === 0) {
        server.log.debug(`[WHISPER]: [${callId}] - No transcription results for chunk`);
        return;
      }
      
      // Process each segment
      for (const segment of transcriptionResult.segments) {
        segmentCounter++;
        
        // Determine speaker - for simplicity, we'll alternate between caller and agent
        // In a real implementation, you might want to use a more sophisticated speaker diarization
        const channelId = segmentCounter % 2 === 0 ? 'ch_1' : 'ch_0';
        const speakerName = channelId === 'ch_0' 
          ? socketCallMap.callMetadata.activeSpeaker 
          : socketCallMap.callMetadata.agentId ?? 'n/a';
        
        // Adjust segment times to be relative to the call start
        const absoluteStartTime = startTime + segment.start;
        const absoluteEndTime = startTime + segment.end;
        
        // Create a unique segment ID
        const segmentId = `${speakerName}-${absoluteStartTime}-${channelId}`;
        
        // Send the transcription segment
        await writeTranscriptionSegment(
          segmentId,
          channelId,
          speakerName,
          absoluteStartTime,
          absoluteEndTime,
          segment.text,
          false, // isPartial
          socketCallMap.callMetadata,
          server
        );
      }
    } catch (error) {
      server.log.error(
        `[WHISPER]: [${callId}] - Error in processAudioChunk: ${normalizeErrorForLogging(error)}`
      );
    } finally {
      // Clean up temporary files
      try {
        if (fs.existsSync(tempWavFile)) {
          fs.unlinkSync(tempWavFile);
        }
        if (fs.existsSync(tempJsonFile)) {
          fs.unlinkSync(tempJsonFile);
        }
      } catch (error) {
        server.log.error(
          `[WHISPER]: [${callId}] - Error cleaning up temp files: ${normalizeErrorForLogging(error)}`
        );
      }
    }
  }
};

// Create a WAV file from raw PCM audio
async function createWavFile(audioChunk: Buffer, outputPath: string, sampleRate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      // WAV header for 16-bit PCM, mono
      const header = Buffer.alloc(44);
      
      // RIFF chunk descriptor
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + audioChunk.length, 4); // Chunk size
      header.write('WAVE', 8);
      
      // FMT sub-chunk
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16); // Subchunk1 size
      header.writeUInt16LE(1, 20); // Audio format (PCM)
      header.writeUInt16LE(1, 22); // Num channels (mono)
      header.writeUInt32LE(sampleRate, 24); // Sample rate
      header.writeUInt32LE(sampleRate * 2, 28); // Byte rate
      header.writeUInt16LE(2, 32); // Block align
      header.writeUInt16LE(16, 34); // Bits per sample
      
      // Data sub-chunk
      header.write('data', 36);
      header.writeUInt32LE(audioChunk.length, 40); // Subchunk2 size
      
      // Write header and audio data to file
      const writeStream = fs.createWriteStream(outputPath);
      writeStream.write(header);
      writeStream.write(audioChunk);
      writeStream.end();
      
      writeStream.on('finish', () => {
        resolve();
      });
      
      writeStream.on('error', (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Run Whisper on a WAV file
async function runWhisperOnFile(
  inputFile: string, 
  outputJsonFile: string,
  server: FastifyInstance,
  callId: string
): Promise<WhisperTranscriptionResult> {
  return new Promise((resolve, reject) => {
    try {
      // Command to run Whisper CLI with appropriate options
      const whisperArgs = [
        inputFile,
        '--model', WHISPER_MODEL,
        '--language', WHISPER_LANGUAGE,
        '--task', WHISPER_TASK,
        '--output_format', 'json',
        '--output_dir', path.dirname(outputJsonFile),
        '--verbose', 'False'
      ];
      
      server.log.debug(`[WHISPER]: [${callId}] - Running command: ${WHISPER_BINARY_PATH} ${whisperArgs.join(' ')}`);
      
      const whisperProcess = spawn(WHISPER_BINARY_PATH, whisperArgs);
      let stdoutData = '';
      let stderrData = '';
      
      whisperProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });
      
      whisperProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
      });
      
      whisperProcess.on('close', (code) => {
        if (code !== 0) {
          server.log.error(`[WHISPER]: [${callId}] - Whisper process exited with code ${code}`);
          server.log.error(`[WHISPER]: [${callId}] - stderr: ${stderrData}`);
          reject(new Error(`Whisper process exited with code ${code}: ${stderrData}`));
          return;
        }
        
        try {
          // Whisper CLI saves the output to a JSON file with the same name as the input
          const jsonFileName = path.basename(inputFile, path.extname(inputFile)) + '.json';
          const jsonFilePath = path.join(path.dirname(outputJsonFile), jsonFileName);
          
          if (fs.existsSync(jsonFilePath)) {
            const jsonData = fs.readFileSync(jsonFilePath, 'utf8');
            const result = JSON.parse(jsonData) as WhisperTranscriptionResult;
            resolve(result);
          } else {
            server.log.error(`[WHISPER]: [${callId}] - JSON output file not found: ${jsonFilePath}`);
            reject(new Error('Whisper output file not found'));
          }
        } catch (error) {
          server.log.error(`[WHISPER]: [${callId}] - Error parsing Whisper output: ${normalizeErrorForLogging(error)}`);
          reject(error);
        }
      });
      
      whisperProcess.on('error', (error) => {
        server.log.error(`[WHISPER]: [${callId}] - Error spawning Whisper process: ${normalizeErrorForLogging(error)}`);
        reject(error);
      });
    } catch (error) {
      server.log.error(`[WHISPER]: [${callId}] - Error in runWhisperOnFile: ${normalizeErrorForLogging(error)}`);
      reject(error);
    }
  });
}

// Write transcription segment to the client
export const writeTranscriptionSegment = async function (
  segmentId: string,
  channelId: string,
  speakerName: string,
  startTime: number,
  endTime: number,
  transcript: string,
  isPartial: boolean,
  callMetadata: any,
  server: FastifyInstance
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
  
  // Send the segment to the client via WebSocket
  server.log.debug(
    `[WHISPER]: [${callMetadata.callId}] - Sending transcript segment: ${JSON.stringify(segmentEvent)}`
  );
  
  // In a real implementation, you would send this to the WebSocket client
  // For now, we'll just log it
  
  // Also create the AddTranscriptSegmentEvent for compatibility with existing code
  const kdsObject: AddTranscriptSegmentEvent = {
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
  // Since we're not using Kinesis, we'll just log it
  server.log.debug(
    `[WHISPER]: [${callMetadata.callId}] - Generated transcript segment event: ${JSON.stringify(kdsObject)}`
  );
  
  // You can implement WebSocket sending logic here
  // Example: ws.send(JSON.stringify(segmentEvent));
};
