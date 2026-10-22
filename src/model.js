import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

export function validateProposals(input) {
  if (!keys(input, ['sessionId', 'title', 'criterion', 'proposals']) || !word(input.sessionId)
    || !line(input.title, 60) || !line(input.criterion, 80) || !Array.isArray(input.proposals)
    || input.proposals.length < 2 || input.proposals.length > 6) throw new Error('Provide a session ID, title, criterion, and 2–6 proposals.');
  for (const proposal of input.proposals) {
    if (!keys(proposal, ['id', 'label', 'detail']) || !word(proposal.id) || !line(proposal.label, 40)
      || !line(proposal.detail, 80)) throw new Error('Invalid proposal ID, label, or detail.');
  }
  if (new Set(input.proposals.map((p) => p.id)).size !== input.proposals.length
    || new Set(input.proposals.map((p) => p.label)).size !== input.proposals.length) throw new Error('Proposal IDs and labels must be distinct.');
  return structuredClone(input);
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact participant UUID and label.');
  return structuredClone(config);
}

export function pairsFor(input) {
  const ids = input.proposals.map((p) => p.id).sort(compare), pairs = [];
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) pairs.push([ids[a], ids[b]]);
  return pairs;
}

export function requestFor(input, config, pair, attemptId) {
  if (!isId(attemptId) || !pairsFor(input).some((p) => hash(p) === hash(pair))) throw new Error('Invalid comparison or attempt.');
  const [a, b] = pair.map((id) => input.proposals.find((p) => p.id === id));
  const key = `preference-${attemptId}`;
  return {
    prompt: `${input.title}\n${input.criterion}\nA: ${a.label} - ${a.detail}\nB: ${b.label} - ${b.detail}`,
    context: `Compare ${hash({ input, pair }).slice(0, 20)}`,
    options: [ ['a', 'A preferred'], ['b', 'B preferred'], ['tie', 'Tied'], ['skip', 'Skip'] ]
      .map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { proposals_hash: hash(input), pair_a: a.id, pair_b: b.id, attempt_id: attemptId }, idempotencyKey: key,
  };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt !== observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved preference evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered comparisons must not contain preference evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved comparison, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function validateState(state, input) {
  validateProposals(input);
  const pairs = pairsFor(input);
  if (!keys(state, ['version', 'proposalsHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.proposalsHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > pairs.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed proposals. Restore the original session and configuration.');
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'pair', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || hash(attempt.pair) !== hash(pairs[index]) || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, pairs[index], attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved comparison.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last comparison may be active.');
  }
  return state;
}

/** Tie closure is an explicit equivalence assumption; strict cycles are never ranked. */
export function preferenceGraph(ids, decisions) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  for (const { pair, value } of decisions) if (value === 'tie') {
    const roots = pair.map(find).sort(compare); parent.set(roots[1], roots[0]);
  }
  const groups = ids.map((id) => find(id)).filter((id, index, all) => all.indexOf(id) === index).sort(compare)
    .map((root) => ids.filter((id) => find(id) === root).sort(compare));
  const groupOf = (id) => groups.findIndex((group) => group.includes(id));
  const edges = decisions.filter((d) => ['a', 'b'].includes(d.value)).map((d) => ({
    preferred: d.pair[d.value === 'a' ? 0 : 1], over: d.pair[d.value === 'a' ? 1 : 0], questionId: d.questionId,
  }));
  const conflicts = edges.filter((edge) => groupOf(edge.preferred) === groupOf(edge.over));
  const reachable = groups.map(() => groups.map(() => false));
  for (const edge of edges) reachable[groupOf(edge.preferred)][groupOf(edge.over)] = true;
  for (let k = 0; k < groups.length; k++) for (let i = 0; i < groups.length; i++) for (let j = 0; j < groups.length; j++) {
    reachable[i][j] ||= reachable[i][k] && reachable[k][j];
  }
  const cycles = [], used = new Set();
  for (let i = 0; i < groups.length; i++) if (reachable[i][i] && !used.has(i)) {
    const members = groups.map((_, j) => j).filter((j) => reachable[i][j] && reachable[j][i]);
    members.forEach((j) => used.add(j));
    cycles.push(members.map((j) => groups[j]));
  }
  const consistent = conflicts.length === 0 && cycles.length === 0;
  const impliedPreferences = [], incomparableGroups = [];
  if (consistent) for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    if (reachable[i][j]) impliedPreferences.push({ preferred: groups[i], over: groups[j] });
    else if (reachable[j][i]) impliedPreferences.push({ preferred: groups[j], over: groups[i] });
    else incomparableGroups.push([groups[i], groups[j]]);
  }
  return { consistent, observedEdges: edges, explicitTies: decisions.filter((d) => d.value === 'tie').map((d) => ({ pair: d.pair, questionId: d.questionId })),
    equivalenceGroups: groups, strictWithinTieConflicts: conflicts, cycleGroups: cycles,
    impliedPreferences: consistent ? impliedPreferences : null, incomparableGroups: consistent ? incomparableGroups : null };
}

export function report(state, input) {
  validateState(state, input);
  const comparisons = pairsFor(input).map((pair, index) => {
    const attempt = state.attempts[index];
    return { pair, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      questionId: attempt?.questionId ?? null, value: attempt?.observation?.answer?.value ?? null,
      observedAt: attempt?.observation?.checkedAt ?? null, answeredAt: attempt?.observation?.answer?.answeredAt ?? null };
  });
  const decisions = comparisons.filter((item) => item.status === 'answered');
  const active = comparisons.find((item) => ['create_unknown', 'pending'].includes(item.status));
  return { sessionId: input.sessionId, title: input.title, criterion: input.criterion, proposalsHash: state.proposalsHash,
    participant: state.config.participant, proposals: input.proposals, status: active?.status ?? (comparisons.some((p) => p.status === 'unasked') ? 'ready' : 'finished'),
    allPairsAnswered: decisions.length === comparisons.length, comparisons,
    abstainedPairs: decisions.filter((d) => d.value === 'skip').map((d) => d.pair),
    unansweredPairs: comparisons.filter((d) => d.status !== 'answered').map((d) => ({ pair: d.pair, status: d.status })),
    graph: preferenceGraph(input.proposals.map((p) => p.id).sort(compare), decisions) };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
