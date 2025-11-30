# API Credentials Persistence Fix

## Problem

When you manually placed a bet, the system captured the API endpoint and authentication tokens. However, when the browser crashed and restarted, this information was lost because it was only stored in memory. You had to manually place another bet to recapture the credentials.

## Solution

I've implemented automatic persistence of API credentials to disk. Now:

1. **Credentials are saved automatically** when captured:
   - Betting API endpoint
   - Bearer token
   - Auth token
   - API headers
   - Bet request templates (last 10)

2. **Credentials are loaded automatically** when the FliffClient starts:
   - On browser restart
   - After crashes
   - When the backend server restarts

3. **Storage location**: `ray/api_credentials.json`

## How It Works

### When Credentials Are Captured

The system automatically saves credentials to disk when:
- A bearer token is detected in network headers
- An auth token is found in URLs
- A betting API endpoint is identified
- Bet requests are captured (saved periodically every 5 requests)

### When Credentials Are Loaded

On startup, the FliffClient:
1. Loads settings from `ray/settings.json`
2. **Automatically loads persisted API credentials** from `ray/api_credentials.json`
3. Shows console messages indicating what was loaded:
   - `📂 Loaded persisted betting endpoint: [URL]`
   - `📂 Loaded persisted bearer token`
   - `📂 Loaded persisted auth token`
   - `📂 Loaded X persisted bet request templates`

### Console Output

When the backend starts, you'll see:
```
🎮 Starting Fliff Client...
Profile: IPRoyal 60757816
Proxy: 162.251.251.31:12323
📂 Using persisted betting endpoint: https://api.getfliff.com/bet/place
📂 Using persisted authentication tokens
```

## Benefits

1. **No more manual re-capture**: Once you place a bet manually, the credentials are saved forever
2. **Survives crashes**: Browser crashes won't lose your API endpoint
3. **Faster startup**: Direct API betting works immediately after restart
4. **Automatic**: No manual intervention needed

## File Structure

The `ray/api_credentials.json` file contains:
```json
{
  "bettingEndpoint": "https://api.getfliff.com/bet/place",
  "bearerToken": "Bearer xyz123...",
  "authToken": "user_123456",
  "apiHeaders": {
    "Content-Type": "application/json",
    ...
  },
  "capturedBetRequests": [
    {
      "url": "...",
      "method": "POST",
      "headers": {...},
      "postData": "...",
      "timestamp": 1234567890
    }
  ],
  "lastUpdated": "2025-01-XX..."
}
```

## Troubleshooting

### Credentials not loading
- Check that `ray/api_credentials.json` exists
- Verify the file is valid JSON
- Check backend console for error messages

### Credentials not saving
- Check file permissions on `ray/` folder
- Look for console errors when placing bets
- Verify the backend has write access

### Want to reset credentials
- Delete `ray/api_credentials.json`
- Restart the backend
- Place a bet manually to recapture

## Notes

- The file is automatically created when credentials are first captured
- Only the last 10 bet request templates are saved to keep file size manageable
- Credentials are saved immediately when captured (no delay)
- The file is human-readable JSON for debugging


