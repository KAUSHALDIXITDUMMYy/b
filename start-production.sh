#!/bin/bash

# =============================================
# Fliff Bot - Production Start Script
# Run after uploading files to start the app
# =============================================

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_DIR="/opt/fliff-bot"

echo -e "${BLUE}Starting Fliff Bot...${NC}"

# Check if we're in the right directory
if [ ! -f "$APP_DIR/backend/server.js" ]; then
    echo "Error: server.js not found. Make sure files are in $APP_DIR"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "$APP_DIR/backend/node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    cd $APP_DIR/backend
    npm install
fi

# Set permissions
chmod -R 755 $APP_DIR/profiles 2>/dev/null || true
chmod +x $APP_DIR/*.sh 2>/dev/null || true

# Choose start method
echo ""
echo "How do you want to run the application?"
echo "1) Systemd (recommended for production)"
echo "2) PM2 (process manager)"
echo "3) Docker"
echo "4) Direct (foreground - for testing)"
echo ""
read -p "Enter choice [1-4]: " choice

case $choice in
    1)
        echo -e "${GREEN}Starting with Systemd...${NC}"
        sudo systemctl daemon-reload
        sudo systemctl start fliff-bot
        sudo systemctl status fliff-bot
        echo ""
        echo "View logs with: sudo journalctl -u fliff-bot -f"
        ;;
    2)
        echo -e "${GREEN}Starting with PM2...${NC}"
        cd $APP_DIR/backend
        pm2 start server.js --name "fliff-bot"
        pm2 save
        pm2 startup
        pm2 status
        echo ""
        echo "View logs with: pm2 logs fliff-bot"
        ;;
    3)
        echo -e "${GREEN}Starting with Docker...${NC}"
        cd $APP_DIR/docker
        docker-compose up -d
        docker-compose ps
        echo ""
        echo "View logs with: docker-compose logs -f"
        ;;
    4)
        echo -e "${GREEN}Starting in foreground (Ctrl+C to stop)...${NC}"
        cd $APP_DIR/backend
        NODE_ENV=production node server.js
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}Application started!${NC}"
echo "Access at: http://$(hostname -I | awk '{print $1}'):3001"
