#!/bin/bash
# HMS Command Center startup script
# Usage: ./start.sh

cd "$(dirname "$0")"

# Kill any existing processes on port 3000
echo "Checking for existing server..."
fuser -k 3000/tcp 2>/dev/null || true
sleep 2

# Start the server
echo "Starting HMS Command Center server..."
nohup node server.js > server.log 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for server to be ready
sleep 3
if curl -s http://localhost:3000/api/summary > /dev/null; then
    echo "Server is running on http://localhost:3000"
else
    echo "Server failed to start. Check server.log"
    exit 1
fi

# Start tunnel
echo "Starting tunnel..."
lt --port 3000 &
TUNNEL_PID=$!
echo "Tunnel PID: $TUNNEL_PID"

echo ""
echo "HMS Command Center is starting..."
echo "Local: http://localhost:3000"
echo "Wait 10 seconds for tunnel URL, then check:"
echo "  tail -f tunnel.log"
echo ""
echo "To stop: kill $SERVER_PID $TUNNEL_PID"
