// The iPhone app's watchdog tests (mobile/__tests__/watchdog.test.ts), run
// against the desktop copy: node --test desktop/test/*.test.mjs
import { test } from 'node:test';
import { expect } from './expect.mjs';
import { decide, NO_ANSWER_MS, PEER_LOST_MS, JOIN_TIMEOUT_MS, ALONE_REJOIN_MS, ALONE_END_MS, MAX_REJOINS } from '../src/watchdog.js';

const T = 1_000_000;
const base = (o = {}) => ({
  now: T,
  startedAt: T,
  attemptStartedAt: T,
  rejoins: 0,
  joined: true,
  remotes: 1,
  aloneSince: null,
  peerSince: T,
  status: { peer: 'bob', peerSeenMsAgo: 1000, endedBy: '' },
  statusAt: T,
  me: 'alice',
  ...o,
});

test('in the browser (Linux): the room is never looked at', () => {
  // Not joined, nobody in the room, for ages: it'd rejoin or end with a
  // meeting window, but in the browser only the server counts.
  const s = base({ external: true, joined: false, remotes: 0, aloneSince: T - 10 * ALONE_END_MS, attemptStartedAt: T - 10 * JOIN_TIMEOUT_MS });
  expect(decide(s)).toEqual({ action: 'none' });
});

test('in the browser: the other side hanging up or vanishing still ends it', () => {
  expect(decide(base({ external: true, status: { peer: 'bob', peerSeenMsAgo: 1000, endedBy: 'bob' } }))).toEqual({ action: 'end', reason: 'bob hung up' });
  expect(decide(base({ external: true, status: { peer: 'bob', peerSeenMsAgo: PEER_LOST_MS + 1, endedBy: '' } }))).toEqual({ action: 'end', reason: 'Lost the connection to bob' });
});

test('a call going fine is left alone', () => {
  expect(decide(base())).toEqual({ action: 'none' });
});

test('the other side hanging up ends it, even mid-conversation', () => {
  expect(decide(base({ status: { peer: 'bob', peerSeenMsAgo: 1000, endedBy: 'bob' } }))).toEqual({ action: 'end', reason: 'bob hung up' });
});

test('calling yourself: the other device hanging up ends it (endedBy is you either way)', () => {
  const st = (peerEnded) => ({ peer: 'alice', peerSeenMsAgo: 1000, endedBy: 'alice', peerEnded });
  expect(decide(base({ me: 'alice', status: st(true) }))).toEqual({ action: 'end', reason: 'alice hung up' });
  expect(decide(base({ me: 'alice', status: st(false) }))).toEqual({ action: 'none' });
});

test('a decline (or the ring running out) ends it', () => {
  const v = decide(base({ remotes: 0, peerSince: null, status: { peer: 'bob', peerSeenMsAgo: null, endedBy: 'bob' } }));
  expect(v).toEqual({ action: 'end', reason: "bob didn't answer" });
});

test('no answer: waits out the ring, then ends', () => {
  const ringing = { remotes: 0, aloneSince: T, peerSince: null, status: { peer: 'bob', peerSeenMsAgo: null, endedBy: '' } };
  expect(decide(base({ ...ringing, now: T + NO_ANSWER_MS - 1, statusAt: T + NO_ANSWER_MS - 1 }))).toEqual({ action: 'none' });
  expect(decide(base({ ...ringing, now: T + NO_ANSWER_MS + 1, statusAt: T + NO_ANSWER_MS + 1 }))).toEqual({ action: 'end', reason: "bob didn't answer" });
});

test('the other side gone from the room and from the server ends it', () => {
  const now = T + 60_000;
  const v = decide(base({ now, statusAt: now, remotes: 0, aloneSince: now - 5000, status: { peer: 'bob', peerSeenMsAgo: PEER_LOST_MS + 1, endedBy: '' } }));
  expect(v).toEqual({ action: 'end', reason: 'Lost the connection to bob' });
});

test("the other side's heartbeats stopping doesn't end a call Jitsi still carries", () => {
  expect(decide(base({ status: { peer: 'bob', peerSeenMsAgo: 10 * PEER_LOST_MS, endedBy: '' } }))).toEqual({ action: 'none' });
});

test("Quple's server unreachable doesn't end a working call", () => {
  expect(decide(base({ now: T + 600_000, statusAt: T }))).toEqual({ action: 'none' });
});

test('never joining the room rejoins, then gives up', () => {
  const now = T + JOIN_TIMEOUT_MS + 1;
  expect(decide(base({ now, statusAt: now, joined: false, remotes: 0 }))).toEqual({ action: 'rejoin', why: 'not joined' });
  expect(decide(base({ now, statusAt: now, joined: false, remotes: 0, rejoins: MAX_REJOINS }))).toEqual({ action: 'end', reason: "Couldn't connect the call" });
});

test('a callee still loading Jitsi is not a reason to rejoin', () => {
  // Alice has been alone for a minute of ringing; Bob just answered.
  const now = T + 50_000;
  const v = decide(base({ now, statusAt: now, remotes: 0, aloneSince: T, peerSince: now - 5000 }));
  expect(v).toEqual({ action: 'none' });
});

test('the other side in the call but not in our room: rejoin', () => {
  const now = T + 100_000;
  const v = decide(base({ now, statusAt: now, remotes: 0, aloneSince: now - ALONE_REJOIN_MS - 1, peerSince: T }));
  expect(v).toEqual({ action: 'rejoin', why: 'peer in the call but not in the room' });
});

test('alone for long enough ends it, whatever the server says', () => {
  const now = T + 300_000;
  const v = decide(base({ now, statusAt: T, remotes: 0, aloneSince: now - ALONE_END_MS - 1 }));
  expect(v).toEqual({ action: 'end', reason: 'Lost the connection to bob' });
});
