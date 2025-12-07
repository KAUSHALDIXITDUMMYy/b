# Fliff Bot Profile Container with VNC
# Based on Ubuntu with Chrome, VNC, and noVNC for remote viewing

FROM ubuntu:22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Set display for VNC
ENV DISPLAY=:1

# Install dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    xvfb \
    x11vnc \
    fluxbox \
    supervisor \
    net-tools \
    procps \
    novnc \
    websockify \
    python3 \
    python3-numpy \
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
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy application files
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create profile directory mount point
RUN mkdir -p /app/profiles

# VNC password (change in production!)
RUN mkdir -p /root/.vnc && \
    x11vnc -storepasswd fliff123 /root/.vnc/passwd

# Supervisor config for managing services
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Expose ports
# 5900 - VNC
# 6080 - noVNC web
# 3001 - Node.js app
EXPOSE 5900 6080 3001

# Start supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]

