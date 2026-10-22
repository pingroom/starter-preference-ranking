import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { makeClient } from './client.js';
import { readJson, atomicJson, acquireLock } from './storage.js';
import { credentialDirectory, validateConnection } from './config.js';

export async function connect(signal) {
  const release = await acquireLock(credentialDirectory);
  try {
    if (await readJson(join(credentialDirectory, 'credentials.json'), 32768)) throw new Error('Saved connection already exists. Keep it to resume ranking; archive deliberately before reconnecting.');
    const client = makeClient({ signal, pairing: true });
    let pending = await readJson(join(credentialDirectory, 'pairing.json'), 65536);
    if (pending === null) {
      const pairing = await client.auth.startPairing({ agent_label: 'Preference ranking' });
      pending = { pairing, token: client.getToken(), createdAt: Date.now() };
      await atomicJson(credentialDirectory, 'pairing.json', pending, 65536);
    }
    if (typeof pending.token !== 'string' || !pending.token || !Number.isSafeInteger(pending.createdAt)
      || !Number.isInteger(pending.pairing?.expires_in) || pending.pairing.expires_in < 1 || pending.pairing.expires_in > 3600) throw new Error('Saved pairing is malformed; inspect it before reconnecting.');
    const remaining = Math.floor((pending.createdAt + pending.pairing.expires_in * 1000 - Date.now()) / 1000);
    if (remaining <= 0) throw new Error('Saved pairing expired. Remove only .pingroom/pairing.json after confirming the link is unusable, then reconnect.');
    const url = new URL(pending.pairing.pair_browser_url);
    if (url.origin !== 'https://pingroom.io' || url.username || url.password) throw new Error('Unexpected pairing URL.');
    client.setToken(pending.token);
    console.log('Install PingRoom: https://pingroom.io/i');
    console.log(`Approve this connection and choose the participant's private room: ${url.href}`);
    const approved = await client.auth.waitForPairing({ ...pending.pairing, expires_in: remaining }, { signal });
    const connection = validateConnection({ token: approved.credential, room: (approved.home_room ?? approved.room)?.invite_code });
    await atomicJson(credentialDirectory, 'credentials.json', connection, 32768);
    await rm(join(credentialDirectory, 'pairing.json'));
    console.log('Saved private connection. Run npm run inspect to identify the participant.');
  } finally { await release(); }
}
