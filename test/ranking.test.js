import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/ranking.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateProposals, validateState, preferenceGraph, requestFor, observeQuestion, pairsFor, hash, iso } from '../src/model.js';
import { loadConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/proposals.json', import.meta.url), 16384);
const two = () => ({ ...structuredClone(example), proposals: structuredClone(example.proposals.slice(0, 2)) });
async function setup(t, proposals = two()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-ranking-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, proposals, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
const pendingId = (result) => result.comparisons.find((comparison) => comparison.status === 'pending').questionId;
const decision = (a, b, value, n = 1) => ({ pair: [a, b], value, questionId: id(n) });

test('real SDK creates once, reads a preference, and reuses finished evidence without network', async (t) => {
  const s = await setup(t); let result = await s.run();
  assert.equal(result.status, 'pending'); assert.equal(sends(s.api), 1);
  assert.equal((await s.run()).status, 'pending'); assert.equal(sends(s.api), 1);
  s.api.answer(pendingId(result), 'b'); result = await s.run();
  assert.equal(result.status, 'finished'); assert.equal(result.allPairsAnswered, true);
  assert.deepEqual(result.graph.observedEdges, [{ preferred: 'reference', over: 'examples', questionId: id(1) }]);
  const calls = s.api.calls.length;
  assert.equal((await s.run()).status, 'finished'); assert.equal(s.api.calls.length, calls);
  assert.equal((await stat(join(s.directory, 'state.json'))).mode & 0o777, 0o600);
});

test('pair order uses IDs rather than supplied order and visits every unordered pair once', async (t) => {
  const proposals = structuredClone(example); proposals.proposals.reverse();
  const s = await setup(t, proposals);
  const expected = pairsFor(proposals), observed = [];
  for (let i = 0; i < expected.length; i++) {
    const result = await s.run(); observed.push(result.comparisons.find((c) => c.status === 'pending').pair);
    await s.run(); assert.equal(sends(s.api), i + 1);
    s.api.answer(pendingId(result), 'a'); const finished = await s.run();
    assert.equal(sends(s.api), i + 1); assert.equal(finished.status, i === expected.length - 1 ? 'finished' : 'ready');
  }
  assert.deepEqual(observed, expected); assert.equal(new Set(observed.map(JSON.stringify)).size, 3);
});

test('tie closure groups explicit equals and identifies a strict edge inside a tie group', () => {
  const graph = preferenceGraph(['a', 'b', 'c'], [decision('a', 'b', 'tie'), decision('b', 'c', 'tie', 2), decision('a', 'c', 'a', 3)]);
  assert.deepEqual(graph.equivalenceGroups, [['a', 'b', 'c']]); assert.equal(graph.explicitTies.length, 2);
  assert.equal(graph.consistent, false); assert.equal(graph.strictWithinTieConflicts.length, 1);
  assert.equal(graph.impliedPreferences, null); assert.equal(graph.incomparableGroups, null);
});

test('three-way strict preference cycle is explicit and produces no inferred ordering', () => {
  const graph = preferenceGraph(['a', 'b', 'c'], [decision('a', 'b', 'a'), decision('b', 'c', 'a', 2), decision('a', 'c', 'b', 3)]);
  assert.equal(graph.consistent, false); assert.deepEqual(graph.cycleGroups, [[['a'], ['b'], ['c']]]);
  assert.equal(graph.strictWithinTieConflicts.length, 0); assert.equal(graph.impliedPreferences, null);
});

test('consistent partial order separates transitive implications, ties, and incomparable groups', () => {
  const graph = preferenceGraph(['a', 'b', 'c', 'd'], [decision('a', 'b', 'a'), decision('b', 'c', 'a', 2), decision('a', 'd', 'skip', 3)]);
  assert.equal(graph.consistent, true); assert.equal(graph.explicitTies.length, 0);
  assert.ok(graph.impliedPreferences.some((edge) => edge.preferred[0] === 'a' && edge.over[0] === 'c'));
  assert.deepEqual(graph.incomparableGroups, [[['a'], ['d']], [['b'], ['d']], [['c'], ['d']]]);
});

test('Skip is an attributed abstention, with no edge and no tie', async (t) => {
  const s = await setup(t); const result = await s.run(); s.api.answer(pendingId(result), 'skip');
  const done = await s.run(); assert.equal(done.allPairsAnswered, true); assert.equal(done.abstainedPairs.length, 1);
  assert.equal(done.unansweredPairs.length, 0); assert.equal(done.graph.observedEdges.length, 0);
  assert.equal(done.graph.explicitTies.length, 0); assert.equal(done.graph.incomparableGroups.length, 1);
});

test('Tied records explicit evidence and a two-item equivalence group without a strict edge', async (t) => {
  const s = await setup(t); const result = await s.run(); s.api.answer(pendingId(result), 'tie');
  const done = await s.run(); assert.equal(done.graph.explicitTies.length, 1);
  assert.deepEqual(done.graph.equivalenceGroups, [['examples', 'reference']]); assert.equal(done.graph.observedEdges.length, 0);
});

test('pending and unasked comparisons remain visible in an incomplete report', async (t) => {
  const s = await setup(t, structuredClone(example)); const result = await s.run();
  assert.equal(result.allPairsAnswered, false); assert.equal(result.unansweredPairs.length, 3);
  assert.equal(result.unansweredPairs[0].status, 'pending'); assert.equal(result.unansweredPairs[1].status, 'unasked');
  assert.equal(result.graph.observedEdges.length, 0); assert.equal(result.graph.explicitTies.length, 0);
});

test('expired and cancelled comparisons are unobserved, never Skip or Tie, and are not asked twice', async (t) => {
  for (const terminal of ['expired', 'cancelled']) {
    const s = await setup(t); const started = await s.run();
    if (terminal === 'expired') s.clock.value = '2026-01-01T09:15:01.000Z';
    s.api.terminal(pendingId(started), terminal);
    const result = await s.run(); assert.equal(result.status, 'finished'); assert.equal(result.observedStatus, terminal);
    assert.equal(result.allPairsAnswered, false); assert.equal(result.abstainedPairs.length, 0);
    assert.equal(result.unansweredPairs[0].status, terminal); assert.equal(result.graph.explicitTies.length, 0);
    assert.equal((await s.run()).status, 'finished'); assert.equal(sends(s.api), 1);
  }
});

test('lost creation response blocks later pairs; exact recovery reads the original without resend', async (t) => {
  const s = await setup(t, structuredClone(example)); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.equal(sends(s.api), 1);
  const candidates = await s.run({ command: 'find' }); assert.deepEqual(candidates.candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'a');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('malformed create response retains uncertainty, while an empty candidate scan proves no absence', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true;
  await assert.rejects(s.run()); assert.equal((await s.saved()).attempts[0].status, 'creating');
  s.api.questions.clear(); assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery rejects wrong candidate, target, room, options, data and handoff provenance', async (t) => {
  for (const modify of [
    (q) => { q.id = id(99); }, (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.pair_a = 'wrong'; }, (q) => { delete q.is_handoff; }, (q) => { q.is_handoff = true; },
    (q) => { q.resolution_policy = 'all'; }, (q) => { q.prompt = 'Wrong'; }, (q) => { q.asker.type = 'user'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); modify(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) }));
    assert.equal((await s.saved()).attempts[0].status, 'creating'); assert.equal(sends(s.api), 1);
  }
});

test('wrong responder, redacted identity, typed answer and unknown option produce no preference', async (t) => {
  for (const modify of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'a'; }, (q) => { q.answer.value = 'unknown'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); const started = await s.run(); s.api.answer(pendingId(started), 'a');
    modify(s.api.questions.get(id(1))); const result = await s.run();
    assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.graph.observedEdges.length, 0);
    assert.equal(result.abstainedPairs.length, 0); assert.equal(result.unansweredPairs[0].status, 'invalid_answer');
  }
});

test('original asker and lifetime cannot drift between reads', async (t) => {
  for (const modify of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); modify(s.api.questions.get(id(1)));
    await assert.rejects(s.run(), /identity or lifetime/); assert.equal((await s.saved()).attempts[0].status, 'pending');
  }
});

test('all comparisons stay bound to the first asking registration and creation intent', async (t) => {
  const s = await setup(t, structuredClone(example)); await s.run(); s.api.answer(id(1), 'a'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('delayed expiry is persisted and replayed locally without another Question', async (t) => {
  for (const resolvedAt of ['2026-01-01T09:15:30.000Z', '2026-01-01T09:17:00.000Z']) {
    const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
    s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = resolvedAt;
    const result = await s.run();
    assert.equal(result.status, 'finished'); assert.equal(result.observedStatus, 'expired');
    assert.equal(result.unansweredPairs[0].status, 'expired'); assert.equal(result.allPairsAnswered, false);
    assert.equal(result.graph.observedEdges.length, 0); assert.equal(result.graph.explicitTies.length, 0);
    const saved = await s.saved(); assert.equal(saved.attempts[0].observation.resolvedAt, resolvedAt);
    const calls = s.api.calls.length; s.clock.value = '2026-01-02T09:00:00.000Z';
    const historical = await localReport(s.directory, s.options.proposals, { save: true });
    assert.equal(historical.unansweredPairs[0].status, 'expired');
    assert.deepEqual(await readJson(join(s.directory, 'report.json')), historical);
    assert.equal((await s.run()).status, 'finished'); assert.equal(s.api.calls.length, calls);
    assert.equal(sends(s.api), 1); assert.deepEqual(await s.saved(), saved);
  }
});

test('expiry before its deadline or beyond clock tolerance is rejected on reads and state replay', async (t) => {
  for (const resolvedAt of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
    s.api.terminal(id(1), 'expired'); const q = s.api.questions.get(id(1)); q.resolved_at = resolvedAt;
    await assert.rejects(s.run(), /resolution time/);
    q.resolved_at = q.expires_at; await s.run(); const saved = await s.saved();
    saved.attempts[0].observation.resolvedAt = resolvedAt; await atomicJson(s.directory, 'state.json', saved);
    const before = s.api.calls.length;
    await assert.rejects(localReport(s.directory, s.options.proposals), /resolution time/);
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, before);
  }
});

test('answer time must match resolution and both answer and cancellation stay within lifetime', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'a');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'a'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('future timestamps fail; checked time is captured after network response', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'a'); return get(...args); };
  assert.equal((await s.run()).observedStatus, 'answered'); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  const other = await setup(t); await other.run(); const q = other.api.questions.get(id(1));
  q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z';
  await assert.rejects(other.run(), /future/);
});

test('UTC timestamps normalize, while impossible dates, wrong TTL and pending answers fail', async (t) => {
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z');
  assert.throws(() => iso('2026-02-30T09:00:00Z')); assert.throws(() => iso('2026-01-01T09:00:00+04:00'));
  const s = await setup(t); await s.run(); const q = s.api.questions.get(id(1));
  q.expires_at = '2026-01-01T10:00:00.000Z'; await assert.rejects(s.run(), /lifetime/);
  q.expires_at = '2026-01-01T09:15:00.000Z'; q.answer = {}; await assert.rejects(s.run(), /unexpected answer/);
});

test('changed session, proposals, order, participant or credential cannot reuse the journal', async (t) => {
  const s = await setup(t); await s.run();
  await assert.rejects(s.run({ proposals: { ...s.options.proposals, sessionId: 'another' } }), /changed proposals/);
  const modified = structuredClone(s.options.proposals); modified.proposals.reverse();
  await assert.rejects(s.run({ proposals: modified }), /changed proposals/);
  await assert.rejects(s.run({ config: { participant: { id: OTHER, label: 'Other' } } }), /another connection/);
  await assert.rejects(s.run({ token: 'different' }), /another connection/); assert.equal(sends(s.api), 1);
});

test('strict manifest validation rejects duplicates, extra keys, excessive counts and numeric IDs', () => {
  for (const mutate of [
    (p) => { p.proposals.push(p.proposals[0]); }, (p) => { p.proposals[1].label = p.proposals[0].label; },
    (p) => { p.sessionId = 42; }, (p) => { p.proposals[0].id = 1; }, (p) => { p.script = 'anything'; },
    (p) => { p.proposals = [p.proposals[0]]; }, (p) => { p.proposals[0].detail = 'x'.repeat(81); },
  ]) { const proposals = two(); mutate(proposals); assert.throws(() => validateProposals(proposals)); }
});

test('room preflight rejects public, unsupported and missing-member rooms before creating', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('failed reservation sends nothing; failed answer save resumes the exact Question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'a');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'finished'); assert.equal(sends(s.api), 1);
});

test('post-create save failure persists uncertainty and permits verified recovery only', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'creating'); assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve saved evidence; state corruption fails before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  const saved = await s.saved(); saved.attempts[0].request.ttl = 60; await atomicJson(s.directory, 'state.json', saved);
  const calls = s.api.calls.length; await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
});

test('forged preference evidence, repeated IDs and out-of-order pairs fail validation', async (t) => {
  const s = await setup(t, structuredClone(example)); await s.run(); s.api.answer(id(1), 'a'); await s.run(); const saved = await s.saved();
  const duplicate = structuredClone(saved); duplicate.attempts.push(duplicate.attempts[0]); assert.throws(() => validateState(duplicate, s.options.proposals));
  const evidence = structuredClone(saved); evidence.attempts[0].observation.answer.responderId = OTHER; assert.throws(() => validateState(evidence, s.options.proposals));
  const order = structuredClone(saved); order.attempts[0].pair.reverse(); assert.throws(() => validateState(order, s.options.proposals));
});

test('six maximum-sized proposals produce fifteen bounded comparisons and a bounded final report', async (t) => {
  const proposals = { sessionId: 's'.repeat(40), title: 't'.repeat(60), criterion: 'c'.repeat(80),
    proposals: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}${'x'.repeat(38)}`, label: `${i}${'l'.repeat(39)}`, detail: 'd'.repeat(80) })) };
  const s = await setup(t, proposals);
  for (let i = 0; i < 15; i++) { const pending = await s.run(); s.api.answer(pendingId(pending), 'a'); await s.run(); }
  const saved = await s.saved(); validateState(saved, proposals);
  assert.ok(saved.attempts.every((attempt) => attempt.request.prompt.length <= 500));
  assert.ok(Buffer.byteLength(JSON.stringify(saved, null, 2)) + 4096 < 1024 * 1024);
  const result = await localReport(s.directory, proposals, { save: true }); assert.equal(result.status, 'finished');
  assert.ok((await stat(join(s.directory, 'report.json'))).size < 1024 * 1024);
  await s.run(); assert.equal(sends(s.api), 15);
});

test('bounded reads reject malformed, oversized, invalid UTF-8 and symlink files without leaking content', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands and report export needs no network', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.proposals), /lock exists/);
  await release(); const before = s.api.calls.length;
  const result = await localReport(s.directory, s.options.proposals, { save: true }); assert.equal(result.status, 'pending'); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial and blank environment overrides fail instead of using saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' }));
  await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized bodies', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1);
  await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) });
  await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch and body and yield to abort on ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) });
  await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; abort after reservation leaves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort();
  await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});
