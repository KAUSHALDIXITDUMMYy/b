#!/bin/bash

# =============================================
# Fliff Bot - Linux Server Setup Script
# Run as: sudo bash setup-server.sh
# =============================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
APP_DIR="/opt/fliff-bot"
APP_USER="fliffbot"
NODE_VERSION="20"

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║          FLIFF BOT - SERVER SETUP SCRIPT                   ║"
echo "║                  Ubuntu 22.04 LTS                          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root (sudo bash setup-server.sh)${NC}"
    exit 1
fi

# Function to print step
step() {
    echo -e "\n${GREEN}[STEP]${NC} $1"
}

# Function to print info
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

# Function to print warning
warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# =============================================
# 1. Update System
# =============================================
step "Updating system packages..."
apt update && apt upgrade -y

# =============================================
# 2. Install Basic Dependencies
# =============================================
step "Installing basic dependencies..."
apt install -y \
    curl \
    wget \
    git \
    unzip \
    htop \
    nano \
    ufw \
    fail2ban \
    gnupg \
    ca-certificates \
    software-properties-common

# =============================================
# 3. Install Node.js
# =============================================
step "Installing Node.js ${NODE_VERSION}.x..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt install -y nodejs
fi
info "Node.js version: $(node --version)"
info "NPM version: $(npm --version)"

# =============================================
# 4. Install Docker
# =============================================
step "Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    systemctl start docker
    systemctl enable docker
fi
info "Docker version: $(docker --version)"

# Install Docker Compose
step "Installing Docker Compose..."
if ! command -v docker-compose &> /dev/null; then
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi
info "Docker Compose version: $(docker-compose --version)"

# =============================================
# 5. Install Chrome Dependencies
# =============================================
step "Installing Chrome dependencies..."
apt install -y \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    xvfb

# =============================================
# 6. Install Google Chrome
# =============================================
step "Installing Google Chrome..."
if ! command -v google-chrome &> /dev/null; then
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
    echo "deb http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list
    apt update
    apt install -y google-chrome-stable
fi
info "Chrome version: $(google-chrome --version)"

# =============================================
# 7. Install Nginx
# =============================================
step "Installing Nginx..."
apt install -y nginx
systemctl start nginx
systemctl enable nginx

# =============================================
# 8. Install Certbot for SSL
# =============================================
step "Installing Certbot..."
apt install -y certbot python3-certbot-nginx

# =============================================
# 9. Install PM2 (Process Manager)
# =============================================
step "Installing PM2..."
npm install -g pm2

# =============================================
# 10. Create Application User
# =============================================
step "Creating application user..."
if ! id "$APP_USER" &>/dev/null; then
    useradd -m -s /bin/bash $APP_USER
    usermod -aG docker $APP_USER
    info "User '$APP_USER' created and added to docker group"
else
    info "User '$APP_USER' already exists"
fi

# =============================================
# 11. Create Application Directory
# =============================================
step "Creating application directory..."
mkdir -p $APP_DIR
chown $APP_USER:$APP_USER $APP_DIR

# =============================================
# 12. Create Systemd Service
# =============================================
step "Creating systemd service..."
cat > /etc/systemd/system/fliff-bot.service << 'EOF'
[Unit]
Description=Fliff Bot Server
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=fliffbot
WorkingDirectory=/opt/fliff-bot/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=fliff-bot
Environment=NODE_ENV=production
Environment=PORT=3001

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

# =============================================
# 13. Configure Firewall
# =============================================
step "Configuring firewall..."
ufw --force enable
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3001/tcp
info "Firewall configured"

# =============================================
# 14. Configure Fail2ban
# =============================================
step "Configuring Fail2ban..."
systemctl enable fail2ban
systemctl start fail2ban

# =============================================
# 15. Create Nginx Config
# =============================================
step "Creating Nginx configuration..."
cat > /etc/nginx/sites-available/fliff-bot << 'EOF'
upstream fliff_backend {
    server 127.0.0.1:3001;
}

server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://fliff_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    location /ws {
        proxy_pass http://fliff_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
EOF

# Enable site
ln -sf /etc/nginx/sites-available/fliff-bot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# =============================================
# Summary
# =============================================
echo -e "\n${GREEN}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║              SETUP COMPLETE!                               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Next Steps:${NC}"
echo ""
echo "1. Upload your application files to: ${APP_DIR}"
echo "   From your Windows machine, run:"
echo "   scp -r \"C:\\path\\to\\Fliff Bot\\*\" ${APP_USER}@YOUR_SERVER_IP:${APP_DIR}/"
echo ""
echo "2. Install Node.js dependencies:"
echo "   cd ${APP_DIR}/backend && npm install"
echo ""
echo "3. Start the application:"
echo "   sudo systemctl start fliff-bot"
echo ""
echo "4. (Optional) Setup SSL with your domain:"
echo "   sudo certbot --nginx -d your-domain.com"
echo ""
echo "5. Access your application at:"
echo "   http://YOUR_SERVER_IP/"
echo ""
echo -e "${GREEN}Installed Components:${NC}"
echo "  ✓ Node.js $(node --version)"
echo "  ✓ Docker $(docker --version | cut -d' ' -f3)"
echo "  ✓ Docker Compose $(docker-compose --version | cut -d' ' -f4)"
echo "  ✓ Nginx"
echo "  ✓ Certbot"
echo "  ✓ PM2"
echo "  ✓ Google Chrome"
echo "  ✓ Firewall (UFW)"
echo "  ✓ Fail2ban"
echo ""
echo -e "${YELLOW}Security Notes:${NC}"
echo "  - Firewall is enabled (ports 22, 80, 443, 3001 open)"
echo "  - Fail2ban is protecting SSH"
echo "  - Remember to setup SSL for production!"
echo ""

