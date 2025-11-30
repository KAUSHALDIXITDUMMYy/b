const WebSocket = require('ws');
const zlib = require('zlib');

// Decode binary zlib message
function decode(buffer) {
  try {
    const decompressed = zlib.inflateSync(buffer);
    return JSON.parse(decompressed.toString('utf8'));
  } catch (e) {
    // Try as plain text/JSON
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      return null;
    }
  }
}

// Encode JSON to zlib binary
function encode(obj) {
  const json = JSON.stringify(obj);
  return zlib.deflateSync(json);
}

// Connection params - Ray's authenticated session
const params = {
  device_x_id: 'web.41a30556cd67f9f3d88362474f034921',
  app_x_version: '5.0.23.241',
  app_install_token: 'slLOPNAqgg',
  app_start_token: 'xInG8Fmv',
  ip_address: '156.228.210.149',
  auth_token: 'user_3581761',
  device_local_stamp_millis: Date.now(),
  device_server_stamp_millis: Date.now() - 356,
  app_uptime_millis: 0,
  seq_no: 0,
  platform: 'prod'
};

const queryString = Object.entries(params)
  .map(([k, v]) => `${k}=${v}`)
  .join('&');

const wsUrl = `wss://herald-2.app.getfliff.com/heraldz?${queryString}`;

let messageCount = 0;
let seqNo = 0;
const allMessages = [];

console.log('\n🔌 FLIFF LIVE DATA DECODER\n');
console.log('─'.repeat(70));

const ws = new WebSocket(wsUrl, {
  perMessageDeflate: false // Server sends pre-compressed data
});

ws.on('open', () => {
  console.log('🟢 Connected!\n');
});

ws.on('message', (data) => {
  messageCount++;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📨 #${messageCount} | ${buffer.length} bytes | ${new Date().toLocaleTimeString()}`);
  console.log('─'.repeat(70));
  
  const decoded = decode(buffer);
  
  if (decoded) {
    allMessages.push(decoded);
    
    // Show message type
    const msgName = decoded.message_name || 'Unknown';
    console.log(`📋 Type: ${msgName}`);
    
    // Handle different message types
    if (decoded.inplay_conflicts) {
      console.log(`\n🏀 LIVE GAMES (${decoded.inplay_conflicts.length}):`);
      decoded.inplay_conflicts.forEach(game => {
        console.log(`   ${game.home_team_name} vs ${game.away_team_name}`);
        console.log(`   Score: ${game.live_home_score} - ${game.live_away_score} | ${game.live_state_desc}`);
        console.log(`   Markets: ${game.estimated_markets_count || 'N/A'}`);
        console.log('');
      });
    }
    
    if (decoded.prematch_conflicts) {
      console.log(`\n📅 UPCOMING GAMES (${decoded.prematch_conflicts.length}):`);
      decoded.prematch_conflicts.slice(0, 5).forEach(game => {
        console.log(`   ${game.home_team_name} vs ${game.away_team_name}`);
      });
      if (decoded.prematch_conflicts.length > 5) {
        console.log(`   ... and ${decoded.prematch_conflicts.length - 5} more`);
      }
    }
    
    if (decoded.commands) {
      console.log(`\n⚡ Commands: ${decoded.commands.map(c => c.name).join(', ')}`);
    }
    
    // Show full JSON for other message types
    if (!decoded.inplay_conflicts && !decoded.prematch_conflicts && !decoded.commands) {
      console.log(JSON.stringify(decoded, null, 2));
    }
  } else {
    console.log('❌ Could not decode');
    console.log('HEX:', buffer.slice(0, 50).toString('hex'));
  }
});

ws.on('error', (error) => {
  console.error('❌ Error:', error.message);
});

ws.on('close', (code) => {
  console.log(`\n⚫ Disconnected (code: ${code})`);
  console.log(`Total messages: ${messageCount}`);
  
  // Save all messages
  if (allMessages.length > 0) {
    const fs = require('fs');
    const filename = `fliff_data_${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(allMessages, null, 2));
    console.log(`💾 Saved to ${filename}`);
  }
  
  process.exit(0);
});

// Send a command
function send(commands) {
  seqNo++;
  const msg = {
    header: {
      device_x_id: params.device_x_id,
      app_x_version: params.app_x_version,
      app_install_token: params.app_install_token,
      app_start_token: params.app_start_token,
      ip_address: params.ip_address,
      auth_token: params.auth_token,
      device_local_stamp_millis: Date.now(),
      device_server_stamp_millis: Date.now() - 800,
      app_uptime_millis: Date.now() - params.device_local_stamp_millis,
      seq_no: seqNo,
      platform: params.platform
    },
    commands: commands
  };
  
  const encoded = encode(msg);
  ws.send(encoded);
  console.log('📤 SENT:', commands.map(c => c.name).join(', '));
}

// Subscribe to a channel
function subscribe(channelId) {
  send([{ name: 'HCommand___Subscribe', topic: `/v3/channel/${channelId}` }]);
}

// Unsubscribe from a channel  
function unsubscribe(channelId) {
  send([{ name: 'HCommand___Unsubscribe', topic: `/v3/channel/${channelId}` }]);
}

// Ctrl+C handler
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  ws.close();
});

console.log('Waiting for messages...');
console.log('(Copy auth_token from browser Network tab for authenticated data)\n');
