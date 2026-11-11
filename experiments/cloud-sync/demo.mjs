import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CloudFolder } from './protocol.mjs';
import { startFixture } from './fixture-server.mjs';
import { exampleWorkspace } from './fixture-workspace.mjs';

const output = new URL('../../.tmp/cloud-sync-probe-20261027/demo/', import.meta.url);
await mkdir(output, { recursive: true });
const fixture = await startFixture();
const steps = [];
const record = (step, status) => {
  steps.push({ step, status });
  console.log(`${step}: ${status}`);
};
try {
  const cloud = new CloudFolder({
    url: fixture.url, username: 'fixture-user', password: 'fixture-password', allowLoopbackHttp: true,
  });
  const folder = '/EnvDock 演示空间';
  const password = 'synthetic-demo-sync-password';
  const a = await cloud.create(folder, password, exampleWorkspace());
  record('电脑 A 新建云端文件夹并上传', 'created');
  assert((await cloud.list('/')).includes(folder));
  const b = await cloud.join(folder, password);
  assert.equal(a.workspace.requests[0].id, b.workspace.requests[0].id);
  await writeFile(new URL('device-b-imported.json', output), JSON.stringify(b.workspace, null, 2), 'utf8');
  const imported = JSON.parse(await readFile(new URL('device-b-imported.json', output), 'utf8'));
  assert.equal(imported.requests[0].id, 'request-demo');
  record('电脑 B 选择已有文件夹，将配置写入独立演示文件', 'joined; IDs preserved');

  const changeA = a.workspace;
  changeA.requests[0].name = '电脑 A 的虚构修改';
  a.edit(changeA);
  assert.equal((await a.sync()).status, 'pushed');
  assert.equal((await b.sync()).status, 'pulled');
  assert.equal(b.workspace.requests[0].name, changeA.requests[0].name);
  record('A 修改后 B 获取更新', 'pushed → pulled');

  const changeB = b.workspace;
  changeB.requests[0].body = '{"demo":"B"}';
  b.edit(changeB);
  assert.equal((await b.sync()).status, 'pushed');
  assert.equal((await a.sync()).status, 'pulled');
  assert.equal(a.workspace.requests[0].body, changeB.requests[0].body);
  record('B 修改后 A 获取更新', 'pushed → pulled');

  const conflictA = a.workspace;
  const conflictB = b.workspace;
  conflictA.requests[0].name = 'A 的冲突修改';
  conflictB.requests[0].name = 'B 的冲突修改';
  a.edit(conflictA); b.edit(conflictB);
  await a.sync();
  assert.equal((await b.sync()).status, 'conflict');
  assert.equal(b.workspace.requests[0].name, 'B 的冲突修改');
  record('两台电脑同时修改', 'conflict; both versions retained');

  await writeFile(new URL('device-a-final.json', output), JSON.stringify(a.workspace, null, 2), 'utf8');
  await writeFile(new URL('device-b-conflict-retained.json', output), JSON.stringify(b.workspace, null, 2), 'utf8');
  await writeFile(new URL('result.json', output), JSON.stringify({ mode: 'local-fixture-only', steps }, null, 2), 'utf8');
  console.log(`演示结果：${fileURLToPath(output)}`);
} finally {
  await fixture.close();
}
