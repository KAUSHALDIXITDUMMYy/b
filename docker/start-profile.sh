#!/bin/bash

# Start profile container
echo "🚀 Starting Fliff Profile Container"
echo "Profile: ${PROFILE_NAME:-unknown}"
echo "VNC Port: 5900"
echo "noVNC Port: 6080"

# Create directories if needed
mkdir -p /app/profile/browser_data

# Start supervisor
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf




