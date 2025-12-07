# 🚀 Fliff Bot - Complete Linux Server Deployment Guide

This guide will walk you through deploying the Fliff Bot on a Linux server (Ubuntu 22.04 recommended).

## 📋 Table of Contents
1. [Server Requirements](#server-requirements)
2. [Initial Server Setup](#initial-server-setup)
3. [Install Dependencies](#install-dependencies)
4. [Deploy Application](#deploy-application)
5. [Configure Nginx Reverse Proxy](#configure-nginx-reverse-proxy)
6. [SSL Setup with Let's Encrypt](#ssl-setup-with-lets-encrypt)
7. [Systemd Service](#systemd-service)
8. [Firewall Configuration](#firewall-configuration)
9. [Running the Application](#running-the-application)
10. [Maintenance Commands](#maintenance-commands)

---

## 🖥️ Server Requirements

### Minimum Specs
- **CPU**: 2+ cores
- **RAM**: 4GB minimum (8GB recommended for multiple profiles)
- **Storage**: 20GB+ SSD
- **OS**: Ubuntu 22.04 LTS (recommended)
- **Network**: Open ports for HTTP/HTTPS

### Recommended VPS Providers
- DigitalOcean ($24/mo for 4GB RAM)
- Vultr ($20/mo for 4GB RAM)
- Linode ($24/mo for 4GB RAM)
- AWS EC2 (t3.medium)

---

## 🔧 Initial Server Setup

### 1. Connect to your server
```bash
ssh root@your-server-ip
```

### 2. Create a non-root user (recommended)
```bash
adduser fliffbot
usermod -aG sudo fliffbot
su - fliffbot
```

### 3. Update system
```bash
sudo apt update && sudo apt upgrade -y
```

---

## 📦 Install Dependencies

### Run the automated setup script:
```bash
# Download and run the setup script
curl -fsSL https://raw.githubusercontent.com/yourusername/fliff-bot/main/setup-server.sh | bash

# OR manually run these commands:
```

### Manual Installation:

#### 1. Install Node.js 20.x
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # Should show v20.x
```

#### 2. Install Docker
```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add user to docker group
sudo usermod -aG docker $USER

# Start Docker
sudo systemctl start docker
sudo systemctl enable docker

# Log out and back in for group changes
exit
ssh fliffbot@your-server-ip

# Verify
docker --version
docker-compose --version
```

#### 3. Install Docker Compose (if not included)
```bash
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
docker-compose --version
```

#### 4. Install Nginx (for reverse proxy)
```bash
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

#### 5. Install Certbot (for SSL)
```bash
sudo apt install -y certbot python3-certbot-nginx
```

#### 6. Install Chrome dependencies (for non-Docker setup)
```bash
sudo apt install -y \
    wget \
    gnupg \
    ca-certificates \
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
    xdg-utils
```

#### 7. Install Google Chrome
```bash
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google.list
sudo apt update
sudo apt install -y google-chrome-stable
```

---

## 📁 Deploy Application

### 1. Create app directory
```bash
sudo mkdir -p /opt/fliff-bot
sudo chown $USER:$USER /opt/fliff-bot
cd /opt/fliff-bot
```

### 2. Upload your files

**Option A: Using Git (recommended)**
```bash
git clone https://github.com/yourusername/fliff-bot.git .
```

**Option B: Using SCP from your local machine**
```bash
# Run this from your LOCAL machine (Windows PowerShell)
scp -r "C:\Users\kaush\Desktop\New folder (3)\Fliff Bot\*" fliffbot@your-server-ip:/opt/fliff-bot/
```

**Option C: Using SFTP**
- Use FileZilla or WinSCP
- Connect to your server
- Upload the entire `Fliff Bot` folder to `/opt/fliff-bot/`

### 3. Install Node.js dependencies
```bash
cd /opt/fliff-bot/backend
npm install

# Also install in root if package.json exists there
cd /opt/fliff-bot
npm install 2>/dev/null || true
```

### 4. Set permissions
```bash
chmod +x /opt/fliff-bot/start.sh 2>/dev/null || true
chmod -R 755 /opt/fliff-bot/profiles
```

---

## 🌐 Configure Nginx Reverse Proxy

### 1. Create Nginx config
```bash
sudo nano /etc/nginx/sites-available/fliff-bot
```

### 2. Paste this configuration:
```nginx
# Fliff Bot Nginx Configuration
upstream fliff_backend {
    server 127.0.0.1:3001;
}

server {
    listen 80;
    server_name your-domain.com;  # Replace with your domain or server IP

    # Redirect HTTP to HTTPS (uncomment after SSL setup)
    # return 301 https://$server_name$request_uri;

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

    # WebSocket support
    location /ws {
        proxy_pass http://fliff_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    # VNC WebSocket proxy (if using noVNC)
    location /vnc/ {
        proxy_pass http://127.0.0.1:6080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

### 3. Enable the site
```bash
sudo ln -s /etc/nginx/sites-available/fliff-bot /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default  # Remove default site
sudo nginx -t  # Test config
sudo systemctl reload nginx
```

---

## 🔒 SSL Setup with Let's Encrypt

### 1. Point your domain to your server IP
- Add an A record in your DNS settings pointing to your server IP

### 2. Get SSL certificate
```bash
sudo certbot --nginx -d your-domain.com
```

### 3. Auto-renewal is automatic, but test it:
```bash
sudo certbot renew --dry-run
```

---

## ⚙️ Systemd Service

### 1. Create service file
```bash
sudo nano /etc/systemd/system/fliff-bot.service
```

### 2. Paste this configuration:
```ini
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
```

### 3. Enable and start the service
```bash
sudo systemctl daemon-reload
sudo systemctl enable fliff-bot
sudo systemctl start fliff-bot
```

### 4. Check status
```bash
sudo systemctl status fliff-bot
```

---

## 🔥 Firewall Configuration

### Using UFW (Ubuntu Firewall)
```bash
# Enable UFW
sudo ufw enable

# Allow SSH (important - don't lock yourself out!)
sudo ufw allow ssh

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow app port (if not using nginx)
sudo ufw allow 3001/tcp

# For VNC access (optional - restrict to your IP for security)
sudo ufw allow from YOUR_IP to any port 5900:5999/tcp
sudo ufw allow from YOUR_IP to any port 6080:6090/tcp

# Check status
sudo ufw status
```

---

## 🚀 Running the Application

### Option 1: Using Systemd (Recommended for Production)
```bash
# Start
sudo systemctl start fliff-bot

# Stop
sudo systemctl stop fliff-bot

# Restart
sudo systemctl restart fliff-bot

# View logs
sudo journalctl -u fliff-bot -f
```

### Option 2: Using Docker
```bash
cd /opt/fliff-bot/docker

# Build images
docker build -t fliff-bot -f Dockerfile ..

# Start with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Option 3: Using PM2 (Process Manager)
```bash
# Install PM2
sudo npm install -g pm2

# Start app
cd /opt/fliff-bot/backend
pm2 start server.js --name "fliff-bot"

# Auto-start on reboot
pm2 startup
pm2 save

# View logs
pm2 logs fliff-bot

# Restart
pm2 restart fliff-bot
```

---

## 🛠️ Maintenance Commands

### View Application Logs
```bash
# Systemd logs
sudo journalctl -u fliff-bot -f --lines=100

# Docker logs
docker-compose logs -f

# PM2 logs
pm2 logs fliff-bot
```

### Update Application
```bash
# Stop service
sudo systemctl stop fliff-bot

# Pull updates (if using git)
cd /opt/fliff-bot
git pull

# Install dependencies
cd backend && npm install

# Restart
sudo systemctl start fliff-bot
```

### Backup Profiles
```bash
# Create backup
tar -czvf fliff-backup-$(date +%Y%m%d).tar.gz /opt/fliff-bot/profiles

# Restore backup
tar -xzvf fliff-backup-YYYYMMDD.tar.gz -C /
```

### Monitor Resources
```bash
# CPU/Memory usage
htop

# Disk usage
df -h

# Docker stats
docker stats
```

---

## 🌐 Access Points

After deployment, access your application at:

| Service | URL |
|---------|-----|
| Main Dashboard | `https://your-domain.com/` |
| Admin Panel | `https://your-domain.com/admin` |
| User Dashboard | `https://your-domain.com/user/USERNAME` |
| VNC Dashboard | `https://your-domain.com/vnc` |
| API | `https://your-domain.com/api/` |

---

## ⚠️ Security Checklist

- [ ] Changed default VNC password in Dockerfile
- [ ] Using HTTPS with valid SSL certificate
- [ ] Firewall enabled and configured
- [ ] Non-root user running the application
- [ ] Regular backups configured
- [ ] Fail2ban installed for brute-force protection
- [ ] Admin panel protected with strong password

### Install Fail2ban
```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

---

## 🆘 Troubleshooting

### App won't start
```bash
# Check logs
sudo journalctl -u fliff-bot -n 50

# Check if port is in use
sudo lsof -i :3001
```

### Chrome crashes
```bash
# Check Chrome dependencies
ldd $(which google-chrome) | grep "not found"

# Run with more memory
NODE_OPTIONS="--max-old-space-size=4096" node server.js
```

### Permission denied
```bash
sudo chown -R $USER:$USER /opt/fliff-bot
chmod -R 755 /opt/fliff-bot
```

### Docker issues
```bash
# Restart Docker
sudo systemctl restart docker

# Prune unused images
docker system prune -a
```

---

## 📞 Support

If you encounter issues:
1. Check the logs first
2. Verify all dependencies are installed
3. Ensure ports are not blocked by firewall
4. Check disk space and memory usage



