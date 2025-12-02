const puppeteer = require('puppeteer-core');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// =============================================
// FLIFF CLIENT - Handles browser & WebSocket
// =============================================

class FliffClient {
  constructor(handlers = {}, profileDirectory = 'ray') {
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.messageCount = 0;
    
    // Profile directory - used for loading settings, credentials, and browser data
    this.profileDirectory = profileDirectory;
    
    // Channel to Game ID mapping
    this.channelToGame = new Map(); // channelId -> Set of gameIds
    this.gameToChannel = new Map(); // gameId -> channelId
    this.gameInfo = new Map(); // gameId -> {home, away} for matching odds
    
    // Error deduplication - prevent logging same error repeatedly
    this.errorLogs = new Map(); // key -> { count, lastLog }
    this.errorLogInterval = 10000; // Log same error max once per 10 seconds
    
    // Auth token for API
    this.authToken = null;
    this.bearerToken = null;
    
    // Betting API endpoint and format (captured from network requests)
    this.bettingEndpoint = null;
    this.bettingMethod = null; // 'api' or 'puppeteer'
    this.apiHeaders = {};
    this.capturedBetRequests = []; // Store last few bet requests for analysis
    
    // Locked API requests - stores the exact API request for each oddId (locked during lock & load)
    // Key: oddId, Value: { url, headers, requestBody, timestamp }
    this.lockedAPIRequests = new Map();
    
    // Event handlers
    this.onGame = handlers.onGame || (() => {});
    this.onOdds = handlers.onOdds || (() => {});
    this.onStats = handlers.onStats || (() => {});
    this.onConnect = handlers.onConnect || (() => {});
    this.onDisconnect = handlers.onDisconnect || (() => {});
    
    // Load settings
    this.settings = this.loadSettings();
    
    // Load persisted API credentials
    this.loadAPICredentials();
  }

  loadSettings() {
    try {
      const settingsPath = path.join(__dirname, '..', 'profiles', this.profileDirectory, 'settings.json');
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      return { 
        proxy: 'Yd0IwkF5:wWXhE4@156.228.210.149:6666',
        name: 'Default'
      };
    }
  }

  // Load persisted API credentials from disk
  loadAPICredentials() {
    try {
      const credentialsPath = path.join(__dirname, '..', 'profiles', this.profileDirectory, 'api_credentials.json');
      if (fs.existsSync(credentialsPath)) {
        const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        if (data.bettingEndpoint) {
          this.bettingEndpoint = data.bettingEndpoint;
          console.log('📂 Loaded persisted betting endpoint:', this.bettingEndpoint);
        }
        if (data.bearerToken) {
          this.bearerToken = data.bearerToken;
          console.log('📂 Loaded persisted bearer token');
        }
        if (data.authToken) {
          this.authToken = data.authToken;
          console.log('📂 Loaded persisted auth token');
        }
        if (data.apiHeaders) {
          this.apiHeaders = data.apiHeaders;
        }
        if (data.capturedBetRequests && Array.isArray(data.capturedBetRequests)) {
          // Only keep recent requests (last 10)
          this.capturedBetRequests = data.capturedBetRequests.slice(-10);
          console.log(`📂 Loaded ${this.capturedBetRequests.length} persisted bet request templates`);
        }
      }
    } catch (e) {
      console.log('⚠️ Could not load API credentials:', e.message);
    }
  }

  // Save API credentials to disk
  saveAPICredentials() {
    try {
      const credentialsPath = path.join(__dirname, '..', 'profiles', this.profileDirectory, 'api_credentials.json');
      const data = {
        bettingEndpoint: this.bettingEndpoint,
        bearerToken: this.bearerToken,
        authToken: this.authToken,
        apiHeaders: this.apiHeaders,
        // Only save last 10 requests to keep file size manageable
        capturedBetRequests: this.capturedBetRequests.slice(-10),
        lastUpdated: new Date().toISOString()
      };
      fs.writeFileSync(credentialsPath, JSON.stringify(data, null, 2), 'utf8');
      console.log('💾 Saved API credentials to disk');
    } catch (e) {
      console.log('⚠️ Could not save API credentials:', e.message);
    }
  }

  parseProxy(proxyString) {
    const match = proxyString?.match(/(.+):(.+)@(.+):(\d+)/);
    if (match) {
      return { 
        username: match[1], 
        password: match[2], 
        host: match[3], 
        port: match[4] 
      };
    }
    return null;
  }

  decode(base64Data) {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      return JSON.parse(zlib.inflateSync(buffer).toString('utf8'));
    } catch {
      try {
        return JSON.parse(Buffer.from(base64Data, 'base64').toString('utf8'));
      } catch {
        return null;
      }
    }
  }

  async start() {
    console.log('\n🎮 Starting Fliff Client...');
    console.log(`Profile: ${this.settings.name}`);
    
    const proxy = this.parseProxy(this.settings.proxy);
    if (proxy) {
      console.log(`Proxy: ${proxy.host}:${proxy.port}`);
    }
    
    // Show API credentials status
    if (this.bettingEndpoint) {
      console.log(`📂 Using persisted betting endpoint: ${this.bettingEndpoint}`);
    }
    if (this.bearerToken || this.authToken) {
      console.log(`📂 Using persisted authentication tokens`);
    }

    try {
      // Detect OS and set Chrome path
      let chromePath;
      if (process.platform === 'win32') {
        // Windows Chrome paths - check multiple locations
        const possiblePaths = [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe')
        ];
        
        // Find first existing Chrome path
        chromePath = possiblePaths.find(p => p && fs.existsSync(p));
        
        if (!chromePath) {
          console.error('❌ Chrome not found in common locations:');
          possiblePaths.forEach(p => console.error(`   ${p}`));
          throw new Error('Chrome not found. Please install Google Chrome or specify the path manually.');
        }
        
        console.log(`✅ Found Chrome at: ${chromePath}`);
      } else if (process.platform === 'darwin') {
        // macOS
        chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        if (!fs.existsSync(chromePath)) {
          throw new Error('Chrome not found at: ' + chromePath);
        }
      } else {
        // Linux
        const linuxPaths = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
        chromePath = linuxPaths.find(p => fs.existsSync(p));
        if (!chromePath) {
          throw new Error('Chrome/Chromium not found. Please install it.');
        }
      }
      
      const browserDataPath = path.join(__dirname, '..', 'profiles', this.profileDirectory, 'browser_data');

      console.log('🚀 Launching browser...');
      
      this.browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false,
        userDataDir: browserDataPath,
        args: [
          proxy ? `--proxy-server=${proxy.host}:${proxy.port}` : '',
          '--window-size=420,850',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ].filter(Boolean),
        defaultViewport: null
      });

      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();

      if (proxy) {
        await this.page.authenticate({ 
          username: proxy.username, 
          password: proxy.password 
        });
      }

      // Mobile emulation
      await this.page.emulate({
        viewport: { 
          width: 375, 
          height: 812, 
          deviceScaleFactor: 3, 
          isMobile: true, 
          hasTouch: true 
        },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
      });

      // CDP for WebSocket interception
      this.cdp = await this.page.target().createCDPSession();
      await this.cdp.send('Network.enable');

      // Set geolocation to match proxy location (prevent location verification failure)
      if (this.settings.latitude && this.settings.longitude) {
        try {
          await this.cdp.send('Emulation.setGeolocationOverride', {
            latitude: parseFloat(this.settings.latitude),
            longitude: parseFloat(this.settings.longitude),
            accuracy: parseFloat(this.settings.accuracy) || 75
          });
          console.log(`📍 Location set: ${this.settings.latitude}, ${this.settings.longitude}`);
        } catch (e) {
          console.log('⚠️ Could not set geolocation:', e.message);
        }
      }

      // Grant geolocation permissions
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions('https://sports.getfliff.com', ['geolocation']);

      // Capture auth tokens and betting API endpoints from network requests
      this.cdp.on('Network.requestWillBeSent', (params) => {
        const headers = params.request.headers;
        const url = params.request.url || '';
        const method = params.request.method || '';
        const postData = params.request.postData;
        
        // Look for auth/bearer token in headers
        // Note: Bearer token changes on refresh, so we update it but don't treat it as an error
        if (headers.Authorization) {
          const newToken = headers.Authorization;
          if (this.bearerToken !== newToken) {
            const wasNew = !this.bearerToken;
            this.bearerToken = newToken;
            if (wasNew) {
              console.log('🔑 Captured bearer token');
            } else {
              console.log('🔄 Bearer token updated (normal on page refresh)');
            }
            this.saveAPICredentials(); // Persist immediately
          }
        }
        
        // Check URL for auth_token
        if (url.includes('auth_token=')) {
          const match = url.match(/auth_token=([^&]+)/);
          if (match) {
            const newToken = match[1];
            if (this.authToken !== newToken) {
              this.authToken = newToken;
              console.log('🔑 Captured auth token:', this.authToken);
              this.saveAPICredentials(); // Persist immediately
            }
          }
        }
        
        // Capture betting API endpoints - look for POST requests that might be placing bets
        if (method === 'POST' && postData) {
          const lowerUrl = url.toLowerCase();
          const lowerPostData = postData.toLowerCase();
          
          // Look for betting-related endpoints - more aggressive matching
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
            // Store this as a potential betting endpoint
            const betRequest = {
              url: url,
              method: method,
              headers: headers,
              postData: postData,
              timestamp: Date.now()
            };
            
            // ENHANCED LOGGING: Capture full bet request details
            console.log('\n🎯 ========================================');
            console.log('🎯 CAPTURED BET REQUEST (MANUAL PLACEMENT)');
            console.log('🎯 ========================================');
            console.log(`📤 URL: ${url}`);
            console.log(`📤 Method: ${method}`);
            console.log(`📤 Headers (${Object.keys(headers).length}):`);
            Object.entries(headers).forEach(([key, value]) => {
              if (key.toLowerCase().includes('auth') || key.toLowerCase().includes('token')) {
                console.log(`   ${key}: ${value.substring(0, 20)}...${value.slice(-10)}`);
              } else {
                console.log(`   ${key}: ${value}`);
              }
            });
            
            if (postData) {
              try {
                const data = JSON.parse(postData);
                console.log(`📤 Request Body (${Object.keys(data).length} fields):`);
                console.log(JSON.stringify(data, null, 2));
              } catch (e) {
                console.log(`📤 Request Body (raw): ${postData.substring(0, 500)}`);
              }
            } else {
              console.log('📤 Request Body: (empty)');
            }
            console.log('🎯 ========================================\n');
            
            this.capturedBetRequests.push(betRequest);
            // Keep only last 20 requests (increased for better analysis)
            if (this.capturedBetRequests.length > 20) {
              this.capturedBetRequests.shift();
            }
            // Periodically save (every 5 new requests to avoid too frequent writes)
            if (this.capturedBetRequests.length % 5 === 0) {
              this.saveAPICredentials();
            }
            
            // Always update if we find a better match (more specific URL)
            const isBetterMatch = !this.bettingEndpoint || 
                                 (lowerUrl.includes('bet') && !this.bettingEndpoint.toLowerCase().includes('bet')) ||
                                 (lowerUrl.includes('wager') && !this.bettingEndpoint.toLowerCase().includes('wager'));
            
            if (!this.bettingEndpoint || isBetterMatch) {
              this.bettingEndpoint = url;
              this.apiHeaders = { ...headers };
              console.log('🎯 Captured betting API endpoint:', url);
              console.log('   Headers:', Object.keys(headers).join(', '));
              if (postData) {
                try {
                  const data = JSON.parse(postData);
                  console.log('   Request body keys:', Object.keys(data).join(', '));
                  console.log('   Sample data:', JSON.stringify(data).substring(0, 300));
                } catch (e) {
                  console.log('   Request body (non-JSON):', postData.substring(0, 200));
                }
              }
              // Persist the endpoint immediately
              this.saveAPICredentials();
            }
          }
        }
      });
      
      // Also capture response data to see what the API returns
      this.cdp.on('Network.responseReceived', async (params) => {
        const url = params.response.url || '';
        const lowerUrl = url.toLowerCase();
        
        // If this is a betting endpoint response, try to get the response body
        if (this.bettingEndpoint && url === this.bettingEndpoint) {
          try {
            const response = await this.cdp.send('Network.getResponseBody', {
              requestId: params.requestId
            });
            if (response.body) {
              console.log('\n📥 ========================================');
              console.log('📥 BETTING API RESPONSE (MANUAL PLACEMENT)');
              console.log('📥 ========================================');
              console.log(`📥 Status: ${params.response.status} ${params.response.statusText}`);
              console.log(`📥 Headers:`);
              if (params.response.headers) {
                Object.entries(params.response.headers).forEach(([key, value]) => {
                  console.log(`   ${key}: ${value}`);
                });
              }
              console.log(`📥 Response Body:`);
              try {
                const responseData = JSON.parse(response.body);
                console.log(JSON.stringify(responseData, null, 2));
              } catch (e) {
                console.log(response.body);
              }
              console.log('📥 ========================================\n');
            }
          } catch (e) {
            // Response body might not be available, that's okay
            console.log(`📥 Response received but body not available: ${e.message}`);
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
          console.log('🔌 Fliff WebSocket connected');
          this.onConnect();
        }
      });

      this.cdp.on('Network.webSocketClosed', () => {
        console.log('⚫ WebSocket disconnected');
        this.onDisconnect();
      });

          // Inject geolocation override script before page loads
          await this.page.evaluateOnNewDocument((lat, lon, acc) => {
            Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
              value: function(success, error) {
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
            });
            
            Object.defineProperty(navigator.geolocation, 'watchPosition', {
              value: function(success, error) {
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
                return 1; // Return watch ID
              }
            });
          }, 
          parseFloat(this.settings.latitude || 40.7132), 
          parseFloat(this.settings.longitude || -74.0061),
          parseFloat(this.settings.accuracy || 75));

          // Inject bearer token capture script
          await this.page.evaluateOnNewDocument(() => {
            // Intercept fetch requests to capture bearer token
            const originalFetch = window.fetch;
            window.fetch = function(...args) {
              const request = args[0];
              const options = args[1] || {};
              
              // Check for Authorization header
              if (options.headers) {
                const authHeader = options.headers.Authorization || 
                                  options.headers.authorization ||
                                  (typeof options.headers.get === 'function' ? options.headers.get('Authorization') : null);
                
                if (authHeader && authHeader.startsWith('Bearer ')) {
                  // Send token to parent (will be captured by CDP)
                  window.__fliffBearerToken = authHeader;
                  console.log('🔑 Bearer token captured from injection: present');
                }
              }
              
              return originalFetch.apply(this, args);
            };
            
            // Also intercept XMLHttpRequest
            const originalXHROpen = XMLHttpRequest.prototype.open;
            const originalXHRSend = XMLHttpRequest.prototype.send;
            
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
              this._url = url;
              return originalXHROpen.apply(this, [method, url, ...rest]);
            };
            
            XMLHttpRequest.prototype.send = function(data) {
              if (this._url && typeof data === 'string') {
                try {
                  const headers = this.getAllResponseHeaders ? this.getAllResponseHeaders() : '';
                  if (headers.includes('Authorization') || headers.includes('authorization')) {
                    const authHeader = this.getRequestHeader ? this.getRequestHeader('Authorization') : null;
                    if (authHeader && authHeader.startsWith('Bearer ')) {
                      window.__fliffBearerToken = authHeader;
                      console.log('🔑 Bearer token captured from injection: present');
                    }
                  }
                } catch (e) {
                  // Ignore
                }
              }
              return originalXHRSend.apply(this, [data]);
            };
          });

      console.log('📱 Loading Fliff...');
      await this.page.goto('https://sports.getfliff.com/', { 
        waitUntil: 'networkidle2', 
        timeout: 60000 
      });

      console.log('🟢 Fliff ready!\n');

    } catch (error) {
      console.error('❌ Error starting Fliff:', error.message);
      throw error;
    }
  }

  handleWSFrame(payloadData) {
    this.messageCount++;
    
    const decoded = this.decode(payloadData);
    if (!decoded) return;

    // Update stats
    if (this.messageCount % 20 === 0) {
      this.onStats({ messages: this.messageCount });
    }

    // Handle live games
    if (decoded.inplay_conflicts) {
      // Track how many games per channel
      const channelGameCount = {};
      
      decoded.inplay_conflicts.forEach(g => {
        const gameId = g.id;
        const channelId = g.channel_id;
        
        // Count games per channel
        channelGameCount[channelId] = (channelGameCount[channelId] || 0) + 1;
        
        // Store mapping both ways
        if (!this.channelToGame.has(channelId)) {
          this.channelToGame.set(channelId, new Set());
        }
        this.channelToGame.get(channelId).add(gameId);
        this.gameToChannel.set(gameId, channelId);
        
        // Store game info for matching odds - extract key words from team names
        const homeName = (g.home_team_name || '').toLowerCase().trim();
        const awayName = (g.away_team_name || '').toLowerCase().trim();
        
        // Extract key words (remove common words like "state", "university", etc.)
        const extractKeyWords = (name) => {
          return name
            .replace(/\b(state|university|univ|college|tech|tech|st|u|of|the)\b/gi, '')
            .split(/\s+/)
            .filter(w => w.length > 2)
            .join(' ')
            .trim();
        };
        
        this.gameInfo.set(gameId, {
          home: homeName,
          away: awayName,
          homeKeyWords: extractKeyWords(homeName),
          awayKeyWords: extractKeyWords(awayName),
          homeShort: homeName.split(/\s+/).filter(w => w.length > 2).slice(0, 2).join(' '), // First 2 significant words
          awayShort: awayName.split(/\s+/).filter(w => w.length > 2).slice(0, 2).join(' '),
          channel: channelId,
          fullName: `${homeName} vs ${awayName}` // For exact matching
        });
        
        const game = {
          id: gameId,
          home: g.home_team_name,
          away: g.away_team_name,
          homeScore: g.live_home_score,
          awayScore: g.live_away_score,
          status: g.live_state_desc,
          channel: channelId,
          sport: this.getSport(g.conflict_class_code),
          markets: g.estimated_markets_count
        };
        
        this.onGame(game);
      });
      
      // Log channels with multiple games (deduplicated)
      Object.entries(channelGameCount).forEach(([channel, count]) => {
        if (count > 1) {
          const errorKey = `multi_game_channel_${channel}`;
          const now = Date.now();
          const lastLog = this.errorLogs?.get(errorKey);
          
          if (!lastLog || (now - lastLog.lastLog) > 30000) { // Log max once per 30 seconds
            console.log(`⚠️ Channel ${channel} has ${count} games`);
            if (!this.errorLogs) this.errorLogs = new Map();
            this.errorLogs.set(errorKey, { count: (lastLog?.count || 0) + 1, lastLog: now });
          }
        }
      });
    }

    // Handle live odds only
    if (decoded.inplay_subfeeds_update) {
      this.handleOddsUpdate(decoded.inplay_subfeeds_update);
    }
  }

  handleOddsUpdate(update) {
    if (!update?.packed_subfeed_updates) return;

    // Debug: Track which channels are sending odds
    const oddsPerChannel = {};

    update.packed_subfeed_updates.forEach(sf => {
      const channelId = sf.channel_id;
      
      // Get all games for this channel
      const gameIds = this.findGameIdsByChannel(channelId);
      
      if (!gameIds || gameIds.length === 0) {
        // Channel not mapped yet, skip
        return;
      }
      
      // Count odds for this channel
      if (!oddsPerChannel[channelId]) {
        oddsPerChannel[channelId] = { gameIds, count: 0 };
      }
      
      sf.market_updates?.forEach(m => {
        m.groups?.forEach(g => {
          g.proposals?.forEach(p => {
            if (!p.coeff) return;

            // STRICT MATCHING: Match odds to the correct game using event_info
            // This ensures 100% accuracy - no mixing of games
            let targetGameId = null;
            
            const eventInfo = (p.t_121_event_info || '').toLowerCase().trim();
            
            // If no event_info, skip this odd (can't verify it belongs to any game)
            if (!eventInfo || eventInfo.length < 3) {
              console.log(`⚠️ Skipping odd with no event_info: ${p.t_141_selection_name || 'N/A'}`);
              return;
            }
            
            if (gameIds.length === 1) {
              // Only one game on this channel - but STILL verify it matches
              const gameInfo = this.gameInfo.get(gameIds[0]);
              if (!gameInfo) {
                console.log(`⚠️ No game info for game ${gameIds[0]}, skipping odd`);
                return;
              }
              
              // Verify event_info contains BOTH team names (or key words)
              const hasHome = eventInfo.includes(gameInfo.home) || 
                             eventInfo.includes(gameInfo.homeKeyWords) ||
                             gameInfo.homeShort.split(/\s+/).some(word => eventInfo.includes(word));
              const hasAway = eventInfo.includes(gameInfo.away) || 
                             eventInfo.includes(gameInfo.awayKeyWords) ||
                             gameInfo.awayShort.split(/\s+/).some(word => eventInfo.includes(word));
              
              // Require at least one team name match (for single game channels)
              if (hasHome || hasAway) {
                targetGameId = gameIds[0];
              } else {
                console.log(`⚠️ Event info "${eventInfo}" doesn't match game ${gameIds[0]} (${gameInfo.fullName}), skipping`);
                return; // Don't assign to wrong game
              }
            } else {
              // Multiple games on channel - STRICT matching required
              let bestMatch = null;
              let bestMatchScore = 0;
              
              for (const gid of gameIds) {
                const gameInfo = this.gameInfo.get(gid);
                if (!gameInfo) continue;
                
                let matchScore = 0;
                
                // Check for full team name matches (highest score)
                if (eventInfo.includes(gameInfo.home)) matchScore += 10;
                if (eventInfo.includes(gameInfo.away)) matchScore += 10;
                
                // Check for key words matches
                if (eventInfo.includes(gameInfo.homeKeyWords)) matchScore += 8;
                if (eventInfo.includes(gameInfo.awayKeyWords)) matchScore += 8;
                
                // Check for short name matches
                gameInfo.homeShort.split(/\s+/).forEach(word => {
                  if (word.length > 2 && eventInfo.includes(word)) matchScore += 5;
                });
                gameInfo.awayShort.split(/\s+/).forEach(word => {
                  if (word.length > 2 && eventInfo.includes(word)) matchScore += 5;
                });
                
                // Check for full game name match (e.g., "michigan vs ohio state")
                if (eventInfo.includes(gameInfo.fullName) || 
                    eventInfo.includes(`${gameInfo.home} vs ${gameInfo.away}`) ||
                    eventInfo.includes(`${gameInfo.away} vs ${gameInfo.home}`)) {
                  matchScore += 20; // Very high score for exact match
                }
                
                // Require BOTH teams to be mentioned for high confidence
                const hasHome = eventInfo.includes(gameInfo.home) || 
                               eventInfo.includes(gameInfo.homeKeyWords) ||
                               gameInfo.homeShort.split(/\s+/).some(word => eventInfo.includes(word));
                const hasAway = eventInfo.includes(gameInfo.away) || 
                               eventInfo.includes(gameInfo.awayKeyWords) ||
                               gameInfo.awayShort.split(/\s+/).some(word => eventInfo.includes(word));
                
                if (hasHome && hasAway) {
                  matchScore += 15; // Bonus for both teams
                }
                
                if (matchScore > bestMatchScore) {
                  bestMatchScore = matchScore;
                  bestMatch = gid;
                }
              }
              
              // Only assign if we have a strong match (score >= 15) for multiple games
              // This ensures we don't mix games
              if (bestMatch && bestMatchScore >= 15) {
                targetGameId = bestMatch;
              } else {
                // Check if this game exists on a different channel
                let foundOnOtherChannel = false;
                for (const [otherChannelId, otherGameIds] of this.channelToGame.entries()) {
                  if (otherChannelId === channelId) continue; // Skip current channel
                  
                  for (const otherGid of otherGameIds) {
                    const otherGameInfo = this.gameInfo.get(otherGid);
                    if (!otherGameInfo) continue;
                    
                    // Check if event_info matches this game
                    const otherHome = otherGameInfo.home;
                    const otherAway = otherGameInfo.away;
                    const otherFullName = otherGameInfo.fullName;
                    
                    if (eventInfo.includes(otherHome) && eventInfo.includes(otherAway) ||
                        eventInfo.includes(otherFullName) ||
                        eventInfo.includes(`${otherHome} vs ${otherAway}`) ||
                        eventInfo.includes(`${otherAway} vs ${otherHome}`)) {
                      // Found on different channel - assign it
                      targetGameId = otherGid;
                      foundOnOtherChannel = true;
                      console.log(`✅ Found "${eventInfo}" on different channel ${otherChannelId} → Game ${otherGid} (${otherFullName})`);
                      break;
                    }
                  }
                  if (foundOnOtherChannel) break;
                }
                
                if (!foundOnOtherChannel) {
                  // Deduplicate error logging - prevent spam
                  const errorKey = `no_match_${channelId}_${eventInfo.substring(0, 30).replace(/\s+/g, '_')}`;
                  const now = Date.now();
                  const lastLog = this.errorLogs?.get(errorKey);
                  
                  if (!lastLog || (now - lastLog.lastLog) > this.errorLogInterval) {
                    const gameList = gameIds.map(gid => {
                      const gi = this.gameInfo.get(gid);
                      return gi ? gi.fullName : `Game ${gid}`;
                    }).slice(0, 5).join(', '); // Only show first 5 games
                    
                    const count = (lastLog?.count || 0) + 1;
                    console.log(`❌ No match for "${eventInfo}" on channel ${channelId} (${gameIds.length} games)${count > 1 ? ` [seen ${count}x]` : ''}. Sample: ${gameList}${gameIds.length > 5 ? '...' : ''}`);
                    if (!this.errorLogs) this.errorLogs = new Map();
                    this.errorLogs.set(errorKey, { count, lastLog: now });
                  }
                  return; // Don't assign to wrong game - skip this odd
                }
              }
            }
            
            if (!targetGameId) {
              // Don't log every time - these are ghost lines, filter them silently
              return; // Skip ghost lines (odds that don't match any game)
            }

            // Verify the game info matches before creating odd
            const verifiedGameInfo = this.gameInfo.get(targetGameId);
            if (!verifiedGameInfo) {
              // Don't log every time - these are ghost lines
              return; // Skip ghost lines (game not found in gameInfo)
            }
            
            // Additional verification: check if event info actually matches the game
            // eventInfo is already declared above, just reuse it
            const gameHome = (verifiedGameInfo.home || '').toLowerCase();
            const gameAway = (verifiedGameInfo.away || '').toLowerCase();
            
            // If event info doesn't contain either team name, it's likely a ghost line
            if (eventInfo && !eventInfo.includes(gameHome.substring(0, 5)) && !eventInfo.includes(gameAway.substring(0, 5))) {
              // Silent filter - this is a ghost line
              return;
            }
            
            // Verify proposal_fkey format - ghost lines often have malformed IDs
            const proposalFkey = String(p.proposal_fkey || '');
            if (!proposalFkey || proposalFkey.length < 5) {
              return; // Skip odds with invalid proposal_fkey
            }
            
            // Check for valid proposal_fkey format (should have proper structure)
            // Valid: "123456_p_399_inplay", "123456_p_399_prematch", "123456_p_602_universal"
            // Or at least: "123456_p_399" or similar
            const hasValidFormat = /^\d+_p_\d+/.test(proposalFkey) || /^\d+_/.test(proposalFkey) || /^\d+$/.test(proposalFkey);
            if (!hasValidFormat) {
              return; // Skip ghost lines with malformed proposal_fkey
            }

            // Count this odd (only if it passed all checks)
            oddsPerChannel[channelId].count++;

            // Create a more unique ID by combining multiple fields
            // This helps ensure we can identify the exact odd even if proposal_fkey is not unique
            const uniqueId = `${p.proposal_fkey}_${p.coeff}_${(p.t_141_selection_name || '').substring(0, 20)}_${(p.t_142_selection_param_1 || '').substring(0, 10)}`;
            
            const odd = {
              id: p.proposal_fkey, // Keep original ID for compatibility
              uniqueId: uniqueId, // More unique identifier
              event: p.t_121_event_info,
              market: p.t_131_market_name,
              selection: p.t_141_selection_name,
              param: p.t_142_selection_param_1,
              odds: p.coeff,
              decimal: p.eu_coeff,
              prevOdds: p.prev_coeff,
              channelId: channelId, // Store channel for debugging
              gameId: targetGameId, // Store verified game ID
              verifiedGame: verifiedGameInfo.fullName, // Store game name for verification
              updated: Date.now(),
              // Store full proposal data for debugging
              _debug: {
                proposal_fkey: p.proposal_fkey,
                channel_id: channelId,
                game_id: targetGameId,
                event_info: p.t_121_event_info,
                market_name: p.t_131_market_name,
                selection_name: p.t_141_selection_name,
                param: p.t_142_selection_param_1,
                verified_game: verifiedGameInfo.fullName
              }
            };
            
            // Log verification for important odds
            if (p.t_131_market_name?.toLowerCase().includes('total') || 
                p.t_131_market_name?.toLowerCase().includes('spread')) {
            }
            
            this.onOdds(targetGameId, odd);
          });
        });
      });
    });
    
    // Debug log occasionally
    if (Math.random() < 0.05) { // 5% of the time
      Object.entries(oddsPerChannel).forEach(([channel, data]) => {
        console.log(`📊 Channel ${channel}: ${data.count} odds → ${data.gameIds.length} game(s) [${data.gameIds.join(', ')}]`);
      });
    }
  }

  findGameIdsByChannel(channelId) {
    // Return all game IDs for this channel
    const gameSet = this.channelToGame.get(channelId);
    return gameSet ? Array.from(gameSet) : [];
  }

  getSport(classCode) {
    const sports = {
      62901: 'Football',
      62902: 'Basketball', 
      62903: 'Baseball',
      62904: 'Tennis',
      62905: 'Hockey',
      62906: 'Soccer'
    };
    return sports[classCode] || 'Other';
  }

  // =============================================
  // PREFIRE BETTING - Auto $0.20 test bet
  // =============================================

  async prefire(selection, targetOdds, param = null, market = null, oddId = null) {
    if (!this.page) throw new Error('Browser not connected');
    
    console.log(`\n🔥 PREFIRE: ${selection} @ ${targetOdds}`);
    if (param) console.log(`   Param: ${param}`);
    if (market) console.log(`   Market: ${market}`);
    if (oddId) console.log(`   Odd ID: ${oddId}`);
    
    try {
      // Wait for page to be ready
      try {
        await this.page.waitForSelector('body', { timeout: 5000 });
      } catch (e) {
        console.log('Page not ready, waiting...');
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // First, let's see what's actually on the page
      const pageSnapshot = await this.page.evaluate(() => {
        const elements = document.querySelectorAll('button, [role="button"], [class*="odds"], [class*="Odds"], [class*="coeff"], [class*="proposal"], [class*="Proposal"], [class*="cell"], [class*="pick"]');
        const snapshot = [];
        for (let i = 0; i < Math.min(elements.length, 30); i++) {
          const el = elements[i];
          if (el.offsetParent !== null) {
            snapshot.push({
              text: el.textContent.substring(0, 100).trim(),
              className: el.className,
              id: el.id,
              hasDataAttrs: Array.from(el.attributes).some(attr => attr.name.startsWith('data-'))
            });
          }
        }
        return snapshot;
      });
      
      console.log('📋 Page snapshot (first 30 visible elements):');
      pageSnapshot.forEach((item, idx) => {
        console.log(`  ${idx + 1}. ${item.text.substring(0, 60)}${item.hasDataAttrs ? ' [has data-*]' : ''}`);
      });
      
      // Step 1: Click the odds element - use STRICT matching
      const clicked = await this.page.evaluate(async (sel, odds, param, market, oddId) => {
        console.log('🔍 Looking for:', {
          selection: sel,
          odds: odds,
          param: param,
          market: market,
          oddId: oddId
        });
        
        // Normalize the search terms
        const selLower = (sel || '').toLowerCase().trim();
        const oddsStr = odds > 0 ? `+${odds}` : odds.toString();
        const paramLower = (param || '').toLowerCase().trim();
        const marketLower = (market || '').toLowerCase().trim();
        
        // Extract key parts from selection (e.g., "Over 34.5" -> ["over", "34.5"])
        const selParts = selLower.split(/\s+/).filter(p => p.length > 0);
        // Extract number with word boundaries to ensure exact match
        // Match number that appears after "over"/"under"/"o"/"u" or as standalone
        const numberMatch = selLower.match(/(?:over|under|o|u)\s+(\d+\.?\d*)|^(\d+\.?\d*)$|(\d+\.?\d*)/);
        const numberInSel = numberMatch ? (numberMatch[1] || numberMatch[2] || numberMatch[3]) : null;
        
        // Get all clickable elements - be more specific
        const allElements = document.querySelectorAll('button, [role="button"], [class*="odds"], [class*="Odds"], [class*="coeff"], [class*="proposal"], [class*="Proposal"], [class*="cell"], [class*="pick"], [class*="bet"], [class*="Bet"]');
        
        // Filter to only visible elements
        const elements = Array.from(allElements).filter(el => {
          return el.offsetParent !== null && 
                 el.offsetWidth > 0 && 
                 el.offsetHeight > 0 &&
                 window.getComputedStyle(el).display !== 'none';
        });
        
        console.log('Found', elements.length, 'visible clickable elements');
        
        // Helper function to check if number matches exactly (with word boundaries)
        function numberMatchesExactly(text, targetNumber) {
          if (!targetNumber) return false;
          // Create regex with word boundaries to match exact number
          // This prevents "33" from matching "33.5", "330", "3", etc.
          const exactNumberRegex = new RegExp(`\\b${targetNumber.replace('.', '\\.')}\\b`);
          return exactNumberRegex.test(text);
        }
        
        // Score each element based on how well it matches
        const scoredElements = elements.map(el => {
          const text = (el.textContent || '').toLowerCase().trim();
          const fullText = text;
          
          let score = 0;
          const reasons = [];
          
          // Check for exact odds match (highest priority)
          if (text.includes(oddsStr)) {
            score += 100;
            reasons.push('has-odds');
          }
          
          // Check for selection text match
          if (selLower && text.includes(selLower)) {
            score += 50;
            reasons.push('has-selection');
          } else if (selParts.length > 0) {
            // Partial match on selection parts
            const matchedParts = selParts.filter(part => text.includes(part)).length;
            if (matchedParts > 0) {
              score += (matchedParts / selParts.length) * 30;
              reasons.push(`partial-selection-${matchedParts}/${selParts.length}`);
            }
          }
          
          // Check for EXACT number match (e.g., "33" should match "33" but NOT "33.5" or "330")
          if (numberInSel && numberMatchesExactly(text, numberInSel)) {
            score += 30; // Increased weight for exact number match
            reasons.push('has-exact-number');
          } else if (numberInSel && text.includes(numberInSel)) {
            // Fallback: if exact match fails, check substring (but with lower score)
            score += 10; // Lower score for substring match
            reasons.push('has-number-substring');
          }
          
          // Check for param match
          if (paramLower && text.includes(paramLower)) {
            score += 30;
            reasons.push('has-param');
          }
          
          // Check market context in parent/siblings - MORE AGGRESSIVE for spreads/totals
          if (marketLower) {
            let parent = el.parentElement;
            let marketFound = false;
            let marketScore = 0;
            const isSpread = selLower.includes('+') || selLower.includes('-') || marketLower.includes('spread');
            const isTotal = selLower.includes('over') || selLower.includes('under') || marketLower.includes('total');
            
            // Build full context from all parent elements
            let fullContext = '';
            let depth = 0;
            while (parent && depth < 8) {
              const parentText = (parent.textContent || '').toLowerCase();
              fullContext = parentText + ' ' + fullContext;
              parent = parent.parentElement;
              depth++;
            }
            
            // Check for market keywords in full context
            const marketKeywords = {
              'game': ['game', 'full game', 'match'],
              '1st half': ['1st half', 'first half', '1h', 'half 1', 'h1'],
              '2nd half': ['2nd half', 'second half', '2h', 'half 2', 'h2'],
              '1st quarter': ['1st quarter', 'first quarter', 'q1', 'quarter 1'],
              '2nd quarter': ['2nd quarter', 'second quarter', 'q2', 'quarter 2'],
              '3rd quarter': ['3rd quarter', 'third quarter', 'q3', 'quarter 3'],
              '4th quarter': ['4th quarter', 'fourth quarter', 'q4', 'quarter 4']
            };
            
            // Determine expected market
            let expectedMarkets = [];
            if (marketLower.includes('game') || (!marketLower.includes('half') && !marketLower.includes('quarter'))) {
              expectedMarkets.push('game');
            }
            if (marketLower.includes('1st half') || marketLower.includes('1h')) {
              expectedMarkets.push('1st half');
            }
            if (marketLower.includes('2nd half') || marketLower.includes('2h')) {
              expectedMarkets.push('2nd half');
            }
            if (marketLower.match(/\d+(st|nd|rd|th)?\s*quarter/)) {
              const qMatch = marketLower.match(/(\d+)(st|nd|rd|th)?\s*quarter/);
              if (qMatch) {
                expectedMarkets.push(`${qMatch[1]}${qMatch[2] || 'st'} quarter`);
              }
            }
            
            // Check if context matches expected market
            for (const expectedMarket of expectedMarkets) {
              const keywords = marketKeywords[expectedMarket] || [];
              for (const keyword of keywords) {
                if (fullContext.includes(keyword)) {
                  marketFound = true;
                  marketScore += 50; // Higher score for market match
                  break;
                }
              }
            }
            
            // Also check for direct market name
            if (fullContext.includes(marketLower)) {
              marketFound = true;
              marketScore += 60;
            }
            
            // For spreads/totals, market context is CRITICAL
            if (isSpread || isTotal) {
              if (marketFound) {
                score += marketScore; // Higher weight for spreads/totals
                reasons.push('in-market-context');
              } else {
                score -= 50; // Bigger penalty for spreads/totals without market context
                reasons.push('not-in-market');
              }
            } else {
              // For moneyline, market context is nice but not critical
              if (marketFound) {
                score += 30;
                reasons.push('in-market-context');
              } else {
                score -= 10;
                reasons.push('not-in-market');
              }
            }
          }
          
          return {
            element: el,
            score: score,
            text: fullText.substring(0, 80),
            reasons: reasons
          };
        });
        
        // Sort by score (highest first)
        scoredElements.sort((a, b) => b.score - a.score);
        
        console.log('🏆 Top 5 matches:');
        scoredElements.slice(0, 5).forEach((item, idx) => {
          console.log(`  ${idx + 1}. Score: ${item.score} | ${item.text} | Reasons: ${item.reasons.join(', ')}`);
        });
        
        // Helper to check if element is in correct market section
        function isInCorrectMarketSection(el, expectedMarket) {
          if (!expectedMarket) return true; // No market specified
          
          const expectedMarketLower = expectedMarket.toLowerCase();
          
          // Build a comprehensive context from parent elements
          let parent = el.parentElement;
          let contextText = '';
          let depth = 0;
          
          while (parent && depth < 8) {
            const parentText = (parent.textContent || '').toLowerCase();
            contextText = parentText + ' ' + contextText;
            parent = parent.parentElement;
            depth++;
          }
          
          // Check for market keywords
          const marketKeywords = {
            'game': ['game', 'full game', 'match'],
            '1st half': ['1st half', 'first half', '1h', 'half 1', 'h1'],
            '2nd half': ['2nd half', 'second half', '2h', 'half 2', 'h2'],
            '1st quarter': ['1st quarter', 'first quarter', 'q1', 'quarter 1'],
            '2nd quarter': ['2nd quarter', 'second quarter', 'q2', 'quarter 2'],
            '3rd quarter': ['3rd quarter', 'third quarter', 'q3', 'quarter 3'],
            '4th quarter': ['4th quarter', 'fourth quarter', 'q4', 'quarter 4'],
            'total': ['total', 'over/under', 'o/u'],
            'spread': ['spread', 'line', 'handicap']
          };
          
          // Determine what market we're looking for
          let lookingFor = [];
          if (expectedMarketLower.includes('game') || (!expectedMarketLower.includes('half') && !expectedMarketLower.includes('quarter'))) {
            lookingFor.push('game');
          }
          if (expectedMarketLower.includes('1st half') || expectedMarketLower.includes('1h')) {
            lookingFor.push('1st half');
          }
          if (expectedMarketLower.includes('2nd half') || expectedMarketLower.includes('2h')) {
            lookingFor.push('2nd half');
          }
          if (expectedMarketLower.includes('quarter')) {
            const qMatch = expectedMarketLower.match(/(\d+)(st|nd|rd|th)?\s*quarter/);
            if (qMatch) {
              lookingFor.push(`${qMatch[1]}${qMatch[2] || 'st'} quarter`);
            }
          }
          
          // Check if context contains our market keywords
          for (const marketType of lookingFor) {
            const keywords = marketKeywords[marketType] || [];
            for (const keyword of keywords) {
              if (contextText.includes(keyword)) {
                return true;
              }
            }
          }
          
          // Also check for direct market name match
          if (contextText.includes(expectedMarketLower)) {
            return true;
          }
          
          return false;
        }
        
        // Determine bet type from selection
        const isSpread = selLower.includes('+') || selLower.includes('-') || marketLower.includes('spread');
        const isTotal = selLower.includes('over') || selLower.includes('under') || marketLower.includes('total');
        const isMoneyline = !isSpread && !isTotal && (marketLower.includes('moneyline') || marketLower.includes('ml') || marketLower.includes('win'));
        
        console.log('📊 Bet type detected:', {
          isSpread,
          isTotal,
          isMoneyline,
          market: market || 'N/A'
        });
        
        // STRICT MATCHING: Different rules for different bet types
        const strictMatches = scoredElements.filter(item => {
          const hasExactOdds = item.reasons.includes('has-odds');
          const hasExactSelection = item.reasons.includes('has-selection');
          const hasExactNumber = item.reasons.includes('has-exact-number');
          const hasNumberSubstring = item.reasons.includes('has-number-substring');
          const inMarketContext = item.reasons.includes('in-market-context');
          
          // Must have odds
          if (!hasExactOdds) return false;
          
          // For spreads and totals, REQUIRE market context match
          if ((isSpread || isTotal) && !inMarketContext) {
            // Double-check with more thorough market section check
            if (!isInCorrectMarketSection(item.element, market)) {
              return false;
            }
          }
          
          // Additional check: verify the text actually contains what we're looking for
          const text = item.text.toLowerCase();
          
          // STRICT: Selection text must match - require significant portion of selection
          const hasSelectionText = selLower && (
            text === selLower || // Exact match (best)
            text.includes(selLower) || // Contains full selection
            (selLower.length > 15 && text.includes(selLower.substring(0, 20))) // First 20 chars for long selections
          );
          
          // STRICT: Odds must match exactly
          const hasOddsText = text.includes(oddsStr) || text.includes(odds.toString());
          
          // For totals (over/under), REQUIRE exact number match to prevent wrong selection
          if (isTotal && numberInSel) {
            // Must have exact number match, not substring match
            if (!hasExactNumber) {
              return false; // Reject if number doesn't match exactly (e.g., "33" should not match "33.5")
            }
            // Also verify the number appears in the text with exact match
            if (!numberMatchesExactly(text, numberInSel)) {
              return false;
            }
          }
          
          // For spreads/totals, be extra strict - require exact selection match
          if (isSpread || isTotal) {
            if (!hasExactSelection) return false; // No partial matches for spreads/totals
            // Also require selection text to be present
            if (!hasSelectionText) return false;
          }
          
          // Must have selection text or exact number
          if (!hasExactSelection && !hasExactNumber) return false;
          
          // FINAL CHECK: Both selection AND odds must be present
          if (!hasSelectionText || !hasOddsText) return false;
          
          return true;
        });
        
        console.log('🔍 Strict matches found:', strictMatches.length);
        strictMatches.slice(0, 3).forEach((item, idx) => {
          console.log(`  ${idx + 1}. ${item.text} | Score: ${item.score} | ${item.reasons.join(', ')}`);
        });
        
        // Use the highest scoring strict match, but prioritize market context for spreads/totals
        if (strictMatches.length > 0) {
          let bestMatch = strictMatches[0];
          
          // For spreads/totals, prefer matches with market context
          if (isSpread || isTotal) {
            const withMarketContext = strictMatches.filter(m => 
              m.reasons.includes('in-market-context') || 
              isInCorrectMarketSection(m.element, market)
            );
            
            if (withMarketContext.length > 0) {
              // Use the one with highest score that also has market context
              bestMatch = withMarketContext[0];
              console.log('🎯 For spread/total, selected match with market context');
            } else {
              console.warn('⚠️ No spread/total match found with market context, using best available');
            }
          }
          
          // Final verification: check element is in correct market section
          if ((isSpread || isTotal) && market) {
            if (!isInCorrectMarketSection(bestMatch.element, market)) {
              console.error('❌ Match found but NOT in correct market section!');
              console.error('   Expected market:', market);
              console.error('   Element text:', bestMatch.text);
              
              // Try to find a match that IS in the correct section
              const inCorrectSection = strictMatches.find(m => 
                isInCorrectMarketSection(m.element, market)
              );
              
              if (inCorrectSection) {
                console.log('✅ Found alternative match in correct market section');
                bestMatch = inCorrectSection;
              } else {
                return { 
                  success: false, 
                  error: 'Match found but not in correct market section',
                  expectedMarket: market,
                  foundText: bestMatch.text
                };
              }
            }
          }
          
          // Double-check: verify the element text contains both selection and odds
          const finalCheck = bestMatch.element.textContent.toLowerCase();
          if (!finalCheck.includes(selLower) || !finalCheck.includes(oddsStr)) {
            console.error('❌ Final check failed - element text does not match!');
            console.error('   Element text:', finalCheck);
            console.error('   Expected selection:', selLower);
            console.error('   Expected odds:', oddsStr);
            return { success: false, error: 'Element verification failed', elementText: finalCheck };
          }
          
          console.log('✅ Using strict match:', bestMatch.text, 'Score:', bestMatch.score);
          console.log('   Market context verified:', isInCorrectMarketSection(bestMatch.element, market));
          bestMatch.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(r => setTimeout(r, 300)); // Small delay before click
          bestMatch.element.click();
          return { 
            success: true, 
            method: 'strict-match', 
            text: bestMatch.text, 
            score: bestMatch.score,
            reasons: bestMatch.reasons
          };
        }
        
        // NO FALLBACK - if we can't find a strict match, fail
        console.error('❌ No strict match found!');
        console.error('   Looking for:', { selection: sel, odds: oddsStr, param, market });
        console.error('   Top 3 candidates:', scoredElements.slice(0, 3).map(s => ({
          text: s.text,
          score: s.score,
          reasons: s.reasons
        })));
        
        return { 
          success: false, 
          error: 'No matching element found with exact selection and odds',
          candidates: scoredElements.slice(0, 5).map(s => ({ text: s.text, score: s.score }))
        };
      }, selection, targetOdds, param, market, oddId);

      if (!clicked.success) {
        return { success: false, error: 'Could not find odds to click', details: clicked };
      }

      // Verify what was actually clicked
      console.log('✅ Clicked element:', clicked.method, clicked.text);
      if (clicked.reasons) {
        console.log('   Match reasons:', clicked.reasons);
      }
      if (clicked.score) {
        console.log('   Match score:', clicked.score);
      }
      
      // Wait a bit and check what bet slip shows
      await this.page.waitForTimeout(1500);
      
      // Try to verify the bet slip shows the correct selection
      const betSlipCheck = await this.page.evaluate((expectedSel, expectedOdds, expectedParam, expectedMarket) => {
        const betSlipText = document.body.innerText.toLowerCase();
        const expectedSelLower = expectedSel.toLowerCase();
        const expectedOddsStr = expectedOdds > 0 ? `+${expectedOdds}` : expectedOdds.toString();
        const expectedParamLower = (expectedParam || '').toLowerCase();
        const expectedMarketLower = (expectedMarket || '').toLowerCase();
        
        const hasSelection = betSlipText.includes(expectedSelLower);
        const hasOdds = betSlipText.includes(expectedOddsStr);
        const hasParam = !expectedParamLower || betSlipText.includes(expectedParamLower);
        const hasMarket = !expectedMarketLower || betSlipText.includes(expectedMarketLower);
        
        // Extract what's actually in the bet slip
        const betSlipLines = document.body.innerText.split('\n').filter(line => line.trim().length > 0).slice(0, 10);
        
        return {
          hasSelection,
          hasOdds,
          hasParam,
          hasMarket,
          allMatch: hasSelection && hasOdds && hasParam && hasMarket,
          betSlipPreview: betSlipLines.join(' | '),
          fullText: document.body.innerText.substring(0, 500)
        };
      }, selection, targetOdds, param, market);
      
      console.log('📋 Bet slip verification:');
      console.log('   Expected:', { selection, odds: targetOdds, param, market });
      console.log('   Found in bet slip:', {
        selection: betSlipCheck.hasSelection,
        odds: betSlipCheck.hasOdds,
        param: betSlipCheck.hasParam,
        market: betSlipCheck.hasMarket,
        allMatch: betSlipCheck.allMatch
      });
      console.log('   Bet slip preview:', betSlipCheck.betSlipPreview);
      
      if (!betSlipCheck.allMatch) {
        console.error('❌ MISMATCH DETECTED!');
        console.error('   Expected:', { selection, odds: targetOdds, param, market });
        console.error('   Bet slip shows:', betSlipCheck.betSlipPreview);
        console.error('   Full bet slip text:', betSlipCheck.fullText);
        
        // Return error so we can handle it
        return { 
          success: false, 
          error: 'Bet slip does not match expected selection',
          expected: { selection, odds: targetOdds, param, market },
          actual: betSlipCheck.betSlipPreview,
          clicked: clicked.text
        };
      }

      await this.page.waitForTimeout(300);

      // Step 2: Select Cash (always use cash)
      await this.page.evaluate(() => {
        const cashBtns = document.querySelectorAll('button, [role="button"]');
        for (const btn of cashBtns) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('cash')) {
            btn.click();
            break;
          }
        }
      });

      await this.page.waitForTimeout(300);

      // Step 3: Enter $0.20 wager
      const wagerEntered = await this.page.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
          if (input.offsetParent !== null && (
            input.type === 'text' || 
            input.type === 'number' || 
            input.placeholder?.toLowerCase().includes('wager') ||
            input.placeholder?.toLowerCase().includes('amount')
          )) {
            input.value = '';
            input.focus();
            
            // Type 0.20
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, '0.20');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      });

      if (!wagerEntered) {
        console.log('⚠️ Could not enter wager amount');
      }

      await this.page.waitForTimeout(500);

      // Step 4: Click SUBMIT button
      console.log('Looking for Submit button...');
      
      const betResult = await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], [type="submit"], input[type="submit"]');
        
        // Log all buttons found
        const allBtnTexts = [];
        buttons.forEach(btn => {
          if (btn.offsetParent !== null) {
            allBtnTexts.push(btn.textContent?.trim().substring(0, 30));
          }
        });
        console.log('Visible buttons:', allBtnTexts);
        
        // First look for "Submit" button specifically
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase().trim();
          if (text === 'submit' || text.includes('submit')) {
            if (!btn.disabled && btn.offsetParent !== null) {
              console.log('Clicking submit button:', btn.textContent);
              btn.click();
              return { clicked: true, button: 'submit' };
            }
          }
        }
        
        // Try by class name
        const submitBtns = document.querySelectorAll('[class*="submit"], [class*="Submit"]');
        for (const btn of submitBtns) {
          if (!btn.disabled && btn.offsetParent !== null) {
            console.log('Clicking by class:', btn.className);
            btn.click();
            return { clicked: true, button: 'class-submit' };
          }
        }
        
        // Fallback to other bet buttons
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if ((text.includes('place') || text.includes('bet') || text.includes('confirm')) && 
              !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return { clicked: true, button: text };
          }
        }
        
        return { clicked: false, buttons: allBtnTexts };
      });

      console.log('Submit result:', betResult);

      if (!betResult.clicked) {
        console.log('❌ No submit button found. Buttons:', betResult.buttons);
        return { success: false, error: 'Could not find submit button' };
      }

      await this.page.waitForTimeout(2000);

      // Step 5: Check result
      const result = await this.page.evaluate(() => {
        const pageText = document.body.innerText.toLowerCase();
        
        // Check for odds changed message
        if (pageText.includes('odds have changed') || 
            pageText.includes('odds changed') || 
            pageText.includes('price changed')) {
          return { oddsChanged: true };
        }
        
        // Check for success
        if (pageText.includes('bet placed') || 
            pageText.includes('success') ||
            pageText.includes('confirmed')) {
          return { success: true };
        }
        
        // Check for error
        if (pageText.includes('error') || pageText.includes('failed')) {
          return { error: 'Bet rejected' };
        }
        
        return { success: true }; // Assume success if no error
      });

      // Close any modals/bet slip
      await this.page.evaluate(() => {
        const closeButtons = document.querySelectorAll('[class*="close"], [class*="Close"], [aria-label="close"]');
        closeButtons.forEach(btn => btn.click());
      });

      return result;

    } catch (e) {
      console.error('Prefire error:', e);
      return { success: false, error: e.message };
    }
  }

  // =============================================
  // DIRECT API BETTING - Fast method using API
  // =============================================

  // Save locked API request for a specific oddId (from lock and load)
  saveLockedAPIRequest(oddId, url, headers, requestBody) {
    if (!oddId) return;
    this.lockedAPIRequests.set(oddId, {
      url,
      headers: { ...headers },
      requestBody: JSON.parse(JSON.stringify(requestBody)), // Deep clone
      timestamp: Date.now()
    });
    console.log(`🔒 Saved locked API request for oddId: ${oddId}`);
  }
  
  // Get locked API request for a specific oddId
  getLockedAPIRequest(oddId) {
    if (!oddId) return null;
    return this.lockedAPIRequests.get(oddId) || null;
  }

  async placeBetViaAPI(selection, targetOdds, wager, coinType, param = null, market = null, oddId = null, useLockedRequest = false) {
    // Always use cash - coinType parameter kept for compatibility but ignored
    coinType = 'cash';
    
    // Check if we have a locked API request for this oddId
    let lockedRequest = null;
    if (useLockedRequest && oddId) {
      lockedRequest = this.getLockedAPIRequest(oddId);
      if (lockedRequest) {
        console.log(`🔒 Using locked API request for oddId: ${oddId}`);
      }
    }
    
    if (!lockedRequest) {
      // Fallback to regular endpoint
      if (!this.bettingEndpoint) {
        return { success: false, error: 'Betting API endpoint not captured yet. Place a bet manually in the browser first to capture it.' };
      }
      
      if (!this.bearerToken && !this.authToken) {
        return { success: false, error: 'Auth token not available. Please ensure you are logged in.' };
      }
    }
    
    // Reduced logging for cleaner output
    console.log(`🚀 PLACING BET VIA API: ${selection} @ ${targetOdds} - $${wager}${lockedRequest ? ' (using locked request)' : ''}`);
    if (lockedRequest) {
      console.log(`   Using locked endpoint: ${lockedRequest.url.substring(0, 100)}...`);
    } else {
      console.log(`   Endpoint: ${this.bettingEndpoint.substring(0, 100)}...`);
    }
    console.log(`   Has bearer token: ${!!this.bearerToken}`);
    console.log(`   Has auth token: ${!!this.authToken}`);
    
    try {
      // Analyze captured bet requests to understand the format
      let requestBody = {};
      let template = null;
      let requestUrl = null;
      let requestHeaders = {};
      
      if (lockedRequest) {
        // Use locked request - this locks the odds!
        requestUrl = lockedRequest.url;
        requestHeaders = { ...lockedRequest.headers };
        requestBody = JSON.parse(JSON.stringify(lockedRequest.requestBody)); // Deep clone
        
        console.log(`🔒 Using locked API request - odds are locked!`);
      } else if (this.capturedBetRequests.length > 0) {
        // Use the most recent bet request as a template
        template = this.capturedBetRequests[this.capturedBetRequests.length - 1];
        try {
          requestBody = JSON.parse(template.postData);
          // Reduced logging - only log if needed for debugging
        } catch (e) {
          console.log('⚠️ Could not parse template request body:', e.message);
        }
      }
      
      // Build request body - properly handle nested Fliff API structure
      if (lockedRequest) {
        // Using locked request - ONLY update wager amount, keep everything else the same!
        // Convert wager to cents (Fliff uses cents for amounts)
        const riskAmountCents = Math.round(wager * 100);
        
        // Calculate expected payout based on odds (from locked request)
        const lockedPick = requestBody.invocation?.request?.picks?.[0];
        if (lockedPick) {
          const lockedOdds = lockedPick.selections?.[0]?.coeff || targetOdds;
          let expectedPayoutCents;
          if (lockedOdds > 0) {
            expectedPayoutCents = Math.round((lockedOdds / 100) * riskAmountCents) + riskAmountCents;
          } else {
            expectedPayoutCents = Math.round((100 / Math.abs(lockedOdds)) * riskAmountCents) + riskAmountCents;
          }
          
          // ONLY update the wager amount - keep everything else locked!
          lockedPick.risk_amount = riskAmountCents;
          lockedPick.expected_payout_amount = expectedPayoutCents;
          
          // Generate new shopping cart ID (required for each bet)
          if (requestBody.invocation?.request) {
            requestBody.invocation.request.unique_shopping_cart_id = Math.random().toString(36).substring(2, 11) + Math.random().toString(36).substring(2, 11);
          }
          
          // Update conn_id (increment it)
          if (requestBody.header && typeof requestBody.header.conn_id === 'number') {
            requestBody.header.conn_id = requestBody.header.conn_id + 1;
          }
        }
      } else if (template && requestBody && Object.keys(requestBody).length > 0) {
        // Deep clone the template structure
        requestBody = JSON.parse(JSON.stringify(requestBody));
        
        // Convert wager to cents (Fliff uses cents for amounts)
        const riskAmountCents = Math.round(wager * 100);
        
        // Calculate expected payout based on odds
        // For American odds: positive odds = (odds/100) * wager, negative odds = (100/|odds|) * wager
        let expectedPayoutCents;
        if (targetOdds > 0) {
          expectedPayoutCents = Math.round((targetOdds / 100) * riskAmountCents) + riskAmountCents;
        } else {
          expectedPayoutCents = Math.round((100 / Math.abs(targetOdds)) * riskAmountCents) + riskAmountCents;
        }
        
        // Update the nested structure properly
        if (requestBody.invocation && requestBody.invocation.request) {
          const request = requestBody.invocation.request;
          
          // Update picks array
          if (request.picks && request.picks.length > 0) {
            const pick = request.picks[0];
            
            // Update risk amount and expected payout
            pick.risk_amount = riskAmountCents;
            pick.expected_payout_amount = expectedPayoutCents;
            pick.confirmed_server_quote_coeff = 0;
            
            // Update selections array
            if (pick.selections && pick.selections.length > 0) {
              const selection = pick.selections[0];
              if (oddId) {
                selection.proposal_fkey = oddId;
              }
              // Use American odds directly (no conversion needed)
              selection.coeff = targetOdds;
            } else {
              // Create selection if it doesn't exist
              pick.selections = [{
                proposal_fkey: oddId || '',
                coeff: targetOdds
              }];
            }
            
            // FORCE Fliff Cash - always override (never use gold coins)
            // Remove any gold coin related fields
            delete pick.currency_code;
            delete pick.type;
            pick.currency_code = 331; // 331 = Fliff Cash in cents
            pick.type = 81; // 81 = Fliff Cash
          } else {
            // Create picks array if it doesn't exist
            request.picks = [{
              type: 81,
              currency_code: 331,
              risk_amount: riskAmountCents,
              confirmed_server_quote_coeff: 0,
              expected_payout_amount: expectedPayoutCents,
              selections: [{
                proposal_fkey: oddId || '',
                coeff: targetOdds
              }],
              is_same_game_parlay_mode: false
            }];
          }
          
          // Generate new unique shopping cart ID
          request.unique_shopping_cart_id = Math.random().toString(36).substring(2, 11) + Math.random().toString(36).substring(2, 11);
          
          // Ensure verify_mode is 0
          request.verify_mode = 0;
        }
        
        // Update header conn_id (increment it)
        if (requestBody.header && typeof requestBody.header.conn_id === 'number') {
          requestBody.header.conn_id = requestBody.header.conn_id + 1;
        }
        
      } else {
        // Fallback: build from scratch (shouldn't happen if template exists, but just in case)
        console.warn('⚠️ No template available, using fallback structure');
        requestBody = {
          header: {
            device_x_id: this.deviceXId || 'web.unknown',
            app_x_version: '5.0.23.241',
            app_install_token: this.appInstallToken || '',
            auth_token: this.authToken || '',
            conn_id: 1,
            platform: 'prod',
            usa_state_code: 'CA',
            usa_state_code_source: 'ipOrigin=radar|regionCode=CA|meta=successGetRegionCode|geocodeOrigin=radar|regionCode=CA|meta=successGetRegionCode'
          },
          invocation: {
            request: {
              __object_class_name: 'FCM__Place_Pick__Request',
              picks: [{
                type: 81,
                currency_code: 331,
                risk_amount: Math.round(wager * 100),
                confirmed_server_quote_coeff: 0,
                expected_payout_amount: Math.round((targetOdds > 0 ? (targetOdds / 100) : (100 / Math.abs(targetOdds))) * wager * 100) + Math.round(wager * 100),
                selections: [{
                  proposal_fkey: oddId || '',
                  coeff: targetOdds
                }],
                is_same_game_parlay_mode: false
              }],
              unique_shopping_cart_id: Math.random().toString(36).substring(2, 11) + Math.random().toString(36).substring(2, 11),
              verify_mode: 0,
              subfeed_meta: {
                packed_subfeed_revisions: []
              }
            }
          }
        };
      }
      
      // Build headers - use locked headers if available, otherwise use captured headers
      let headers = {};
      if (lockedRequest) {
        // Use locked headers (preserves exact auth tokens and other params)
        // BUT update Authorization header with current profile's bearer token
        headers = { ...lockedRequest.headers };
        
        // IMPORTANT: Update bearer token to use current profile's token (tokens can expire/change)
        if (this.bearerToken) {
          headers['Authorization'] = this.bearerToken;
          console.log(`🔑 Updated locked request with current bearer token`);
        } else if (this.authToken) {
          // Fallback to auth token if bearer token not available
          headers['X-Auth-Token'] = this.authToken;
          headers['Authorization'] = `Bearer ${this.authToken}`;
          console.log(`🔑 Updated locked request with current auth token`);
        } else {
          console.log(`⚠️ No current bearer/auth token available - using locked request token (may be expired)`);
        }
      } else {
        // Build headers from captured data
        headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...this.apiHeaders
        };
        
        // Ensure auth token is included (use bearer token or auth token)
        if (this.bearerToken) {
          headers['Authorization'] = this.bearerToken;
        } else if (this.authToken) {
          // Some APIs use auth_token in query or header
          headers['X-Auth-Token'] = this.authToken;
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }
      }
      
      // Remove undefined values
      Object.keys(headers).forEach(key => {
        if (headers[key] === undefined) delete headers[key];
      });
      
      // Update conn_id in URL query parameters to match header
      if (!requestUrl) {
        requestUrl = this.bettingEndpoint;
      }
      if (requestBody.header && typeof requestBody.header.conn_id === 'number') {
        const urlObj = new URL(requestUrl);
        urlObj.searchParams.set('conn_id', requestBody.header.conn_id.toString());
        requestUrl = urlObj.toString();
      }
      
      // Reduced logging - only log essential info
      
      // Make the API request - use built-in fetch (Node 18+) or require node-fetch
      let fetch;
      try {
        // Try built-in fetch first (Node 18+)
        fetch = globalThis.fetch || require('node-fetch');
      } catch (e) {
        // Fallback to https module if fetch not available
        const https = require('https');
        const url = require('url');
        return new Promise((resolve) => {
          const parsedUrl = new url.URL(requestUrl);
          const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: headers
          };
          
          const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const responseData = JSON.parse(data);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  resolve({ success: true, response: responseData });
                } else {
                  resolve({ success: false, error: `API error: ${res.statusCode}` });
                }
              } catch (e) {
                resolve({ success: false, error: 'Invalid JSON response' });
              }
            });
          });
          
          req.on('error', (e) => {
            resolve({ success: false, error: e.message });
          });
          
          req.write(JSON.stringify(requestBody));
          req.end();
          return;
        });
      }
      
      // Add timeout to fetch request (30 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      console.log(`📤 Sending API request...`);
      
      // If this is a lock and load request ($0.20), capture it for later use
      const isLockAndLoad = wager === 0.20 && oddId;
      if (isLockAndLoad && !lockedRequest) {
        // Save this request as locked - it will be reused for the actual bet
        this.saveLockedAPIRequest(oddId, requestUrl, headers, requestBody);
        console.log(`🔒 Captured and saved API request for lock & load (oddId: ${oddId})`);
      }
      
      let response;
      try {
        response = await fetch(requestUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        console.log(`📥 Received response: ${response.status} ${response.statusText}`);
      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
          console.error('❌ API request timeout after 30 seconds');
          return { success: false, error: 'API request timeout' };
        }
        console.error('❌ API request error:', e.message);
        return { success: false, error: `API request failed: ${e.message}` };
      }
      
      // Get response text first to handle both JSON and non-JSON responses
      const responseText = await response.text();
      let responseData;
      
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        // Not JSON, treat as text
        console.log('📥 API Response (non-JSON):', responseText.substring(0, 300));
        if (response.ok && responseText.toLowerCase().includes('success')) {
          return { success: true, response: { message: responseText } };
        } else {
          return { success: false, error: `API returned non-JSON: ${responseText.substring(0, 200)}` };
        }
      }
      
      // Check status in multiple possible locations
      const apiStatus = responseData.status || responseData.code || responseData.result?.status || responseData.data?.status;
      
      // Log response status with actual data
      console.log(`📥 Response: ${response.status} | Status: ${apiStatus || 'N/A'}`);
      if (apiStatus) {
        console.log(`Final result: ${JSON.stringify({ status: apiStatus, hasPickResult: responseData.hasPickResult || responseData.result?.hasPickResult || false })}`);
      } else if (responseData) {
        // Log first few keys to see what we got
        const keys = Object.keys(responseData).slice(0, 5);
        console.log(`Response keys: ${keys.join(', ')}`);
        
        // If we have a result field, log its structure for debugging
        if (responseData.result && typeof responseData.result === 'object') {
          const resultKeys = Object.keys(responseData.result);
          console.log(`Result keys: ${resultKeys.join(', ')}`);
          if (resultKeys.length > 0 && resultKeys.length <= 10) {
            console.log(`Result content: ${JSON.stringify(responseData.result).substring(0, 500)}`);
          }
        }
      }
      
      // Check for unauthorized errors first (401, 403) - but ONLY if response is not OK
      if (response.status === 401 || response.status === 403) {
        console.error(`❌ Unauthorized error (${response.status}): Bearer token may be expired or invalid`);
        return { 
          success: false, 
          error: `Unauthorized (${response.status}): Bearer token may be expired or invalid`,
          unauthorized: true,
          response: responseData
        };
      }
      
      if (response.ok) {
        // Check status codes FIRST - 8301 and 8300 are SUCCESS (check before unauthorized check)
        // Check all possible paths for status 8301/8300
        let actualStatus = apiStatus;
        
        // Check nested path: result.response.place_picks_operation_status.status
        if (responseData?.result?.response?.place_picks_operation_status?.status !== undefined) {
          actualStatus = responseData.result.response.place_picks_operation_status.status;
        } 
        // Check alternative path: response.place_picks_operation_status.status
        else if (responseData?.response?.place_picks_operation_status?.status !== undefined) {
          actualStatus = responseData.response.place_picks_operation_status.status;
        }
        // Check direct result.status
        else if (responseData?.result?.status !== undefined) {
          actualStatus = responseData.result.status;
        }
        
        // Status 8301 and 8300 are SUCCESS - return immediately if found
        if (actualStatus === 8301 || actualStatus === '8301' || actualStatus === 8300 || actualStatus === '8300') {
          console.log(`✅ Bet successful (status: ${actualStatus})`);
          return { success: true, response: responseData, status: actualStatus };
        }
        
        // Also check apiStatus as fallback
        if (apiStatus === 8301 || apiStatus === '8301' || apiStatus === 8300 || apiStatus === '8300') {
          console.log(`✅ Bet successful (apiStatus: ${apiStatus})`);
          return { success: true, response: responseData, status: apiStatus };
        }
        
        // Check for other success indicators in response
        if (apiStatus && typeof apiStatus === 'number') {
          // Some status codes indicate success (8301, 200, etc.)
          if (apiStatus >= 200 && apiStatus < 400) {
            console.log(`✅ Bet accepted (status: ${apiStatus})`);
            return { success: true, response: responseData, status: apiStatus };
          }
        }
        
        // Check result field first (since response has header, result, schema_version, x_slots)
        if (responseData.result) {
          // Check nested status path: result.response.place_picks_operation_status.status
          let resultStatus = responseData.result.status || responseData.result.code;
          
          // Check the nested path for status (Fliff API structure)
          if (responseData.result.response?.place_picks_operation_status?.status) {
            resultStatus = responseData.result.response.place_picks_operation_status.status;
          } else if (responseData.result.response?.status) {
            resultStatus = responseData.result.response.status;
          }
          
          // Log result structure for debugging
          const resultKeys = Object.keys(responseData.result);
          console.log(`📋 Result keys: ${resultKeys.join(', ')}`);
          if (resultKeys.length <= 10) {
            console.log(`📋 Result content: ${JSON.stringify(responseData.result).substring(0, 500)}`);
          }
          
          // Status 8301 and 8300 are SUCCESS - check FIRST before any error checks
          if (resultStatus === 8301 || resultStatus === '8301' || resultStatus === 8300 || resultStatus === '8300') {
            console.log(`✅ Bet successful (result.status: ${resultStatus})`);
            return { success: true, response: responseData, status: resultStatus };
          }
          
          // Check if result has success indicators
          if (responseData.result.success === true || 
              responseData.result.id ||
              responseData.result.bet_id ||
              responseData.result.ticket_id ||
              (resultStatus && typeof resultStatus === 'number' && resultStatus >= 200 && resultStatus < 400)) {
            console.log(`✅ Bet accepted (result.status: ${resultStatus || 'success'})`);
            return { success: true, response: responseData, status: resultStatus || 'success' };
          }
          
              // Check for error in result - check multiple possible error fields
              const errorFields = ['error', 'message', 'err', 'failure', 'fail'];
              for (const field of errorFields) {
                if (responseData.result[field]) {
                  const resultError = responseData.result[field];
                  let errorStr = '';
                  if (typeof resultError === 'string') {
                    errorStr = resultError;
                  } else if (typeof resultError === 'object' && resultError !== null) {
                    // Try to extract error_message first (Fliff API format)
                    if (resultError.error_message) {
                      errorStr = String(resultError.error_message);
                    } else if (resultError.message) {
                      errorStr = String(resultError.message);
                    } else if (resultError.error) {
                      errorStr = String(resultError.error);
                    } else if (resultError.error_code) {
                      // If we have error_code but no message, create a descriptive error
                      errorStr = `Error ${resultError.error_code}: ${resultError.error_message || 'Unknown error'}`;
                    } else {
                      // Last resort: convert to JSON but limit length
                      const jsonStr = JSON.stringify(resultError);
                      errorStr = jsonStr.length > 200 ? jsonStr.substring(0, 200) + '...' : jsonStr;
                    }
                  } else {
                    errorStr = String(resultError);
                  }
                  
                  const resultErrorLower = errorStr.toLowerCase();
                  
                  // Check for "no Fliff Cash" errors - skip this account
                  if (resultErrorLower.includes('gold coins') || 
                      resultErrorLower.includes('below min') ||
                      resultErrorLower.includes('bad risk_amount') ||
                      resultErrorLower.includes('insufficient') ||
                      resultErrorLower.includes('balance error') ||
                      resultErrorLower.includes('no enough playable') ||
                      resultErrorLower.includes('no enough') ||
                      resultErrorLower.includes('available: 0.00') ||
                      (resultErrorLower.includes('cash') && (resultErrorLower.includes('not available') || resultErrorLower.includes('no enough')))) {
                    console.log(`⚠️ Account has no Fliff Cash available: ${errorStr}`);
                    return { 
                      success: false, 
                      error: errorStr, 
                      noFliffCash: true, 
                      skipAccount: true 
                    };
                  }
                  
                  if (resultErrorLower.includes('odds') || resultErrorLower.includes('price') || resultErrorLower.includes('changed')) {
                    console.log(`⚠️ Odds changed detected in result.${field}: ${errorStr}`);
                    return { oddsChanged: true, error: errorStr };
                  }
                  
                  // Check for MARKET NOT AVAILABLE (error_code 30721) - specific error, don't retry
                  const hasMarketNotAvailableError = resultErrorLower.includes('market not available') || 
                      (resultError && typeof resultError === 'object' && resultError.error_code === 30721);
                  
                  if (hasMarketNotAvailableError) {
                    console.log(`⚠️ Market not available: ${errorStr}`);
                    return { 
                      success: false, 
                      error: errorStr, 
                      marketNotAvailable: true, 
                      skipRetry: true,
                      skipAccount: false // Don't skip account, just this market
                    };
                  }
                  
                  // Check for unauthorized errors
                  if (resultErrorLower.includes('unauthorized') || 
                      resultErrorLower.includes('401') || 
                      resultErrorLower.includes('authentication failed') ||
                      resultErrorLower.includes('invalid token') ||
                      resultErrorLower.includes('token expired')) {
                    console.error(`❌ Unauthorized error detected: ${errorStr}`);
                    return { 
                      success: false, 
                      error: errorStr, 
                      unauthorized: true 
                    };
                  }
                  
                  // Check for event not available or no longer inplay
                  if (resultErrorLower.includes('not available') || resultErrorLower.includes('no longer') || resultErrorLower.includes('inplay')) {
                    console.log(`⚠️ Event not available (no longer inplay): ${errorStr}`);
                    return { success: false, error: errorStr, eventNotAvailable: true, skipRetry: true };
                  }
                  console.log(`⚠️ Error detected in result.${field}: ${errorStr}`);
                  return { success: false, error: errorStr };
                }
              }
          
          // If result exists but no clear success/error, check if it's an error-like structure
          // Some APIs return errors in the result field itself
          if (typeof responseData.result === 'object' && !responseData.result.status && !responseData.result.id) {
            // Check all string values for error indicators
            for (const [key, value] of Object.entries(responseData.result)) {
              if (typeof value === 'string' && (value.toLowerCase().includes('error') || value.toLowerCase().includes('fail') || value.toLowerCase().includes('invalid'))) {
                console.log(`⚠️ Error-like value found in result.${key}: ${value}`);
                return { success: false, error: value };
              }
            }
          }
        }
        
        // Check if bet was successful - try multiple success indicators (only if result field wasn't already checked)
        if (!responseData.result && (
            responseData.success === true || 
            responseData.status === 'accepted' || 
            responseData.status === 'success' ||
            responseData.id ||
            responseData.bet_id ||
            responseData.ticket_id ||
            responseData.data?.id ||
            (responseData.message && typeof responseData.message === 'string' && responseData.message.toLowerCase().includes('success'))
          )) {
          return { success: true, response: responseData, status: apiStatus || 'success' };
        }
        
        // Check for errors at top level (only if result field wasn't checked)
        if (!responseData.result && (responseData.error || responseData.message)) {
          // Safely extract error message as string
          let errorMsg = '';
          if (responseData.message) {
            errorMsg = typeof responseData.message === 'string' ? responseData.message : String(responseData.message);
          } else if (responseData.error) {
            errorMsg = typeof responseData.error === 'string' ? responseData.error : String(responseData.error);
          }
          
          // Check for unauthorized errors
          const errorMsgLower = errorMsg.toLowerCase();
          if (errorMsgLower.includes('unauthorized') || 
              errorMsgLower.includes('401') || 
              errorMsgLower.includes('authentication failed') ||
              errorMsgLower.includes('invalid token') ||
              errorMsgLower.includes('token expired')) {
            console.error(`❌ Unauthorized error detected: ${errorMsg}`);
            return { 
              success: false, 
              error: errorMsg, 
              unauthorized: true 
            };
          }
          
          // Check for odds changed
          if (errorMsgLower.includes('odds') || errorMsgLower.includes('price') || errorMsgLower.includes('changed')) {
            return { oddsChanged: true, error: String(errorMsg || 'Odds changed') };
          }
          
          // Check for MARKET NOT AVAILABLE
          if (errorMsgLower.includes('market not available')) {
            console.log(`⚠️ Market not available: ${errorMsg}`);
            return { 
              success: false, 
              error: String(errorMsg || 'Market not available'), 
              marketNotAvailable: true, 
              skipRetry: true 
            };
          }
          
          // Check for "no Fliff Cash" errors
          if (errorMsgLower.includes('balance error') ||
              errorMsgLower.includes('no enough playable') ||
              errorMsgLower.includes('no enough') ||
              errorMsgLower.includes('available: 0.00') ||
              (errorMsgLower.includes('cash') && errorMsgLower.includes('no enough'))) {
            console.log(`⚠️ Account has no Fliff Cash available: ${errorMsg}`);
            return { 
              success: false, 
              error: String(errorMsg || 'No Fliff Cash available'), 
              noFliffCash: true, 
              skipAccount: true 
            };
          }
          
          return { success: false, error: String(errorMsg || 'Unknown error') };
        }
        
        // If we have a result field but no clear success/error indicators, log it for debugging
        if (responseData.result && !responseData.result.status && !responseData.result.error && !responseData.result.id && !responseData.result.bet_id && !responseData.result.ticket_id) {
          console.log(`⚠️ Response has result field but no clear status/error/id. Result keys: ${Object.keys(responseData.result).slice(0, 10).join(', ')}`);
          console.log(`⚠️ Result content: ${JSON.stringify(responseData.result).substring(0, 500)}`);
          
          // Check if result has any error-like fields
          const resultKeys = Object.keys(responseData.result);
          const errorKeys = resultKeys.filter(k => k.toLowerCase().includes('error') || k.toLowerCase().includes('fail') || k.toLowerCase().includes('message'));
          
          if (errorKeys.length > 0) {
            // Found error-like keys, extract the error message
            const errorValue = responseData.result[errorKeys[0]];
            let errorStr = '';
            if (typeof errorValue === 'string') {
              errorStr = errorValue;
            } else if (typeof errorValue === 'object' && errorValue !== null) {
              // Try to extract message from object
              if (errorValue.message) {
                errorStr = String(errorValue.message);
              } else if (errorValue.error) {
                errorStr = String(errorValue.error);
              } else {
                // Convert entire object to JSON string
                errorStr = JSON.stringify(errorValue);
              }
            } else {
              errorStr = String(errorValue);
            }
            
            // Check for MARKET NOT AVAILABLE
            const errorStrLower = errorStr.toLowerCase();
            if (errorStrLower.includes('market not available')) {
              console.log(`⚠️ Market not available: ${errorStr}`);
              return { 
                success: false, 
                error: errorStr, 
                marketNotAvailable: true, 
                skipRetry: true 
              };
            }
            
            // Check for "no Fliff Cash" errors
            if (errorStrLower.includes('balance error') ||
                errorStrLower.includes('no enough playable') ||
                errorStrLower.includes('no enough') ||
                errorStrLower.includes('available: 0.00') ||
                (errorStrLower.includes('cash') && errorStrLower.includes('no enough'))) {
              console.log(`⚠️ Account has no Fliff Cash available: ${errorStr}`);
              return { 
                success: false, 
                error: errorStr, 
                noFliffCash: true, 
                skipAccount: true 
              };
            }
            
            console.log(`⚠️ Found error in result: ${errorStr}`);
            return { success: false, error: errorStr };
          }
          
          // Check if result itself might be an error (if it's an object with error-like structure)
          if (typeof responseData.result === 'object' && responseData.result !== null) {
            // Check all values in result for error indicators
            for (const [key, value] of Object.entries(responseData.result)) {
              if (typeof value === 'string' && (value.toLowerCase().includes('error') || value.toLowerCase().includes('fail'))) {
                console.log(`⚠️ Found error-like value in result.${key}: ${value}`);
                return { success: false, error: String(value) };
              }
            }
          }
          
          // Try to parse result as success if it exists and has no error
          // BUT only if we haven't already detected an error above
          if (responseData.result && !responseData.result.error && !responseData.result.message) {
            // Double-check: make sure result doesn't have error_code indicating failure
            if (!responseData.result.error_code || responseData.result.error_code < 30000) {
              console.log(`✅ Assuming success - result exists with no error`);
              return { success: true, response: responseData, status: 'success' };
            }
          }
        }
        
        // If no clear success/error, assume success if status is 200
        return { success: true, response: responseData, status: apiStatus || 'unknown' };
      } else {
        // HTTP error status
        let errorMsg = responseData.message || responseData.error || response.statusText;
        if (errorMsg && typeof errorMsg !== 'string') {
          errorMsg = typeof errorMsg === 'object' && errorMsg.message 
            ? String(errorMsg.message) 
            : String(errorMsg);
        }
        return { success: false, error: `API error (${response.status}): ${errorMsg || 'Unknown error'}` };
      }
      
    } catch (e) {
      console.error('❌ API betting error:', e.message);
      return { success: false, error: String(e.message || 'Unknown error'), method: 'api' };
    }
  }

  // =============================================
  // PLACE BET API ONLY - No Puppeteer fallback (for lock and load)
  // =============================================

  async placeBetAPIOnly(selection, targetOdds, wager, coinType, param = null, market = null, oddId = null) {
    // Always use cash - coinType parameter kept for compatibility but ignored
    console.log(`\n💰 PLACING BET VIA API ONLY: ${selection} @ ${targetOdds} - $${wager} (Cash)`);
    if (param) console.log(`   Param: ${param}`);
    if (market) console.log(`   Market: ${market}`);
    if (oddId) console.log(`   Odd ID: ${oddId}`);
    
    // Check prerequisites
    if (!this.page) {
      const error = 'Browser page not available';
      console.error(`❌ ${error}`);
      return { success: false, error };
    }
    
    if (!this.browser) {
      const error = 'Browser not available';
      console.error(`❌ ${error}`);
      return { success: false, error };
    }
    
    // Check API status
    const apiStatus = this.getBettingAPIStatus();
    console.log(`📊 API Status: endpoint=${!!apiStatus.endpoint}, hasAuth=${apiStatus.hasAuth}, method=${apiStatus.method}`);
    
    // API ONLY - no fallback to Puppeteer
    if (!this.bettingEndpoint || (!this.bearerToken && !this.authToken)) {
      const error = this.bettingEndpoint 
        ? 'Auth token not available. Please ensure you are logged in.'
        : 'Betting API endpoint not captured yet. Place a bet manually in the browser first to capture it.';
      console.error(`❌ ${error}`);
      return { success: false, error };
    }
    
    console.log('🚀 Placing bet via API (API-only mode, no Puppeteer fallback)...');
    console.log(`   Endpoint: ${this.bettingEndpoint.substring(0, 80)}...`);
    
    try {
      const apiResult = await this.placeBetViaAPI(selection, targetOdds, wager, 'cash', param, market, oddId);
      
      if (apiResult && apiResult.success) {
        console.log('✅ Bet placed via API!');
        if (apiResult.status) {
          console.log(`   Status: ${apiResult.status}`);
        }
        return apiResult;
      } else {
        // API failed - return error (no Puppeteer fallback)
        const errorMsg = apiResult && typeof apiResult.error === 'string' 
          ? apiResult.error 
          : (apiResult && apiResult.error && typeof apiResult.error === 'object' && apiResult.error.message)
            ? apiResult.error.message
            : apiResult && apiResult.error
              ? JSON.stringify(apiResult.error)
              : 'API bet failed - no fallback available';
        console.error(`❌ API bet failed: ${errorMsg}`);
        return apiResult || { success: false, error: errorMsg };
      }
    } catch (e) {
      console.error(`❌ API bet error: ${e.message}`);
      console.error(`   Stack: ${e.stack}`);
      return { success: false, error: e.message };
    }
  }

  // =============================================
  // PLACE REAL BET - After prefire succeeds
  // =============================================

  async placeBet(selection, targetOdds, wager, coinType, param = null, market = null, oddId = null) {
    // Always use cash - coinType parameter kept for compatibility but ignored
    console.log(`\n💰 PLACING BET: ${selection} @ ${targetOdds} - $${wager} (Cash)`);
    if (param) console.log(`   Param: ${param}`);
    if (market) console.log(`   Market: ${market}`);
    if (oddId) console.log(`   Odd ID: ${oddId}`);
    
    // Check prerequisites
    if (!this.page) {
      const error = 'Browser page not available';
      console.error(`❌ ${error}`);
      return { success: false, error };
    }
    
    if (!this.browser) {
      const error = 'Browser not available';
      console.error(`❌ ${error}`);
      return { success: false, error };
    }
    
    // Check API status
    const apiStatus = this.getBettingAPIStatus();
    console.log(`📊 API Status: endpoint=${!!apiStatus.endpoint}, hasAuth=${apiStatus.hasAuth}, method=${apiStatus.method}`);
    
    // Try API method first (much faster) - ALWAYS try if we have endpoint
    if (this.bettingEndpoint && (this.bearerToken || this.authToken)) {
      console.log('🚀 Attempting direct API bet (preferred method)...');
      console.log(`   Endpoint: ${this.bettingEndpoint.substring(0, 80)}...`);
      let apiResult;
      try {
        apiResult = await this.placeBetViaAPI(selection, targetOdds, wager, 'cash', param, market, oddId);
      } catch (e) {
        console.error(`❌ API bet error: ${e.message}`);
        console.error(`   Stack: ${e.stack}`);
        apiResult = { success: false, error: e.message };
      }
      
      if (apiResult && apiResult.success) {
        console.log('✅ Bet placed via API! (Fast method)');
        if (apiResult.status) {
          console.log(`   Status: ${apiResult.status}`);
        }
        return apiResult;
      } else {
        // Log the error but still try Puppeteer as fallback
        const errorMsg = apiResult && typeof apiResult.error === 'string' 
          ? apiResult.error 
          : (apiResult && apiResult.error && typeof apiResult.error === 'object' && apiResult.error.message)
            ? apiResult.error.message
            : apiResult && apiResult.error
              ? JSON.stringify(apiResult.error)
              : 'Unknown error';
        console.log(`⚠️ API bet failed: ${errorMsg}`);
        
        // Don't fall back to Puppeteer if account has no Fliff Cash
        if (apiResult && (apiResult.noFliffCash || apiResult.skipAccount)) {
          console.log('   Account has no Fliff Cash - skipping (no fallback to Puppeteer)');
          return apiResult;
        }
        
        // Don't fall back to Puppeteer if market is not available
        if (apiResult && apiResult.marketNotAvailable) {
          console.log('   Market not available - skipping (no fallback to Puppeteer)');
          return apiResult;
        }
        
        // Don't fall back to Puppeteer if event is not available
        if (apiResult && apiResult.eventNotAvailable) {
          console.log('   Event not available - skipping (no fallback to Puppeteer)');
          return apiResult;
        }
        
        if (apiResult && apiResult.oddsChanged) {
          console.log('   Odds changed - returning early');
          return apiResult;
        }
        console.log('   Falling back to Puppeteer method...');
      }
    } else {
      if (!this.bettingEndpoint) {
        console.log('⚠️ API endpoint not captured yet. Place a bet manually in browser to capture it.');
      }
      if (!this.bearerToken && !this.authToken) {
        console.log('⚠️ Auth token not available. Please ensure you are logged in.');
      }
      console.log('   Using Puppeteer method as fallback...');
    }
    
    // Fallback to Puppeteer method
    if (!this.page) throw new Error('Browser not connected');
    
    try {
      // Wait for page to be ready
      try {
        await this.page.waitForSelector('body', { timeout: 5000 });
      } catch (e) {
        console.log('Page not ready, waiting...');
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // Use the same improved matching logic as prefire
      const clicked = await this.page.evaluate(async (sel, odds, param, market, oddId) => {
        console.log('🔍 Looking for:', {
          selection: sel,
          odds: odds,
          param: param,
          market: market,
          oddId: oddId
        });
        
        // Normalize the search terms
        const selLower = (sel || '').toLowerCase().trim();
        const oddsStr = odds > 0 ? `+${odds}` : odds.toString();
        const paramLower = (param || '').toLowerCase().trim();
        const marketLower = (market || '').toLowerCase().trim();
        
        // Extract key parts from selection
        const selParts = selLower.split(/\s+/).filter(p => p.length > 0);
        // Extract number with word boundaries to ensure exact match
        const numberMatch = selLower.match(/(?:over|under|o|u)\s+(\d+\.?\d*)|^(\d+\.?\d*)$|(\d+\.?\d*)/);
        const numberInSel = numberMatch ? (numberMatch[1] || numberMatch[2] || numberMatch[3]) : null;
        
        // Get all clickable elements - expanded selectors
        const selectors = [
          'button',
          '[role="button"]',
          '[class*="odds"]', '[class*="Odds"]',
          '[class*="coeff"]', '[class*="Coeff"]',
          '[class*="proposal"]', '[class*="Proposal"]',
          '[class*="cell"]', '[class*="Cell"]',
          '[class*="pick"]', '[class*="Pick"]',
          '[class*="bet"]', '[class*="Bet"]',
          '[class*="line"]', '[class*="Line"]',
          '[class*="option"]', '[class*="Option"]',
          '[data-proposal]', '[data-odd]', '[data-id]',
          'a[href*="bet"]', 'a[href*="wager"]'
        ];
        
        const allElements = [];
        selectors.forEach(selector => {
          try {
            const found = document.querySelectorAll(selector);
            allElements.push(...Array.from(found));
          } catch (e) {
            // Invalid selector, skip
          }
        });
        
        // Also try to find by data attributes if oddId is provided
        let elementsById = [];
        if (oddId) {
          const idSelectors = [
            `[data-id="${oddId}"]`,
            `[data-proposal="${oddId}"]`,
            `[data-odd-id="${oddId}"]`,
            `[data-proposal-fkey="${oddId}"]`,
            `[id*="${oddId}"]`
          ];
          
          idSelectors.forEach(selector => {
            try {
              const found = document.querySelectorAll(selector);
              elementsById.push(...Array.from(found));
            } catch (e) {
              // Invalid selector, skip
            }
          });
        }
        
        // Filter to only visible elements
        const elements = Array.from(allElements).filter(el => {
          return el.offsetParent !== null && 
                 el.offsetWidth > 0 && 
                 el.offsetHeight > 0 &&
                 window.getComputedStyle(el).display !== 'none' &&
                 window.getComputedStyle(el).visibility !== 'hidden';
        });
        
        // Combine with elements found by ID (remove duplicates)
        const allCandidates = [...elements];
        elementsById.forEach(el => {
          if (!allCandidates.includes(el) && el.offsetParent !== null) {
            allCandidates.push(el);
          }
        });
        
        console.log('Found', elements.length, 'visible clickable elements');
        if (elementsById.length > 0) {
          console.log('Found', elementsById.length, 'elements by ID/attribute');
        }
        
        // Helper function to check if number matches exactly (with word boundaries)
        function numberMatchesExactly(text, targetNumber) {
          if (!targetNumber) return false;
          // Create regex with word boundaries to match exact number
          // This prevents "33" from matching "33.5", "330", "3", etc.
          const exactNumberRegex = new RegExp(`\\b${targetNumber.replace('.', '\\.')}\\b`);
          return exactNumberRegex.test(text);
        }
        
        // Helper to check market section (same as prefire)
        function isInCorrectMarketSection(el, expectedMarket) {
          if (!expectedMarket) return true;
          
          const expectedMarketLower = expectedMarket.toLowerCase();
          let parent = el.parentElement;
          let contextText = '';
          let depth = 0;
          
          while (parent && depth < 8) {
            const parentText = (parent.textContent || '').toLowerCase();
            contextText = parentText + ' ' + contextText;
            parent = parent.parentElement;
            depth++;
          }
          
          const marketKeywords = {
            'game': ['game', 'full game', 'match'],
            '1st half': ['1st half', 'first half', '1h', 'half 1', 'h1'],
            '2nd half': ['2nd half', 'second half', '2h', 'half 2', 'h2'],
            '1st quarter': ['1st quarter', 'first quarter', 'q1', 'quarter 1'],
            '2nd quarter': ['2nd quarter', 'second quarter', 'q2', 'quarter 2'],
            '3rd quarter': ['3rd quarter', 'third quarter', 'q3', 'quarter 3'],
            '4th quarter': ['4th quarter', 'fourth quarter', 'q4', 'quarter 4']
          };
          
          let lookingFor = [];
          if (expectedMarketLower.includes('game') || (!expectedMarketLower.includes('half') && !expectedMarketLower.includes('quarter'))) {
            lookingFor.push('game');
          }
          if (expectedMarketLower.includes('1st half') || expectedMarketLower.includes('1h')) {
            lookingFor.push('1st half');
          }
          if (expectedMarketLower.includes('2nd half') || expectedMarketLower.includes('2h')) {
            lookingFor.push('2nd half');
          }
          if (expectedMarketLower.includes('quarter')) {
            const qMatch = expectedMarketLower.match(/(\d+)(st|nd|rd|th)?\s*quarter/);
            if (qMatch) {
              lookingFor.push(`${qMatch[1]}${qMatch[2] || 'st'} quarter`);
            }
          }
          
          for (const marketType of lookingFor) {
            const keywords = marketKeywords[marketType] || [];
            for (const keyword of keywords) {
              if (contextText.includes(keyword)) {
                return true;
              }
            }
          }
          
          return contextText.includes(expectedMarketLower);
        }
        
        // Score each element
        const scoredElements = allCandidates.map(el => {
          const text = (el.textContent || '').toLowerCase().trim();
          let score = 0;
          const reasons = [];
          
          // Bonus for elements found by data attributes/ID
          const hasMatchingId = oddId && (
            el.getAttribute('data-id') === oddId ||
            el.getAttribute('data-proposal') === oddId ||
            el.getAttribute('data-odd-id') === oddId ||
            el.getAttribute('data-proposal-fkey') === oddId ||
            (el.id && el.id.includes(oddId))
          );
          
          if (hasMatchingId) {
            score += 200; // Very high score for ID match
            reasons.push('id-match');
          }
          
          if (text.includes(oddsStr)) {
            score += 100;
            reasons.push('has-odds');
          }
          
          if (selLower && text.includes(selLower)) {
            score += 50;
            reasons.push('has-selection');
          } else if (selParts.length > 0) {
            const matchedParts = selParts.filter(part => text.includes(part)).length;
            if (matchedParts > 0) {
              score += (matchedParts / selParts.length) * 30;
              reasons.push(`partial-selection-${matchedParts}/${selParts.length}`);
            }
          }
          
          // Check for EXACT number match (e.g., "33" should match "33" but NOT "33.5" or "330")
          if (numberInSel && numberMatchesExactly(text, numberInSel)) {
            score += 30; // Increased weight for exact number match
            reasons.push('has-exact-number');
          } else if (numberInSel && text.includes(numberInSel)) {
            // Fallback: if exact match fails, check substring (but with lower score)
            score += 10; // Lower score for substring match
            reasons.push('has-number-substring');
          }
          
          if (paramLower && text.includes(paramLower)) {
            score += 30;
            reasons.push('has-param');
          }
          
          // Market context check
          if (marketLower) {
            if (isInCorrectMarketSection(el, market)) {
              score += 50;
              reasons.push('in-market-context');
            } else {
              score -= 30;
              reasons.push('not-in-market');
            }
          }
          
          return { element: el, score, text: text.substring(0, 80), reasons };
        });
        
        scoredElements.sort((a, b) => b.score - a.score);
        
        // Find strict matches
        const isSpread = selLower.includes('+') || selLower.includes('-') || marketLower.includes('spread');
        const isTotal = selLower.includes('over') || selLower.includes('under') || marketLower.includes('total');
        
        const strictMatches = scoredElements.filter(item => {
          const hasIdMatch = item.reasons.includes('id-match');
          const hasExactOdds = item.reasons.includes('has-odds');
          const hasExactSelection = item.reasons.includes('has-selection');
          const hasExactNumber = item.reasons.includes('has-exact-number');
          
          // If we have an ID match, that's very reliable - accept it
          if (hasIdMatch) {
            return true; // ID match is most reliable
          }
          
          // Otherwise, require odds and selection/number match
          if (!hasExactOdds) return false;
          if (!hasExactSelection && !hasExactNumber) return false;
          
          const text = item.text.toLowerCase();
          if (!text.includes(selLower) || !text.includes(oddsStr)) return false;
          
          // For totals (over/under), REQUIRE exact number match to prevent wrong selection
          if (isTotal && numberInSel) {
            // Must have exact number match, not substring match
            if (!hasExactNumber) {
              return false; // Reject if number doesn't match exactly (e.g., "33" should not match "33.5")
            }
            // Also verify the number appears in the text with exact match
            if (!numberMatchesExactly(text, numberInSel)) {
              return false;
            }
          }
          
          // For spreads/totals, require market context (unless we have ID match)
          if ((isSpread || isTotal) && !isInCorrectMarketSection(item.element, market)) {
            return false;
          }
          
          return true;
        });
        
        if (strictMatches.length > 0) {
          const bestMatch = strictMatches[0];
          console.log('✅ Using match:', bestMatch.text, 'Score:', bestMatch.score);
          bestMatch.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(r => setTimeout(r, 300));
          bestMatch.element.click();
          return { success: true, text: bestMatch.text };
        }
        
        return { success: false, error: 'No matching element found' };
      }, selection, targetOdds, param, market, oddId);

      if (!clicked.success) {
        return { success: false, error: clicked.error || 'Could not find odds to click', details: clicked };
      }
      
      console.log('✅ Clicked element:', clicked.text);

      await this.page.waitForTimeout(800);

      // Step 2: Select cash type (always use cash)
      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('cash')) {
            btn.click();
            break;
          }
        }
      });

      await this.page.waitForTimeout(300);

      // Step 3: Enter wager amount
      await this.page.evaluate((amt) => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
          if (input.offsetParent !== null) {
            input.value = '';
            input.focus();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, amt.toString());
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      }, wager);

      await this.page.waitForTimeout(500);

      // Step 4: Click SUBMIT button
      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], [type="submit"]');
        
        // First look for "Submit" button
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase().trim();
          if (text === 'submit' || text.includes('submit')) {
            if (!btn.disabled && btn.offsetParent !== null) {
              btn.click();
              return;
            }
          }
        }
        
        // Fallback
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if ((text.includes('place') || text.includes('bet')) && !btn.disabled) {
            btn.click();
            return;
          }
        }
      });

      await this.page.waitForTimeout(2000);

      // Step 5: Check result
      const result = await this.page.evaluate(() => {
        const pageText = document.body.innerText.toLowerCase();
        if (pageText.includes('odds have changed') || pageText.includes('odds changed')) {
          return { oddsChanged: true };
        }
        if (pageText.includes('bet placed') || pageText.includes('success')) {
          return { success: true };
        }
        return { success: true };
      });

      // Close bet slip
      await this.page.evaluate(() => {
        const closeButtons = document.querySelectorAll('[class*="close"], [class*="Close"]');
        closeButtons.forEach(btn => btn.click());
      });

      return result;

    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Place bet with reload during submission - for Lock & Load
  async placeBetWithReload(selection, targetOdds, wager, coinType, param = null, market = null, oddId = null) {
    console.log(`\n🔒 PLACING BET WITH RELOAD (Lock & Load): ${selection} @ ${targetOdds} - $${wager} (Cash)`);
    if (param) console.log(`   Param: ${param}`);
    if (market) console.log(`   Market: ${market}`);
    if (oddId) console.log(`   Odd ID: ${oddId}`);
    
    if (!this.page) throw new Error('Browser not connected');
    
    try {
      // Step 1: Click on the bet
      const clicked = await this.page.evaluate(async (sel, odds, param, market, oddId) => {
        // Use the same matching logic as placeBet
        const selLower = (sel || '').toLowerCase().trim();
        const oddsStr = odds > 0 ? `+${odds}` : odds.toString();
        const paramLower = (param || '').toLowerCase().trim();
        
        // Get all clickable elements
        const selectors = [
          'button', '[role="button"]',
          '[class*="odds"]', '[class*="Odds"]',
          '[class*="coeff"]', '[class*="Coeff"]',
          '[class*="proposal"]', '[class*="Proposal"]',
          '[data-proposal]', '[data-odd]', '[data-id]'
        ];
        
        const allElements = [];
        selectors.forEach(selector => {
          try {
            const found = document.querySelectorAll(selector);
            allElements.push(...Array.from(found));
          } catch (e) {}
        });
        
        // Filter to visible elements
        const elements = Array.from(allElements).filter(el => {
          return el.offsetParent !== null && 
                 el.offsetWidth > 0 && 
                 el.offsetHeight > 0;
        });
        
        // Find best match
        let bestMatch = null;
        let bestScore = 0;
        
        for (const el of elements) {
          const text = (el.textContent || '').toLowerCase();
          let score = 0;
          
          if (oddId && (el.id?.includes(oddId) || el.getAttribute('data-id') === oddId)) {
            score += 200;
          }
          if (selLower && text.includes(selLower)) {
            score += 50;
          }
          if (text.includes(oddsStr) || text.includes(odds.toString())) {
            score += 30;
          }
          if (paramLower && text.includes(paramLower)) {
            score += 20;
          }
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = el;
          }
        }
        
        if (bestMatch && bestScore > 0) {
          bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(r => setTimeout(r, 300));
          bestMatch.click();
          return { clicked: true };
        }
        
        return { clicked: false, error: 'No matching element found' };
      }, selection, targetOdds, param, market, oddId);
      
      if (!clicked.clicked) {
        return { betPlaced: false, error: clicked.error || 'Could not find bet to click' };
      }
      
      await this.page.waitForTimeout(800);
      
      // Step 2: Select cash type
      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('cash')) {
            btn.click();
            break;
          }
        }
      });
      
      await this.page.waitForTimeout(300);
      
      // Step 3: Enter wager amount ($0.20)
      await this.page.evaluate((amt) => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
          if (input.offsetParent !== null) {
            input.value = '';
            input.focus();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, amt.toString());
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      }, wager);
      
      await this.page.waitForTimeout(500);
      
      // Step 4: Click SUBMIT and reload page simultaneously
      console.log('🔄 Clicking submit and reloading page...');
      const submitPromise = this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], [type="submit"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase().trim();
          if (text === 'submit' || text.includes('submit')) {
            if (!btn.disabled && btn.offsetParent !== null) {
              btn.click();
              return true;
            }
          }
        }
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if ((text.includes('place') || text.includes('bet')) && !btn.disabled) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      // Reload page while submitting
      const reloadPromise = this.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      
      // Wait for both to complete
      const [submitClicked, reloadResult] = await Promise.all([submitPromise, reloadPromise]);
      
      if (!submitClicked) {
        return { betPlaced: false, error: 'Could not find submit button' };
      }
      
      console.log('✅ Bet submitted and page reloaded');
      await this.page.waitForTimeout(2000); // Wait for page to fully load
      
      // Step 5: Check if odds changed after reload
      const oddsCheck = await this.getCurrentOddsAfterRefresh(selection, targetOdds, param, market, oddId);
      
      if (!oddsCheck.found) {
        return { 
          betPlaced: true, 
          pageReloaded: true, 
          oddsChanged: true, 
          currentOdds: null,
          error: oddsCheck.error || 'Could not verify odds after reload' 
        };
      }
      
      const currentOdds = oddsCheck.currentOdds;
      if (currentOdds === null || currentOdds === undefined) {
        return { 
          betPlaced: true, 
          pageReloaded: true, 
          oddsChanged: true, 
          currentOdds: null,
          error: 'Could not extract odds from page' 
        };
      }
      
      // Compare odds - allow small floating point differences (0.5)
      const oddsChanged = Math.abs(currentOdds - targetOdds) > 0.5;
      
      console.log(`📊 Odds check: target=${targetOdds}, current=${currentOdds}, changed=${oddsChanged}`);
      
      return {
        betPlaced: true,
        pageReloaded: true,
        oddsChanged: oddsChanged,
        currentOdds: currentOdds,
        targetOdds: targetOdds
      };
      
    } catch (e) {
      console.error('❌ Place bet with reload error:', e.message);
      return { betPlaced: false, error: e.message };
    }
  }

  // Reload page - used to lock odds after placing coin bet
  async reloadPage() {
    if (!this.page) throw new Error('Browser not connected');
    
    try {
      console.log('🔄 Reloading page to lock odds...');
      await this.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await this.page.waitForTimeout(2000); // Wait a bit longer for page to fully load
      console.log('✅ Page reloaded successfully');
      return { success: true };
    } catch (e) {
      console.error('❌ Page reload error:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Get current odds and selection text from page for a specific oddId
  async getCurrentOddsAfterRefresh(selection, targetOdds, param = null, market = null, oddId = null) {
    if (!this.page) throw new Error('Browser not connected');
    
    try {
      // Wait longer for page to fully render after refresh
      await this.page.waitForTimeout(3000);
      
      // Try multiple times with different strategies
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await this.page.evaluate((sel, odds, param, market, oddId, attemptNum) => {
          // Strategy 1: Try to find by oddId first (most reliable)
          let foundElement = null;
          
          if (oddId) {
            const idSelectors = [
              `[data-id="${oddId}"]`,
              `[data-proposal="${oddId}"]`,
              `[data-odd-id="${oddId}"]`,
              `[data-proposal-fkey="${oddId}"]`,
              `[data-id*="${oddId}"]`,
              `[data-proposal*="${oddId}"]`
            ];
            
            for (const selector of idSelectors) {
              try {
                const el = document.querySelector(selector);
                if (el && el.offsetParent !== null) {
                  foundElement = el;
                  break;
                }
              } catch (e) {}
            }
          }
          
          // Strategy 2: Search by selection text with odds (STRICT MATCHING)
          if (!foundElement) {
            const selLower = (sel || '').toLowerCase().trim();
            const oddsStr = odds > 0 ? `+${odds}` : odds.toString();
            const oddsStrAlt = odds.toString(); // Also check without + sign
            
            // Try multiple selectors
            const selectors = [
              '[class*="odds"]',
              '[class*="coeff"]',
              '[class*="proposal"]',
              '[class*="bet"]',
              'button',
              '[role="button"]',
              '[class*="line"]',
              '[class*="pick"]'
            ];
            
            for (const baseSelector of selectors) {
              try {
                const allElements = document.querySelectorAll(baseSelector);
                for (const el of Array.from(allElements)) {
                  if (el.offsetParent === null) continue;
                  const text = (el.textContent || '').toLowerCase().trim();
                  
                  // STRICT: Must contain BOTH selection text AND odds
                  // For selection, require significant match (not just a single word)
                  const hasSelection = selLower && (
                    text === selLower || // Exact match
                    text.includes(selLower) || // Contains full selection
                    (selLower.length > 10 && text.includes(selLower.substring(0, Math.min(15, selLower.length)))) // First part for long selections
                  );
                  
                  // For odds, require exact match (with or without +)
                  const hasOdds = text.includes(oddsStr) || text.includes(oddsStrAlt);
                  
                  // Both must match
                  if (hasSelection && hasOdds) {
                    // Additional verification: check if param matches (for totals/spreads)
                    if (param) {
                      const paramStr = param.toString();
                      if (!text.includes(paramStr)) {
                        continue; // Skip if param doesn't match
                      }
                    }
                    foundElement = el;
                    break;
                  }
                }
                if (foundElement) break;
              } catch (e) {}
            }
          }
          
          // Strategy 3: Search by param (for totals/spreads)
          if (!foundElement && param) {
            const paramStr = param.toString();
            const allElements = document.querySelectorAll('button, [role="button"], [class*="odds"], [class*="coeff"]');
            
            for (const el of Array.from(allElements)) {
              if (el.offsetParent === null) continue;
              const text = (el.textContent || '').toLowerCase();
              
              // Check if it contains param and odds
              if (text.includes(paramStr) && (text.includes(odds > 0 ? `+${odds}` : odds.toString()))) {
                foundElement = el;
                break;
              }
            }
          }
          
          // Strategy 4: Last resort - find by odds AND selection (never use odds alone)
          if (!foundElement && sel) {
            const selLower = (sel || '').toLowerCase().trim();
            const oddsStr = odds > 0 ? `+${odds}` : odds.toString();
            const allElements = document.querySelectorAll('[class*="odds"], [class*="coeff"], button, [role="button"]');
            
            for (const el of Array.from(allElements)) {
              if (el.offsetParent === null) continue;
              const text = (el.textContent || '').toLowerCase().trim();
              
              // MUST have both selection AND odds - never match on odds alone
              const hasSelection = selLower && text.includes(selLower);
              const hasOdds = text.includes(oddsStr) || text.includes(odds.toString());
              
              if (hasSelection && hasOdds) {
                // Check if it's in the right market context
                let parent = el.parentElement;
                let contextText = '';
                for (let i = 0; i < 5 && parent; i++) {
                  contextText = (parent.textContent || '').toLowerCase() + ' ' + contextText;
                  parent = parent.parentElement;
                }
                
                // If market is specified, check context
                if (!market || contextText.includes(market.toLowerCase()) || contextText.includes(selLower)) {
                  foundElement = el;
                  break;
                }
              }
            }
          }
          
          if (!foundElement) {
            return { found: false, error: 'Element not found', attempt: attemptNum };
          }
          
          const text = foundElement.textContent || '';
          // Extract odds from text - try multiple patterns
          let oddsMatch = text.match(/([+-]?\d+)/);
          if (!oddsMatch) {
            // Try decimal odds format
            oddsMatch = text.match(/(\d+\.\d+)/);
          }
          const currentOdds = oddsMatch ? parseFloat(oddsMatch[1]) : null;
          
          // Extract selection text
          const selectionText = text.trim().substring(0, 100);
          
          return {
            found: true,
            currentOdds: currentOdds,
            currentSelection: selectionText,
            originalOdds: odds,
            originalSelection: sel,
            attempt: attemptNum
          };
        }, selection, targetOdds, param, market, oddId, attempt);
        
        if (result.found) {
          return result;
        }
        
        // Wait a bit more before next attempt
        if (attempt < 2) {
          await this.page.waitForTimeout(1000);
        }
      }
      
      // If all attempts failed, return not found
      return { found: false, error: 'Element not found after multiple attempts' };
    } catch (e) {
      console.error('❌ Error getting current odds:', e.message);
      return { found: false, error: e.message };
    }
  }

  // Get current odds from page
  async getCurrentOdds(selection) {
    if (!this.page) throw new Error('Browser not connected');
    
    try {
      return await this.page.evaluate((sel) => {
        const elements = document.querySelectorAll('[class*="odds"], [class*="coeff"]');
        for (const el of elements) {
          if (el.textContent?.includes(sel)) {
            const match = el.textContent.match(/[+-]?\d+/);
            return match ? parseInt(match[0]) : null;
          }
        }
        return null;
      }, selection);
    } catch {
      return null;
    }
  }

  // Get auth token
  getAuthToken() {
    return this.authToken;
  }

  // Get bearer token
  getBearerToken() {
    return this.bearerToken;
  }
  
  // Get betting API status
  getBettingAPIStatus() {
    return {
      endpoint: this.bettingEndpoint,
      hasAuth: !!(this.bearerToken || this.authToken),
      method: this.bettingEndpoint ? 'api' : 'puppeteer',
      capturedRequests: this.capturedBetRequests.length,
      bearerToken: this.bearerToken ? '***' + this.bearerToken.slice(-10) : null,
      authToken: this.authToken ? '***' + this.authToken.slice(-10) : null
    };
  }
  
  // Navigate to game page to help capture betting endpoint
  async navigateToGame(gameId) {
    if (!this.page) throw new Error('Browser not connected');
    
    try {
      // Navigate to the game page
      const gameUrl = `https://sports.getfliff.com/game/${gameId}`;
      console.log(`🌐 Navigating to game page: ${gameUrl}`);
      await this.page.goto(gameUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await this.page.waitForTimeout(2000);
      console.log('✅ Navigated to game page - ready to capture betting endpoint');
      return { success: true };
    } catch (e) {
      console.error('❌ Navigation error:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Select bet (click on it) without placing - used for Lock & Load
  async selectBet(selection, targetOdds, param = null, market = null, oddId = null) {
    console.log(`\n🔒 SELECTING BET (Lock & Load): ${selection} @ ${targetOdds}`);
    if (param) console.log(`   Param: ${param}`);
    if (market) console.log(`   Market: ${market}`);
    if (oddId) console.log(`   Odd ID: ${oddId}`);
    
    if (!this.page) throw new Error('Browser not connected');
    
    try {
      // Wait for page to be ready
      try {
        await this.page.waitForSelector('body', { timeout: 5000 });
      } catch (e) {
        console.log('Page not ready, waiting...');
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // Use similar matching logic as placeBet but just click to select (not place)
      const clicked = await this.page.evaluate(async (sel, odds, param, market, oddId) => {
        console.log('🔍 Looking for bet to select:', {
          selection: sel,
          odds: odds,
          param: param,
          market: market,
          oddId: oddId
        });
        
        // Normalize the search terms
        const selLower = (sel || '').toLowerCase().trim();
        const oddsStr = odds > 0 ? `+${odds}` : odds.toString();
        const paramLower = (param || '').toLowerCase().trim();
        const marketLower = (market || '').toLowerCase().trim();
        
        // Extract number with word boundaries
        const numberMatch = selLower.match(/(?:over|under|o|u)\s+(\d+\.?\d*)|^(\d+\.?\d*)$|(\d+\.?\d*)/);
        const numberInSel = numberMatch ? (numberMatch[1] || numberMatch[2] || numberMatch[3]) : null;
        
        // Get all clickable elements
        const selectors = [
          'button',
          '[role="button"]',
          '[class*="odds"]', '[class*="Odds"]',
          '[class*="coeff"]', '[class*="Coeff"]',
          '[class*="proposal"]', '[class*="Proposal"]',
          '[class*="cell"]', '[class*="Cell"]',
          '[class*="pick"]', '[class*="Pick"]',
          '[class*="bet"]', '[class*="Bet"]',
          '[class*="line"]', '[class*="Line"]',
          '[class*="option"]', '[class*="Option"]',
          '[data-proposal]', '[data-odd]', '[data-id]'
        ];
        
        const allElements = [];
        selectors.forEach(selector => {
          try {
            const found = document.querySelectorAll(selector);
            allElements.push(...Array.from(found));
          } catch (e) {}
        });
        
        // Also try to find by data attributes if oddId is provided
        let elementsById = [];
        if (oddId) {
          const idSelectors = [
            `[data-id="${oddId}"]`,
            `[data-proposal="${oddId}"]`,
            `[data-odd-id="${oddId}"]`,
            `[data-proposal-fkey="${oddId}"]`,
            `[id*="${oddId}"]`
          ];
          idSelectors.forEach(selector => {
            try {
              const found = document.querySelectorAll(selector);
              elementsById.push(...Array.from(found));
            } catch (e) {}
          });
        }
        
        // Filter to only visible elements
        const elements = Array.from(allElements).filter(el => {
          return el.offsetParent !== null && 
                 el.offsetWidth > 0 && 
                 el.offsetHeight > 0 &&
                 window.getComputedStyle(el).display !== 'none' &&
                 window.getComputedStyle(el).visibility !== 'hidden';
        });
        
        // Combine with elements found by ID
        const allCandidates = [...elements];
        elementsById.forEach(el => {
          if (!allCandidates.includes(el) && el.offsetParent !== null) {
            allCandidates.push(el);
          }
        });
        
        // Helper function to check if number matches exactly
        function numberMatchesExactly(text, targetNumber) {
          if (!targetNumber) return false;
          const exactNumberRegex = new RegExp(`\\b${targetNumber.replace('.', '\\.')}\\b`);
          return exactNumberRegex.test(text);
        }
        
        // Score each element
        let bestMatch = null;
        let bestScore = 0;
        
        for (const el of allCandidates) {
          const text = (el.textContent || '').toLowerCase();
          const elId = el.id || '';
          const dataAttrs = Array.from(el.attributes)
            .filter(attr => attr.name.startsWith('data-'))
            .map(attr => attr.value)
            .join(' ');
          
          let score = 0;
          let reasons = [];
          
          // ID match gets highest priority
          if (oddId && (elId.includes(oddId) || dataAttrs.includes(oddId))) {
            score += 200;
            reasons.push('id-match');
          }
          
          // Selection text match
          if (selLower && text.includes(selLower)) {
            score += 50;
            reasons.push('selection-match');
          }
          
          // Number match (exact)
          if (numberInSel && numberMatchesExactly(text, numberInSel)) {
            score += 40;
            reasons.push('has-exact-number');
          }
          
          // Odds match
          if (text.includes(oddsStr) || text.includes(odds.toString())) {
            score += 30;
            reasons.push('odds-match');
          }
          
          // Param match (for totals/spreads)
          if (paramLower && text.includes(paramLower)) {
            score += 20;
            reasons.push('param-match');
          }
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = { element: el, score, reasons };
          }
        }
        
        if (bestMatch && bestScore > 0) {
          console.log('✅ Found match, clicking to select:', {
            score: bestScore,
            reasons: bestMatch.reasons,
            text: bestMatch.element.textContent?.substring(0, 50)
          });
          
          // Scroll into view and click
          bestMatch.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(r => setTimeout(r, 300));
          bestMatch.element.click();
          
          return { clicked: true, score: bestScore };
        }
        
        return { clicked: false, error: 'No matching element found' };
      }, selection, targetOdds, param, market, oddId);
      
      if (clicked.clicked) {
        console.log('✅ Bet selected successfully');
        // Small delay to ensure selection is registered
        await new Promise(r => setTimeout(r, 500));
        return { success: true };
      } else {
        console.log('❌ Could not select bet:', clicked.error);
        return { success: false, error: clicked.error || 'Could not find bet element to select' };
      }
      
    } catch (e) {
      console.error('❌ Select bet error:', e.message);
      return { success: false, error: e.message };
    }
  }

  stop() {
    if (this.browser) {
      this.browser.close();
    }
  }
}

module.exports = FliffClient;



