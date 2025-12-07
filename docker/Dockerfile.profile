# Fliff Bot Individual Profile Container
# Lightweight container for a single browser profile with VNC

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1

# Install minimal dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    xvfb \
    x11vnc \
    fluxbox \
    supervisor \
    novnc \
    websockify \
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

WORKDIR /app

# Copy only the necessary backend files
COPY backend/fliff.js ./backend/
COPY backend/package*.json ./backend/

# Install dependencies
RUN cd backend && npm install puppeteer-core

# VNC password
RUN mkdir -p /root/.vnc && \
    x11vnc -storepasswd fliff123 /root/.vnc/passwd

# Copy supervisor config for profile container
COPY docker/supervisord-profile.conf /etc/supervisor/conf.d/supervisord.conf

# Profile directory mount point
RUN mkdir -p /app/profile

# Expose ports
EXPOSE 5900 6080

# Start script
COPY docker/start-profile.sh /start-profile.sh
RUN chmod +x /start-profile.sh

CMD ["/start-profile.sh"]



