import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const browserUrl = 'https://api.pingroom.io/pair?token=offline-fixture';
const pairing = extra => ({ pair_url: browserUrl, expires_in: 900, poll_interval_ms: 1000, ...extra });

async function fixture(t, response = pairing()) {
  const directory = await mkdtemp(join(tmpdir(), 'preference-ranking-pairing-url-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(root, 'package.json'), join(directory, 'package.json'));
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'transport.mjs'), `
import { appendFileSync } from 'node:fs';
const pairing = ${JSON.stringify(response)};
globalThis.fetch = async (raw, init) => {
  const path = new URL(raw).pathname;
  appendFileSync('calls.jsonl', JSON.stringify({ method: init.method, path }) + '\\n');
  if (init.method === 'POST' && path === '/api/agent/auth') {
    return Response.json({ credential: 'offline-pending', credential_type: 'pre_claim', expires_in: 900 });
  }
  if (init.method === 'POST' && path === '/api/agent/auth/pair/start') {
    return Response.json(pairing);
  }
  if (init.method === 'GET' && path === '/api/agent/auth/pair/status') {
    return Response.json({ status: 'active', credential: 'offline-active', credential_type: 'active', expires_in: null,
      room: { invite_code: 'DEMO12345678' } });
  }
  throw new Error('Unexpected fixture request.');
};
`);
  return {
    directory,
    run: () => spawnSync(process.execPath, ['--import', './transport.mjs', 'src/cli.js', 'connect'], { cwd: directory, encoding: 'utf8', timeout: 5000 }),
    calls: async () => (await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    })).trim().split('\n').filter(Boolean).map(JSON.parse),
    read: async name => JSON.parse(await readFile(join(directory, '.pingroom', name), 'utf8')),
  };
}

for (const [name, response, expectedUrl] of [
  ['API-hosted browser approval', pairing({ pair_browser_url: browserUrl }), browserUrl],
  ['pair_url fallback without a browser field', pairing(), browserUrl],
  ['existing website approval', pairing({ pair_browser_url: 'https://pingroom.io/pair?token=offline-fixture' }), 'https://pingroom.io/pair?token=offline-fixture'],
]) test(`connect accepts ${name} through the actual CLI`, async t => {
  const f = await fixture(t, response), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(expectedUrl));
  assert.deepEqual(await f.read('credentials.json'), { token: 'offline-active', room: 'DEMO12345678' });
  assert.equal((await stat(join(f.directory, '.pingroom', 'credentials.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await f.calls()).map(call => call.method), ['POST', 'POST', 'GET']);
  await assert.rejects(f.read('pairing.json'), { code: 'ENOENT' });
});

test('connect rejects unsafe approval origins and userinfo before polling', async t => {
  for (const url of ['http://api.pingroom.io/pair', 'https://api.pingroom.io.evil.example/pair',
    'https://evil.example/pair', 'https://user:pass@api.pingroom.io/pair', 'https://user@pingroom.io/pair']) {
    const f = await fixture(t, pairing({ pair_browser_url: url })), result = f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, /Unexpected pairing URL/);
    assert.deepEqual((await f.calls()).map(call => call.method), ['POST', 'POST']);
    assert.equal((await f.read('pairing.json')).pairing.pair_browser_url, url);
    await assert.rejects(f.read('credentials.json'), { code: 'ENOENT' });
  }
});

test('saved API-hosted pairing resumes without another registration or pairing POST', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, '.pingroom'), { mode: 0o700 });
  await writeFile(join(f.directory, '.pingroom', 'pairing.json'), JSON.stringify({ pairing: pairing(), token: 'offline-pending', createdAt: Date.now() }), { mode: 0o600 });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.calls(), [{ method: 'GET', path: '/api/agent/auth/pair/status' }]);
  assert.equal((await f.read('credentials.json')).token, 'offline-active');
});
