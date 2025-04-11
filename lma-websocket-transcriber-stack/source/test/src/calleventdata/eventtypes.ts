// Event types for call data

import WebSocket from 'ws';

export type ChannelSpeakerData = {
    currentSpeakerName: string | null;
    speakers: string[];
    startTimes: number[];
};

export type CallMetaData = {
    callId: string,
    fromNumber?: string,
    toNumber?: string,
    shouldRecordCall?: boolean,
    agentId?: string,
    samplingRate: number,
    callEvent: string,
    activeSpeaker: string,
    channels: {
        [channelId: string]: ChannelSpeakerData;
    };
    accessToken?: string;
    idToken?: string;
    refreshToken?: string;
};

export type SocketCallData = {
    callMetadata: CallMetaData,
    audioInputStream?: any, // BlockStream
    writeRecordingStream?: any, // fs.WriteStream
    recordingFileSize?: number
    startStreamTime: Date,
    speakerEvents: any[],
    ended: boolean,
    // Add these new fields
    transcriptionWs?: WebSocket;  // For WebSocket approach
    audioBuffer?: Buffer;         // For HTTP approach
    lastTranscriptionTime?: number; // For HTTP approach
    transcriptionInterval?: NodeJS.Timeout; // For HTTP approach
    ws?: WebSocket; // Reference to the client WebSocket
}

export interface AddTranscriptSegmentEvent {
    EventType: string;
    CallId: string;
    Channel: string;
    SegmentId: string;
    StartTime: number;
    EndTime: number;
    Transcript: string;
    IsPartial: boolean;
    CreatedAt: string;
    UpdatedAt: string;
    Sentiment?: any;
    TranscriptEvent?: any;
    UtteranceEvent?: any;
    Speaker: string;
    AccessToken?: string;
    IdToken?: string;
    RefreshToken?: string;
}
