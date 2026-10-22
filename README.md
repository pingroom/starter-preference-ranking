# PingRoom preference ranking

Compare 2–6 proposals by asking one named person which of each pair they prefer.
PingRoom offers **A preferred**, **B preferred**, **Tied**, and **Skip**. Application
code turns the answers into a preference graph and reports contradictions,
unanswered comparisons, and relationships that remain unknown.

The result is a planning aid. It never edits tickets, allocates resources, or
executes a proposal. There is no invented total ranking or score.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux and persistent private storage.
Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm test
npm run demo
```

The demo uses the real pinned SDK with an in-memory HTTP transport. It records a
tie, a strict preference, and an abstention, then replays the finished session
without another send. It needs no credentials or network after installation and
removes its temporary state. Installation requires npm access.

## Connect and configure

```sh
cp examples/proposals.json proposals.json
cp config.example.json config.json
cp .env.example .env
npm run connect
npm run inspect
```

Install [PingRoom](https://pingroom.io/i), approve the printed pairing link, and
select a **standard private room** containing the participant. They may be you or
another room member. The connection needs `pingroom:rooms:read`,
`pingroom:questions:ask`, and a grant for that room. Normal permissions and quotas
apply. Connecting does not send a question.

`inspect` lists member UUIDs. Verify the intended person in the app and set their
exact UUID and a local label in `config.json`. Labels are not identity checks.
Edit `proposals.json` before starting: give the session an ID, a title, a common
comparison criterion, and stable proposal IDs, labels, and short details.

Pairing saves private credentials in `.pingroom/credentials.json`. An interrupted
pairing reuses its saved link; an existing connection is never overwritten. After
a link expires, confirm it is unusable before removing only
`.pingroom/pairing.json` and reconnecting.

For an existing connection or unattended run, set **both** `PINGROOM_TOKEN` and
`PINGROOM_ROOM` in `.env` or the process environment. A complete pair overrides
saved credentials; partial or blank values fail. Shell values override `.env`.
All local paths resolve from this project, regardless of the current directory.

## Run comparisons

```sh
npm start           # Ask the next pair, or read the existing question.
# Answer in PingRoom, then rerun:
npm start
npm run status      # Read local evidence without network or credentials.
npm run report      # Also write private .ranking/report.json.
```

Each invocation creates or reads at most one Question. After observing a terminal
outcome, another invocation starts the next pair. At most one Question is active.
Questions are direct to the configured participant and last **15 minutes**.
The starter does not wait for the person or install a scheduler; serialize calls
from your own scheduler if needed.

Pairs use sorted proposal IDs, with each unordered pair asked once: at most 15
questions for six proposals. Sorting determines presentation order, not priority.
The participant sees the common criterion and both proposals' labels and details.
Keep that meaning stable throughout a session. This is one person's stated
preference, not a team consensus or an objective measure of value.

## Read the report

`comparisons` preserves every pair's status, attributed choice, Question ID, and
observation timestamps. A finished session may still contain missing preferences.

- `observedEdges` contains explicit A/B preferences, directed from preferred to
  less preferred. `explicitTies` contains only directly observed Tied answers.
- `equivalenceGroups` computes the transitive closure of ties. This is an explicit
  modeling assumption: A tied with B and B tied with C places all three together.
- `strictWithinTieConflicts` identifies strict preferences inside a tie group.
  `cycleGroups` identifies mutually reachable groups, such as A over B, B over C,
  and C over A. Any such conflict makes `consistent` false.
- For a consistent graph, `impliedPreferences` follows transitive edges between
  groups. These are deductions, not extra answers. `incomparableGroups` identifies
  pairs with no ordering path in either direction; they are **not ties**. Both
  fields are `null` when the graph conflicts.
- `abstainedPairs` contains explicit Skip answers. Pending, unasked, expired,
  cancelled, and invalid answers stay in `unansweredPairs`, without a preference.

`allPairsAnswered` includes Skip because it is an observed response. It does not
mean every pair is ordered. Terminal evidence is reused locally; later commands
do not recheck historical answers, current room access, or availability.

The server-authenticated responder, exact request, room, asking registration,
and Question lifetime are checked. Answer and resolution timestamps must agree
and fall within the lifetime. Expired Questions resolve at their expiry timestamp.
Observations allow 60 seconds of local clock skew. Malformed or conflicting
evidence never becomes a preference.

Exit codes for `start` and `recover`: `0` ready or finished; `2` a newly observed
expired/cancelled/invalid answer or a conflicting graph; `3` pending or interrupted;
`4` uncertain creation; `1` configuration, validation, storage, or API failure.
Local `status` and `report` return `0` when readable; inspect their JSON fields.

## Recover an uncertain send

The journal saves and syncs the exact request, target, fixed TTL, correlation,
and idempotency key **before** the POST. A crash, lost response, invalid response,
or failed save may leave `create_unknown`. This blocks later comparisons and
never automatically repeats the POST.

```sh
npm run status
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` reads a bounded recent window and prints matching candidates. An empty
list does not prove creation failed. Obtain the original ID from your saved
response, originating robot's history, or logs when needed. `recover` reads that
exact ID and verifies the saved request and provenance before attaching it; it
creates no question. Keep uncertain state while investigating. Deleting it or
starting another checkout can send a duplicate.

Expired, cancelled, skipped, and invalid comparisons are not asked again within
the session. To collect revised preferences, first resolve all
active or uncertain work, archive the entire private `.ranking/` directory, and
start with a new session ID. Preserve the old evidence. Changing proposals,
their array order, criterion, participant, room, or credential during a session
is refused; no automatic migration is provided.

## Adapt and verify

`src/ranking.js` exports `step` for workflow tools. `src/model.js` owns deterministic
pair selection, evidence validation, tie closure, and graph analysis. Input text
is data; it never becomes a command, URL to fetch, or AI instruction. No AI service
is required. Add ticket updates or other external actions as a separate reviewed
integration that interprets incomplete and conflicting results explicitly.

IDs start with a lowercase letter and contain up to 40 lowercase letters, digits,
`_`, or `-`. Titles allow 60 printable ASCII characters; criteria 80; proposal
labels 40 and details 80. Labels and IDs must be distinct. Strings cannot have
leading or trailing spaces. Configuration and proposal files are limited to
16 KiB each; state and report files to 1 MiB; HTTP response bodies to 512 KiB.
The maximum 15-comparison session fits those storage bounds.

Writes use a private temporary file, file sync, rename, and directory sync. A lock
excludes concurrent commands. After a crash, inspect `.ranking/.lock/owner.json`
(or `.pingroom/.lock/owner.json` for pairing), confirm that process has stopped,
then remove only the stale lock. Restore corrupt state from a valid backup.
This is local persistence, without distributed exactly-once delivery or permanent
server idempotency retention. Files use `0600` and directories `0700` on POSIX;
credentials, inputs, state, and reports are ignored by Git. Keep backups private.

The official [SDK](https://github.com/pingroom/sdk) is pinned to **0.6.0** with a
lockfile and a 14-day minimum release age. Requests use the official API origin,
reject redirects, and have a five-second deadline through body consumption.
CI tests Node 22 and 24 with mocked success, failure, recovery, storage, and
transport cases. Live phone delivery is not tested.

Unlike [data completion](https://github.com/pingroom/starter-data-completion),
which fills one missing field, this workflow compares unordered proposals and
preserves a partial order, ties, and contradictions.

MIT licensed; see [LICENSE](LICENSE).
