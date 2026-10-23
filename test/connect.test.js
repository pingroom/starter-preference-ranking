import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('..', import.meta.url));
// Exercise the real CLI and pinned SDK. Every request is intercepted, and an
// unexpected origin or route fails instead of reaching the network.
const preload = `
import { appendFileSync, writeFileSync } from 'node:fs';
let clock = 1800000000000;
if (process.env.PROBE_MODE === 'delayed-pair') Date.now = () => clock;
globalThis.fetch = async (input, init) => {
  const url = new URL(input), path = url.pathname;
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected mock origin');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({ run: process.env.PROBE_RUN, method: init.method, path }) + '\\n');
  if (path === '/api/agent/auth' && init.method === 'POST') {
    if (process.env.PROBE_MODE === 'lost-register') throw new Error('Lost registration response');
    return Response.json({ credential: 'offline-pending-token', credential_type: 'pre_claim', expires_in: 900 });
  }
  if (path === '/api/agent/auth/pair/start' && init.method === 'POST') {
    if (process.env.PROBE_MODE === 'lost-pair') throw new Error('Lost pairing response');
    if (process.env.PROBE_MODE === 'delayed-pair') clock += 120000;
    return Response.json({ pair_token: 'offline-token', pair_browser_url: 'https://pingroom.io/claim/offline', expires_in: process.env.PROBE_MODE === 'delayed-pair' ? 60 : 900, poll_interval_ms: 1000 });
  }
  if (path === '/api/agent/auth/pair/status' && init.method === 'GET') {
    if (new Headers(init.headers).get('authorization') !== 'Bearer offline-pending-token') throw new Error('Wrong pending credential');
    if (['interrupt', 'hold'].includes(process.env.PROBE_MODE)) {
      writeFileSync(process.env.PROBE_READY, 'ready');
      if (process.env.PROBE_MODE === 'interrupt') setTimeout(() => process.kill(process.pid, 'SIGINT'), 1);
      return Response.json({ status: 'pending' });
    }
    return Response.json({ status: 'active', credential: 'offline-approved-token', credential_type: 'active', expires_in: null, home_room: { invite_code: 'RANKROOM0001' }, room: { invite_code: 'RANKROOM0001' } });
  }
  throw new Error('Unexpected mock route');
};
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ranking-connect-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  return directory;
}
function launch(t, directory, mode = 'active', run = mode) {
  const env = { ...process.env, PROBE_MODE: mode, PROBE_RUN: run, PROBE_LOG: join(directory, 'requests.jsonl'), PROBE_READY: join(directory, 'ready') };
  for (const key of ['NODE_OPTIONS', 'PINGROOM_TOKEN', 'PINGROOM_ROOM']) delete env[key];
  const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), 'connect'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  return { child, done };
}
async function requests(directory) {
  try { return (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function ready(directory) {
  for (let i = 0; i < 100; i++) {
    try { await stat(join(directory, 'ready')); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error('Mock setup did not reach the pending wait.');
}
const credentialPath = directory => join(directory, '.pingroom', 'credentials.json');
const pairingPath = directory => join(directory, '.pingroom', 'pairing.json');

test('lost registration or pairing response retains private intent and prevents another POST', async t => {
  for (const mode of ['lost-register', 'lost-pair']) {
    const directory = await fixture(t);
    assert.equal((await launch(t, directory, mode).done).code, 1);
    const saved = await readFile(pairingPath(directory), 'utf8');
    assert.equal(JSON.parse(saved).phase, 'creating');
    assert.equal((await stat(pairingPath(directory))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, '.pingroom'))).mode & 0o777, 0o700);
    const retry = await launch(t, directory, 'active', 'retry').done;
    assert.equal(retry.code, 1); assert.match(retry.stderr, /uncertain/);
    assert.equal((await requests(directory)).filter(r => r.run === 'retry').length, 0);
    assert.equal(await readFile(pairingPath(directory), 'utf8'), saved);
    await assert.rejects(readFile(credentialPath(directory)), { code: 'ENOENT' });
  }
});

test('pairing creation time includes response delay instead of extending its lifetime', async t => {
  const directory = await fixture(t), result = await launch(t, directory, 'delayed-pair').done;
  assert.equal(result.code, 1); assert.match(result.stderr, /expired/);
  assert.equal(JSON.parse(await readFile(pairingPath(directory), 'utf8')).createdAt, 1800000000000);
  assert.equal((await requests(directory)).filter(r => r.path.endsWith('/status')).length, 0);
  await assert.rejects(readFile(credentialPath(directory)), { code: 'ENOENT' });
});

test('interrupted setup resumes the existing private pairing without new registration', async t => {
  const directory = await fixture(t), first = await launch(t, directory, 'interrupt').done;
  assert.equal(first.code, 3);
  const pending = JSON.parse(await readFile(pairingPath(directory), 'utf8'));
  assert.equal(pending.token, 'offline-pending-token');
  const second = await launch(t, directory, 'active', 'retry').done;
  assert.equal(second.code, 0, second.stderr);
  const calls = await requests(directory);
  assert.equal(calls.filter(r => r.path === '/api/agent/auth').length, 1);
  assert.equal(calls.filter(r => r.path === '/api/agent/auth/pair/start').length, 1);
  assert.ok(calls.filter(r => r.run === 'retry').every(r => r.method === 'GET'));
  assert.match(first.stdout, /https:\/\/pingroom.io\/claim\/offline/);
  assert.match(second.stdout, /https:\/\/pingroom.io\/claim\/offline/);
  assert.equal(JSON.parse(await readFile(credentialPath(directory), 'utf8')).token, 'offline-approved-token');
  assert.equal((await stat(credentialPath(directory))).mode & 0o777, 0o600);
  await assert.rejects(readFile(pairingPath(directory)), { code: 'ENOENT' });
});

test('existing credentials and ranking journal remain untouched without API calls', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, '.pingroom')); await mkdir(join(directory, '.ranking'));
  const credential = JSON.stringify({ token: 'existing-offline-token', room: 'RANKROOM0001' }), journal = '{"keep":"historical evidence"}\n';
  await writeFile(credentialPath(directory), credential); await writeFile(join(directory, '.ranking/state.json'), journal);
  const result = await launch(t, directory).done;
  assert.equal(result.code, 1); assert.match(result.stderr, /already exists/);
  assert.deepEqual(await requests(directory), []);
  assert.equal(await readFile(credentialPath(directory), 'utf8'), credential);
  assert.equal(await readFile(join(directory, '.ranking/state.json'), 'utf8'), journal);
});

test('concurrent connect cannot create a second robot', async t => {
  const directory = await fixture(t), first = launch(t, directory, 'hold', 'first');
  await ready(directory);
  try {
    const second = await launch(t, directory, 'active', 'second').done;
    assert.equal(second.code, 1); assert.match(second.stderr, /lock exists/);
    assert.equal((await requests(directory)).filter(r => r.run === 'second').length, 0);
  } finally { first.child.kill('SIGINT'); await first.done; }
});

test('expired or malformed saved pairing is preserved without new requests', async t => {
  for (const malformed of [false, true]) {
    const directory = await fixture(t); await launch(t, directory, 'interrupt').done;
    const pending = JSON.parse(await readFile(pairingPath(directory), 'utf8'));
    if (malformed) pending.pairing.expires_in = 0;
    else pending.createdAt = Date.now() - 3600000;
    const saved = JSON.stringify(pending); await writeFile(pairingPath(directory), saved);
    const result = await launch(t, directory, 'active', 'retry').done;
    assert.equal(result.code, 1); assert.match(result.stderr, malformed ? /malformed/ : /expired/);
    assert.equal((await requests(directory)).filter(r => r.run === 'retry').length, 0);
    assert.equal(await readFile(pairingPath(directory), 'utf8'), saved);
  }
});
