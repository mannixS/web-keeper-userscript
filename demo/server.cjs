const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const server = http.createServer((request, response) => {
  const installer = new URL(request.url, 'http://localhost').pathname === '/web-keeper.user.js';
  response.setHeader('Content-Type', installer ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(fs.readFileSync(path.join(__dirname, installer ? '../web-keeper.user.js' : 'index.html')));
});
server.listen(4173, '127.0.0.1', () => {
  console.log('演示页面：http://127.0.0.1:4173');
  console.log('脚本安装地址：http://127.0.0.1:4173/web-keeper.user.js');
  console.log('按 Ctrl+C 关闭本地服务。');
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
