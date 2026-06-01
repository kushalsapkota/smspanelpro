// Tiny local HTTP "provider" for smoke tests — accepts a send and returns a message id.
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log('[echo] ' + req.method + ' ' + req.url + ' ' + body.slice(0, 120));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message_id: 'ECHO' + Date.now(), status: 'ok' }));
  });
}).listen(9099, () => console.log('[echo] provider on :9099'));
