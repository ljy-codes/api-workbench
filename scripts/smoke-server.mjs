// Local manual acceptance fixture. Never binds a public network interface.
import http from 'node:http';
const server = http.createServer(async (request, response) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 22 * 1024 * 1024) {
      response.writeHead(413).end('fixture body too large');
      return;
    }
    chunks.push(chunk);
  }
  if (request.url?.includes('/delay')) await new Promise(resolve => setTimeout(resolve, 5000));
  const headers = { ...request.headers };
  for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']) {
    if (headers[name]) headers[name] = '[fixture redacted]';
  }
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Fixture': 'api-workbench' });
  response.end(JSON.stringify({
    ok: true, method: request.method, path: request.url, headers,
    body: Buffer.concat(chunks).toString('utf8'), receivedBytes: bytes,
  }));
});
server.listen(18765, '127.0.0.1', () => console.log('Smoke fixture ready at 127.0.0.1:18765'));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
