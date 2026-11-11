// Development-only protocol probe. No app database, credentials, or background jobs.
import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, randomUUID, scrypt, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const FORMAT = 'envdock-sync-probe';
const HEAD = 'envdock-sync.json';
const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COLLECTIONS = ['projects', 'environments', 'services', 'bindings', 'folders', 'requests', 'variables'];
const canonical = value => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  return item;
});
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const requireValue = (condition, code = 'INVALID_DATA', message = '同步数据格式无效') => {
  if (!condition) fail(code, message);
};
const parse = text => {
  try { return JSON.parse(text); } catch { return fail('INVALID_DATA', '云端文件不是有效 JSON'); }
};

function folderPath(path) {
  requireValue(typeof path === 'string' && path.startsWith('/') && path.length <= 1024,
    'INVALID_PATH', '请选择有效的云端文件夹');
  requireValue(!/[%\\?#\u0000-\u001f\u007f]/.test(path), 'INVALID_PATH', '云端路径包含不支持的字符');
  const segments = path.split('/').filter(Boolean);
  requireValue(segments.every(segment => segment !== '.' && segment !== '..'), 'INVALID_PATH', '云端路径不可越级');
  return '/' + segments.join('/');
}

function base64(value, length) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value));
  const result = Buffer.from(value, 'base64');
  requireValue(result.toString('base64') === value && (!length || result.length === length));
  return result;
}

function workspaceProjection(source) {
  requireValue(source && typeof source === 'object' && !Array.isArray(source));
  requireValue(Buffer.byteLength(JSON.stringify(source)) <= MAX_BYTES);
  const value = { revision: 0, activeProjectId: null };
  const ids = new Set();
  for (const collection of COLLECTIONS) {
    requireValue(Array.isArray(source[collection]) && source[collection].length <= 20000);
    value[collection] = structuredClone(source[collection]);
    for (const item of value[collection]) {
      requireValue(item && typeof item === 'object' && typeof item.id === 'string'
        && item.id.length > 0 && item.id.length <= 256 && !ids.has(item.id));
      ids.add(item.id);
    }
  }
  for (const project of value.projects) project.activeEnvironmentId = null;
  for (const variable of value.variables) {
    requireValue(typeof variable.isSecret === 'boolean' && typeof variable.value === 'string');
    if (variable.isSecret) variable.value = '';
  }
  const credential = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|access_token|refresh_token|token|password|secret)$/i;
  const reference = /^\{\{[^{}]+\}\}$/;
  const clean = config => {
    for (const pair of [...(config.headers ?? []), ...(config.query ?? []), ...(config.form ?? [])]) {
      if (pair.kind === 'file') { pair.value = ''; pair.enabled = false; }
      else if (credential.test(pair.key) && !reference.test(pair.value)) pair.value = '';
    }
    if (config.auth) {
      for (const key of ['token', 'username', 'password', 'value']) {
        if (typeof config.auth[key] === 'string' && !reference.test(config.auth[key])) config.auth[key] = '';
      }
    }
  };
  for (const service of value.services) clean(service);
  for (const request of value.requests) {
    clean(request);
    for (const config of Object.values(request.environmentConfigs ?? {})) clean(config);
  }
  return value;
}

async function keyFor(password, salt) {
  requireValue(typeof password === 'string' && password.length >= 8 && password.length <= 1024,
    'INVALID_PASSWORD', '试验同步密码需为 8 至 1024 个字符');
  return derive(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

const unsigned = head => ({
  format: head.format, version: head.version, spaceId: head.spaceId, salt: head.salt, snapshotId: head.snapshotId,
});
function signed(head, key) {
  const value = unsigned(head);
  return { ...value, mac: createHmac('sha256', key.subarray(32)).update(canonical(value)).digest('base64') };
}
function validateHead(head) {
  requireValue(head && head.format === FORMAT && head.version === 1
    && UUID.test(head.spaceId) && UUID.test(head.snapshotId));
  base64(head.salt, 16);
  base64(head.mac, 32);
  return head;
}
function verify(head, key) {
  const expected = Buffer.from(signed(head, key).mac, 'base64');
  requireValue(timingSafeEqual(expected, base64(head.mac, 32)), 'INTEGRITY_FAILED', '同步密码不正确或云端文件已被修改');
}
function encrypt(snapshot, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  cipher.setAAD(Buffer.from(canonical({ spaceId: snapshot.spaceId, snapshotId: snapshot.snapshotId })));
  const ciphertext = Buffer.concat([cipher.update(canonical(snapshot), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
}
function decrypt(payload, head, key) {
  let plaintext;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key.subarray(0, 32), base64(payload.iv, 12));
    cipher.setAAD(Buffer.from(canonical({ spaceId: head.spaceId, snapshotId: head.snapshotId })));
    cipher.setAuthTag(base64(payload.tag, 16));
    plaintext = Buffer.concat([cipher.update(base64(payload.data)), cipher.final()]);
  } catch { fail('DECRYPT_FAILED', '云端配置解密失败，未修改本地数据'); }
  try {
    const snapshot = parse(plaintext.toString('utf8'));
    requireValue(snapshot.spaceId === head.spaceId && snapshot.snapshotId === head.snapshotId
      && (snapshot.parentVersion === null || UUID.test(snapshot.parentVersion)));
    return workspaceProjection(snapshot.workspace);
  } finally { plaintext.fill(0); }
}

export class CloudFolder {
  #base;
  #authorization;
  #checked = new Set();
  constructor({ url, username = '', password = '', allowLoopbackHttp = false }) {
    this.#base = new URL(url);
    const loopback = allowLoopbackHttp && this.#base.protocol === 'http:'
      && ['127.0.0.1', '[::1]'].includes(this.#base.hostname);
    requireValue((this.#base.protocol === 'https:' || loopback) && !this.#base.username
      && !this.#base.password && !this.#base.search && !this.#base.hash, 'INVALID_URL', '云存储地址需为不含凭据的 HTTPS 地址');
    requireValue(typeof username === 'string' && typeof password === 'string' && !/[:\r\n]/.test(username));
    if (!this.#base.pathname.endsWith('/')) this.#base.pathname += '/';
    this.#authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  async #request(method, path, { body, headers = {}, missing = false, exists = false } = {}) {
    if (body !== undefined) requireValue(Buffer.byteLength(body) <= MAX_BYTES, 'INVALID_DATA', '上传文件超过试验大小上限');
    const encoded = path.split('/').map(encodeURIComponent).join('/').replace(/^\//, '');
    const url = new URL(encoded, this.#base);
    let response;
    try {
      response = await fetch(url, {
        method, headers: { Authorization: this.#authorization, ...headers }, body,
        redirect: 'error', signal: AbortSignal.timeout(4000),
      });
    } catch { fail('NETWORK_FAILED', '连接云存储失败；本地数据已保留'); }
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (exists && response.status === 405) { await response.body?.cancel(); return { exists: true }; }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) fail('AUTH_FAILED', '云存储认证失败或访问权限不足');
      if (response.status === 412) fail('PRECONDITION', '云端版本已改变，请重新检查冲突');
      fail('HTTP_FAILED', '云存储操作失败；本地数据已保留');
    }
    if (method === 'PUT' && ![200, 201, 204].includes(response.status)) {
      await response.body?.cancel();
      fail('UNCONFIRMED_WRITE', '云存储尚未确认写入完成；保留本地修改及原同步版本');
    }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
      await response.body?.cancel();
      fail('INVALID_DATA', '云端文件超过试验大小上限');
    }
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of response.body ?? []) {
        length += chunk.byteLength;
        requireValue(length <= MAX_BYTES, 'INVALID_DATA', '云端文件超过试验大小上限');
        chunks.push(chunk);
      }
    } catch (error) {
      if (error.code === 'INVALID_DATA') throw error;
      fail('NETWORK_FAILED', '下载中断；本地数据已保留');
    }
    return { text: Buffer.concat(chunks).toString('utf8'), etag: response.headers.get('etag'), status: response.status };
  }
  async makeFolder(folder) {
    const segments = folderPath(folder).slice(1).split('/').filter(Boolean);
    let path = '';
    for (const segment of segments) {
      const parent = path || '/';
      path += '/' + segment;
      const result = await this.#request('MKCOL', path + '/', { exists: true });
      if (result.exists) requireValue((await this.list(parent)).includes(path), 'INVALID_PATH', '目标不是可访问的文件夹');
    }
  }
  async list(folder) {
    const path = folderPath(folder);
    const result = await this.#request('PROPFIND', path === '/' ? '/' : path + '/', {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    });
    requireValue(result.status === 207 && !/<!DOCTYPE|<!ENTITY/i.test(result.text));
    const folders = [];
    const unescape = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, code) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[code]);
    const prefix = '(?:[\\w.-]+:)?';
    for (const match of result.text.matchAll(new RegExp(`<${prefix}response\\b[^>]*>([\\s\\S]*?)<\\/${prefix}response>`, 'g'))) {
      if (!new RegExp(`<${prefix}collection\\b`).test(match[1])) continue;
      const href = match[1].match(new RegExp(`<${prefix}href\\b[^>]*>([\\s\\S]*?)<\\/${prefix}href>`));
      if (!href) continue;
      const absolute = new URL(unescape(href[1]), this.#base);
      if (absolute.origin !== this.#base.origin || !absolute.pathname.startsWith(this.#base.pathname)) continue;
      const relative = folderPath('/' + decodeURIComponent(absolute.pathname.slice(this.#base.pathname.length)));
      if (relative !== path && relative.slice(0, relative.lastIndexOf('/')) === (path === '/' ? '' : path)) folders.push(relative);
    }
    return [...new Set(folders)];
  }
  async _readHead(folder, missing = false) {
    const result = await this.#request('GET', `${folder === '/' ? '' : folder}/${HEAD}`, { missing });
    if (!result) return null;
    requireValue(typeof result.etag === 'string' && /^"[^"\r\n]+"$/.test(result.etag),
      'ETAG_REQUIRED', '该服务未提供可用的强 ETag，未启用写同步');
    return { head: validateHead(parse(result.text)), etag: result.etag };
  }
  async _readWorkspace(folder, head, key) {
    verify(head, key);
    const prefix = folder === '/' ? '' : folder;
    const payload = await this.#request('GET', `${prefix}/snapshots/${head.snapshotId}.enc.json`);
    return decrypt(parse(payload.text), head, key);
  }
  async #checkWriteConditions(folder) {
    if (this.#checked.has(folder)) return;
    const path = `${folder === '/' ? '' : folder}/.envdock-probe-${randomUUID()}.json`;
    const body = '{"probe":"original"}';
    let created = false;
    try {
      await this.#request('PUT', path, { headers: { 'If-None-Match': '*' }, body });
      created = true;
      const before = await this.#request('GET', path);
      requireValue(typeof before.etag === 'string' && /^"[^"\r\n]+"$/.test(before.etag),
        'ETAG_REQUIRED', '该服务未提供可用的强 ETag，未启用写同步');
      for (const headers of [{ 'If-Match': '"envdock-deliberately-wrong-etag"' }, { 'If-None-Match': '*' }]) {
        try {
          await this.#request('PUT', path, { headers, body: '{"probe":"must-be-rejected"}' });
          fail('CONDITIONAL_UNSUPPORTED', '该服务未正确检查写入条件，未启用写同步');
        } catch (error) {
          if (error.code !== 'PRECONDITION') throw error;
        }
      }
      const after = await this.#request('GET', path);
      requireValue(before.etag === after.etag && after.text === body,
        'CONDITIONAL_UNSUPPORTED', '该服务在拒绝写入后仍改变了内容，未启用写同步');
      this.#checked.add(folder);
    } finally {
      if (created) {
        try {
          const current = await this.#request('GET', path);
          if (typeof current.etag === 'string' && /^"[^"\r\n]+"$/.test(current.etag)) {
            await this.#request('DELETE', path, { headers: { 'If-Match': current.etag } });
          }
        } catch {
          // Only this random marker can remain. No workspace file is deleted.
        }
      }
    }
  }
  async _publish(folder, head, key, workspace, parentVersion, etag) {
    const prefix = folder === '/' ? '' : folder;
    const snapshotId = randomUUID();
    const snapshot = { spaceId: head.spaceId, snapshotId, parentVersion, workspace };
    const body = JSON.stringify(encrypt(snapshot, key));
    requireValue(Buffer.byteLength(body) <= MAX_BYTES, 'INVALID_DATA', '加密后的文件超过试验大小上限');
    await this.#checkWriteConditions(folder);
    await this.#request('PUT', `${prefix}/snapshots/${snapshotId}.enc.json`, {
      headers: { 'If-None-Match': '*', 'Content-Type': 'application/json' },
      body,
    });
    const next = signed({ ...head, snapshotId }, key);
    await this.#request('PUT', `${prefix}/${HEAD}`, {
      headers: { ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }), 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    return next;
  }
  async create(folder, password, source) {
    const path = folderPath(folder);
    const workspace = workspaceProjection(source);
    await this.makeFolder(path);
    if (await this._readHead(path, true)) fail('ALREADY_EXISTS', '该文件夹已有云端工作区，请使用云端数据接入');
    await this.makeFolder(`${path === '/' ? '' : path}/snapshots`);
    const salt = randomBytes(16);
    const key = await keyFor(password, salt);
    try {
      const head = await this._publish(path, {
        format: FORMAT, version: 1, spaceId: randomUUID(), salt: salt.toString('base64'),
      }, key, workspace, null, null);
      return new Device(this, path, head, key, workspace);
    } catch (error) {
      key.fill(0);
      if (error.code === 'PRECONDITION') fail('ALREADY_EXISTS', '另一设备已初始化该文件夹，请使用云端数据接入');
      throw error;
    }
  }
  async join(folder, password) {
    const path = folderPath(folder);
    const { head } = await this._readHead(path);
    const key = await keyFor(password, base64(head.salt, 16));
    try {
      return new Device(this, path, head, key, await this._readWorkspace(path, head, key));
    } catch (error) { key.fill(0); throw error; }
  }
}

class Device {
  #cloud; #folder; #head; #key; #workspace; #baseHash; #busy = false;
  constructor(cloud, folder, head, key, workspace) {
    this.#cloud = cloud; this.#folder = folder; this.#head = head; this.#key = key;
    this.#workspace = structuredClone(workspace); this.#baseHash = digest(workspace);
  }
  get workspace() { return structuredClone(this.#workspace); }
  get baseVersion() { return this.#head.snapshotId; }
  edit(value) {
    requireValue(!this.#busy, 'BUSY', '同步进行中，请稍后编辑');
    this.#workspace = workspaceProjection(value);
  }
  async sync() {
    requireValue(!this.#busy, 'BUSY', '同步正在进行中');
    this.#busy = true;
    try {
      const { head, etag } = await this.#cloud._readHead(this.#folder);
      requireValue(head.spaceId === this.#head.spaceId && head.salt === this.#head.salt, 'INTEGRITY_FAILED', '云端同步空间发生变化');
      const remote = await this.#cloud._readWorkspace(this.#folder, head, this.#key);
      const dirty = digest(this.#workspace) !== this.#baseHash;
      if (head.snapshotId !== this.#head.snapshotId) {
        if (dirty && digest(remote) !== digest(this.#workspace)) return { status: 'conflict', remote, remoteVersion: head.snapshotId };
        this.#head = head; this.#workspace = remote; this.#baseHash = digest(remote);
        return { status: 'pulled' };
      }
      if (!dirty) return { status: 'unchanged' };
      try {
        const next = await this.#cloud._publish(this.#folder, head, this.#key, this.#workspace, this.baseVersion, etag);
        this.#head = next; this.#baseHash = digest(this.#workspace);
        return { status: 'pushed' };
      } catch (error) {
        if (error.code !== 'PRECONDITION') throw error;
        const current = await this.#cloud._readHead(this.#folder);
        const currentWorkspace = await this.#cloud._readWorkspace(this.#folder, current.head, this.#key);
        return { status: 'conflict', remote: currentWorkspace, remoteVersion: current.head.snapshotId };
      }
    } finally { this.#busy = false; }
  }
}
