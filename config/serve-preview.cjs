// Only serve public website files; never expose the checkout, configuration, or tests.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
    try {
        const requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1);
        if (!['GET', 'HEAD'].includes(req.method) || relative.includes('\\') || relative.split('/').some(segment => segment.startsWith('.')) ||
            !(relative === 'index.html' || /^(assets|data|background music)\//.test(relative))) {
            res.writeHead(404); res.end(); return;
        }
        const file = path.resolve(root, relative);
        if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    } catch { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log('WordKing preview: http://127.0.0.1:' + server.address().port));
