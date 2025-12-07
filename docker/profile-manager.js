/**
 * Docker Profile Manager
 * Manages Docker containers for Fliff browser profiles with VNC
 */

const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execAsync = util.promisify(exec);

class DockerProfileManager {
  constructor() {
    this.baseVncPort = 5900;
    this.baseNoVncPort = 6080;
    this.containers = new Map();
    this.dataPath = path.join(__dirname, '..', 'backend', 'data', 'docker-profiles.json');
  }

  // Load saved container mappings
  load() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
        this.containers = new Map(Object.entries(data.containers || {}));
        return data;
      }
    } catch (e) {
      console.error('Error loading docker profile data:', e.message);
    }
    return { containers: {} };
  }

  // Save container mappings
  save() {
    try {
      const data = {
        containers: Object.fromEntries(this.containers),
        lastUpdated: new Date().toISOString()
      };
      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('Error saving docker profile data:', e.message);
    }
  }

  // Get next available ports
  getNextPorts() {
    let maxVnc = this.baseVncPort;
    let maxNoVnc = this.baseNoVncPort;
    
    for (const [, container] of this.containers) {
      if (container.vncPort > maxVnc) maxVnc = container.vncPort;
      if (container.noVncPort > maxNoVnc) maxNoVnc = container.noVncPort;
    }
    
    return {
      vncPort: maxVnc + 1,
      noVncPort: maxNoVnc + 1
    };
  }

  // Generate container name from profile
  getContainerName(profileName) {
    return `fliff-profile-${profileName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  }

  // Check if Docker is available
  async checkDocker() {
    try {
      await execAsync('docker --version');
      return true;
    } catch (e) {
      return false;
    }
  }

  // Build the profile image
  async buildImage() {
    console.log('🔨 Building Docker image for profiles...');
    
    const dockerDir = path.join(__dirname);
    const contextDir = path.join(__dirname, '..');
    
    try {
      const { stdout, stderr } = await execAsync(
        `docker build -t fliff-profile -f "${path.join(dockerDir, 'Dockerfile.profile')}" "${contextDir}"`,
        { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer for build output
      );
      console.log('✅ Docker image built successfully');
      return { success: true };
    } catch (e) {
      console.error('❌ Failed to build Docker image:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Create and start a container for a profile
  async createContainer(profileName, profileDirectory) {
    const containerName = this.getContainerName(profileName);
    const ports = this.getNextPorts();
    
    console.log(`🚀 Creating container for profile: ${profileName}`);
    console.log(`   Container: ${containerName}`);
    console.log(`   VNC Port: ${ports.vncPort}`);
    console.log(`   noVNC Port: ${ports.noVncPort}`);
    
    const profilePath = path.resolve(path.join(__dirname, '..', profileDirectory));
    
    try {
      // Stop and remove existing container if any
      await this.stopContainer(profileName).catch(() => {});
      
      // Create new container
      const dockerCmd = [
        'docker', 'run', '-d',
        '--name', containerName,
        '-p', `${ports.vncPort}:5900`,
        '-p', `${ports.noVncPort}:6080`,
        '-v', `${profilePath}:/app/profile`,
        '-e', `PROFILE_NAME=${profileName}`,
        '--restart', 'unless-stopped',
        'fliff-profile'
      ].join(' ');
      
      const { stdout } = await execAsync(dockerCmd);
      const containerId = stdout.trim().slice(0, 12);
      
      // Save container info
      this.containers.set(profileName, {
        containerId,
        containerName,
        vncPort: ports.vncPort,
        noVncPort: ports.noVncPort,
        profileDirectory,
        createdAt: new Date().toISOString(),
        status: 'running'
      });
      
      this.save();
      
      console.log(`✅ Container ${containerName} started (${containerId})`);
      
      return {
        success: true,
        containerId,
        containerName,
        vncPort: ports.vncPort,
        noVncPort: ports.noVncPort,
        noVncUrl: `http://localhost:${ports.noVncPort}/vnc.html`
      };
    } catch (e) {
      console.error(`❌ Failed to create container for ${profileName}:`, e.message);
      return { success: false, error: e.message };
    }
  }

  // Stop a container
  async stopContainer(profileName) {
    const containerName = this.getContainerName(profileName);
    
    try {
      await execAsync(`docker stop ${containerName}`);
      await execAsync(`docker rm ${containerName}`);
      
      if (this.containers.has(profileName)) {
        const info = this.containers.get(profileName);
        info.status = 'stopped';
        this.save();
      }
      
      console.log(`🛑 Container ${containerName} stopped`);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Get container status
  async getContainerStatus(profileName) {
    const containerName = this.getContainerName(profileName);
    
    try {
      const { stdout } = await execAsync(`docker inspect --format='{{.State.Status}}' ${containerName}`);
      const status = stdout.trim();
      
      return {
        success: true,
        status,
        isRunning: status === 'running'
      };
    } catch (e) {
      return {
        success: false,
        status: 'not_found',
        isRunning: false
      };
    }
  }

  // Get all container statuses
  async getAllStatuses() {
    const statuses = [];
    
    for (const [profileName, info] of this.containers) {
      const status = await this.getContainerStatus(profileName);
      statuses.push({
        profileName,
        ...info,
        currentStatus: status.status,
        isRunning: status.isRunning
      });
    }
    
    return statuses;
  }

  // Get VNC info for a profile
  getVncInfo(profileName) {
    const info = this.containers.get(profileName);
    if (!info) return null;
    
    return {
      vncPort: info.vncPort,
      noVncPort: info.noVncPort,
      noVncUrl: `http://localhost:${info.noVncPort}/vnc.html`,
      vncUrl: `vnc://localhost:${info.vncPort}`
    };
  }

  // Generate docker-compose.yml with all profiles
  async generateComposeFile(profiles) {
    const composeContent = {
      version: '3.8',
      services: {},
      networks: {
        'fliff-network': {
          driver: 'bridge'
        }
      }
    };
    
    let portOffset = 0;
    
    for (const profile of profiles) {
      const serviceName = this.getContainerName(profile.name).replace(/^fliff-/, '');
      const vncPort = this.baseVncPort + portOffset + 1;
      const noVncPort = this.baseNoVncPort + portOffset + 1;
      
      composeContent.services[serviceName] = {
        build: {
          context: '..',
          dockerfile: 'docker/Dockerfile.profile'
        },
        container_name: this.getContainerName(profile.name),
        ports: [
          `${vncPort}:5900`,
          `${noVncPort}:6080`
        ],
        volumes: [
          `../${profile.directory}:/app/profile`
        ],
        environment: [
          `PROFILE_NAME=${profile.name}`
        ],
        restart: 'unless-stopped',
        networks: ['fliff-network']
      };
      
      portOffset++;
    }
    
    const yaml = this.toYaml(composeContent);
    const composePath = path.join(__dirname, 'docker-compose.generated.yml');
    fs.writeFileSync(composePath, yaml);
    
    console.log(`✅ Generated docker-compose.generated.yml with ${profiles.length} profiles`);
    return composePath;
  }

  // Simple YAML serializer
  toYaml(obj, indent = 0) {
    let result = '';
    const spaces = '  '.repeat(indent);
    
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        result += `${spaces}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object') {
            result += `${spaces}  -\n`;
            result += this.toYaml(item, indent + 2);
          } else {
            result += `${spaces}  - ${item}\n`;
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        result += `${spaces}${key}:\n`;
        result += this.toYaml(value, indent + 1);
      } else {
        result += `${spaces}${key}: ${value}\n`;
      }
    }
    
    return result;
  }

  // Start all containers using docker-compose
  async startAllWithCompose() {
    const composePath = path.join(__dirname, 'docker-compose.generated.yml');
    
    if (!fs.existsSync(composePath)) {
      return { success: false, error: 'No docker-compose.generated.yml found. Generate it first.' };
    }
    
    try {
      await execAsync(`docker-compose -f "${composePath}" up -d`);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Stop all containers
  async stopAll() {
    const results = [];
    
    for (const [profileName] of this.containers) {
      const result = await this.stopContainer(profileName);
      results.push({ profileName, ...result });
    }
    
    return results;
  }
}

module.exports = DockerProfileManager;

// CLI usage
if (require.main === module) {
  const manager = new DockerProfileManager();
  const args = process.argv.slice(2);
  const command = args[0];
  
  async function main() {
    manager.load();
    
    switch (command) {
      case 'build':
        await manager.buildImage();
        break;
        
      case 'create':
        if (args.length < 3) {
          console.log('Usage: node profile-manager.js create <profile-name> <profile-directory>');
          process.exit(1);
        }
        const result = await manager.createContainer(args[1], args[2]);
        console.log(result);
        break;
        
      case 'stop':
        if (args.length < 2) {
          console.log('Usage: node profile-manager.js stop <profile-name>');
          process.exit(1);
        }
        await manager.stopContainer(args[1]);
        break;
        
      case 'status':
        const statuses = await manager.getAllStatuses();
        console.table(statuses);
        break;
        
      case 'stop-all':
        await manager.stopAll();
        break;
        
      default:
        console.log('Commands: build, create, stop, status, stop-all');
    }
  }
  
  main().catch(console.error);
}

