// Mobile WebSocket interceptor
// Paste this in Chrome DevTools Console while on getfliff.com (mobile view)

(function() {
  const log = [];
  const OrigWS = window.WebSocket;
  
  window.WebSocket = function(url, protocols) {
    console.log('%c🔌 WS CONNECT', 'color: lime; font-size: 14px', url.split('?')[0]);
    
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    
    ws.addEventListener('message', async (e) => {
      let data, raw;
      if (e.data instanceof Blob) {
        const buf = await e.data.arrayBuffer();
        raw = new Uint8Array(buf);
        try {
          data = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          try {
            data = JSON.parse(pako.inflate(raw, {to: 'string'}));
          } catch {
            try {
              data = JSON.parse(pako.inflateRaw(raw, {to: 'string'}));
            } catch {
              data = {_raw: Array.from(raw.slice(0,100)).map(b=>b.toString(16).padStart(2,'0')).join(' '), size: raw.length};
            }
          }
        }
      } else if (e.data instanceof ArrayBuffer) {
        raw = new Uint8Array(e.data);
        data = {_raw: Array.from(raw.slice(0,100)).map(b=>b.toString(16).padStart(2,'0')).join(' '), size: raw.length};
      } else {
        try { data = JSON.parse(e.data); } catch { data = e.data; }
      }
      
      console.log('%c📨 MSG #' + (log.length + 1), 'color: cyan; font-weight: bold', data);
      log.push({t: Date.now(), d: data});
    });
    
    const origSend = ws.send.bind(ws);
    ws.send = function(msg) {
      console.log('%c📤 SEND', 'color: yellow', msg);
      return origSend(msg);
    };
    
    return ws;
  };
  
  window.getLog = () => log;
  window.saveLog = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(log,null,2)]));
    a.download = 'fliff_' + Date.now() + '.json';
    a.click();
  };
  
  console.log('%c✅ Interceptor ready! Navigate the app.', 'color: lime; font-size: 16px');
  console.log('%csaveLog() to export', 'color: gray');
})();

