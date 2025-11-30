#!/bin/bash

# =============================================
# FLIFF BOT STARTUP SCRIPT
# =============================================

echo "🚀 Starting Fliff Bot..."
echo ""

# Kill any existing processes
killall node 2>/dev/null
pkill -f "Google Chrome" 2>/dev/null
sleep 1

# Change to project directory
cd "$(dirname "$0")"

# Start backend
echo "📡 Starting Backend Server..."
cd backend
node server.js &
BACKEND_PID=$!
cd ..

# Wait for backend to start
sleep 3

# Open frontend
echo "🌐 Opening Frontend..."
open frontend/index.html

echo ""
echo "═════════════════════════════════════════════"
echo "✅ Fliff Bot Running!"
echo ""
echo "  Backend API:  http://localhost:3001/api"
echo "  Frontend:     frontend/index.html"
echo ""
echo "Press Ctrl+C to stop"
echo "═════════════════════════════════════════════"

# Wait for backend
wait $BACKEND_PID

