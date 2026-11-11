// Local protocol fixture only. This is not a WebDAV server for deployment.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const xml = value => value.replace(/[<>&"']/g, char => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[char]);
const etag = body => `"${createHash('sha256').update(body).digest('hex')}"`;

export async function startFixture() {
  const records = new Map([['/dav/', { directory: true }]]);
  const faults = {
    failNextSnapshot: false, failNextHead: false, omitEtag: false, beforeHeadWrite: null,
    ignorePreconditions: false, dropNextHeadResponse: false,
    acceptNextSnapshot: false, acceptNextHead: false,
  };
  const requests = [];
  const expectedAuth = `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const method = request.method;
      requests.push({ method, path });
      const finish = (status, body = '', headers = {}) => {
        response.writeHead(status, headers);
        response.end(body);
      };
      if (request.headers.authorization !== expectedAuth) return finish(401);
      if (method === 'MKCOL') {
        if (records.has(path)) return finish(405);
        const parent = path.slice(0, path.slice(0, -1).lastIndexOf('/') + 1);
        if (!records.get(parent)?.directory) return finish(409);
        records.set(path, { directory: true });
        return finish(201);
      }
      if (method === 'PROPFIND') {
        if (!records.get(path)?.directory) return finish(404);
        const children = [...records.entries()].filter(([name]) =>
          name === path || (name.startsWith(path) && !name.slice(path.length).replace(/\/$/, '').includes('/')));
        const body = children.map(([name, item]) =>
          `<d:response><d:href>${xml(name.split('/').map(encodeURIComponent).join('/'))}</d:href>` +
          `<d:propstat><d:prop><d:resourcetype>${item.directory ? '<d:collection/>' : ''}</d:resourcetype>` +
          `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('');
        return finish(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`, {
          'Content-Type': 'application/xml; charset=utf-8',
        });
      }
      if (method === 'GET') {
        const item = records.get(path);
        if (!item || item.directory) return finish(404);
        return finish(200, item.body, {
          'Content-Type': 'application/json',
          ...(faults.omitEtag ? {} : { ETag: item.etag }),
        });
      }
      if (method === 'PUT') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const isHead = path.endsWith('/envdock-sync.json');
        const acceptFault = isHead ? 'acceptNextHead' : path.endsWith('.enc.json') ? 'acceptNextSnapshot' : null;
        if (acceptFault && faults[acceptFault]) {
          faults[acceptFault] = false;
          return finish(202);
        }
        if (isHead && faults.beforeHeadWrite) {
          const hook = faults.beforeHeadWrite;
          faults.beforeHeadWrite = null;
          await hook();
        }
        if ((isHead && faults.failNextHead) || (!isHead && faults.failNextSnapshot)) {
          if (isHead) faults.failNextHead = false;
          else faults.failNextSnapshot = false;
          return finish(503);
        }
        const previous = records.get(path);
        if (!faults.ignorePreconditions && request.headers['if-none-match'] === '*' && previous) return finish(412);
        if (!faults.ignorePreconditions && request.headers['if-match'] && request.headers['if-match'] !== previous?.etag) return finish(412);
        if (!records.get(path.slice(0, path.lastIndexOf('/') + 1))?.directory) return finish(409);
        records.set(path, { body, etag: etag(body) });
        if (isHead && faults.dropNextHeadResponse) {
          faults.dropNextHeadResponse = false;
          return response.destroy();
        }
        return finish(previous ? 204 : 201, '', { ETag: etag(body) });
      }
      if (method === 'DELETE') {
        const item = records.get(path);
        if (!item) return finish(404);
        if (item.directory) return finish(405);
        if (request.headers['if-match'] !== item.etag) return finish(412);
        records.delete(path);
        return finish(204);
      }
      return finish(405);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closing;
  return {
    url: `http://127.0.0.1:${server.address().port}/dav/`,
    records, faults, requests,
    close: () => closing ??= new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
