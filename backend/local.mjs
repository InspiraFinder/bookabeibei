import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';
import { securityHeaders } from './security.mjs';
import { openDatabase } from './sqlite.mjs';

const DB = openDatabase();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const server = http.createServer(async (req, res) => {
  try {
    // Use the actual Host so LAN requests keep same-origin checks valid.
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      const init = { method: req.method, headers: req.headers };
      if (!['GET', 'HEAD'].includes(req.method)) { init.body = req; init.duplex = 'half'; }
      const response = await handleApi(new Request(url, init), { DB });
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...securityHeaders });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = files.get(url.pathname);
    if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404, securityHeaders); res.end('Not found'); return; }
    const data = await readFile(fileURLToPath(new URL(`../frontend/${file[0]}`, import.meta.url)));
    res.writeHead(200, { ...securityHeaders, 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    if (!res.headersSent) res.writeHead(500, securityHeaders);
    res.end('Service unavailable');
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, host, () => console.log(`杯杯预约已启动：http://${host}:${port}\n首次使用：打开页面右上角「登录 / 注册」自助创建账号`));
function shutdown() { server.close(() => { DB.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
