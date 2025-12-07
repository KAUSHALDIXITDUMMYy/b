# Docker + VNC Setup for Fliff Bot

This setup allows you to run Fliff browser profiles in Docker containers with VNC access for remote viewing.

## Prerequisites

1. **Docker Desktop** - Install from https://www.docker.com/products/docker-desktop
2. **Docker Compose** - Usually included with Docker Desktop

## Quick Start

### Option 1: Using Admin Dashboard (Recommended)

1. Start the server: `npm run dev`
2. Go to Admin Dashboard: `http://localhost:3001/admin`
3. Click "Profiles" tab
4. Use the Docker controls to:
   - Build the Docker image
   - Create containers for each profile
   - View noVNC links for remote access

### Option 2: Using Docker Compose

1. **Build the image:**
   ```bash
   cd docker
   docker build -t fliff-profile -f Dockerfile.profile ..
   ```

2. **Generate docker-compose file:**
   ```bash
   node profile-manager.js generate
   ```
   
   Or via API:
   ```bash
   curl -X POST http://localhost:3001/api/admin/docker/generate-compose
   ```

3. **Start all containers:**
   ```bash
   docker-compose -f docker-compose.generated.yml up -d
   ```

### Option 3: Manual Container Creation

```bash
# Build image
docker build -t fliff-profile -f docker/Dockerfile.profile .

# Create container for a profile
docker run -d \
  --name fliff-profile-john \
  -p 5901:5900 \
  -p 6081:6080 \
  -v ./profiles/john-account:/app/profile \
  -e PROFILE_NAME="John Account" \
  fliff-profile
```

## Accessing VNC

### Via Browser (noVNC)
- Each container exposes a noVNC web interface
- Access at: `http://localhost:<noVNC-port>/vnc.html`
- Default password: `fliff123`

Port assignments:
- First profile: `http://localhost:6081/vnc.html`
- Second profile: `http://localhost:6082/vnc.html`
- And so on...

### Via VNC Client
- Use any VNC client (RealVNC, TigerVNC, etc.)
- Connect to: `localhost:<VNC-port>`
- Default password: `fliff123`

Port assignments:
- First profile: `localhost:5901`
- Second profile: `localhost:5902`
- And so on...

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    FLIFF BOT SERVER                         │
│                    (localhost:3001)                         │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  Admin API      │  │  User API       │                  │
│  │  /api/admin/*   │  │  /api/user/*    │                  │
│  └─────────────────┘  └─────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Docker Container│ │ Docker Container│ │ Docker Container│
│ Profile: John   │ │ Profile: Sarah  │ │ Profile: Mike   │
│                 │ │                 │ │                 │
│ Chrome + VNC    │ │ Chrome + VNC    │ │ Chrome + VNC    │
│                 │ │                 │ │                 │
│ VNC:  5901      │ │ VNC:  5902      │ │ VNC:  5903      │
│ noVNC: 6081     │ │ noVNC: 6082     │ │ noVNC: 6083     │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

## API Endpoints

### Docker Management (Admin)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/docker/status` | GET | Check if Docker is available |
| `/api/admin/docker/build` | POST | Build Docker image |
| `/api/admin/docker/create-container` | POST | Create container for profile |
| `/api/admin/docker/stop-container` | POST | Stop a container |
| `/api/admin/docker/containers` | GET | List all containers |
| `/api/admin/docker/vnc/:profileName` | GET | Get VNC info for profile |
| `/api/admin/docker/generate-compose` | POST | Generate docker-compose file |
| `/api/admin/docker/start-all` | POST | Start all containers |
| `/api/admin/docker/stop-all` | POST | Stop all containers |

### User VNC Access

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/user/:username/docker-vnc` | GET | Get VNC info for user's profiles |

## Troubleshooting

### Container won't start
- Check Docker logs: `docker logs fliff-profile-<name>`
- Ensure ports aren't already in use
- Check Chrome logs: `docker exec fliff-profile-<name> cat /var/log/chrome-error.log`

### VNC not connecting
- Ensure container is running: `docker ps`
- Check VNC logs: `docker exec fliff-profile-<name> cat /var/log/supervisor/supervisord.log`
- Verify ports are mapped: `docker port fliff-profile-<name>`

### Profile data not persisting
- Check volume mount: `docker inspect fliff-profile-<name>`
- Ensure profile directory exists and has correct permissions

## Security Notes

⚠️ **For Production:**
- Change the default VNC password in Dockerfile
- Use a reverse proxy with authentication
- Restrict network access to VNC ports
- Consider using SSH tunnels for VNC access



