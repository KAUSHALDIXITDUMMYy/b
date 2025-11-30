const WebSocket = require('ws');
const zlib = require('zlib');
const fs = require('fs');
const readline = require('readline');

// Parse WebSocket URL to extract params
function parseUrl(url) {
  const params = {};
  const queryString = url.split('?')[1];
  if (queryString) {
    queryString.split('&').forEach(pair => {
      const [key, value] = pair.split('=');
      params[key] = decodeURIComponent(value);
    });
  }
  return params;
}

// Decode zlib message
function decode(buffer) {
  try {
    return JSON.parse(zlib.inflateSync(buffer).toString('utf8'));
  } catch {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      return null;
    }
  }
}

// Encode message
function encode(obj) {
  return zlib.deflateSync(JSON.stringify(obj));
}

// Main bot
async function main() {
  console.log('\n🔌 FLIFF LIVE ODDS BOT\n');
  console.log('Copy the WebSocket URL from Chrome DevTools:');
  console.log('  Network tab → WS → click heraldz → Copy URL\n');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('Paste URL: ', (url) => {
    rl.close();
    
    if (!url.includes('heraldz')) {
      console.log('❌ Invalid URL. Must contain "heraldz"');
      process.exit(1);
    }

    const params = parseUrl(url);
    console.log(`\n✅ User: ${params.auth_token}`);
    console.log('═'.repeat(60));

    const ws = new WebSocket(url, { perMessageDeflate: false });
    let msgCount = 0;
    let seqNo = parseInt(params.seq_no) || 0;
    const liveGames = new Map();
    const startTime = Date.now();

    ws.on('open', () => {
      console.log('🟢 Connected! Receiving live data...\n');
    });

    ws.on('message', (data) => {
      msgCount++;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const decoded = decode(buffer);

      if (!decoded) return;

      // Live games
      if (decoded.inplay_conflicts) {
        console.log(`\n🏀 LIVE GAMES (${decoded.inplay_conflicts.length}):`);
        decoded.inplay_conflicts.forEach(g => {
          liveGames.set(g.id, g);
          console.log(`  ${g.home_team_name} ${g.live_home_score} - ${g.live_away_score} ${g.away_team_name} | ${g.live_state_desc}`);
        });
      }

      // Upcoming games
      if (decoded.prematch_conflicts) {
        console.log(`\n📅 UPCOMING (${decoded.prematch_conflicts.length}):`);
        decoded.prematch_conflicts.slice(0, 3).forEach(g => {
          console.log(`  ${g.home_team_name} vs ${g.away_team_name}`);
        });
      }

      // Odds updates
      if (decoded.inplay_subfeeds_update || decoded.prematch_subfeeds_update) {
        const update = decoded.inplay_subfeeds_update || decoded.prematch_subfeeds_update;
        if (update.packed_subfeed_updates) {
          update.packed_subfeed_updates.forEach(sf => {
            if (sf.market_updates) {
              sf.market_updates.forEach(m => {
                if (m.groups) {
                  m.groups.forEach(g => {
                    if (g.proposals) {
                      g.proposals.forEach(p => {
                        if (p.prev_coeff && p.prev_coeff !== p.coeff) {
                          const dir = p.coeff > p.prev_coeff ? '📈' : '📉';
                          console.log(`${dir} ${p.t_121_event_info || 'Event'}`);
                          console.log(`   ${p.t_141_selection_name}: ${p.prev_coeff} → ${p.coeff} (${p.eu_coeff})`);
                        }
                      });
                    }
                  });
                }
              });
            }
          });
        }
      }

      // Status updates
      if (msgCount % 20 === 0) {
        console.log(`\n📊 ${msgCount} messages received | ${liveGames.size} live games tracked`);
      }
    });

    ws.on('error', (e) => console.error('❌', e.message));
    
    ws.on('close', (code) => {
      console.log(`\n⚫ Disconnected (${code}) | ${msgCount} messages received`);
      
      // Save data
      const data = {
        timestamp: new Date().toISOString(),
        messages: msgCount,
        games: Array.from(liveGames.values())
      };
      fs.writeFileSync(`session_${Date.now()}.json`, JSON.stringify(data, null, 2));
      console.log('💾 Session saved');
      process.exit(0);
    });

    // Heartbeat
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        seqNo++;
        const msg = {
          header: {
            ...params,
            device_local_stamp_millis: Date.now(),
            device_server_stamp_millis: Date.now() - 300,
            app_uptime_millis: Date.now() - startTime,
            seq_no: seqNo
          },
          commands: [{ name: 'HCommand___ClientHeartbeat', conn_stats: {} }]
        };
        ws.send(encode(msg));
      }
    }, 25000);

    process.on('SIGINT', () => {
      console.log('\n🛑 Closing...');
      ws.close();
    });
  });
}

main();

