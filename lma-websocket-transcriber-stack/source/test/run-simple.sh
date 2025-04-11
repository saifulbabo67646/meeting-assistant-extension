#!/bin/bash
# Simple script to run the simplified websocket server

# Create temp directory if it doesn't exist
mkdir -p ./temp

# Set environment variables
export LOCAL_TEMP_DIR="./temp"
export SERVERPORT="8080"
export SERVERHOST="127.0.0.1"
export WS_LOG_LEVEL="info"

# Run the simplified server
echo "Starting simplified websocket server..."
npx ts-node src/index.ts
