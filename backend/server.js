const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const FliffClient = require('./fliff');
const UserManager = require('./userManager');
const DockerProfileManager = require('../docker/profile-manager');

// =============================================
// FLIFF BACKEND SERVER - MULTI-USER EDITION
// =============================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// =============================================
// SEPARATE LOGGING SERVER (Port 3002)
// =============================================
const LOGGING_PORT = 3002;
const loggingServer = http.createServer();
const loggingWss = new WebSocket.Server({ server: loggingServer });
const loggingClients = new Set();

// Logging function that routes to separate server
function logToSeparateServer(type, message, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    ...data
  };
  
  // Send to all connected logging clients
  const logString = JSON.stringify(logEntry);
  loggingClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(logString);
    }
  });
  
  // Also log to console with prefix (optional - can be disabled)
  // console.log(`[${type}] ${message}`);
}

// =============================================
// LOGGING SERVER WEBSOCKET CONNECTIONS
// =============================================
loggingWss.on('connection', (ws) => {
  loggingClients.add(ws);
  logToSeparateServer('SYSTEM', '📊 Logging client connected to port 3002');
  
  ws.on('close', () => {
    loggingClients.delete(ws);
  });
  
  ws.on('error', (error) => {
    // Silent error handling for logging server
  });
});

// Initialize User Manager
const userManager = new UserManager();

// Initialize Docker Profile Manager
const dockerManager = new DockerProfileManager();
dockerManager.load();

app.use(cors());
app.use(express.json());

// =============================================
// VNC DASHBOARD AND noVNC ROUTES
// =============================================

// Serve VNC dashboard route (before static files)
app.get('/vnc', (req, res) => {
  const vncPath = path.join(__dirname, '..', 'frontend', 'vnc-dashboard.html');
  if (fs.existsSync(vncPath)) {
    res.sendFile(vncPath);
  } else {
    res.status(404).send('VNC Dashboard not found');
  }
});

// Serve frontend index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Serve admin.html for /admin route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'admin.html'));
});

// =============================================
// USER DASHBOARD ROUTES (URL-based access)
// Access: /user/:username - No login required
// =============================================

// Serve user-specific dashboard
app.get('/user/:username', (req, res) => {
  const { username } = req.params;
  
  // Check if user exists and is active
  if (!userManager.userExists(username)) {
    return res.status(404).send(`
      <html>
        <head><title>User Not Found</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px; background: #1a1a2e; color: white;">
          <h1>❌ User Not Found</h1>
          <p>The user "${username}" does not exist.</p>
          <a href="/" style="color: #00d4ff;">Go to Home</a>
        </body>
      </html>
    `);
  }
  
  if (!userManager.isUserActive(username)) {
    return res.status(403).send(`
      <html>
        <head><title>Account Inactive</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px; background: #1a1a2e; color: white;">
          <h1>🔒 Account Inactive</h1>
          <p>This account is currently inactive.</p>
          <a href="/" style="color: #00d4ff;">Go to Home</a>
        </body>
      </html>
    `);
  }
  
  // Serve the user dashboard
  res.sendFile(path.join(__dirname, '..', 'frontend', 'user-dashboard.html'));
});

// User dashboard data endpoint
app.get('/api/user/:username/dashboard', (req, res) => {
  const { username } = req.params;
  
  if (!userManager.userExists(username) || !userManager.isUserActive(username)) {
    return res.status(404).json({ error: 'User not found or inactive' });
  }
  
  const dashboardData = userManager.getUserDashboardData(username);
  
  // Add running status for each profile
  const profilesWithStatus = dashboardData.profiles.map(profileName => {
    const client = fliffClients.get(profileName);
    return {
      name: profileName,
      isRunning: !!client,
      isMain: profileName === dashboardData.mainProfile
    };
  });
  
  res.json({
    ...dashboardData,
    profiles: profilesWithStatus
  });
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Serve noVNC files if they exist (for web-based VNC)
const novncPath = path.join(__dirname, '..', 'frontend', 'novnc');
if (fs.existsSync(novncPath)) {
  app.use('/novnc', express.static(novncPath));
  logSystem('✅ Serving noVNC files from /novnc');
  
  // Serve noVNC viewer page
  app.get('/novnc-viewer', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'novnc-viewer.html'));
  });
  
  // Also serve original noVNC pages
  // Serve from /novnc/ path so relative imports work correctly
  app.get('/vnc-lite', (req, res) => {
    res.redirect('/novnc/vnc_lite.html');
  });
  
  app.get('/vnc-full', (req, res) => {
    res.redirect('/novnc/vnc.html');
  });
  
  // Serve vnc_lite.html directly from novnc directory
  app.get('/novnc/vnc_lite.html', (req, res) => {
    res.sendFile(path.join(novncPath, 'vnc_lite.html'));
  });
  
  app.get('/novnc/vnc.html', (req, res) => {
    res.sendFile(path.join(novncPath, 'vnc.html'));
  });
}

// =============================================
// SEPARATE LOGGING
// =============================================

// logLive is now defined below with other logging functions

// logBetting is now defined below with other logging functions

// Data stores
const liveGames = new Map();
const gameOdds = new Map();
const clients = new Set();

// Betting logs
const betLogs = [];
const accountStats = {
  totalBets: 0,
  wins: 0,
  losses: 0,
  pending: 0,
  totalWagered: 0,
  totalWon: 0,
  prefireAttempts: 0,
  prefireSuccess: 0
};

let fliffClient = null; // Keep for backward compatibility (primary client)
let fliffClients = new Map(); // Map of profileName -> FliffClient for all profiles
let stats = { messages: 0, connected: false };

// =============================================
// MAIN PROFILE CONFIGURATION (Fliff Cluster V1 approach)
// The main profile is used for data scraping - it browses games
// and captures all market data via WebSocket
// =============================================
let mainProfile = 'Live Event'; // Default main profile for data scraping

// Priority game tracking - for faster updates when a game is selected
let priorityGameId = null;
let priorityGameUpdateInterval = null;

// =============================================
// PERFORMANCE OPTIMIZATION: Selected Game Only
// When a game is selected, ONLY process odds for that game
// This prevents lag when there are many live games
// =============================================
let selectedGameId = null; // The game user clicked on - ONLY this game gets odds processed

// =============================================
// LOG LEVEL CONTROLS - Separate odds/betting logging
// Set to false to disable verbose logging
// =============================================
const LOG_CONFIG = {
  ODDS_VERBOSE: false,      // Detailed odds verification logs (causes lag)
  ODDS_SUMMARY: true,       // Summary odds logs only
  BETTING: true,            // Betting action logs
  LIVE: true,               // Live game/score logs
  PERFORMANCE: true         // Performance warnings
};

// =============================================
// ADMIN API - USER MANAGEMENT
// =============================================

// Get all users (admin only)
app.get('/api/admin/users', (req, res) => {
  const users = userManager.getAllUsers();
  res.json(users);
});

// Create new user
app.post('/api/admin/users', (req, res) => {
  const { username, displayName, role } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  const result = userManager.createUser(username, displayName, role);
  
  if (result.success) {
    res.json(result.user);
  } else {
    res.status(400).json({ error: result.error });
  }
});

// =============================================
// ADMIN API - PROFILE CREATION
// =============================================

// Create new profile (similar to "with Auto bet" project)
app.post('/api/admin/create-profile', (req, res) => {
  const { name, proxy, latitude, longitude, accuracy, account_number, multiplier } = req.body;
  
  if (!name || name.trim() === '') {
    return res.status(400).json({ success: false, error: 'Profile name cannot be empty' });
  }
  
  try {
    // Slugify profile name for directory name (similar to Python slugify)
    const slugify = (text) => {
      return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start
        .replace(/-+$/, '');            // Trim - from end
    };
    
    const profileSlug = slugify(name);
    const profilesDir = path.join(__dirname, '..', 'profiles');
    const profilePath = path.join(profilesDir, profileSlug);
    
    // Check if profile already exists
    if (fs.existsSync(profilePath)) {
      return res.status(400).json({ 
        success: false, 
        error: `Profile "${name}" already exists` 
      });
    }
    
    // Create profile directory
    fs.mkdirSync(profilePath, { recursive: true });
    
    // Create browser_data directory (will be used by browser)
    const browserDataPath = path.join(profilePath, 'browser_data');
    fs.mkdirSync(browserDataPath, { recursive: true });
    
    // Create settings.json file
    const profileData = {
      name: name.trim(),
      proxy: proxy || '',
      latitude: parseFloat(latitude) || 0,
      longitude: parseFloat(longitude) || 0,
      accuracy: parseFloat(accuracy) || 100,
      account_number: account_number || '',
      multiplier: parseFloat(multiplier) || 1.0
    };
    
    const settingsPath = path.join(profilePath, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(profileData, null, 2), 'utf8');
    
    logSystem(`✅ Created new profile: ${name} (${profileSlug})`);
    
    res.json({ 
      success: true, 
      message: `Profile "${name}" created successfully`,
      profile: {
        name: profileData.name,
        slug: profileSlug,
        directory: `profiles/${profileSlug}`,
        ...profileData
      }
    });
  } catch (e) {
    logSystem(`❌ Error creating profile: ${e.message}`);
    return res.status(500).json({ 
      success: false, 
      error: `Failed to create profile: ${e.message}` 
    });
  }
});

// Update user
app.put('/api/admin/users/:username', (req, res) => {
  const { username } = req.params;
  const updates = req.body;
  
  const result = userManager.updateUser(username, updates);
  
  if (result.success) {
    res.json(result.user);
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Delete user
app.delete('/api/admin/users/:username', (req, res) => {
  const { username } = req.params;
  
  const result = userManager.deleteUser(username);
  
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// =============================================
// ADMIN API - PROFILE MANAGEMENT
// =============================================

// Get all profiles with assignment info
app.get('/api/admin/profiles', (req, res) => {
  // Sync running profiles first
  userManager.syncRunningProfiles(fliffClients);
  
  const profiles = userManager.getAllProfiles();
  
  // Add running status from fliffClients
  const profilesWithStatus = profiles.map(profile => ({
    ...profile,
    isRunning: fliffClients.has(profile.name),
    hasClient: !!fliffClients.get(profile.name)
  }));
  
  res.json(profilesWithStatus);
});

// Assign profile to user
app.post('/api/admin/assign-profile', (req, res) => {
  const { username, profileName } = req.body;
  
  if (!username || !profileName) {
    return res.status(400).json({ error: 'username and profileName are required' });
  }
  
  const result = userManager.assignProfile(username, profileName);
  
  if (result.success) {
    res.json({ success: true, user: userManager.getUser(username) });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Unassign profile from user
app.post('/api/admin/unassign-profile', (req, res) => {
  const { username, profileName } = req.body;
  
  if (!username || !profileName) {
    return res.status(400).json({ error: 'username and profileName are required' });
  }
  
  const result = userManager.unassignProfile(username, profileName);
  
  if (result.success) {
    res.json({ success: true, user: userManager.getUser(username) });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Set main profile for user
app.post('/api/admin/set-main-profile', (req, res) => {
  const { username, profileName } = req.body;
  
  if (!username || !profileName) {
    return res.status(400).json({ error: 'username and profileName are required' });
  }
  
  const result = userManager.setMainProfile(username, profileName);
  
  if (result.success) {
    res.json({ success: true, user: userManager.getUser(username) });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Bulk assign profiles to user
app.post('/api/admin/bulk-assign', (req, res) => {
  const { username, profileNames, mainProfile } = req.body;
  
  if (!username || !profileNames || !Array.isArray(profileNames)) {
    return res.status(400).json({ error: 'username and profileNames array are required' });
  }
  
  const result = userManager.assignMultipleProfiles(username, profileNames, mainProfile);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Get admin overview
app.get('/api/admin/overview', (req, res) => {
  // Sync profiles first
  userManager.syncRunningProfiles(fliffClients);
  
  const overview = userManager.getAdminOverview();
  
  // Add running status
  overview.runningProfiles = Array.from(fliffClients.keys());
  overview.totalRunning = fliffClients.size;
  
  res.json(overview);
});

// =============================================
// ADMIN API - PROFILE CONTROL (START/STOP)
// =============================================

// Get available (not running) profiles from filesystem
app.get('/api/admin/available-profiles', (req, res) => {
  try {
    const profilesPath = path.join(__dirname, '..', 'profiles');
    const directories = fs.readdirSync(profilesPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    const availableProfiles = [];
    
    for (const dir of directories) {
      const settingsPath = path.join(profilesPath, dir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          const isRunning = fliffClients.has(settings.name);
          availableProfiles.push({
            directory: dir,
            name: settings.name,
            isRunning,
            hasProxy: !!settings.proxy,
            isLiveEvent: settings.isLiveEvent || false
          });
        } catch (e) {
          console.error(`Error reading settings for ${dir}:`, e.message);
        }
      }
    }
    
    res.json(availableProfiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start a single profile
app.post('/api/admin/start-profile', async (req, res) => {
  const { profileDirectory } = req.body;
  
  if (!profileDirectory) {
    return res.status(400).json({ error: 'profileDirectory is required' });
  }
  
  try {
    const result = await startSingleProfile(profileDirectory);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stop a single profile
app.post('/api/admin/stop-profile', async (req, res) => {
  const { profileName } = req.body;
  
  if (!profileName) {
    return res.status(400).json({ error: 'profileName is required' });
  }
  
  try {
    const client = fliffClients.get(profileName);
    if (!client) {
      return res.status(404).json({ error: 'Profile not running' });
    }
    
    // Close browser
    if (client.browser) {
      await client.browser.close();
    }
    
    // Remove from clients map
    fliffClients.delete(profileName);
    
    // Update user manager
    userManager.updateProfileStatus(profileName, false);
    
    logSystem(`🛑 Profile ${profileName} stopped`);
    res.json({ success: true, message: `Profile ${profileName} stopped` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Start all profiles for a specific user
app.post('/api/admin/start-user-profiles', async (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }
  
  const user = userManager.getUser(username);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const assignedProfiles = user.assignedProfiles || [];
  const results = [];
  
  for (const profileName of assignedProfiles) {
    // Find profile directory from user manager data
    const profile = userManager.getProfile(profileName);
    if (!profile) continue;
    
    // Skip if already running
    if (fliffClients.has(profileName)) {
      results.push({ profile: profileName, success: true, status: 'already_running' });
      continue;
    }
    
    // Find the directory by searching profiles folder
    try {
      const profilesPath = path.join(__dirname, '..', 'profiles');
      const directories = fs.readdirSync(profilesPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      
      for (const dir of directories) {
        const settingsPath = path.join(profilesPath, dir, 'settings.json');
        if (fs.existsSync(settingsPath)) {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          if (settings.name === profileName) {
            const result = await startSingleProfile(dir);
            results.push({ profile: profileName, ...result });
            break;
          }
        }
      }
    } catch (e) {
      results.push({ profile: profileName, success: false, error: e.message });
    }
  }
  
  res.json({ 
    success: true, 
    results,
    startedCount: results.filter(r => r.success).length,
    totalCount: assignedProfiles.length
  });
});

// Start all profiles
app.post('/api/admin/start-all-profiles', async (req, res) => {
  try {
    const profilesPath = path.join(__dirname, '..', 'profiles');
    const directories = fs.readdirSync(profilesPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    const results = [];
    
    for (const dir of directories) {
      const settingsPath = path.join(profilesPath, dir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          
          // Skip if already running
          if (fliffClients.has(settings.name)) {
            results.push({ profile: settings.name, success: true, status: 'already_running' });
            continue;
          }
          
          const result = await startSingleProfile(dir);
          results.push({ profile: settings.name, ...result });
          
          // Add delay between starts
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
          results.push({ profile: dir, success: false, error: e.message });
        }
      }
    }
    
    res.json({
      success: true,
      results,
      startedCount: results.filter(r => r.success && r.status !== 'already_running').length,
      alreadyRunningCount: results.filter(r => r.status === 'already_running').length,
      totalCount: results.length
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stop all profiles
app.post('/api/admin/stop-all-profiles', async (req, res) => {
  const results = [];
  
  for (const [profileName, client] of fliffClients.entries()) {
    try {
      if (client.browser) {
        await client.browser.close();
      }
      fliffClients.delete(profileName);
      userManager.updateProfileStatus(profileName, false);
      results.push({ profile: profileName, success: true });
    } catch (e) {
      results.push({ profile: profileName, success: false, error: e.message });
    }
  }
  
  logSystem(`🛑 All profiles stopped`);
  res.json({
    success: true,
    results,
    stoppedCount: results.filter(r => r.success).length
  });
});

// Helper function to start a single profile
async function startSingleProfile(profileDirectory) {
  const profilesPath = path.join(__dirname, '..', 'profiles');
  const settingsPath = path.join(profilesPath, profileDirectory, 'settings.json');
  
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Settings not found for profile: ${profileDirectory}`);
  }
  
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  
  // Check if already running
  if (fliffClients.has(settings.name)) {
    return { success: true, status: 'already_running', message: `${settings.name} is already running` };
  }
  
  const isLiveEvent = settings.isLiveEvent || false;
  
  logSystem(`🚀 Starting profile: ${settings.name} (${isLiveEvent ? 'Live Event' : 'Betting'})...`);
  
  // Create FliffClient
  const client = new FliffClient({
    onGame: (game) => handleGameUpdate(game),
    onOdds: (gameId, odd) => handleOddsUpdate(gameId, odd),
    onStats: (newStats) => handleStats(newStats),
    onConnect: () => {
      stats.connected = true;
      broadcast({ type: 'connected', profile: settings.name });
    },
    onDisconnect: () => {
      broadcast({ type: 'disconnected', profile: settings.name });
    }
  }, profileDirectory);
  
  client.isLiveEventProfile = isLiveEvent;
  client.isBettingProfile = !isLiveEvent;
  client.settings = settings;
  client.loadAPICredentials();
  
  // Override start to use profile-specific browser data
  const originalStart = client.start;
  client.start = async function() {
    const browserDataPath = path.join(__dirname, '..', 'profiles', profileDirectory, 'browser_data');
    
    logSystem(`🎮 Starting Fliff Client for ${settings.name}...`);
    
    try {
      let chromePath;
      if (process.platform === 'win32') {
        const possiblePaths = [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
        ];
        chromePath = possiblePaths.find(p => p && fs.existsSync(p));
      } else if (process.platform === 'darwin') {
        chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      } else {
        chromePath = '/usr/bin/google-chrome';
      }
      
      if (!chromePath || !fs.existsSync(chromePath)) {
        throw new Error('Chrome not found');
      }
      
      const proxy = this.parseProxy(this.settings.proxy);
      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800'
      ];
      
      if (proxy) {
        launchArgs.push(`--proxy-server=${proxy.host}:${proxy.port}`);
      }
      
      this.browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false,
        defaultViewport: { width: 1280, height: 800 },
        args: launchArgs,
        userDataDir: browserDataPath
      });
      
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
      
      if (proxy && proxy.username && proxy.password) {
        await this.page.authenticate({ username: proxy.username, password: proxy.password });
      }
      
      await this.setupInterception();
      await this.page.goto('https://sports.getfliff.com', { waitUntil: 'networkidle2', timeout: 60000 });
      
    } catch (e) {
      console.error(`Error starting ${settings.name}:`, e.message);
      throw e;
    }
  };
  
  // Start the client
  await client.start();
  
  // Register with system
  fliffClients.set(settings.name, client);
  userManager.registerProfile(settings.name, {
    directory: `profiles/${profileDirectory}`,
    proxy: settings.proxy
  });
  
  if (!fliffClient) {
    fliffClient = client;
  }
  
  logSystem(`✅ Profile ${settings.name} started successfully`);
  
  return { success: true, message: `${settings.name} started successfully` };
}

// =============================================
// DOCKER CONTAINER MANAGEMENT API
// =============================================

// Check if Docker is available
app.get('/api/admin/docker/status', async (req, res) => {
  const available = await dockerManager.checkDocker();
  res.json({ 
    available,
    message: available ? 'Docker is available' : 'Docker is not installed or not running'
  });
});

// Build Docker image
app.post('/api/admin/docker/build', async (req, res) => {
  try {
    const result = await dockerManager.buildImage();
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Create Docker container for a profile
app.post('/api/admin/docker/create-container', async (req, res) => {
  const { profileName, profileDirectory } = req.body;
  
  if (!profileName || !profileDirectory) {
    return res.status(400).json({ error: 'profileName and profileDirectory are required' });
  }
  
  try {
    const result = await dockerManager.createContainer(profileName, profileDirectory);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stop Docker container
app.post('/api/admin/docker/stop-container', async (req, res) => {
  const { profileName } = req.body;
  
  if (!profileName) {
    return res.status(400).json({ error: 'profileName is required' });
  }
  
  try {
    const result = await dockerManager.stopContainer(profileName);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get all Docker container statuses
app.get('/api/admin/docker/containers', async (req, res) => {
  try {
    const statuses = await dockerManager.getAllStatuses();
    res.json(statuses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get VNC info for a profile
app.get('/api/admin/docker/vnc/:profileName', (req, res) => {
  const { profileName } = req.params;
  const info = dockerManager.getVncInfo(profileName);
  
  if (!info) {
    return res.status(404).json({ error: 'No Docker container found for this profile' });
  }
  
  res.json(info);
});

// Generate docker-compose file for all profiles
app.post('/api/admin/docker/generate-compose', async (req, res) => {
  try {
    const profilesPath = path.join(__dirname, '..', 'profiles');
    const directories = fs.readdirSync(profilesPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    const profiles = [];
    
    for (const dir of directories) {
      const settingsPath = path.join(profilesPath, dir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        profiles.push({
          name: settings.name,
          directory: `profiles/${dir}`
        });
      }
    }
    
    const composePath = await dockerManager.generateComposeFile(profiles);
    res.json({ success: true, path: composePath, profileCount: profiles.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Start all containers with docker-compose
app.post('/api/admin/docker/start-all', async (req, res) => {
  try {
    const result = await dockerManager.startAllWithCompose();
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stop all Docker containers
app.post('/api/admin/docker/stop-all', async (req, res) => {
  try {
    const results = await dockerManager.stopAll();
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get VNC info for user's profiles (Docker containers)
app.get('/api/user/:username/docker-vnc', (req, res) => {
  const { username } = req.params;
  
  if (!userManager.userExists(username)) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const profiles = userManager.getUserProfiles(username);
  const vncInfoList = [];
  
  for (const profileName of profiles) {
    const vncInfo = dockerManager.getVncInfo(profileName);
    vncInfoList.push({
      profileName,
      hasContainer: !!vncInfo,
      ...vncInfo
    });
  }
  
  res.json(vncInfoList);
});

// =============================================
// USER-SCOPED API ENDPOINTS
// These endpoints are scoped to a specific user
// =============================================

// Get user's profiles
app.get('/api/user/:username/profiles', (req, res) => {
  const { username } = req.params;
  
  if (!userManager.userExists(username)) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const profiles = userManager.getUserProfiles(username);
  const mainProfile = userManager.getUserMainProfile(username);
  
  const profilesWithStatus = profiles.map(name => ({
    name,
    isRunning: fliffClients.has(name),
    isMain: name === mainProfile
  }));
  
  res.json({
    profiles: profilesWithStatus,
    mainProfile
  });
});

// Get user's main profile
app.get('/api/user/:username/main-profile', (req, res) => {
  const { username } = req.params;
  
  if (!userManager.userExists(username)) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const mainProfile = userManager.getUserMainProfile(username);
  const client = mainProfile ? fliffClients.get(mainProfile) : null;
  
  res.json({
    mainProfile,
    isRunning: !!client
  });
});

// Navigate user's main profile to a game
app.post('/api/user/:username/navigate-to-game', async (req, res) => {
  const { username } = req.params;
  const { conflictFkey, gameId } = req.body;
  
  if (!userManager.userExists(username)) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const mainProfileName = userManager.getUserMainProfile(username);
  if (!mainProfileName) {
    return res.status(400).json({ error: 'No main profile set for this user' });
  }
  
  const client = fliffClients.get(mainProfileName);
  if (!client) {
    return res.status(500).json({ error: `Main profile "${mainProfileName}" is not running` });
  }
  
  // Find conflictFkey if not provided
  let targetFkey = conflictFkey;
  if (!targetFkey && gameId) {
    const game = liveGames.get(parseInt(gameId));
    if (game && game.conflictFkey) {
      targetFkey = game.conflictFkey;
    }
  }
  
  if (!targetFkey) {
    return res.status(400).json({ error: 'conflictFkey or valid gameId is required' });
  }
  
  try {
    const result = await client.navigateToGameByFkey(targetFkey);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Place bet on user's profiles only
app.post('/api/user/:username/place-bet', async (req, res) => {
  const { username } = req.params;
  const { profileNames, selection, odds, wager, wagerType, param, market, oddId, gameId } = req.body;
  
  if (!userManager.userExists(username)) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Get user's allowed profiles
  const allowedProfiles = userManager.getUserProfiles(username);
  
  // If no specific profiles requested, use all user's profiles
  let targetProfiles = profileNames && profileNames.length > 0 
    ? profileNames.filter(p => allowedProfiles.includes(p))
    : allowedProfiles;
  
  if (targetProfiles.length === 0) {
    return res.status(403).json({ error: 'No valid profiles available for betting' });
  }
  
  // Place bets on target profiles
  const results = [];
  
  for (const profileName of targetProfiles) {
    const client = fliffClients.get(profileName);
    
    if (!client) {
      results.push({
        profile: profileName,
        success: false,
        error: 'Profile not running'
      });
      continue;
    }
    
    try {
      const betResult = await client.placeBetViaAPI(
        selection,
        parseInt(odds),
        parseFloat(wager),
        wagerType || 'cash',
        param,
        market,
        oddId,
        false
      );
      
      results.push({
        profile: profileName,
        success: betResult.success,
        ...betResult
      });
    } catch (e) {
      results.push({
        profile: profileName,
        success: false,
        error: e.message
      });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  
  res.json({
    success: successCount > 0,
    totalProfiles: targetProfiles.length,
    successCount,
    results
  });
});

// Lock and load for user's profiles
app.post('/api/user/:username/lock-and-load', async (req, res) => {
  const { username } = req.params;
  const { selection, odds, param, market, oddId, gameId } = req.body;
  
  if (!userManager.userExists(username)) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const allowedProfiles = userManager.getUserProfiles(username);
  
  if (allowedProfiles.length === 0) {
    return res.status(403).json({ error: 'No profiles assigned to this user' });
  }
  
  // Filter to only running profiles
  const runningProfiles = allowedProfiles.filter(p => fliffClients.has(p));
  
  if (runningProfiles.length === 0) {
    return res.status(500).json({ error: 'No assigned profiles are currently running' });
  }
  
  // Place $0.20 lock and load bet on each profile
  const lockWager = 0.20;
  const results = [];
  
  for (const profileName of runningProfiles) {
    const client = fliffClients.get(profileName);
    
    try {
      // Capture bearer token first
      await client.captureCurrentBearerToken();
      
      // Place lock and load bet
      const betResult = await client.placeBetViaAPI(
        selection,
        parseInt(odds),
        lockWager,
        'cash',
        param,
        market,
        oddId,
        false
      );
      
      results.push({
        profile: profileName,
        success: betResult.success,
        armed: betResult.success,
        ...betResult
      });
    } catch (e) {
      results.push({
        profile: profileName,
        success: false,
        armed: false,
        error: e.message
      });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  const allArmed = successCount === runningProfiles.length;
  
  res.json({
    success: successCount > 0,
    armed: allArmed,
    totalProfiles: runningProfiles.length,
    successCount,
    results,
    message: allArmed 
      ? `🔒 ARMED! All ${runningProfiles.length} profile(s) locked at ${odds}`
      : `⚠️ ${successCount}/${runningProfiles.length} profiles armed`
  });
});

// Get VNC info for user's profiles
app.get('/api/user/:username/vnc-info', (req, res) => {
  const { username } = req.params;
  
  if (!userManager.userExists(username)) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const profiles = userManager.getUserProfiles(username);
  
  const vncInfo = profiles.map(profileName => {
    const client = fliffClients.get(profileName);
    return {
      profile: profileName,
      isRunning: !!client,
      // VNC port would be configured per profile
      vncPort: client?.vncPort || null,
      vncUrl: client?.vncPort ? `/novnc/vnc.html?host=${req.hostname}&port=${client.vncPort}` : null
    };
  });
  
  res.json(vncInfo);
});

// Helper to get the main profile FliffClient
function getMainProfileClient() {
  return fliffClients.get(mainProfile) || fliffClient;
}

// Load existing logs
function loadLogs() {
  try {
    const logsPath = path.join(__dirname, 'bet_logs.json');
    if (fs.existsSync(logsPath)) {
      const data = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
      betLogs.push(...data.logs);
      Object.assign(accountStats, data.stats);
    }
  } catch (e) {
    console.log('No existing logs found');
  }
}

// Save logs
function saveLogs() {
  try {
    const logsPath = path.join(__dirname, 'bet_logs.json');
    // Use writeFileSync with a small delay to batch writes and reduce nodemon restarts
    fs.writeFileSync(logsPath, JSON.stringify({
      logs: betLogs.slice(-1000), // Keep last 1000
      stats: accountStats
    }, null, 2));
  } catch (e) {
    console.error('Error saving logs:', e);
  }
}

loadLogs();

// =============================================
// API ENDPOINTS - GAMES
// =============================================

app.get('/api/games', (req, res) => {
  res.json(Array.from(liveGames.values()));
});

app.get('/api/games/:id', (req, res) => {
  const game = liveGames.get(parseInt(req.params.id));
  if (game) {
    res.json(game);
  } else {
    res.status(404).json({ error: 'Game not found' });
  }
});

app.get('/api/betting/status', (req, res) => {
  if (!fliffClient) {
    return res.status(500).json({ error: 'Fliff not connected' });
  }
  
  const status = fliffClient.getBettingAPIStatus();
  res.json(status);
});

app.post('/api/betting/capture-endpoint', async (req, res) => {
  if (!fliffClient) {
    return res.status(500).json({ error: 'Fliff not connected' });
  }
  
  const { gameId } = req.body;
  
  try {
    if (gameId) {
      await fliffClient.navigateToGame(gameId);
    }
    
    const status = fliffClient.getBettingAPIStatus();
    res.json({ 
      success: true, 
      message: 'Navigate to game page and place a bet manually to capture the endpoint',
      status 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// MAIN PROFILE GAME NAVIGATION API (Fliff Cluster V1 approach)
// Uses the main profile (Live Event) to browse and capture game data
// =============================================

// Get/Set main profile configuration
app.get('/api/main-profile', (req, res) => {
  res.json({
    success: true,
    mainProfile: mainProfile,
    isConnected: !!getMainProfileClient(),
    availableProfiles: Array.from(fliffClients.keys())
  });
});

app.post('/api/main-profile', (req, res) => {
  const { profile } = req.body;
  
  if (!profile) {
    return res.status(400).json({ error: 'Profile name is required' });
  }
  
  // Check if profile exists in clients
  if (!fliffClients.has(profile)) {
    return res.status(404).json({ 
      error: `Profile "${profile}" not found or not connected`,
      availableProfiles: Array.from(fliffClients.keys())
    });
  }
  
  mainProfile = profile;
  logSystem(`📌 Main profile set to: ${mainProfile}`);
  
  res.json({
    success: true,
    mainProfile: mainProfile,
    message: `Main profile set to "${mainProfile}"`
  });
});

// Navigate to live events page (main profile)
app.post('/api/main-profile/go-live', async (req, res) => {
  const client = getMainProfileClient();
  
  if (!client) {
    return res.status(500).json({ error: 'Main profile not connected' });
  }
  
  try {
    const result = await client.goToLive();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get visible games from main profile's browser
app.get('/api/main-profile/visible-games', async (req, res) => {
  const client = getMainProfileClient();
  
  if (!client) {
    return res.status(500).json({ error: 'Main profile not connected' });
  }
  
  try {
    const result = await client.getVisibleGames();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Click on a game by index (main profile)
app.post('/api/main-profile/click-game', async (req, res) => {
  const client = getMainProfileClient();
  
  if (!client) {
    return res.status(500).json({ error: 'Main profile not connected' });
  }
  
  const { index } = req.body;
  
  if (index === undefined || index === null) {
    return res.status(400).json({ error: 'Game index is required' });
  }
  
  try {
    const result = await client.clickGameByIndex(parseInt(index));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Navigate to game using conflict_fkey (main profile)
app.post('/api/main-profile/navigate-to-game', async (req, res) => {
  const client = getMainProfileClient();
  
  if (!client) {
    return res.status(500).json({ error: 'Main profile not connected' });
  }
  
  const { conflictFkey, gameId } = req.body;
  
  // Try to find conflictFkey from game data if not provided
  let targetFkey = conflictFkey;
  if (!targetFkey && gameId) {
    const game = liveGames.get(parseInt(gameId));
    if (game && game.conflictFkey) {
      targetFkey = game.conflictFkey;
    }
  }
  
  if (!targetFkey) {
    return res.status(400).json({ error: 'conflictFkey or valid gameId is required' });
  }
  
  try {
    const result = await client.navigateToGameByFkey(targetFkey);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Go back in browser (main profile)
app.post('/api/main-profile/go-back', async (req, res) => {
  const client = getMainProfileClient();
  
  if (!client) {
    return res.status(500).json({ error: 'Main profile not connected' });
  }
  
  try {
    const result = await client.goBack();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// BEARER TOKEN CAPTURE
// Actively capture bearer token from browser
// =============================================

// Capture bearer token from a specific profile
app.post('/api/profile/:profileName/capture-token', async (req, res) => {
  const { profileName } = req.params;
  const client = fliffClients.get(profileName);
  
  if (!client) {
    return res.status(404).json({ error: `Profile "${profileName}" not found or not connected` });
  }
  
  try {
    console.log(`🔑 Capturing bearer token for profile: ${profileName}`);
    const result = await client.captureCurrentBearerToken();
    
    if (result.success) {
      logSystem(`🔑 [${profileName}] Bearer token captured (source: ${result.source})`);
      res.json({
        success: true,
        profile: profileName,
        source: result.source,
        hasToken: !!result.token,
        tokenPreview: result.token ? '***' + result.token.slice(-10) : null
      });
    } else {
      res.status(400).json({
        success: false,
        profile: profileName,
        error: result.error
      });
    }
  } catch (e) {
    console.error(`❌ Error capturing token for ${profileName}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Capture bearer token from all profiles
app.post('/api/capture-all-tokens', async (req, res) => {
  const results = [];
  
  for (const [profileName, client] of fliffClients) {
    try {
      console.log(`🔑 Capturing bearer token for profile: ${profileName}`);
      const result = await client.captureCurrentBearerToken();
      
      results.push({
        profile: profileName,
        success: result.success,
        source: result.source || null,
        hasToken: !!result.token,
        error: result.error || null
      });
    } catch (e) {
      results.push({
        profile: profileName,
        success: false,
        error: e.message
      });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  logSystem(`🔑 Token capture complete: ${successCount}/${results.length} profiles`);
  
  res.json({
    totalProfiles: results.length,
    successCount,
    results
  });
});

// Get token status for all profiles
app.get('/api/token-status', (req, res) => {
  const status = [];
  
  for (const [profileName, client] of fliffClients) {
    const apiStatus = client.getBettingAPIStatus();
    status.push({
      profile: profileName,
      hasAuth: apiStatus.hasAuth,
      hasBearerToken: !!apiStatus.bearerToken,
      hasAuthToken: !!apiStatus.authToken,
      bearerPreview: apiStatus.bearerToken,
      authPreview: apiStatus.authToken
    });
  }
  
  res.json({
    profileCount: status.length,
    profiles: status
  });
});

// Navigate any specific profile to game
app.post('/api/profile/:profileName/navigate-to-game', async (req, res) => {
  const { profileName } = req.params;
  const { conflictFkey, gameId } = req.body;
  
  const client = fliffClients.get(profileName);
  
  if (!client) {
    return res.status(404).json({ 
      error: `Profile "${profileName}" not found`,
      availableProfiles: Array.from(fliffClients.keys())
    });
  }
  
  // Try to find conflictFkey from game data if not provided
  let targetFkey = conflictFkey;
  if (!targetFkey && gameId) {
    const game = liveGames.get(parseInt(gameId));
    if (game && game.conflictFkey) {
      targetFkey = game.conflictFkey;
    }
  }
  
  if (!targetFkey) {
    return res.status(400).json({ error: 'conflictFkey or valid gameId is required' });
  }
  
  try {
    const result = await client.navigateToGameByFkey(targetFkey);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/games/:id/odds', (req, res) => {
  const gameId = parseInt(req.params.id);
  const game = liveGames.get(gameId);
  
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  const odds = gameOdds.get(gameId) || new Map();
  const oddsArray = Array.from(odds.values());
  
  // STRICT FINAL VERIFICATION: Filter out any odds that don't match this game
  const homeName = (game.home || '').toLowerCase().trim();
  const awayName = (game.away || '').toLowerCase().trim();
  
  // Extract key words
  const extractKeyWords = (name) => {
    return name
      .replace(/\b(state|university|univ|college|tech|tech|st|u|of|the)\b/gi, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .join(' ')
      .trim();
  };
  
  const homeKeyWords = extractKeyWords(homeName);
  const awayKeyWords = extractKeyWords(awayName);
  
  const verifiedOdds = [];
  const rejectedOdds = [];
  
  oddsArray.forEach(odd => {
    if (!odd.event) {
      rejectedOdds.push({ reason: 'no_event_info', odd: odd.selection });
      return;
    }
    
    const eventInfo = (odd.event || '').toLowerCase().trim();
    
    // Check for full team name matches (strongest)
    const hasHomeFull = eventInfo.includes(homeName);
    const hasAwayFull = eventInfo.includes(awayName);
    
    // Check for key words
    const hasHomeKey = homeKeyWords && eventInfo.includes(homeKeyWords);
    const hasAwayKey = awayKeyWords && eventInfo.includes(awayKeyWords);
    
    // Check for individual significant words
    const homeWords = homeName.split(/\s+/).filter(w => w.length > 2);
    const awayWords = awayName.split(/\s+/).filter(w => w.length > 2);
    const hasHomeWord = homeWords.some(word => eventInfo.includes(word));
    const hasAwayWord = awayWords.some(word => eventInfo.includes(word));
    
    // Check for full game pattern
    const hasFullGame = eventInfo.includes(`${homeName} vs ${awayName}`) ||
                       eventInfo.includes(`${awayName} vs ${homeName}`);
    
    // Require STRONG match - full name OR both key words OR full game pattern
    const hasStrongMatch = hasHomeFull || hasAwayFull || hasFullGame || 
                          (hasHomeKey && hasAwayKey) ||
                          (hasHomeFull && hasAwayWord) ||
                          (hasAwayFull && hasHomeWord);
    
    if (hasStrongMatch) {
      verifiedOdds.push(odd);
    } else {
      rejectedOdds.push({ 
        reason: 'no_match', 
        event: odd.event, 
        selection: odd.selection,
        hasHome: hasHomeFull || hasHomeKey || hasHomeWord,
        hasAway: hasAwayFull || hasAwayKey || hasAwayWord
      });
    }
  });
  
  // Log summary with separate odds logging
  if (rejectedOdds.length > 0) {
    logOdds(`🧹 Removed ${rejectedOdds.length} mismatched odds`, { gameId, count: rejectedOdds.length });
    if (rejectedOdds.length <= 10) {
      rejectedOdds.forEach(r => {
        logOdds(`   ❌ Rejected: "${r.event}" - ${r.selection}`, { gameId });
      });
    } else {
      logOdds(`   ❌ Sample rejected: ${rejectedOdds.slice(0, 3).map(r => r.event).join(', ')}...`, { gameId });
    }
  }
  
  logOdds(`${game.home} vs ${game.away}: ${oddsArray.length} stored → ${verifiedOdds.length} verified`, { gameId, count: verifiedOdds.length });
  
  // Also clean up stored odds map
  if (rejectedOdds.length > 0) {
    const verifiedIds = new Set(verifiedOdds.map(o => o.id));
    const cleanedOdds = new Map();
    odds.forEach((odd, id) => {
      if (verifiedIds.has(id)) {
        cleanedOdds.set(id, odd);
      }
    });
    gameOdds.set(gameId, cleanedOdds);
    logOdds(`🧹 Cleaned stored odds: ${odds.size} → ${cleanedOdds.size}`, { gameId });
  }
  
  res.json(verifiedOdds);
});

app.get('/api/odds', (req, res) => {
  const allOdds = [];
  gameOdds.forEach((odds, gameId) => {
    odds.forEach(odd => {
      allOdds.push({ ...odd, gameId });
    });
  });
  res.json(allOdds);
});

app.get('/api/status', (req, res) => {
  // Get profile status
  const profileStatuses = [];
  let profileIndex = 0;
  for (const [profileName, client] of fliffClients.entries()) {
    // Skip live event profiles in status (they're for data scraping only)
    if (client.isLiveEventProfile) {
      continue;
    }
    const isReady = !!(client.page && client.browser);
    const apiStatus = client.getBettingAPIStatus();
    
    // Use client's vncPort if set, otherwise calculate from index
    const vncPort = client.profileVncPort || (5900 + profileIndex);
    const wsPort = 6081 + profileIndex;
    const vncUrl = `/novnc-viewer?port=${vncPort}&ws=${wsPort}`;
    
    profileStatuses.push({
      name: profileName,
      ready: isReady,
      hasPage: !!client.page,
      hasBrowser: !!client.browser,
      hasBettingEndpoint: !!apiStatus.endpoint,
      hasAuth: apiStatus.hasAuth,
      method: apiStatus.method,
      profileType: client.isBettingProfile ? 'betting' : 'liveEvent',
      vncPort: vncPort, // Include VNC port for this profile
      vncDisplay: client.profileDisplay || null, // Include display number
      vncUrl: vncUrl // websockify URL for this profile
    });
    profileIndex++;
  }
  
  res.json({
    connected: stats.connected,
    messages: stats.messages,
    liveGames: liveGames.size,
    totalOdds: Array.from(gameOdds.values()).reduce((sum, m) => sum + m.size, 0),
    accountStats,
    selectedGameId: selectedGameId, // Currently selected game (for performance)
    profiles: {
      total: fliffClients.size,
      ready: profileStatuses.filter(p => p.ready).length,
      statuses: profileStatuses
    }
  });
});

// =============================================
// API ENDPOINTS - PERFORMANCE CONTROLS
// =============================================

// Get current performance settings
app.get('/api/performance', (req, res) => {
  res.json({
    selectedGameId,
    priorityGameId,
    logConfig: LOG_CONFIG,
    liveGamesCount: liveGames.size,
    message: selectedGameId 
      ? `Only processing odds for game ${selectedGameId}` 
      : 'Processing odds for ALL games (may cause lag)'
  });
});

// Set selected game (only process odds for this game)
app.post('/api/performance/select-game', (req, res) => {
  const { gameId } = req.body;
  
  if (gameId === null || gameId === undefined) {
    selectedGameId = null;
    logSystem('🔓 Selected game cleared - processing ALL games (may lag)');
    return res.json({ success: true, selectedGameId: null, message: 'Processing all games' });
  }
  
  const gid = parseInt(gameId);
  if (isNaN(gid)) {
    return res.status(400).json({ error: 'Invalid gameId' });
  }
  
  selectedGameId = gid;
  logSystem(`🎯 Selected game set to ${gid} - ONLY processing odds for this game`);
  res.json({ success: true, selectedGameId: gid, message: `Only processing odds for game ${gid}` });
});

// Clear selected game (process all games - may cause lag)
app.post('/api/performance/clear-selection', (req, res) => {
  selectedGameId = null;
  logSystem('🔓 Selected game cleared - processing ALL games');
  res.json({ success: true, message: 'Processing all games now' });
});

// Update log configuration
app.post('/api/performance/logging', (req, res) => {
  const { oddsVerbose, oddsSummary, betting, live, performance } = req.body;
  
  if (typeof oddsVerbose === 'boolean') LOG_CONFIG.ODDS_VERBOSE = oddsVerbose;
  if (typeof oddsSummary === 'boolean') LOG_CONFIG.ODDS_SUMMARY = oddsSummary;
  if (typeof betting === 'boolean') LOG_CONFIG.BETTING = betting;
  if (typeof live === 'boolean') LOG_CONFIG.LIVE = live;
  if (typeof performance === 'boolean') LOG_CONFIG.PERFORMANCE = performance;
  
  logSystem('📝 Log config updated', { config: LOG_CONFIG });
  res.json({ success: true, logConfig: LOG_CONFIG });
});

// =============================================
// API ENDPOINTS - BETTING
// =============================================

// Simple bet (legacy - uses primary client only, use /api/prefire or /api/place-bet for all profiles)
app.post('/api/bet', async (req, res) => {
  const { gameId, selection, odds, wager, coinType } = req.body;
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  // Use first available client for backward compatibility
  const client = fliffClient || Array.from(fliffClients.values())[0];
  
  if (!client) {
    return res.status(500).json({ error: 'No Fliff client available' });
  }
  
  try {
    const result = await client.placeBet(selection, odds, wager || 10, coinType || 'cash');
    
    // Log the bet
    logBet({
      type: 'simple',
      selection,
      odds,
      wager: wager || 10,
      coinType: coinType || 'cash',
      result: result.success ? 'placed' : 'failed',
      timestamp: Date.now()
    });
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PREFIRE BET - Now works with ALL profiles and includes page reload option
app.post('/api/prefire', async (req, res) => {
  // Validate request body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, wager, coinType, reloadPage } = req.body;
  
  // Validate required fields
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  // Default wager if not provided
  const betWager = wager || 10;
  const betCoinType = coinType || 'cash';
  const shouldReload = reloadPage === true; // Default to false - prefire should NOT reload by default
  
  logBetting(`💰 PREFIRE BET (${fliffClients.size} profile(s)): ${selection} @ ${odds} - $${betWager} (${betCoinType})${shouldReload ? ' [with reload]' : ' [no reload - odds verification only]'}`);
  logBetting(`   Odd ID: ${oddId || 'N/A'}`);
  logBetting(`   Param: ${param || 'N/A'} | Market: ${market || 'N/A'}`);
  
  try {
    // Verify we have the correct odd data from the game
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    let finalSelection = selection;
    let finalOdds = odds;
    let finalParam = param;
    let finalMarket = market;
    
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        logBetting(`   ✅ Stored odd found: ${storedOdd.selection} @ ${storedOdd.odds} (Market: ${storedOdd.market})`);
        finalSelection = storedOdd.selection || selection;
        finalOdds = storedOdd.odds || odds;
        finalParam = storedOdd.param || param;
        finalMarket = storedOdd.market || market;
      }
    }
    
    logBetting(`   📊 Using: ${finalSelection} @ ${finalOdds} | Market: ${finalMarket} | Param: ${finalParam}`);
    
    // Verify all clients are ready
    const readyClients = [];
    const notReadyClients = [];
    
    for (const [profileName, client] of fliffClients.entries()) {
      // Only use betting profiles for placing bets
      if (client.isLiveEventProfile) {
        continue; // Skip live event profiles
      }
      if (!client.page || !client.browser) {
        notReadyClients.push(profileName);
        logBetting(`   ⚠️ [${profileName}] Client not ready (no page/browser)`);
        continue;
      }
      readyClients.push({ name: profileName, client });
    }
    
    if (readyClients.length === 0) {
      logBetting(`   ❌ No clients ready to place bets!`);
      return res.status(500).json({ 
        error: 'No clients ready', 
        notReady: notReadyClients,
        totalClients: fliffClients.size
      });
    }
    
    if (notReadyClients.length > 0) {
      logBetting(`   ⚠️ ${notReadyClients.length} client(s) not ready: ${notReadyClients.join(', ')}`);
    }
    
    logBetting(`   ✅ ${readyClients.length} client(s) ready to place bets`);
    
    // Send bet request to ALL ready profiles
    const profileResults = [];
    const profilePromises = [];
    
    for (const { name: profileName, client } of readyClients) {
      logBetting(`   [${profileName}] Placing bet: ${finalSelection} @ ${finalOdds} - $${betWager} (${betCoinType})`);
      
      // Check if client has betting endpoint or will use Puppeteer
      const apiStatus = client.getBettingAPIStatus();
      if (apiStatus.endpoint) {
        logBetting(`      Using API endpoint: ${apiStatus.endpoint.substring(0, 50)}...`);
      } else {
        logBetting(`      Using Puppeteer method (no API endpoint captured)`);
      }
      
      const profilePromise = (async () => {
        try {
          // Prefire: Verify odds first, then place bet (NO page reload)
          // Only reload if explicitly requested (reloadPage: true)
          let betResult;
          
          if (shouldReload) {
            // If reload is explicitly requested, reload page during bet submission
            const betPromise = client.placeBet(finalSelection, finalOdds, betWager, betCoinType, finalParam, finalMarket, oddId);
            const reloadPromise = client.reloadPage();
            const [result, reloadRes] = await Promise.all([betPromise, reloadPromise]);
            result.reloadResult = reloadRes;
            betResult = result;
          } else {
            // No reload - just place bet (prefire default behavior)
            betResult = await client.placeBet(finalSelection, finalOdds, betWager, betCoinType, finalParam, finalMarket, oddId);
          }
          
          if (betResult.success) {
            // Verify bet was actually placed by checking API response
            const verified = await verifyBetPlaced(client, betResult, finalSelection, finalOdds);
            betResult.verified = verified;
            
            if (verified.confirmed) {
              logBet({
                type: 'bet',
                selection: finalSelection,
                odds: finalOdds,
                wager: betWager,
                coinType: betCoinType,
                profile: profileName,
                result: 'accepted',
                verified: true,
                apiStatus: verified.status,
                timestamp: Date.now()
              });
              
              return {
                profileName,
                success: true,
                verified: true,
                message: `Bet placed and verified: ${finalSelection} @ ${finalOdds} - $${betWager}`,
                error: null,
                status: verified.status
              };
            } else {
              // Bet might have been placed but couldn't verify
              logBet({
                type: 'bet',
                selection: finalSelection,
                odds: finalOdds,
                wager: betWager,
                coinType: betCoinType,
                profile: profileName,
                result: 'accepted',
                verified: false,
                timestamp: Date.now()
              });
              
              return {
                profileName,
                success: true,
                verified: false,
                message: `Bet placed (unverified): ${finalSelection} @ ${finalOdds} - $${betWager}`,
                error: verified.reason || 'Could not verify bet placement',
                status: verified.status
              };
            }
          }
          
          if (betResult.oddsChanged) {
            return {
              profileName,
              success: false,
              retry: true,
              message: 'Odds changed',
              error: 'Odds changed'
            };
          }
          
          return {
            profileName,
            success: false,
            retry: false,
            message: 'Bet failed',
            error: betResult.error || 'Bet failed'
          };
        } catch (e) {
          logBetting(`   [${profileName}] ❌ Error: ${e.message}`);
          return {
            profileName,
            success: false,
            retry: false,
            message: 'Error',
            error: e.message
          };
        }
      })();
      
      profilePromises.push(profilePromise);
    }
    
    // Wait for all profiles to complete
    const results = await Promise.all(profilePromises);
    
    // Analyze results
    const successfulBets = results.filter(r => r.success);
    const failedBets = results.filter(r => !r.success);
    const oddsChangedBets = results.filter(r => r.retry);
    
    // Log detailed results
    logBetting(`\n📊 Bet Results Summary:`);
    logBetting(`   Total profiles attempted: ${results.length}`);
    logBetting(`   Successful: ${successfulBets.length}`);
    logBetting(`   Failed: ${failedBets.length}`);
    logBetting(`   Odds changed: ${oddsChangedBets.length}`);
    
    if (successfulBets.length > 0) {
      const verifiedBets = successfulBets.filter(r => r.verified);
      const unverifiedBets = successfulBets.filter(r => !r.verified);
      
      if (verifiedBets.length > 0) {
        logBetting(`   ✅ Verified success on: ${verifiedBets.map(r => `${r.profileName} (status: ${r.status || 'N/A'})`).join(', ')}`);
      }
      if (unverifiedBets.length > 0) {
        logBetting(`   ⚠️ Unverified success on: ${unverifiedBets.map(r => r.profileName).join(', ')}`);
      }
    }
    if (failedBets.length > 0) {
      failedBets.forEach(r => {
        logBetting(`   ❌ Failed on ${r.profileName}: ${r.error || 'Unknown error'}`);
      });
    }
    if (oddsChangedBets.length > 0) {
      logBetting(`   ⚠️ Odds changed on: ${oddsChangedBets.map(r => r.profileName).join(', ')}`);
    }
    
    // Update stats
    accountStats.totalBets += successfulBets.length;
    accountStats.pending += successfulBets.length;
    accountStats.totalWagered += betWager * successfulBets.length;
    
    // Build message
    let message;
    const totalExpected = readyClients.length;
    if (successfulBets.length === totalExpected) {
      message = `✅ Bet placed on all ${totalExpected} profile(s): ${finalSelection} @ ${finalOdds} - $${betWager}`;
    } else if (successfulBets.length > 0) {
      const successProfiles = successfulBets.map(r => r.profileName).join(', ');
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `⚠️ Bet placed on ${successfulBets.length}/${totalExpected} profile(s). Success: ${successProfiles}. Failed: ${failProfiles}`;
    } else {
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `❌ Bet failed on all profiles: ${failProfiles}`;
    }
    
    // Warn if some clients weren't ready
    if (notReadyClients.length > 0) {
      message += ` (${notReadyClients.length} profile(s) not ready: ${notReadyClients.join(', ')})`;
    }
    
    broadcast({
      type: 'prefire_result',
      success: successfulBets.length > 0,
      message: message,
      profileResults: results
    });
    
    setImmediate(() => saveLogs());
    
    if (oddsChangedBets.length > 0) {
      return res.json({ 
        success: false, 
        retry: true, 
        message: `Odds changed on ${oddsChangedBets.length} profile(s). Click again to retry.`,
        profileResults: results
      });
    }
    
    if (successfulBets.length === 0) {
      return res.json({ 
        success: false, 
        error: 'Bet failed on all profiles',
        profileResults: results
      });
    }
    
    return res.json({ 
      success: true, 
      message: `Bet placed on ${successfulBets.length}/${totalExpected} profile(s)!`,
      profileResults: results
    });
    
  } catch (e) {
    console.error('Prefire bet error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// BURN PREFIRE - Fast bet placement on all profiles (optimized for speed)
app.post('/api/burn-prefire', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, wager } = req.body;
  
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  const betWager = wager || 10;
  // Cleaner logging like other bot
  const readyClients = [];
  for (const [profileName, client] of fliffClients.entries()) {
    if (client.page && client.browser) {
      readyClients.push({ name: profileName, client });
    }
  }
  
  if (readyClients.length === 0) {
    return res.status(500).json({ error: 'No clients ready' });
  }
  
  // Log which accounts are processing
  readyClients.forEach(({ name }) => {
    logBetting(`🔥 ${name} processing BURN bet: BURN_PREFIRE_${oddId || 'unknown'}`);
  });
  
  try {
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    let finalSelection = selection;
    let finalOdds = odds;
    let finalParam = param;
    let finalMarket = market;
    
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        finalSelection = storedOdd.selection || selection;
        finalOdds = storedOdd.odds || odds;
        finalParam = storedOdd.param || param;
        finalMarket = storedOdd.market || market;
      }
    }
    
    // Place bets in parallel for maximum speed
    const profilePromises = readyClients.map(({ name: profileName, client }) => {
      return (async () => {
        try {
          // Check for bearer token from injection
          try {
            const injectedToken = await client.page.evaluate(() => {
              return window.__fliffBearerToken || null;
            });
            
            if (injectedToken && injectedToken !== client.bearerToken) {
              client.bearerToken = injectedToken;
              console.log(`🔑 Bearer token captured from injection: present`);
              client.saveAPICredentials();
            }
          } catch (e) {
            // Ignore if page context not ready
          }
          
          console.log(`💰 Placing bet (BURN)`);
          
          // Prefer API method for speed
          const apiStatus = client.getBettingAPIStatus();
          if (apiStatus.endpoint && apiStatus.hasAuth) {
            // Use API method (fastest)
            const betResult = await client.placeBetViaAPI(finalSelection, finalOdds, betWager, 'cash', finalParam, finalMarket, oddId);
            
            // Log result like other bot
            if (betResult.response) {
              console.log(`Response: ${betResult.response.status || 200}`);
              console.log(`Final result: ${JSON.stringify({ status: betResult.response.status, hasPickResult: betResult.response.hasPickResult || false })}`);
              
              if (betResult.response.status === 8301) {
                console.log(`✅ ${profileName} burn successful (8301 as expected)`);
              }
            }
            
            return {
              profileName,
              success: betResult.success,
              retry: betResult.oddsChanged,
              error: betResult.error,
              method: 'api',
              status: betResult.response?.status
            };
          } else {
            // Fallback to regular placeBet
            const betResult = await client.placeBet(finalSelection, finalOdds, betWager, 'cash', finalParam, finalMarket, oddId);
            return {
              profileName,
              success: betResult.success,
              retry: betResult.oddsChanged,
              error: betResult.error,
              method: 'puppeteer'
            };
          }
        } catch (e) {
          return {
            profileName,
            success: false,
            retry: false,
            error: e.message,
            method: 'error'
          };
        }
      })();
    });
    
    const results = await Promise.all(profilePromises);
    const successfulBets = results.filter(r => r.success);
    const failedBets = results.filter(r => !r.success);
    const oddsChangedBets = results.filter(r => r.retry);
    
    // Update stats
    accountStats.totalBets += successfulBets.length;
    accountStats.pending += successfulBets.length;
    accountStats.totalWagered += betWager * successfulBets.length;
    
    setImmediate(() => saveLogs());
    
    if (oddsChangedBets.length > 0) {
      return res.json({ 
        success: false, 
        retry: true, 
        message: `Odds changed on ${oddsChangedBets.length} profile(s)`,
        profileResults: results
      });
    }
    
    return res.json({ 
      success: successfulBets.length > 0, 
      message: `Burn prefire: ${successfulBets.length}/${readyClients.length} successful`,
      profileResults: results
    });
    
  } catch (e) {
    console.error('Burn prefire error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// LOCK AND LOAD - Places $0.20 bet with Cash and refreshes page during submission to lock odds
// Now works with ALL profiles - only shows "locked and loaded" when ALL profiles' odds don't change
// =============================================
// LOCK & LOAD - PRIORITIZED ENDPOINT
// This endpoint is optimized for speed and should process quickly
// =============================================
app.post('/api/lock-and-load', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, reloadPage } = req.body;
  
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  const lockWager = 0.20; // Always use $0.20 for lock and load
  // Lock and load captures the exact API request and saves it - no page reload needed!
  // When placing the actual bet, we reuse that locked API request (only changing wager amount)
  logBetting(`🔒 LOCK & LOAD (${fliffClients.size} profile(s)): ${selection} @ ${odds} - $${lockWager} (Cash) [PRIORITIZED - fast processing]`);
  
  try {
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    let finalSelection = selection;
    let finalOdds = odds;
    let finalParam = param;
    let finalMarket = market;
    
    // Normalize odds to number format
    if (typeof finalOdds === 'string') {
      finalOdds = finalOdds.startsWith('+') ? parseInt(finalOdds.substring(1)) : parseInt(finalOdds);
    }
    
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        finalSelection = storedOdd.selection || selection;
        // Ensure stored odds is a number
        const storedOdds = storedOdd.odds;
        if (typeof storedOdds === 'string') {
          finalOdds = storedOdds.startsWith('+') ? parseInt(storedOdds.substring(1)) : parseInt(storedOdds);
        } else {
          finalOdds = storedOdds || finalOdds;
        }
        finalParam = storedOdd.param || param;
        finalMarket = storedOdd.market || market;
      }
    }
    
    // Verify all clients are ready
    const readyClients = [];
    const notReadyClients = [];
    
    for (const [profileName, client] of fliffClients.entries()) {
      // Only use betting profiles for placing bets
      if (client.isLiveEventProfile) {
        continue; // Skip live event profiles
      }
      if (!client.page || !client.browser) {
        notReadyClients.push(profileName);
        logBetting(`   ⚠️ [${profileName}] Client not ready (no page/browser)`);
        continue;
      }
      readyClients.push({ name: profileName, client });
    }
    
    if (readyClients.length === 0) {
      logBetting(`   ❌ No clients ready for lock & load!`);
      return res.status(500).json({ 
        error: 'No clients ready', 
        notReady: notReadyClients,
        totalClients: fliffClients.size
      });
    }
    
    if (notReadyClients.length > 0) {
      logBetting(`   ⚠️ ${notReadyClients.length} client(s) not ready: ${notReadyClients.join(', ')}`);
    }
    
    logBetting(`   ✅ ${readyClients.length} client(s) ready for lock & load`);
    logBetting(`   📋 Processing profiles: ${readyClients.map(c => c.name).join(', ')}`);
    
    // Send lock-and-load request to ALL ready profiles
    const profileResults = [];
    const profilePromises = [];
    
    for (const { name: profileName, client } of readyClients) {
      logBetting(`   [${profileName}] Starting lock & load: reload page, then place $${lockWager} bet via API...`);
      
      const profilePromise = (async () => {
        try {
          // ACTIVELY capture bearer token at lock & load time using multiple methods
          logBetting(`   [${profileName}] 🔑 Capturing bearer token at lock & load time...`);
          try {
            const tokenResult = await client.captureCurrentBearerToken();
            
            if (tokenResult.success) {
              logBetting(`   [${profileName}] 🔑 Bearer token captured (source: ${tokenResult.source})`);
            } else {
              logBetting(`   [${profileName}] ⚠️ Could not capture bearer token: ${tokenResult.error}`);
              
              // Fallback: try the old method
              const injectedToken = await client.page.evaluate(() => {
                return window.__fliffBearerToken || null;
              });
              
              if (injectedToken && injectedToken !== client.bearerToken) {
                client.bearerToken = injectedToken;
                logBetting(`   [${profileName}] 🔑 Refreshed bearer token from page (fallback)`);
                client.saveAPICredentials();
              } else if (!client.bearerToken && !client.authToken) {
                logBetting(`   [${profileName}] ⚠️ No bearer token or auth token available - may fail`);
              }
            }
          } catch (e) {
            // Ignore if page context not ready, but log warning
            if (client.bearerToken || client.authToken) {
              logBetting(`   [${profileName}] ⚠️ Could not refresh token from page, using stored token`);
            } else {
              logBetting(`   [${profileName}] ⚠️ Could not refresh token and no stored token available`);
            }
          }
          
          // LOCK AND LOAD FLOW (Backend API Only - No UI):
          // 1. Place $0.20 bet via API directly (fast, no UI clicks)
          // 2. Immediately reload page to lock odds
          // 3. After reload, check if odds changed
          // 4. If odds didn't change, mark as successful
          
          logBetting(`   [${profileName}] Step 1: Placing $${lockWager} bet via API (backend only)...`);
          
          // Check if API is available
          const apiStatus = client.getBettingAPIStatus();
          if (!apiStatus.endpoint || !apiStatus.hasAuth) {
            logBetting(`   [${profileName}] ⚠️ API not available, falling back to UI method...`);
            // Fallback to UI method if API not available
            const lockAndLoadResult = await client.placeBetWithReload(finalSelection, finalOdds, lockWager, 'cash', finalParam, finalMarket, oddId);
            
            if (!lockAndLoadResult.betPlaced) {
              return {
                profileName,
                success: false,
                betPlaced: false,
                pageReloaded: false,
                oddsLocked: false,
                oddsChanged: false,
                lockedOdds: null,
                currentOdds: null,
                error: lockAndLoadResult.error || 'Bet placement failed'
              };
            }
            
            if (lockAndLoadResult.oddsChanged) {
              return {
                profileName,
                success: false,
                betPlaced: true,
                pageReloaded: true,
                oddsLocked: false,
                oddsChanged: true,
                lockedOdds: finalOdds,
                currentOdds: lockAndLoadResult.currentOdds,
                error: `Odds changed: ${lockAndLoadResult.currentOdds}`
              };
            }
            
            return {
              profileName,
              success: true,
              betPlaced: true,
              pageReloaded: true,
              oddsLocked: true,
              oddsChanged: false,
              lockedOdds: finalOdds,
              currentOdds: finalOdds,
              error: null,
              method: 'puppeteer'
            };
          }
          
          // API METHOD: Place $0.20 bet via API and capture the exact request
          // This request will be saved and reused for the actual bet (locks odds without reload!)
          logBetting(`   [${profileName}] Placing $${lockWager} bet via API to capture locked request...`);
          
          // Retry logic for 403, 420, and 401 errors with exponential backoff
          let betResult;
          const maxRetries = 3;
          let retryCount = 0;
          let retryDelay = 1000; // Start with 1 second
          
          while (retryCount <= maxRetries) {
            betResult = await client.placeBetViaAPI(
              finalSelection,
              finalOdds,
              lockWager,
              'cash',
              finalParam,
              finalMarket,
              oddId,
              false
            );
            
            // If successful or not retryable, break
            if (betResult.success || !betResult.retryable) {
              break;
            }
            
            // Check for retryable errors (403, 420, 401)
            const isRetryableError = betResult.unauthorized || betResult.rateLimited || 
                                    (betResult.error && (
                                      betResult.error.includes('403') || 
                                      betResult.error.includes('420') ||
                                      betResult.error.includes('401') ||
                                      betResult.error.includes('Unauthorized') ||
                                      betResult.error.includes('Rate limit')
                                    ));
            
            if (!isRetryableError || retryCount >= maxRetries) {
              break;
            }
            
            retryCount++;
            logBetting(
              `   [${profileName}] ⚠️ Error ${betResult.error} (attempt ${retryCount}/${maxRetries}). Retrying in ${retryDelay}ms...`
            );
            
            // Refresh bearer token before retry
            try {
              const tokenResult = await client.captureCurrentBearerToken();
              if (tokenResult.success) {
                logBetting(`   [${profileName}] 🔑 Bearer token refreshed (source: ${tokenResult.source})`);
              } else {
                // Fallback: try the old method
                const injectedToken = await client.page.evaluate(() => {
                  return window.__fliffBearerToken || null;
                });
                if (injectedToken && injectedToken !== client.bearerToken) {
                  client.bearerToken = injectedToken;
                  client.saveAPICredentials();
                  logBetting(`   [${profileName}] 🔑 Bearer token refreshed from page (fallback)`);
                }
              }
            } catch (e) {
              logBetting(`   [${profileName}] ⚠️ Failed to refresh bearer token: ${e.message}`);
            }
            
            // Wait with exponential backoff
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            retryDelay = Math.min(retryDelay * 2, 10000); // Max 10 seconds
          }

          if (!betResult.success) {
            logBetting(`   [${profileName}] ❌ API bet failed: ${betResult.error}`);
            return {
              profileName,
              success: false,
              betPlaced: false,
              pageReloaded: false, // No reload needed with locked API
              oddsLocked: false,
              oddsChanged: false,
              lockedOdds: null,
              currentOdds: null,
              error: betResult.error || 'API bet failed',
              marketNotAvailable: betResult.marketNotAvailable || betResult.eventNotAvailable || false,
              eventNotAvailable: betResult.eventNotAvailable || false
            };
          }
          
          // Check if locked request was saved
          const hasLockedRequest = client.getLockedAPIRequest(oddId);
          if (hasLockedRequest) {
            logBetting(`   [${profileName}] ✅ Lock & Load successful! API request captured and locked for oddId: ${oddId}`);
            logBetting(`   [${profileName}]    No page reload needed - odds are locked via API request`);
            return {
              profileName,
              success: true,
              betPlaced: true,
              pageReloaded: false, // No reload needed!
              oddsLocked: true, // Locked via API request
              oddsChanged: false,
              lockedOdds: finalOdds,
              currentOdds: finalOdds,
              error: null,
              method: 'api_locked'
            };
          } else {
            // Fallback: bet was placed but request wasn't captured
            logBetting(`   [${profileName}] ⚠️ Bet placed but locked request not captured`);
            return {
              profileName,
              success: true,
              betPlaced: true,
              pageReloaded: false,
              oddsLocked: false, // Can't verify without locked request
              oddsChanged: false,
              lockedOdds: finalOdds,
              currentOdds: finalOdds,
              error: null,
              method: 'api'
            };
          }
        } catch (e) {
          logBetting(`   [${profileName}] ❌ Error: ${e.message}`);
          return {
            profileName,
            success: false,
            betPlaced: false,
            pageReloaded: false, // Reload would have failed if bet failed
            oddsLocked: false,
            oddsChanged: false,
            lockedOdds: null,
            currentOdds: null,
            error: e.message
          };
        }
      })();
      
      profilePromises.push(profilePromise);
    }
    
    // Wait for all profiles to complete
    const results = await Promise.all(profilePromises);
    
    // Analyze results - only show "locked and loaded" if ALL profiles have stable odds
    const allBetsPlaced = results.every(r => r.betPlaced);
    const allOddsLocked = results.every(r => r.oddsLocked);
    const anyOddsChanged = results.some(r => r.oddsChanged);
    const allProfilesSuccess = results.every(r => r.success);
    const anyMarketNotAvailable = results.some(r => r.marketNotAvailable);
    const anyEventNotAvailable = results.some(r => r.eventNotAvailable);
    const anyUnavailable = anyMarketNotAvailable || anyEventNotAvailable;
    
    // Log results for each profile
    results.forEach(r => {
      // Determine result status: if bet was placed successfully, it's locked (even if element not found)
      let resultStatus = 'unknown';
      if (r.betPlaced && r.success) {
        // If bet was placed successfully, it's locked (API accepted it)
        // Only mark as 'odds_changed' if odds actually changed, otherwise it's locked
        resultStatus = r.oddsChanged ? 'odds_changed' : 'locked'; // Changed 'placed' to 'locked' since bet was accepted
      } else if (r.oddsChanged) {
        resultStatus = 'odds_changed';
      } else if (!r.success) {
        resultStatus = 'failed';
      }
      
      logBet({
        type: 'lock_and_load',
        selection: finalSelection,
        odds: finalOdds,
        wager: lockWager,
        coinType: 'cash',
        profile: r.profileName,
        result: resultStatus,
        timestamp: Date.now()
      });
      
      // Normalize odds format for display (always show + for positive odds)
      const displayOdds = typeof finalOdds === 'number' 
        ? (finalOdds > 0 ? `+${finalOdds}` : finalOdds.toString())
        : finalOdds;
      
      // Log final status (matching other bot format)
      if (resultStatus === 'locked') {
        logBetting(`LOCK_AND_LOAD: ${finalSelection} @ ${displayOdds} = armed`);
      } else if (resultStatus === 'odds_changed') {
        logBetting(`LOCK_AND_LOAD: ${finalSelection} @ ${displayOdds} = failed`);
      } else if (resultStatus === 'placed') {
        logBetting(`LOCK_AND_LOAD: ${finalSelection} @ ${displayOdds} = armed`);
      } else {
        // For failed results, include error info
        const errorInfo = r.error ? ` (${r.error.substring(0, 50)})` : '';
        logBetting(`LOCK_AND_LOAD: ${finalSelection} @ ${displayOdds} = failed${errorInfo}`);
      }
    });
    
    accountStats.totalBets += results.filter(r => r.betPlaced).length;
    accountStats.totalWagered += lockWager * results.filter(r => r.betPlaced).length;
    
    // Calculate success/failure counts
    const successfulResults = results.filter(r => r.betPlaced && r.success && r.oddsLocked);
    const successCount = successfulResults.length;
    const failedResults = results.filter(r => !r.success || !r.betPlaced);
    const failedCount = failedResults.length;
    const totalProfiles = results.length;
    
    // Show "ARMED" if AT LEAST ONE profile succeeded (partial success is OK)
    // This allows betting even if some accounts fail
    const anyLocked = successCount > 0;
    const allLocked = (allOddsLocked && !anyOddsChanged) || (allBetsPlaced && allProfilesSuccess);
    
    let message;
    if (anyMarketNotAvailable) {
      // Market not available - highest priority message
      message = `⚠️ Market Not Available: ${finalSelection} @ ${finalOdds} - This market is no longer available for betting`;
    } else if (anyLocked) {
      // Partial or full success - show ready to bet
      if (successCount === totalProfiles) {
        message = `🔒 ARMED (${successCount}/${totalProfiles} profiles): ${finalSelection} @ ${finalOdds} - All accounts locked, ready to place bet!`;
      } else {
        const failedNames = failedResults.map(r => r.profileName).join(', ');
        message = `🔒 ARMED (${successCount}/${totalProfiles} profiles): ${finalSelection} @ ${finalOdds} - Partial success! ${failedCount} account(s) failed: ${failedNames}. Ready to place bet on ${successCount} account(s)!`;
      }
    } else if (anyOddsChanged) {
      const changedProfiles = results.filter(r => r.oddsChanged).map(r => r.profileName);
      message = `❌ Lock & Load Failed (${changedProfiles.length} profile(s)): ${finalSelection} @ ${finalOdds} - Odds changed on: ${changedProfiles.join(', ')}`;
    } else {
      const failedProfiles = results.filter(r => !r.success);
      const failedNames = failedProfiles.map(r => r.profileName);
      const failedErrors = failedProfiles
        .map(r => {
          const err = r.error || 'Unknown error';
          if (typeof err === 'string') return err;
          if (typeof err === 'object' && err !== null) {
            return err.message || err.error || JSON.stringify(err);
          }
          return String(err);
        })
        .filter(err => err && err !== 'Unknown error');
      
      if (failedErrors.length > 0) {
        message = `❌ Lock & Load Failed (${failedCount}/${totalProfiles} profiles): ${failedNames.join(', ')} - ${failedErrors.join('; ')}`;
      } else {
        message = `❌ Lock & Load Failed (${failedCount}/${totalProfiles} profiles): ${failedNames.join(', ')} - Unknown error`;
      }
    }
    
    // Use already calculated counts for broadcast (no need to recalculate)
    broadcast({
      type: 'prefire_result',
      success: anyLocked, // Success if ANY account succeeded
      armed: anyLocked, // ARMED if ANY account succeeded
      allOddsLocked,
      anyOddsChanged,
      marketNotAvailable: anyUnavailable,
      eventNotAvailable: anyEventNotAvailable,
      oddId,
      gameId,
      selection: finalSelection,
      odds: finalOdds,
      successCount, // Number of successful accounts
      failedCount, // Number of failed accounts
      totalProfiles: results.length,
      isPartialSuccess: successCount > 0 && successCount < results.length,
      message: anyUnavailable
        ? `⚠️ Market / Event Not Available: This selection is no longer available for betting`
        : message,
      profileResults: results
    });
    
    // Save logs after response is sent
    setImmediate(() => saveLogs());
    
    // Use already calculated counts for response (no need to recalculate)
    let responseMessage;
    if (anyMarketNotAvailable) {
      responseMessage = `⚠️ Market Not Available: This market is no longer available for betting`;
    } else if (anyLocked) {
      if (successCount === results.length) {
        responseMessage = `🔒 ARMED! All ${successCount} profile(s) verified locked at ${finalOdds}. Ready to place bet!`;
      } else {
        responseMessage = `🔒 ARMED! ${successCount}/${results.length} profile(s) locked at ${finalOdds}. ${failedCount} profile(s) failed. Ready to place bet on ${successCount} account(s)!`;
      }
    } else if (anyOddsChanged) {
      responseMessage = `❌ Lock & Load Failed. Odds changed on some profiles. Expected ${finalOdds}, but odds may have moved.`;
    } else {
      responseMessage = `❌ Lock & Load Failed. ${failedCount}/${results.length} profile(s) failed to place bet.`;
    }
    
    return res.json({ 
      success: anyLocked, // Success if ANY profile succeeded (partial success OK)
      armed: anyLocked, // ARMED status - ready to place bet if ANY succeeded
      message: responseMessage,
      betPlaced: allBetsPlaced,
      allOddsLocked: allLocked, // True only if ALL succeeded
      anyOddsChanged: anyOddsChanged,
      marketNotAvailable: anyUnavailable,
      eventNotAvailable: anyEventNotAvailable,
      lockedOdds: anyLocked ? finalOdds : null, // Use odds if ANY succeeded
      successCount, // Number of successful accounts
      failedCount, // Number of failed accounts
      totalProfiles: results.length,
      isPartialSuccess: successCount > 0 && successCount < results.length,
      profileResults: results
    });
    
  } catch (e) {
    console.error('Lock & Load error:', e);
    setImmediate(() => saveLogs());
    const errorMsg = e.message || e.toString() || 'Unknown error occurred during Lock & Load';
    return res.status(500).json({ error: errorMsg, details: e.stack });
  }
});

// RELOAD PAGE - Refresh page for all profiles or a specific profile
app.post('/api/reload-page', async (req, res) => {
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  const { profileName } = req.body || {};
  
  try {
    const profilesToReload = [];
    
    if (profileName) {
      // Reload specific profile
      const client = fliffClients.get(profileName);
      if (!client) {
        return res.status(404).json({ error: `Profile "${profileName}" not found` });
      }
      if (!client.page || !client.browser) {
        return res.status(500).json({ error: `Profile "${profileName}" not ready (no page/browser)` });
      }
      profilesToReload.push({ name: profileName, client });
    } else {
      // Reload all profiles
      for (const [name, client] of fliffClients.entries()) {
        if (client.page && client.browser) {
          profilesToReload.push({ name, client });
        }
      }
    }
    
    if (profilesToReload.length === 0) {
      return res.status(500).json({ error: 'No profiles ready to reload' });
    }
    
    logBetting(`🔄 RELOAD PAGE (${profilesToReload.length} profile(s))${profileName ? `: ${profileName}` : ' (all profiles)'}`);
    
    const reloadPromises = profilesToReload.map(({ name, client }) => 
      (async () => {
        try {
          const result = await client.reloadPage();
          logBetting(`   [${name}] ${result.success ? '✅ Page reloaded' : '❌ Reload failed: ' + (result.error || 'Unknown error')}`);
          return {
            profileName: name,
            success: result.success,
            error: result.error || null
          };
        } catch (e) {
          logBetting(`   [${name}] ❌ Reload error: ${e.message}`);
          return {
            profileName: name,
            success: false,
            error: e.message
          };
        }
      })()
    );
    
    const results = await Promise.all(reloadPromises);
    const allSuccess = results.every(r => r.success);
    const anySuccess = results.some(r => r.success);
    
    return res.json({
      success: allSuccess,
      message: allSuccess 
        ? `All ${results.length} profile(s) reloaded successfully`
        : anySuccess
          ? `Some profiles reloaded (${results.filter(r => r.success).length}/${results.length})`
          : 'All reloads failed',
      profileResults: results
    });
    
  } catch (e) {
    console.error('Reload page error:', e);
    return res.status(500).json({ error: e.message || 'Unknown error occurred during page reload' });
  }
});

// PLACE BET - Places bet with Fliff Cash (uses wager amount from dashboard)
// Now works with ALL profiles - sends bet to each profile with their respective bearer token
app.post('/api/place-bet', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, wager } = req.body;
  
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  // Log which profiles will receive the bet (only betting profiles)
  const bettingProfileNames = Array.from(fliffClients.entries())
    .filter(([name, client]) => !client.isLiveEventProfile)
    .map(([name]) => name);
  const bettingProfileCount = bettingProfileNames.length;
  logBetting(`💰 PLACE BET (${bettingProfileCount} profile(s)): ${selection} @ ${odds} - $${wager} (Cash)`);
  logBetting(`   Profiles: ${bettingProfileNames.join(', ')}`);
  
  try {
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    let finalSelection = selection;
    let finalOdds = odds;
    let finalParam = param;
    let finalMarket = market;
    
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        finalSelection = storedOdd.selection || selection;
        finalOdds = storedOdd.odds || odds;
        finalParam = storedOdd.param || param;
        finalMarket = storedOdd.market || market;
      }
    }
    
    // Send place-bet request to ALL profiles with their respective bearer tokens
    const profileResults = [];
    const profilePromises = [];
    
    // Verify all clients are ready
    const readyClients = [];
    const notReadyClients = [];
    
    for (const [profileName, client] of fliffClients.entries()) {
      // Only use betting profiles for placing bets
      if (client.isLiveEventProfile) {
        continue; // Skip live event profiles
      }
      if (!client.page || !client.browser) {
        notReadyClients.push(profileName);
        logBetting(`   ⚠️ [${profileName}] Client not ready (no page/browser)`);
        continue;
      }
      readyClients.push({ name: profileName, client });
    }
    
    if (readyClients.length === 0) {
      logBetting(`   ❌ No clients ready to place bets!`);
      return res.status(500).json({ 
        error: 'No clients ready', 
        notReady: notReadyClients,
        totalClients: fliffClients.size
      });
    }
    
    if (notReadyClients.length > 0) {
      logBetting(`   ⚠️ ${notReadyClients.length} client(s) not ready: ${notReadyClients.join(', ')}`);
    }
    
    logBetting(`   ✅ ${readyClients.length} client(s) ready to place bets`);
    logBetting(`   📋 Processing profiles: ${readyClients.map(c => c.name).join(', ')}`);
    
    for (const { name: profileName, client } of readyClients) {
      logBetting(`   [${profileName}] Placing bet: ${finalSelection} @ ${finalOdds} - $${wager} (Cash)`);
      
      // Check if client has betting endpoint or will use Puppeteer
      const apiStatus = client.getBettingAPIStatus();
      if (apiStatus.endpoint) {
        logBetting(`      Using API endpoint: ${apiStatus.endpoint.substring(0, 50)}...`);
      } else {
        logBetting(`      Using Puppeteer method (no API endpoint captured)`);
      }
      
      const profilePromise = (async () => {
        try {
          // STEP 1: Acquire bearer token at this moment (when Ready to Bet is clicked)
          logBetting(`   [${profileName}] 🔑 Step 1: Acquiring bearer token...`);
          let tokenAcquired = false;
          try {
            const tokenResult = await client.captureCurrentBearerToken();
            if (tokenResult.success && tokenResult.token) {
              client.bearerToken = tokenResult.token;
              client.saveAPICredentials();
              tokenAcquired = true;
              logBetting(`   [${profileName}] ✅ Bearer token acquired from ${tokenResult.source || 'page'}`);
            } else {
              // Fallback to existing token if available
              if (client.bearerToken || client.authToken) {
                logBetting(`   [${profileName}] ⚠️ Could not acquire new token, using stored token`);
              } else {
                logBetting(`   [${profileName}] ⚠️ No bearer token available - bet may fail`);
              }
            }
          } catch (e) {
            logBetting(`   [${profileName}] ⚠️ Error acquiring token: ${e.message}, using stored token if available`);
            if (!client.bearerToken && !client.authToken) {
              return {
                profileName,
                success: false,
                retry: false,
                message: 'Error acquiring bearer token',
                error: `Could not acquire bearer token: ${e.message}`,
                unauthorized: false
              };
            }
          }
          
          // Check API status before placing bet
          const apiStatus = client.getBettingAPIStatus();
          if (!apiStatus.endpoint) {
            logBetting(`   [${profileName}] ⚠️ No API endpoint captured - will use Puppeteer method`);
          } else if (!apiStatus.hasAuth) {
            logBetting(`   [${profileName}] ⚠️ API endpoint found but no auth token - bet may fail`);
          } else {
            logBetting(`   [${profileName}] ✅ API ready: endpoint + auth token available`);
          }
          
          // STEP 2: Check if we have a locked API request for this oddId (from lock and load)
          const hasLockedRequest = client.getLockedAPIRequest(oddId);
          if (hasLockedRequest) {
            logBetting(`   [${profileName}] 🔒 Step 2: Using stored locked endpoint for oddId: ${oddId}`);
            logBetting(`   [${profileName}] 🔒 Step 3: Placing bet with locked endpoint (ignoring odds changes)...`);
            
            // Use locked API request - only change the wager amount
            // IMPORTANT: We don't check for odds changes when using locked requests
            // The user only cares about using the stored endpoint
            const betResult = await client.placeBetViaAPI(finalSelection, finalOdds, wager, 'cash', finalParam, finalMarket, oddId, true);
            
            if (betResult.success) {
              logBet({
                type: 'bet',
                selection: finalSelection,
                odds: finalOdds,
                wager,
                coinType: 'cash',
                profile: profileName,
                result: 'accepted',
                timestamp: Date.now()
              });
              
              logBetting(`   [${profileName}] ✅ Step 4: Bet placed successfully using locked endpoint`);
              
              return {
                profileName,
                success: true,
                message: `Bet placed (locked endpoint): ${finalSelection} @ ${finalOdds} - $${wager}`,
                error: null,
                step: 'completed'
              };
            }
            
            // Check for unauthorized error
            const errorMsg = betResult.error || '';
            const isUnauthorized = errorMsg.toLowerCase().includes('unauthorized') || 
                                  errorMsg.toLowerCase().includes('401') ||
                                  errorMsg.toLowerCase().includes('authentication');
            
            logBetting(`   [${profileName}] ❌ Step 4: Bet failed: ${errorMsg}`);
            
            return {
              profileName,
              success: false,
              retry: isUnauthorized, // Retry if unauthorized (token might need refresh)
              message: 'Bet failed',
              error: errorMsg || 'Bet failed',
              marketNotAvailable: betResult.marketNotAvailable || betResult.eventNotAvailable || false,
              eventNotAvailable: betResult.eventNotAvailable || false,
              unauthorized: isUnauthorized,
              step: 'failed'
            };
          }
          
          // No locked request - use regular place bet method
          logBetting(`   [${profileName}] ⚠️ No locked endpoint found, using regular method`);
          logBetting(`   [${profileName}] Step 2: Placing bet with regular method...`);
          
          // Place bet with Fliff Cash (uses profile's bearer token automatically)
          const betResult = await client.placeBet(finalSelection, finalOdds, wager, 'cash', finalParam, finalMarket, oddId);
          
          if (betResult.success) {
            logBet({
              type: 'bet',
              selection: finalSelection,
              odds: finalOdds,
              wager,
              coinType: 'cash',
              profile: profileName,
              result: 'accepted',
              timestamp: Date.now()
            });
            
            logBetting(`   [${profileName}] ✅ Bet placed successfully`);
            
            return {
              profileName,
              success: true,
              message: `Bet placed: ${finalSelection} @ ${finalOdds} - $${wager}`,
              error: null,
              step: 'completed'
            };
          }
          
          // Only check for odds changed if NOT using locked request
          // When using locked request, we ignore odds changes
          if (betResult.oddsChanged) {
            logBetting(`   [${profileName}] ⚠️ Odds changed (but this is only checked for non-locked bets)`);
            return {
              profileName,
              success: false,
              retry: true,
              message: 'Odds changed',
              error: 'Odds changed',
              step: 'odds_changed'
            };
          }
          
          // Check for unauthorized error
          const errorMsg = betResult.error || '';
          const isUnauthorized = errorMsg.toLowerCase().includes('unauthorized') || 
                                errorMsg.toLowerCase().includes('401') ||
                                errorMsg.toLowerCase().includes('authentication');
          
          logBetting(`   [${profileName}] ❌ Bet failed: ${errorMsg}`);
          
          return {
            profileName,
            success: false,
            retry: isUnauthorized,
            message: 'Bet failed',
            error: errorMsg || 'Bet failed',
            unauthorized: isUnauthorized,
            step: 'failed'
          };
        } catch (e) {
          logBetting(`   [${profileName}] ❌ Error: ${e.message}`);
          const errorMsg = e.message || '';
          const isUnauthorized = errorMsg.toLowerCase().includes('unauthorized') || 
                                errorMsg.toLowerCase().includes('401') ||
                                errorMsg.toLowerCase().includes('authentication');
          
          return {
            profileName,
            success: false,
            retry: isUnauthorized,
            message: 'Error',
            error: errorMsg,
            unauthorized: isUnauthorized,
            step: 'error'
          };
        }
      })();
      
      profilePromises.push(profilePromise);
    }
    
    // Wait for all profiles to complete
    const results = await Promise.all(profilePromises);
    
    // Analyze results
    const successfulBets = results.filter(r => r.success);
    const failedBets = results.filter(r => !r.success);
    const oddsChangedBets = results.filter(r => r.retry);
    
    // Log detailed results
    const unauthorizedBets = results.filter(r => r.unauthorized);
    logBetting(`\n📊 Bet Results Summary:`);
    logBetting(`   Total profiles attempted: ${results.length}`);
    logBetting(`   Successful: ${successfulBets.length}`);
    logBetting(`   Failed: ${failedBets.length}`);
    logBetting(`   Odds changed: ${oddsChangedBets.length}`);
    if (unauthorizedBets.length > 0) {
      logBetting(`   🔐 Unauthorized: ${unauthorizedBets.length} (bearer token may be expired)`);
    }
    
    if (successfulBets.length > 0) {
      logBetting(`   ✅ Success on: ${successfulBets.map(r => r.profileName).join(', ')}`);
    }
    if (failedBets.length > 0) {
      failedBets.forEach(r => {
        const errorType = r.unauthorized ? '🔐 UNAUTHORIZED' : '❌';
        logBetting(`   ${errorType} Failed on ${r.profileName}: ${r.error || 'Unknown error'}`);
        if (r.unauthorized) {
          logBetting(`      → Bearer token may be expired or invalid. Try refreshing the page for this profile.`);
        }
      });
    }
    if (oddsChangedBets.length > 0) {
      logBetting(`   ⚠️ Odds changed on: ${oddsChangedBets.map(r => r.profileName).join(', ')}`);
    }
    if (unauthorizedBets.length > 0) {
      logBetting(`   🔐 Unauthorized errors on: ${unauthorizedBets.map(r => r.profileName).join(', ')}`);
      logBetting(`      → These profiles may need to refresh their bearer tokens.`);
    }
    
    // Update stats
    accountStats.totalBets += successfulBets.length;
    accountStats.pending += successfulBets.length;
    accountStats.totalWagered += wager * successfulBets.length;
    
    // Build message
    let message;
    const totalExpected = readyClients.length;
    if (successfulBets.length === totalExpected) {
      message = `✅ Bet placed on all ${totalExpected} profile(s): ${finalSelection} @ ${finalOdds} - $${wager}`;
    } else if (successfulBets.length > 0) {
      const successProfiles = successfulBets.map(r => r.profileName).join(', ');
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `⚠️ Bet placed on ${successfulBets.length}/${totalExpected} profile(s). Success: ${successProfiles}. Failed: ${failProfiles}`;
    } else {
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `❌ Bet failed on all profiles: ${failProfiles}`;
    }
    
    // Warn if some clients weren't ready
    if (notReadyClients.length > 0) {
      message += ` (${notReadyClients.length} profile(s) not ready: ${notReadyClients.join(', ')})`;
    }
    
    broadcast({
      type: 'prefire_result',
      success: successfulBets.length > 0,
      message: message,
      profileResults: results
    });
    
    setImmediate(() => saveLogs());
    
    if (oddsChangedBets.length > 0) {
      return res.json({ 
        success: false, 
        retry: true, 
        message: `Odds changed on ${oddsChangedBets.length} profile(s). Click again to retry.`,
        profileResults: results
      });
    }
    
    if (successfulBets.length === 0) {
      return res.json({ 
        success: false, 
        error: 'Bet failed on all profiles',
        profileResults: results
      });
    }
    
    return res.json({ 
      success: true, 
      message: `Bet placed on ${successfulBets.length}/${fliffClients.size} profile(s)!`,
      profileResults: results
    });
    
  } catch (e) {
    console.error('Place bet error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// =============================================
// API ENDPOINTS - ADMIN
// =============================================

// Get all bet logs
app.get('/api/admin/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = betLogs.slice(-limit).reverse();
  res.json(logs);
});

// Get account statistics
app.get('/api/admin/stats', (req, res) => {
  res.json({
    ...accountStats,
    winRate: accountStats.totalBets > 0 
      ? ((accountStats.wins / accountStats.totalBets) * 100).toFixed(1) + '%'
      : '0%',
    prefireRate: accountStats.prefireAttempts > 0
      ? ((accountStats.prefireSuccess / accountStats.prefireAttempts) * 100).toFixed(1) + '%'
      : '0%',
    profit: accountStats.totalWon - accountStats.totalWagered
  });
});

// Update bet result (win/loss)
app.post('/api/admin/result', (req, res) => {
  const { betId, result, payout } = req.body;
  
  // Find and update bet
  const bet = betLogs.find(b => b.id === betId);
  if (bet) {
    bet.result = result;
    bet.payout = payout;
    
    accountStats.pending--;
    if (result === 'win') {
      accountStats.wins++;
      accountStats.totalWon += payout;
    } else {
      accountStats.losses++;
    }
    
    setImmediate(() => saveLogs());
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Bet not found' });
  }
});

// Clear logs
app.post('/api/admin/clear', (req, res) => {
  betLogs.length = 0;
  Object.assign(accountStats, {
    totalBets: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    totalWagered: 0,
    totalWon: 0,
    prefireAttempts: 0,
    prefireSuccess: 0
  });
  saveLogs();
  res.json({ success: true });
});

// =============================================
// HELPER FUNCTIONS
// =============================================

// Verify that a bet was actually placed by checking API response
async function verifyBetPlaced(client, betResult, selection, odds) {
  // If bet was placed via API, check the response
  if (betResult.response) {
    const response = betResult.response;
    const status = response.status || response.result?.status;
    
    // Status 8301 and 8300 = confirmed placed (as seen in other bots)
    if (status === 8301 || status === '8301' || status === 8300 || status === '8300') {
      return {
        confirmed: true,
        status: status,
        reason: `API confirmed (status ${status})`
      };
    }
    
    // Other success indicators
    if (response.id || response.bet_id || response.ticket_id) {
      return {
        confirmed: true,
        status: status || 'success',
        reason: 'API returned bet ID'
      };
    }
    
    // If status exists but not 8301, still consider it placed if HTTP was 200
    if (status && betResult.success) {
      return {
        confirmed: true,
        status: status,
        reason: `API returned status ${status}`
      };
    }
    
    // If no status but response exists and success=true, assume placed
    if (betResult.success && !response.error) {
      return {
        confirmed: true,
        status: 'unknown',
        reason: 'API returned success but no status code'
      };
    }
  }
  
  // If bet was placed via Puppeteer, we can't verify easily
  if (betResult.success && !betResult.response) {
    return {
      confirmed: false,
      status: null,
      reason: 'Placed via Puppeteer - cannot verify via API'
    };
  }
  
  return {
    confirmed: false,
    status: null,
    reason: 'No response data or bet failed'
  };
}

// =============================================
// HELPER FUNCTIONS - SEPARATE LOGGING
// =============================================

// Betting logs (separate from odds)
function logBet(bet) {
  bet.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  betLogs.push(bet);
  const timestamp = new Date().toLocaleTimeString();
  console.log(`💰 [BET ${timestamp}] ${bet.type.toUpperCase()}: ${bet.selection} @ ${bet.odds > 0 ? '+' : ''}${bet.odds} = ${bet.result}`);
  
  // Auto-save every 10 bets (use setImmediate to prevent nodemon restart)
  if (betLogs.length % 10 === 0) {
    setImmediate(() => saveLogs());
  }
}

// =============================================
// SEPARATE CONSOLE LOGGING - Reduced noise
// =============================================

// Odds fetching logs - ROUTE TO SEPARATE LOGGING SERVER (Port 3002)
function logOdds(message, data = {}) {
  if (!LOG_CONFIG.ODDS_VERBOSE && !LOG_CONFIG.ODDS_SUMMARY) return;
  if (!LOG_CONFIG.ODDS_VERBOSE && !data.summary) return;
  logToSeparateServer('ODDS', message, data);
}

// Summary-only odds log - ROUTE TO SEPARATE LOGGING SERVER
function logOddsSummary(message) {
  if (!LOG_CONFIG.ODDS_SUMMARY) return;
  logToSeparateServer('ODDS_SUMMARY', message);
}

// Betting action logs - MAIN CONSOLE ONLY (Port 3001) - PRIORITY
function logBetting(message) {
  if (!LOG_CONFIG.BETTING) return;
  const timestamp = new Date().toLocaleTimeString();
  console.log(`💰 [BET ${timestamp}] ${message}`);
}

// Live game/score logs - ROUTE TO SEPARATE LOGGING SERVER
function logLive(message) {
  if (!LOG_CONFIG.LIVE) return;
  logToSeparateServer('LIVE', message);
}

// Performance warnings - ROUTE TO SEPARATE LOGGING SERVER
function logPerf(message) {
  if (!LOG_CONFIG.PERFORMANCE) return;
  logToSeparateServer('PERFORMANCE', message);
}

// Profile/WebSocket/System logs - ROUTE TO SEPARATE LOGGING SERVER
function logSystem(message, data = {}) {
  logToSeparateServer('SYSTEM', message, data);
}

// =============================================
// WEBSOCKET
// =============================================

wss.on('connection', (ws) => {
  clients.add(ws);
  logSystem('📱 Client connected');
  
  ws.send(JSON.stringify({
    type: 'init',
    games: Array.from(liveGames.values()),
    stats: stats
  }));
  
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      if (data.type === 'subscribe' && data.gameId) {
        const gameId = parseInt(data.gameId);
        ws.gameId = gameId;
        
        // =============================================
        // PERFORMANCE: Set selectedGameId
        // This tells handleOddsUpdate to ONLY process this game
        // All other game odds are SKIPPED to prevent lag
        // =============================================
        selectedGameId = gameId;
        logSystem(`🎯 SELECTED GAME: ${gameId} - Only processing odds for this game now`);
        
        const odds = gameOdds.get(gameId) || new Map();
        const oddsArray = Array.from(odds.values());
        
        logSystem(`📺 Subscribe: game ${gameId}, sending ${oddsArray.length} odds${data.priority ? ' (PRIORITY)' : ''}`);
        
        // Send existing odds immediately
        ws.send(JSON.stringify({
          type: 'odds',
          gameId: gameId,
          odds: oddsArray
        }));
        
        // If priority subscription, also set this as the priority game
        if (data.priority) {
          priorityGameId = gameId;
          
          // Schedule periodic updates for priority game (reduced frequency for performance)
          if (priorityGameUpdateInterval) {
            clearInterval(priorityGameUpdateInterval);
          }
          priorityGameUpdateInterval = setInterval(() => {
            const freshOdds = gameOdds.get(gameId) || new Map();
            const freshOddsArray = Array.from(freshOdds.values());
            
            // Only send to clients subscribed to this game
            clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.gameId === gameId) {
                client.send(JSON.stringify({
                  type: 'odds_update',
                  gameId: gameId,
                  odds: freshOddsArray,
                  count: freshOddsArray.length
                }));
              }
            });
          }, 1000); // Reduced from 500ms to 1000ms for performance
          
          // Clear priority after 30 seconds (extended for better user experience)
          setTimeout(() => {
            if (priorityGameId === gameId) {
              priorityGameId = null;
              if (priorityGameUpdateInterval) {
                clearInterval(priorityGameUpdateInterval);
                priorityGameUpdateInterval = null;
              }
              logSystem(`🔓 Priority cleared for game ${gameId}`);
            }
          }, 30000);
        }
      }
      
      // Handle unsubscribe - clear selected game when user leaves game view
      if (data.type === 'unsubscribe') {
        if (selectedGameId === ws.gameId) {
          logSystem(`🔓 SELECTED GAME CLEARED - will process all odds again`);
          selectedGameId = null;
        }
        ws.gameId = null;
      }
    } catch (e) {
      logSystem(`WS message error: ${e.message}`, { error: e.stack });
    }
  });
  
  ws.on('close', () => {
    clients.delete(ws);
    logSystem('📱 Client disconnected');
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastToGame(gameId, data) {
  const msg = JSON.stringify(data);
  const gid = parseInt(gameId);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.gameId === gid) {
      ws.send(msg);
    }
  });
}

// =============================================
// FLIFF HANDLERS
// =============================================

function handleGameUpdate(game) {
  // =============================================
  // PERFORMANCE: Only process selected game
  // Skip ALL game processing for non-selected games
  // =============================================
  if (selectedGameId !== null && game.id !== selectedGameId) {
    // Silently skip - don't process games that aren't selected
    // Only store minimal game info for the list view
    if (!liveGames.has(game.id)) {
      liveGames.set(game.id, game);
    }
    return;
  }
  
  const existing = liveGames.get(game.id);
  
  // Only log score changes and new games (reduces noise)
  if (existing && (existing.homeScore !== game.homeScore || existing.awayScore !== game.awayScore)) {
    logLive(`⚽ SCORE: ${game.home} ${game.homeScore} - ${game.awayScore} ${game.away}`);
    broadcast({ type: 'score', game });
  } else if (!existing) {
    logLive(`🎮 NEW GAME: ${game.home} vs ${game.away} (${game.sport})`);
  }
  
  liveGames.set(game.id, game);
  
  if (!gameOdds.has(game.id)) {
    gameOdds.set(game.id, new Map());
  }
  
  // Only broadcast game updates (not all odds) - this is lightweight
  broadcast({ type: 'game', game });
}

function handleOddsUpdate(gameId, odd) {
  const gid = parseInt(gameId);
  
  // =============================================
  // PERFORMANCE OPTIMIZATION: Only process selected game
  // Skip ALL odds processing for non-selected games
  // This is the main fix for lag with many live games
  // =============================================
  if (selectedGameId !== null && gid !== selectedGameId) {
    // Silently skip - don't even log (causes lag)
    // Early return saves CPU cycles and memory
    return;
  }
  
  // Additional optimization: Skip if no clients are subscribed to this game
  let hasSubscribers = false;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.gameId === gid) {
      hasSubscribers = true;
    }
  });
  
  if (!hasSubscribers && selectedGameId === null) {
    // No one is watching this game, skip processing
    return;
  }
  
  // VERIFICATION: Ensure odd belongs to this game
  const game = liveGames.get(gid);
  if (!game) {
    // Don't log this - causes noise
    return;
  }
  
  // Quick gameId mismatch check (no logging for performance)
  if (odd.gameId && parseInt(odd.gameId) !== gid) {
    return;
  }
  
  // Skip odds without event info silently
  if (!odd.event) {
    return;
  }
  
  // =============================================
  // SIMPLIFIED VERIFICATION (for selected game only)
  // Only do expensive team matching for selected game
  // =============================================
  const eventInfo = (odd.event || '').toLowerCase().trim();
  const homeName = (game.home || '').toLowerCase().trim();
  const awayName = (game.away || '').toLowerCase().trim();
  
  // Quick check: does event contain at least one team name word?
  const homeWords = homeName.split(/\s+/).filter(w => w.length > 2);
  const awayWords = awayName.split(/\s+/).filter(w => w.length > 2);
  const hasHomeWord = homeWords.some(word => eventInfo.includes(word));
  const hasAwayWord = awayWords.some(word => eventInfo.includes(word));
  
  // Simple match: at least one significant word from either team
  if (!hasHomeWord && !hasAwayWord) {
    // Skip silently - no verbose logging
    return;
  }
  
  let odds = gameOdds.get(gid);
  if (!odds) {
    odds = new Map();
    gameOdds.set(gid, odds);
  }
  
  const existing = odds.get(odd.id);
  
  // Only log BIG odds changes (reduce console noise for performance)
  if (existing && existing.odds !== odd.odds) {
    // Only log if odds changed by more than 10 (was 5)
    if (Math.abs(odd.odds - existing.odds) >= 10) {
      const dir = odd.odds > existing.odds ? '📈' : '📉';
      logLive(`${dir} ${odd.selection}: ${existing.odds} → ${odd.odds}`);
    }
  }
  
  odds.set(odd.id, odd);
  
  // =============================================
  // PERFORMANCE: Only broadcast to game subscribers
  // REMOVED: broadcast to ALL clients (was causing lag)
  // =============================================
  try {
    broadcastToGame(gid, { type: 'odd', gameId: gid, odd });
    // REMOVED: broadcast({ type: 'odd_update', gameId: gid, odd }); - caused lag with many games
  } catch (e) {
    // Silently fail - don't spam console
  }
}

function handleStats(newStats) {
  stats = { ...stats, ...newStats };
  broadcast({ type: 'stats', stats });
}

// =============================================
// PROFILE DISCOVERY
// =============================================

function discoverProfiles() {
  const liveEventProfiles = [];
  const bettingProfiles = [];
  const profilesDir = path.join(__dirname, '..', 'profiles');
  
  // Directories to exclude from profile discovery
  const excludedDirs = new Set([
    'node_modules',
    'backend',
    'frontend',
    'assets',
    '.git',
    '.vscode',
    '.idea'
  ]);
  
  logSystem('🔍 Discovering profiles...');
  
  // Check if profiles directory exists
  if (!fs.existsSync(profilesDir)) {
    console.log('⚠️ Profiles directory not found, creating it...');
    fs.mkdirSync(profilesDir, { recursive: true });
    return { liveEvent: liveEventProfiles, betting: bettingProfiles };
  }
  
  // Check for profile directories in profiles folder
  const items = fs.readdirSync(profilesDir, { withFileTypes: true });
  
  for (const item of items) {
    // Skip if not a directory or in excluded list
    if (!item.isDirectory() || item.name.startsWith('.') || excludedDirs.has(item.name)) {
      continue;
    }
    
    const settingsPath = path.join(profilesDir, item.name, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const profileName = settings.name || item.name;
        const profileData = {
          name: profileName,
          directory: path.join('profiles', item.name),
          settings: settings,
          settingsPath: settingsPath
        };
        
        // Determine if this is a live event profile or betting profile
        // Live Event profiles: name contains "Live Event" or "live" (case insensitive) OR no account_number
        // Betting profiles: have account_number set and not empty
        const isLiveEvent = item.name.toLowerCase().includes('live event') || 
                           item.name.toLowerCase().includes('liveevent') ||
                           profileName.toLowerCase().includes('live event') ||
                           !settings.account_number || 
                           settings.account_number === '' ||
                           settings.account_number === null;
        
        if (isLiveEvent) {
          liveEventProfiles.push(profileData);
          logSystem(`   📡 Found LIVE EVENT profile: ${profileName} (${item.name}) - for data scraping only`);
        } else {
          bettingProfiles.push(profileData);
          logSystem(`   💰 Found BETTING profile: ${profileName} (${item.name}) - account: ${settings.account_number || 'N/A'}`);
        }
      } catch (e) {
        console.log(`   ⚠️ Could not load profile ${item.name}: ${e.message}`);
      }
    }
  }
  
  logSystem(`\n📋 Total profiles discovered:`);
  logSystem(`   📡 Live Event (scraping only): ${liveEventProfiles.length}`);
  logSystem(`   💰 Betting (with accounts): ${bettingProfiles.length}\n`);
  
  return { liveEvent: liveEventProfiles, betting: bettingProfiles };
}

// =============================================
// START
// =============================================

async function startFliff() {
  // Discover all profiles (separated into live event and betting)
  const { liveEvent: liveEventProfiles, betting: bettingProfiles } = discoverProfiles();
  
  const allProfiles = [...liveEventProfiles, ...bettingProfiles];
  
  if (allProfiles.length === 0) {
    console.log('⚠️ No profiles found, using default ray profile');
    // Fallback to default - check if profiles/ray exists
    const defaultSettingsPath = path.join(__dirname, '..', 'profiles', 'ray', 'settings.json');
    if (!fs.existsSync(defaultSettingsPath)) {
      console.log('❌ Default profile not found at profiles/ray/settings.json');
      return;
    }
    fliffClient = new FliffClient({
      onGame: handleGameUpdate,
      onOdds: handleOddsUpdate,
      onStats: handleStats,
      onConnect: () => {
        stats.connected = true;
        broadcast({ type: 'connected' });
      },
      onDisconnect: () => {
        stats.connected = false;
        broadcast({ type: 'disconnected' });
      }
    }, 'ray'); // Pass 'ray' as profile directory for fallback
    
    await fliffClient.start();
    fliffClients.set('default', fliffClient);
    return;
  }
  
  logSystem(`\n📋 Starting ${allProfiles.length} profile(s):`);
  logSystem(`   📡 Live Event profiles: ${liveEventProfiles.length} (data scraping only)`);
  logSystem(`   💰 Betting profiles: ${bettingProfiles.length} (with logged-in accounts)`);
  logSystem('');
  
  // Track which profiles failed to start
  const failedProfiles = [];
  
  // Start all profiles with delays to avoid conflicts
  // With many profiles, use shorter delays but still stagger them
  const delayBetweenProfiles = Math.max(2000, Math.min(3000, 3000 / Math.sqrt(allProfiles.length))); // Adaptive delay
  
  for (let i = 0; i < allProfiles.length; i++) {
    const profile = allProfiles[i];
    const isLiveEvent = liveEventProfiles.includes(profile);
    try {
      // Add delay between profile startups to avoid browser conflicts
      if (i > 0) {
        const delay = delayBetweenProfiles * i; // Staggered delay
        logSystem(`⏳ [${i + 1}/${allProfiles.length}] Waiting ${(delay/1000).toFixed(1)}s before starting ${profile.name}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      const profileType = isLiveEvent ? '📡 LIVE EVENT' : '💰 BETTING';
      logSystem(`🚀 [${i + 1}/${allProfiles.length}] Starting ${profileType} profile: ${profile.name}...`);
      
      // Extract profile directory name from profile.directory (e.g., "profiles/justin-voneck" -> "justin-voneck")
      const profileDirName = path.basename(profile.directory);
      
      // Create a FliffClient with profile-specific directory
      const client = new FliffClient({
        onGame: (game) => {
          // Merge games from all profiles (use first one that reports it)
          handleGameUpdate(game);
        },
        onOdds: (gameId, odd) => {
          // Store odds per profile
          handleOddsUpdate(gameId, odd);
        },
        onStats: (newStats) => {
          // Aggregate stats
          handleStats(newStats);
        },
        onConnect: () => {
          stats.connected = true;
          broadcast({ type: 'connected', profile: profile.name, profileType: isLiveEvent ? 'liveEvent' : 'betting' });
        },
        onDisconnect: () => {
          broadcast({ type: 'disconnected', profile: profile.name, profileType: isLiveEvent ? 'liveEvent' : 'betting' });
        }
      }, profileDirName);
      
      // Mark client as live event or betting profile
      client.isLiveEventProfile = isLiveEvent;
      client.isBettingProfile = !isLiveEvent;
      
      // Override settings to use profile-specific settings
      client.settings = profile.settings;
      
      // Reload API credentials with profile-specific path (now handled by FliffClient constructor)
      client.loadAPICredentials();
      
      // Override browser data path to use profile-specific directory
      const originalStart = client.start;
      client.start = async function() {
        // Temporarily override browser data path
        const browserDataPath = path.join(__dirname, '..', profile.directory, 'browser_data');
        
        // Call original start but with modified browser data path
        logSystem(`🎮 Starting Fliff Client for ${profile.name}...`);
        logSystem(`Profile: ${this.settings.name}`);
        
        const proxy = this.parseProxy(this.settings.proxy);
        if (proxy) {
          logSystem(`Proxy: ${proxy.host}:${proxy.port}`);
        }
        
        // Show API credentials status
        if (this.bettingEndpoint) {
          logSystem(`📂 Using persisted betting endpoint: ${this.bettingEndpoint}`);
        }
        if (this.bearerToken || this.authToken) {
          logSystem(`📂 Using persisted authentication tokens`);
        }

        try {
          // Detect OS and set Chrome path (same as original)
          let chromePath;
          if (process.platform === 'win32') {
            const possiblePaths = [
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
              'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
              path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
              path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
              path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe')
            ];
            chromePath = possiblePaths.find(p => p && fs.existsSync(p));
            if (!chromePath) {
              throw new Error('Chrome not found');
            }
          } else if (process.platform === 'darwin') {
            chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
            if (!fs.existsSync(chromePath)) {
              throw new Error('Chrome not found at: ' + chromePath);
            }
          } else {
            const linuxPaths = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
            chromePath = linuxPaths.find(p => fs.existsSync(p));
            if (!chromePath) {
              throw new Error('Chrome/Chromium not found');
            }
          }
          
          logSystem(`🚀 [${profile.name}] Launching browser with data dir: ${browserDataPath}`);
          
          // Ensure browser data directory exists
          if (!fs.existsSync(browserDataPath)) {
            fs.mkdirSync(browserDataPath, { recursive: true });
            logSystem(`📁 [${profile.name}] Created browser data directory`);
          }
          
          // Check for lockfile that might indicate browser is already running
          const lockfilePath = path.join(browserDataPath, 'lockfile');
          if (fs.existsSync(lockfilePath)) {
            logSystem(`⚠️ [${profile.name}] Lockfile found - browser may already be running for this profile`);
            console.log(`   Attempting to continue anyway...`);
            // Try to remove lockfile (it's safe if browser isn't actually running)
            try {
              fs.unlinkSync(lockfilePath);
              console.log(`   ✅ Removed stale lockfile`);
            } catch (e) {
              console.log(`   ⚠️ Could not remove lockfile (browser may be running): ${e.message}`);
            }
          }
          
          // Check for DevToolsActivePort which might indicate browser is running
          const devToolsPortPath = path.join(browserDataPath, 'DevToolsActivePort');
          if (fs.existsSync(devToolsPortPath)) {
            try {
              const portContent = fs.readFileSync(devToolsPortPath, 'utf8').trim();
              if (portContent) {
                logSystem(`⚠️ [${profile.name}] DevToolsActivePort file exists - browser may be running`);
                console.log(`   Port: ${portContent}`);
              }
            } catch (e) {
              // Ignore read errors
            }
          }
          
          // Build args array
          const browserArgs = [
            proxy ? `--proxy-server=${proxy.host}:${proxy.port}` : '',
            '--window-size=420,850',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage', // Overcome limited resource problems
            '--disable-gpu', // Disable GPU hardware acceleration
            `--user-data-dir=${browserDataPath}` // Explicitly set user data dir
          ].filter(Boolean);
          
          logSystem(`🔧 [${profile.name}] Browser args: ${browserArgs.filter(a => !a.includes('proxy')).join(', ')}`);
          
          this.browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: false,
            userDataDir: browserDataPath,
            args: browserArgs,
            defaultViewport: null,
            ignoreHTTPSErrors: true,
            timeout: 60000
          });

          const pages = await this.browser.pages();
          this.page = pages[0] || await this.browser.newPage();
          
          // Set proxy authentication BEFORE navigating
          if (proxy) {
            logSystem(`🔐 [${profile.name}] Setting proxy authentication: ${proxy.username}@${proxy.host}:${proxy.port}`);
            try {
              await this.page.authenticate({ 
                username: proxy.username, 
                password: proxy.password 
              });
              logSystem(`✅ [${profile.name}] Proxy authentication set successfully`);
            } catch (authError) {
              console.error(`⚠️ [${profile.name}] Proxy authentication error:`, authError.message);
              // Continue anyway - some proxies don't require explicit auth
            }
          }
          
          // Wait a bit for browser to be ready
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Mobile emulation - MUST be set before CDP session
          const mobileUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
          await this.page.setUserAgent(mobileUserAgent);
          await this.page.setViewport({
            width: 375,
            height: 812,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true
          });
          
          // Also use emulate for additional mobile features
          await this.page.emulate({
            viewport: { 
              width: 375, 
              height: 812, 
              deviceScaleFactor: 3, 
              isMobile: true, 
              hasTouch: true 
            },
            userAgent: mobileUserAgent
          });
          
          logSystem(`📱 [${profile.name}] Mobile emulation enabled`);

          // CDP for WebSocket interception
          this.cdp = await this.page.target().createCDPSession();
          await this.cdp.send('Network.enable');

          // ALWAYS set geolocation override (use settings or defaults)
          // This prevents geolocation check prompts
          const defaultLat = 40.7132; // New York default
          const defaultLon = -74.0061;
          const defaultAcc = 75;
          
          const geoLat = this.settings.latitude ? parseFloat(this.settings.latitude) : defaultLat;
          const geoLon = this.settings.longitude ? parseFloat(this.settings.longitude) : defaultLon;
          const geoAcc = this.settings.accuracy ? parseFloat(this.settings.accuracy) : defaultAcc;
          
          try {
            await this.cdp.send('Emulation.setGeolocationOverride', {
              latitude: geoLat,
              longitude: geoLon,
              accuracy: geoAcc
            });
            logSystem(`📍 [${profile.name}] Geolocation set: ${geoLat}, ${geoLon} (accuracy: ${geoAcc}m)`);
          } catch (e) {
            logSystem(`⚠️ [${profile.name}] Could not set geolocation via CDP: ${e.message}`);
          }

          // Grant geolocation permissions BEFORE navigation
          const context = this.browser.defaultBrowserContext();
          try {
            await context.overridePermissions('https://sports.getfliff.com', ['geolocation']);
            logSystem(`✅ [${profile.name}] Geolocation permissions granted`);
          } catch (e) {
            logSystem(`⚠️ [${profile.name}] Could not override permissions: ${e.message}`);
          }

          // Capture auth tokens and betting API endpoints (same as original)
          this.cdp.on('Network.requestWillBeSent', (params) => {
            const headers = params.request.headers;
            const url = params.request.url || '';
            const method = params.request.method || '';
            const postData = params.request.postData;
            
            if (headers.Authorization) {
              const newToken = headers.Authorization;
              if (this.bearerToken !== newToken) {
                const wasNew = !this.bearerToken;
                this.bearerToken = newToken;
                if (wasNew) {
                  logSystem(`🔑 [${profile.name}] Captured bearer token`);
                }
                this.saveAPICredentials();
              }
            }
            
            if (url.includes('auth_token=')) {
              const match = url.match(/auth_token=([^&]+)/);
              if (match) {
                const newToken = match[1];
                if (this.authToken !== newToken) {
                  this.authToken = newToken;
                  logSystem(`🔑 [${profile.name}] Captured auth token`);
                  this.saveAPICredentials();
                }
              }
            }
            
            if (method === 'POST' && postData) {
              const lowerUrl = url.toLowerCase();
              const lowerPostData = postData.toLowerCase();
              
              const isBettingEndpoint = lowerUrl.includes('bet') || 
                  lowerUrl.includes('wager') || 
                  lowerUrl.includes('stake') || 
                  lowerUrl.includes('proposal') ||
                  lowerUrl.includes('place') ||
                  lowerUrl.includes('order') ||
                  lowerUrl.includes('ticket') ||
                  lowerUrl.includes('transaction') ||
                  (lowerUrl.includes('api') && (lowerPostData.includes('amount') || lowerPostData.includes('wager') || lowerPostData.includes('bet'))) ||
                  (lowerUrl.includes('fliff') && lowerPostData.includes('amount'));
              
              if (isBettingEndpoint) {
                const betRequest = {
                  url: url,
                  method: method,
                  headers: headers,
                  postData: postData,
                  timestamp: Date.now()
                };
                
                this.capturedBetRequests.push(betRequest);
                if (this.capturedBetRequests.length > 20) {
                  this.capturedBetRequests.shift();
                }
                if (this.capturedBetRequests.length % 5 === 0) {
                  this.saveAPICredentials();
                }
                
                const isBetterMatch = !this.bettingEndpoint || 
                                   (lowerUrl.includes('bet') && !this.bettingEndpoint.toLowerCase().includes('bet')) ||
                                   (lowerUrl.includes('wager') && !this.bettingEndpoint.toLowerCase().includes('wager'));
                
                if (!this.bettingEndpoint || isBetterMatch) {
                  this.bettingEndpoint = url;
                  this.apiHeaders = { ...headers };
                  console.log(`🎯 [${profile.name}] Captured betting API endpoint: ${url}`);
                  this.saveAPICredentials();
                }
              }
            }
          });
          
          this.cdp.on('Network.responseReceived', async (params) => {
            const url = params.response.url || '';
            if (this.bettingEndpoint && url === this.bettingEndpoint) {
              try {
                const response = await this.cdp.send('Network.getResponseBody', {
                  requestId: params.requestId
                });
                if (response.body) {
                  console.log(`📥 [${profile.name}] Betting API response: ${response.body.substring(0, 500)}`);
                }
              } catch (e) {
                // Response body might not be available
              }
            }
          });

          this.cdp.on('Network.webSocketFrameReceived', (params) => {
            if (params.response?.payloadData) {
              this.handleWSFrame(params.response.payloadData);
            }
          });

          this.cdp.on('Network.webSocketCreated', (params) => {
            if (params.url?.includes('heraldz')) {
              logSystem(`🔌 [${profile.name}] Fliff WebSocket connected`);
              this.onConnect();
            }
          });

          this.cdp.on('Network.webSocketClosed', () => {
            logSystem(`⚫ [${profile.name}] WebSocket disconnected`);
            this.onDisconnect();
          });

          // Inject geolocation override script - MUST be before navigation
          // This bypasses any geolocation checks by overriding the API
          await this.page.evaluateOnNewDocument((lat, lon, acc) => {
            // Override getCurrentPosition
            if (navigator.geolocation) {
              const originalGetCurrentPosition = navigator.geolocation.getCurrentPosition;
              navigator.geolocation.getCurrentPosition = function(success, error, options) {
                if (success) {
                  success({
                    coords: {
                      latitude: lat,
                      longitude: lon,
                      accuracy: acc,
                      altitude: null,
                      altitudeAccuracy: null,
                      heading: null,
                      speed: null
                    },
                    timestamp: Date.now()
                  });
                }
                return originalGetCurrentPosition ? originalGetCurrentPosition.call(this, success, error, options) : null;
              };
              
              // Override watchPosition
              const originalWatchPosition = navigator.geolocation.watchPosition;
              navigator.geolocation.watchPosition = function(success, error, options) {
                if (success) {
                  success({
                    coords: {
                      latitude: lat,
                      longitude: lon,
                      accuracy: acc,
                      altitude: null,
                      altitudeAccuracy: null,
                      heading: null,
                      speed: null
                    },
                    timestamp: Date.now()
                  });
                }
                return originalWatchPosition ? originalWatchPosition.call(this, success, error, options) : 1;
              };
            }
          }, geoLat, geoLon, geoAcc);
          
          console.log(`🔒 [${profile.name}] Geolocation bypass script injected`);

          logSystem(`📱 [${profile.name}] Loading Fliff...`);
          
          // Try to navigate with retries
          let navigationSuccess = false;
          let retries = 3;
          
          while (!navigationSuccess && retries > 0) {
            try {
              await this.page.goto('https://sports.getfliff.com/', { 
                waitUntil: 'networkidle2', 
                timeout: 60000 
              });
              
              // Wait a bit for page to render
              await new Promise(resolve => setTimeout(resolve, 3000));
              
              // Check if page loaded successfully
              const pageTitle = await this.page.title().catch(() => '');
              const pageUrl = this.page.url();
              const pageContent = await this.page.evaluate(() => document.body.innerText).catch(() => '');
              
              // Check for error messages
              const hasError = pageContent.toLowerCase().includes('temporarily down') || 
                              pageContent.toLowerCase().includes('moved permanently') ||
                              pageContent.toLowerCase().includes('this site can\'t be reached') ||
                              pageTitle.toLowerCase().includes('temporarily down') ||
                              pageTitle.toLowerCase().includes('error');
              
              if (pageUrl.includes('getfliff.com') && !hasError) {
                navigationSuccess = true;
                console.log(`🟢 [${profile.name}] Fliff loaded successfully! (URL: ${pageUrl.substring(0, 50)}...)`);
              } else {
                const errorMsg = hasError ? 'Page shows error message' : `Unexpected URL: ${pageUrl}`;
                throw new Error(`${errorMsg} - Title: ${pageTitle.substring(0, 50)}`);
              }
            } catch (e) {
              retries--;
              if (retries > 0) {
                console.log(`⚠️ [${profile.name}] Navigation failed: ${e.message}`);
                console.log(`   Retrying... (${retries} attempts left)`);
                // Close current page and create new one
                try {
                  await this.page.close();
                } catch {}
                this.page = await this.browser.newPage();
                if (proxy) {
                  await this.page.authenticate({ 
                    username: proxy.username, 
                    password: proxy.password 
                  });
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
              } else {
                console.error(`❌ [${profile.name}] Failed to load Fliff after 3 attempts: ${e.message}`);
                throw e;
              }
            }
          }
          
          // Wait a bit more for page to fully initialize
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          logSystem(`🟢 [${profile.name}] Fliff ready!\n`);
        } catch (error) {
          console.error(`❌ [${profile.name}] Error starting Fliff:`, error.message);
          throw error;
        }
      };
      
      try {
        await client.start();
        
        // Verify client actually started successfully
        if (!client.browser) {
          throw new Error('Browser failed to launch');
        }
        if (!client.page) {
          throw new Error('Page failed to initialize');
        }
        
        fliffClients.set(profile.name, client);
        
        // Register profile with user manager
        userManager.registerProfile(profile.name, {
          directory: profile.directory,
          proxy: profile.proxy
        });
        
        // Set first client as primary for backward compatibility
        if (!fliffClient) {
          fliffClient = client;
        }
        
        logSystem(`✅ [${i + 1}/${allProfiles.length}] Profile ${profile.name} started successfully`);
        console.log(`   Browser: ${client.browser ? '✅' : '❌'}, Page: ${client.page ? '✅' : '❌'}\n`);
        
        // Add a small delay after successful start to ensure stability
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (startError) {
        // If start() throws, it's a startup error
        throw new Error(`Startup failed: ${startError.message}`);
      }
    } catch (e) {
      failedProfiles.push({ 
        name: profile.name, 
        directory: profile.directory,
        error: e.message, 
        stack: e.stack 
      });
      console.error(`\n❌ [${i + 1}/${allProfiles.length}] Failed to start profile ${profile.name}:`);
      console.error(`   Directory: ${profile.directory}`);
      console.error(`   Error: ${e.message}`);
      
      // Provide more specific error messages
      if (e.message.includes('Chrome not found') || e.message.includes('Chrome/Chromium not found')) {
        console.error(`   💡 Issue: Chrome browser not found. Please install Google Chrome.`);
      } else if (e.message.includes('Navigation failed') || e.message.includes('timeout')) {
        console.error(`   💡 Issue: Page navigation failed. Check proxy connection: ${profile.settings.proxy}`);
      } else if (e.message.includes('Browser failed to launch')) {
        console.error(`   💡 Issue: Browser process failed to start. Check browser data directory: ${path.join(__dirname, '..', profile.directory, 'browser_data')}`);
      } else if (e.message.includes('Page failed to initialize')) {
        console.error(`   💡 Issue: Page object not created. Browser may have crashed during startup.`);
      } else if (e.message.includes('proxy') || e.message.includes('Proxy')) {
        console.error(`   💡 Issue: Proxy connection problem. Verify proxy: ${profile.settings.proxy}`);
      }
      
      if (e.stack) {
        console.error(`   Stack trace:`, e.stack.split('\n').slice(0, 5).join('\n   '));
      }
      console.error('');
      // Continue with other profiles even if one fails
    }
  }
  
  logSystem(`\n✅ Started ${fliffClients.size} profile(s) out of ${allProfiles.length} total`);
  if (failedProfiles.length > 0) {
    logSystem(`\n❌ Failed to start ${failedProfiles.length} profile(s):`);
    failedProfiles.forEach(fp => {
      logSystem(`   - ${fp.name}: ${fp.error}`);
    });
  }
  
  // List all successfully started profiles
  logSystem(`\n📋 Successfully started profiles:`);
  fliffClients.forEach((client, name) => {
    logSystem(`   ✅ ${name}`);
  });
  logSystem('');
}

const PORT = process.env.PORT || 3001;

// Start logging server first
loggingServer.listen(LOGGING_PORT, () => {
  console.log(`📊 LOGGING SERVER: Port ${LOGGING_PORT} (WebSocket for verbose logs)`);
  console.log(`   Connect: ws://localhost:${LOGGING_PORT}`);
});

// Start main server
server.listen(PORT, () => {
  console.log('\n🚀 FLIFF BACKEND SERVER - BETTING PRIORITY MODE');
  console.log('═'.repeat(60));
  console.log(`💰 MAIN SERVER (Port ${PORT}):`);
  console.log(`   📡 API:       http://localhost:${PORT}/api`);
  console.log(`   🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`   📊 LOGS:      Only BETTING actions shown here`);
  console.log('');
  console.log(`📊 LOGGING SERVER (Port ${LOGGING_PORT}):`);
  console.log(`   🔌 WebSocket: ws://localhost:${LOGGING_PORT}`);
  console.log(`   📊 LOGS:      Odds, profiles, websocket, system logs`);
  console.log('═'.repeat(60));
  
  console.log('\n⚡ PERFORMANCE OPTIMIZATIONS:');
  console.log('  ✅ Odds processed ONLY for selected game');
  console.log('  ✅ Non-betting logs routed to port 3002');
  console.log('  ✅ Betting logs prioritized in main console');
  console.log('  ✅ Broadcast optimized (game subscribers only)');
  
  console.log('\n💰 BETTING ENDPOINTS (Priority):');
  console.log('  POST /api/prefire        - Place bet (all profiles)');
  console.log('  POST /api/place-bet      - Place bet (all profiles)');
  console.log('  POST /api/burn-prefire   - Burn prefire (fast bet)');
  console.log('  POST /api/lock-and-load  - Lock & Load');
  console.log('  POST /api/reload-page    - Reload page');
  
  console.log('\n📊 DATA ENDPOINTS:');
  console.log('  GET  /api/games          - All live games');
  console.log('  GET  /api/games/:id/odds - Game odds');
  console.log('  GET  /api/status         - Server & profile status');
  console.log('─'.repeat(60));
  
  startFliff();
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  logSystem('🛑 Server shutting down...');
  saveLogs();
  // Stop all profile clients
  for (const [profileName, client] of fliffClients.entries()) {
    try {
      client.stop();
      logSystem(`   Stopped profile: ${profileName}`);
    } catch (e) {
      logSystem(`   Error stopping profile ${profileName}: ${e.message}`);
    }
  }
  // Also stop primary client if different
  if (fliffClient && !fliffClients.has(fliffClient.settings?.name || 'default')) {
    try {
      fliffClient.stop();
    } catch (e) {
      // Ignore
    }
  }
  process.exit(0);
});
