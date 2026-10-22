import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, localReport } from './ranking.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-preference-demo-'));
const proposals = await readJson(new URL('../examples/proposals.json', import.meta.url), 16384);
const now = () => '2026-01-01T09:00:00.000Z';
const api = mockApi(now);
const options = { client: api.client, directory, proposals, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
try {
  for (const answer of ['tie', 'a', 'skip']) {
    const pending = await step(options);
    const question = pending.comparisons.find((comparison) => comparison.status === 'pending');
    api.answer(question.questionId, answer);
    await step(options);
  }
  const result = await localReport(directory, proposals, { save: true });
  console.log(JSON.stringify({ demo: 'Explicit tie, strict preference, and abstention; all transport is mocked.',
    status: result.status, abstainedPairs: result.abstainedPairs, graph: result.graph }, null, 2));
  const sends = api.calls.filter((call) => call.method === 'POST').length;
  await step(options);
  if (api.calls.filter((call) => call.method === 'POST').length !== sends) throw new Error('Replay sent another question.');
} finally { await rm(directory, { recursive: true, force: true }); }
