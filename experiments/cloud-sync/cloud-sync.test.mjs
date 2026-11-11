import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFixture } from './fixture-server.mjs';
import { CloudFolder } from './protocol.mjs';
import { exampleWorkspace } from './fixture-workspace.mjs';
const syncPassword = 'fixture-sync-password';
const cloudFor = fixture => new CloudFolder({
  url: fixture.url, username: 'fixture-user', password: 'fixture-password', allowLoopbackHttp: true,
});
const checkCode = code => error => error.code === code && !error.message.includes('fixture-password');

async function fixtureFor(t) {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  return { fixture, cloud: cloudFor(fixture) };
}

test('creates a folder and another device joins it with stable entity IDs', async t => {
  const { cloud } = await fixtureFor(t);
  const source = exampleWorkspace();
  const first = await cloud.create('/EnvDock 示例', syncPassword, source);
  const second = await cloud.join('/EnvDock 示例', syncPassword);
  assert.deepEqual(second.workspace, first.workspace);
  assert.equal(second.workspace.requests[0].id, source.requests[0].id);
  assert.equal(second.baseVersion, first.baseVersion);
  const again = await cloud.join('/EnvDock 示例', syncPassword);
  assert.equal(again.workspace.projects.length, 1);
  assert.equal(again.workspace.projects[0].id, source.projects[0].id);
});

test('uses an existing folder and lists cloud folders for selection', async t => {
  const { cloud } = await fixtureFor(t);
  await cloud.makeFolder('/已有目录');
  await cloud.create('/已有目录', syncPassword, exampleWorkspace());
  const folders = await cloud.list('/');
  assert.deepEqual(folders, ['/已有目录']);
});

test('stores no plaintext body, secret, local path or selected environment in cloud records', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  const source = exampleWorkspace();
  const first = await cloud.create('/EnvDock', syncPassword, source);
  const data = [...fixture.records.values()].map(record => record.body?.toString() ?? '').join('\n');
  assert(!data.includes('body-marker-to-encrypt'));
  assert(!data.includes('device-only-marker'));
  assert(!data.includes('fixture-sync-password'));
  assert.equal(first.workspace.variables.find(v => v.isSecret).value, '');
  assert.equal(first.workspace.requests[0].form[0].value, '');
  assert.equal(first.workspace.requests[0].form[0].enabled, false);
  assert.equal(first.workspace.activeProjectId, null);
  assert.equal(first.workspace.projects[0].activeEnvironmentId, null);
  assert.equal(first.workspace.revision, 0);
  assert.equal(source.variables[1].value, 'device-only-marker', 'source must not be mutated');
});

test('A edits, B pulls, B edits, A pulls; unchanged sync is a no-op', async t => {
  const { cloud } = await fixtureFor(t);
  const a = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  const b = await cloud.join('/EnvDock', syncPassword);
  const changeA = structuredClone(a.workspace);
  changeA.requests[0].name = 'A 修改';
  a.edit(changeA);
  assert.equal((await a.sync()).status, 'pushed');
  assert.equal((await b.sync()).status, 'pulled');
  assert.equal(b.workspace.requests[0].name, 'A 修改');
  const changeB = structuredClone(b.workspace);
  changeB.requests[0].body = '{"from":"B"}';
  b.edit(changeB);
  assert.equal((await b.sync()).status, 'pushed');
  assert.equal((await a.sync()).status, 'pulled');
  assert.equal(a.workspace.requests[0].body, '{"from":"B"}');
  assert.equal((await a.sync()).status, 'unchanged');
});

test('local secret-only changes do not cause a cloud write', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  const a = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  const changed = structuredClone(a.workspace);
  changed.variables[1].value = 'new-device-secret';
  a.edit(changed);
  const before = fixture.requests.filter(r => r.method === 'PUT').length;
  assert.equal((await a.sync()).status, 'unchanged');
  assert.equal(fixture.requests.filter(r => r.method === 'PUT').length, before);
});

test('both sides editing or deleting returns a conflict and preserves local and remote data', async t => {
  const { cloud } = await fixtureFor(t);
  const a = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  const b = await cloud.join('/EnvDock', syncPassword);
  const versionA = structuredClone(a.workspace);
  versionA.requests[0].name = 'remote-change';
  const versionB = structuredClone(b.workspace);
  versionB.requests = [];
  a.edit(versionA); b.edit(versionB);
  await a.sync();
  const base = b.baseVersion;
  const result = await b.sync();
  assert.equal(result.status, 'conflict');
  assert.equal(b.workspace.requests.length, 0);
  assert.equal(b.baseVersion, base);
  assert.equal(result.remote.requests[0].name, 'remote-change');
  assert.equal((await cloud.join('/EnvDock', syncPassword)).workspace.requests[0].name, 'remote-change');
});

test('a competing write after read is rejected by the HTTP precondition', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  const a = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  const b = await cloud.join('/EnvDock', syncPassword);
  const changedA = structuredClone(a.workspace);
  const changedB = structuredClone(b.workspace);
  changedA.requests[0].name = 'losing-local';
  changedB.requests[0].name = 'winning-remote';
  a.edit(changedA); b.edit(changedB);
  fixture.faults.beforeHeadWrite = async () => assert.equal((await b.sync()).status, 'pushed');
  assert.equal((await a.sync()).status, 'conflict');
  assert.equal(a.workspace.requests[0].name, 'losing-local');
  assert.equal((await cloud.join('/EnvDock', syncPassword)).workspace.requests[0].name, 'winning-remote');
});

test('a wrong password cannot join the cloud folder', async t => {
  const { cloud } = await fixtureFor(t);
  await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  await assert.rejects(cloud.join('/EnvDock', 'wrong-password'), checkCode('INTEGRITY_FAILED'));
});

test('creating over an existing sync folder refuses to overwrite its history', async t => {
  const { cloud } = await fixtureFor(t);
  const first = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  await assert.rejects(cloud.create('/EnvDock', syncPassword, exampleWorkspace()), checkCode('ALREADY_EXISTS'));
  assert.equal((await cloud.join('/EnvDock', syncPassword)).baseVersion, first.baseVersion);
});

test('failed snapshot or head upload keeps the published head and local edits', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  const a = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  const originalVersion = a.baseVersion;
  const changed = structuredClone(a.workspace);
  changed.requests[0].name = 'retained-draft';
  a.edit(changed);
  for (const fault of ['failNextSnapshot', 'failNextHead']) {
    fixture.faults[fault] = true;
    await assert.rejects(a.sync(), checkCode('HTTP_FAILED'));
    assert.equal(a.baseVersion, originalVersion);
    assert.equal(a.workspace.requests[0].name, 'retained-draft');
    assert.equal((await cloud.join('/EnvDock', syncPassword)).baseVersion, originalVersion);
  }
  assert.equal((await a.sync()).status, 'pushed');
});

test('missing ETag fails closed rather than falling back to unconditional writes', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  fixture.faults.omitEtag = true;
  await assert.rejects(cloud.join('/EnvDock', syncPassword), checkCode('ETAG_REQUIRED'));
});

test('bad authentication is reported without echoing credentials or server text', async t => {
  const { fixture } = await fixtureFor(t);
  const cloud = new CloudFolder({
    url: fixture.url, username: 'fixture-user', password: 'private-wrong-password', allowLoopbackHttp: true,
  });
  await assert.rejects(cloud.list('/'), error =>
    error.code === 'AUTH_FAILED' && !error.message.includes('private-wrong-password'));
});

test('offline failure keeps local state available', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const cloud = cloudFor(fixture);
  const a = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  await fixture.close();
  const changed = structuredClone(a.workspace);
  changed.requests[0].name = 'offline-edit';
  a.edit(changed);
  await assert.rejects(a.sync(), checkCode('NETWORK_FAILED'));
  assert.equal(a.workspace.requests[0].name, 'offline-edit');
});

test('modified ciphertext or public head is rejected', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  const head = fixture.records.get('/dav/EnvDock/envdock-sync.json');
  const original = head.body;
  const value = JSON.parse(original);
  value.snapshotId = '00000000-0000-4000-8000-000000000000';
  head.body = Buffer.from(JSON.stringify(value));
  await assert.rejects(cloud.join('/EnvDock', syncPassword), checkCode('INTEGRITY_FAILED'));
  head.body = original;
  const snapshot = [...fixture.records.entries()].find(([path]) => path.endsWith('.enc.json'))[1];
  const payload = JSON.parse(snapshot.body);
  payload.data = (payload.data[0] === 'A' ? 'B' : 'A') + payload.data.slice(1);
  snapshot.body = Buffer.from(JSON.stringify(payload));
  await assert.rejects(cloud.join('/EnvDock', syncPassword), checkCode('DECRYPT_FAILED'));
});

test('rejects insecure remote URLs, URL credentials, and folder path traversal', async t => {
  assert.throws(() => new CloudFolder({ url: 'http://example.com/dav', username: 'a', password: 'b' }));
  assert.throws(() => new CloudFolder({ url: 'https://user:pass@example.com/dav' }));
  const { cloud } = await fixtureFor(t);
  for (const path of ['/../private', '/%2e%2e/private', '/ok\\private', '/a?b', '/a#b']) {
    await assert.rejects(cloud.join(path, syncPassword), checkCode('INVALID_PATH'));
  }
});

test('refuses a service that returns ETags but ignores write conditions', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  fixture.faults.ignorePreconditions = true;
  await assert.rejects(cloud.create('/EnvDock', syncPassword, exampleWorkspace()), checkCode('CONDITIONAL_UNSUPPORTED'));
  assert.equal(fixture.records.has('/dav/EnvDock/envdock-sync.json'), false);
});

test('rejects a snapshot whose encoded ciphertext exceeds the transfer limit', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  const source = exampleWorkspace();
  source.requests[0].body = 'x'.repeat(1600 * 1024);
  await assert.rejects(cloud.create('/EnvDock', syncPassword, source), checkCode('INVALID_DATA'));
  assert.equal(fixture.records.has('/dav/EnvDock/envdock-sync.json'), false);
});

test('a lost acknowledgement after commit is recovered without duplicate uploads', async t => {
  const { cloud, fixture } = await fixtureFor(t);
  const a = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
  const changed = structuredClone(a.workspace);
  changed.requests[0].name = 'committed-with-lost-response';
  a.edit(changed);
  fixture.faults.dropNextHeadResponse = true;
  await assert.rejects(a.sync(), checkCode('NETWORK_FAILED'));
  assert.equal((await a.sync()).status, 'pulled');
  assert.equal(a.workspace.requests[0].name, 'committed-with-lost-response');
  const snapshots = [...fixture.records.keys()].filter(path => path.endsWith('.enc.json'));
  assert.equal(snapshots.length, 2);
});

for (const fault of ['acceptNextSnapshot', 'acceptNextHead']) {
  test(`${fault}: HTTP 202 is not a completed write and must preserve local edits`, async t => {
    const { cloud, fixture } = await fixtureFor(t);
    const a = await cloud.create('/EnvDock', syncPassword, exampleWorkspace());
    const previousVersion = a.baseVersion;
    const previousName = a.workspace.requests[0].name;
    const changed = a.workspace;
    changed.requests[0].name = 'must-not-be-lost';
    a.edit(changed);
    fixture.faults[fault] = true;
    await assert.rejects(a.sync(), checkCode('UNCONFIRMED_WRITE'));
    assert.equal(a.baseVersion, previousVersion);
    assert.equal(a.workspace.requests[0].name, 'must-not-be-lost');
    const b = await cloud.join('/EnvDock', syncPassword);
    assert.equal(b.baseVersion, previousVersion);
    assert.equal(b.workspace.requests[0].name, previousName);
    assert.equal((await a.sync()).status, 'pushed');
    assert.equal((await b.sync()).status, 'pulled');
    assert.equal(b.workspace.requests[0].name, 'must-not-be-lost');
  });
}
