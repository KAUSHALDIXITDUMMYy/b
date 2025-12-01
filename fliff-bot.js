const WebSocket = require('ws');
const zlib = require('zlib');
const fs = require('fs');

// =============================================
// FLIFF LIVE ODDS BOT
// =============================================

class FliffBot {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.seqNo = 0;
    this.connected = false;
    this.messageCount = 0;
    this.subscriptions = new Set();
    this.liveGames = new Map();
    this.odds = new Map();
  }

  // Decode zlib compressed message
  decode(buffer) {
    try {
      const decompressed = zlib.inflateSync(buffer);
      return JSON.parse(decompressed.toString('utf8'));
    } catch (e) {
      try {
        return JSON.parse(buffer.toString('utf8'));
      } catch {
        return null;
      }
    }
  }

  // Encode message to zlib
  encode(obj) {
    const json = JSON.stringify(obj);
    return zlib.deflateSync(json);
  }

  // Build connection URL
  buildUrl() {
    const params = {
      device_x_id: this.config.device_x_id,
      app_x_version: this.config.app_x_version,
      app_install_token: this.config.app_install_token,
      app_start_token: this.config.app_start_token,
      ip_address: this.config.ip_address,
      auth_token: this.config.auth_token,
      device_local_stamp_millis: Date.now(),
      device_server_stamp_millis: Date.now() - 356,
      app_uptime_millis: 0,
      seq_no: 0,
      platform: 'prod'
    };
    
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    
    return `wss://herald-2.app.getfliff.com/heraldz?${query}`;
  }

  // Connect to WebSocket
  connect() {
    const url = this.buildUrl();
    console.log('\n🔌 FLIFF LIVE ODDS BOT');
    console.log('═'.repeat(70));
    console.log(`User: ${this.config.auth_token}`);
    console.log('─'.repeat(70));

    this.ws = new WebSocket(url, {
      perMessageDeflate: false
    });

    this.ws.on('open', () => {
      this.connected = true;
      console.log('🟢 Connected!\n');
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('❌ Error:', error.message);
    });

    this.ws.on('close', (code) => {
      this.connected = false;
      console.log(`\n⚫ Disconnected (code: ${code})`);
      this.saveData();
    });
  }

  // Handle incoming message
  handleMessage(data) {
    this.messageCount++;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const decoded = this.decode(buffer);

    if (!decoded) {
      console.log(`📨 #${this.messageCount} | Could not decode`);
      return;
    }

    const msgName = decoded.message_name || 'Unknown';

    // Handle different message types
    if (decoded.inplay_conflicts) {
      this.handleLiveGames(decoded.inplay_conflicts);
    }

    if (decoded.prematch_conflicts) {
      this.handleUpcomingGames(decoded.prematch_conflicts);
    }

    if (decoded.inplay_subfeeds_update) {
      this.handleOddsUpdate(decoded.inplay_subfeeds_update);
    }

    if (decoded.prematch_subfeeds_update) {
      this.handleOddsUpdate(decoded.prematch_subfeeds_update);
    }

    // Log message type
    if (this.messageCount <= 10 || this.messageCount % 50 === 0) {
      console.log(`📨 #${this.messageCount} | ${msgName} | ${buffer.length} bytes`);
    }
  }

  // Handle live games update
  handleLiveGames(games) {
    games.forEach(game => {
      const key = game.conflict_id || game.id;
      const existing = this.liveGames.get(key);
      
      this.liveGames.set(key, {
        id: game.id,
        home: game.home_team_name,
        away: game.away_team_name,
        homeScore: game.live_home_score,
        awayScore: game.live_away_score,
        status: game.live_state_desc,
        channelId: game.channel_id,
        markets: game.estimated_markets_count
      });

      // Log score changes
      if (existing && (existing.homeScore !== game.live_home_score || existing.awayScore !== game.live_away_score)) {
        console.log(`\n⚽ SCORE UPDATE: ${game.home_team_name} ${game.live_home_score} - ${game.live_away_score} ${game.away_team_name}`);
      }
    });

    console.log(`\n🏀 LIVE GAMES: ${this.liveGames.size}`);
    this.liveGames.forEach(g => {
      console.log(`   ${g.home} vs ${g.away} | ${g.homeScore}-${g.awayScore} | ${g.status}`);
    });
  }

  // Handle upcoming games
  handleUpcomingGames(games) {
    console.log(`\n📅 UPCOMING: ${games.length} games`);
    games.slice(0, 5).forEach(g => {
      console.log(`   ${g.home_team_name} vs ${g.away_team_name}`);
    });
  }

  // Handle odds update
  handleOddsUpdate(update) {
    if (!update.packed_subfeed_updates) return;

    update.packed_subfeed_updates.forEach(subfeed => {
      if (!subfeed.market_updates) return;

      subfeed.market_updates.forEach(market => {
        if (!market.groups) return;

        market.groups.forEach(group => {
          if (!group.proposals) return;

          group.proposals.forEach(prop => {
            const key = prop.proposal_fkey;
            const existing = this.odds.get(key);

            this.odds.set(key, {
              event: prop.t_121_event_info,
              market: prop.t_131_market_name,
              selection: prop.t_141_selection_name,
              odds: prop.coeff,
              decimalOdds: prop.eu_coeff,
              prevOdds: prop.prev_coeff,
              changeType: prop.change_type,
              updated: new Date().toISOString()
            });

            // Log odds changes
            if (existing && existing.odds !== prop.coeff) {
              const direction = prop.coeff > existing.odds ? '📈' : '📉';
              console.log(`\n${direction} ODDS CHANGE: ${prop.t_121_event_info}`);
              console.log(`   ${prop.t_141_selection_name}: ${existing.odds} → ${prop.coeff} (${prop.eu_coeff})`);
            }
          });
        });
      });
    });
  }

  // Send command
  send(commands) {
    if (!this.connected) return;

    this.seqNo++;
    const msg = {
      header: {
        device_x_id: this.config.device_x_id,
        app_x_version: this.config.app_x_version,
        app_install_token: this.config.app_install_token,
        app_start_token: this.config.app_start_token,
        ip_address: this.config.ip_address,
        auth_token: this.config.auth_token,
        device_local_stamp_millis: Date.now(),
        device_server_stamp_millis: Date.now() - 356,
        app_uptime_millis: Date.now() - this.startTime,
        seq_no: this.seqNo,
        platform: 'prod'
      },
      commands: commands
    };

    const encoded = this.encode(msg);
    this.ws.send(encoded);
  }

  // Subscribe to channel
  subscribe(channelId) {
    const topic = `/v3/channel/${channelId}`;
    this.subscriptions.add(channelId);
    this.send([{ name: 'HCommand___Subscribe', topic: topic }]);
    console.log(`📡 Subscribed to channel ${channelId}`);
  }

  // Unsubscribe from channel
  unsubscribe(channelId) {
    const topic = `/v3/channel/${channelId}`;
    this.subscriptions.delete(channelId);
    this.send([{ name: 'HCommand___Unsubscribe', topic: topic }]);
    console.log(`📴 Unsubscribed from channel ${channelId}`);
  }

  // Send heartbeat
  startHeartbeat() {
    this.startTime = Date.now();
    setInterval(() => {
      if (this.connected) {
        this.send([{
          name: 'HCommand___ClientHeartbeat',
          conn_stats: {
            activeSubscriptionsCount: this.subscriptions.size
          }
        }]);
      }
    }, 30000);
  }

  // Save collected data
  saveData() {
    const data = {
      timestamp: new Date().toISOString(),
      messageCount: this.messageCount,
      liveGames: Array.from(this.liveGames.values()),
      odds: Array.from(this.odds.values())
    };
    
    const filename = `fliff_session_${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    console.log(`💾 Saved to ${filename}`);
  }

  // Close connection
  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// =============================================
// MAIN
// =============================================

// Load config or use defaults
let config;
try {
  const settings = JSON.parse(fs.readFileSync('./profiles/ray/settings.json', 'utf8'));
  config = {
    device_x_id: 'web.41a30556cd67f9f3d88362474f034921',
    app_x_version: '5.0.23.241',
    app_install_token: 'slLOPNAqgg',
    app_start_token: 'xInG8Fmv',
    ip_address: settings.proxy ? settings.proxy.split('@')[1].split(':')[0] : 'unknown',
    auth_token: 'user_3581761'
  };
} catch {
  // Default config - update with fresh tokens from browser
  config = {
    device_x_id: 'web.41a30556cd67f9f3d88362474f034921',
    app_x_version: '5.0.23.241',
    app_install_token: 'slLOPNAqgg',
    app_start_token: 'xInG8Fmv',
    ip_address: '156.228.210.149',
    auth_token: 'user_3581761'
  };
}

// Create and start bot
const bot = new FliffBot(config);
bot.connect();

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  bot.close();
});

// Export for REPL usage
module.exports = bot;

