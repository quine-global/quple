// The desktop app's copy of the iPhone app's call watchdog
// (mobile/src/watchdog.ts, which documents it): keep the two in step.
// Plain JS, since the desktop app has no build step; tested by
// desktop/test/watchdog.test.mjs (`node --test desktop/test/*.test.mjs`).
//
// Decides when a call should end or rejoin, whatever Jitsi server carries
// it. Two sources, polled from the call screen every few seconds:
// - Quple's server (/calls/{id}/heartbeat): did the other side hang up or
//   decline, and is their call screen still sending heartbeats?
// - The Jitsi SDK's events: have we joined, and who else is in the room?
//
// The Jitsi SDK reconnects by itself after a failed connection (its
// "rejoining in N seconds" overlay), and never reports leaving the
// conference to the app. What it doesn't do: end a call whose other side
// hung up, vanished or never answered, or get out of a room the other side
// isn't in. A Quple server outage alone never ends a call that Jitsi is
// still carrying.

/** The caller gives up when the callee hasn't answered (CallKit rings for 45 s). */
export const NO_ANSWER_MS = 60_000;
/**
 * The same when the callee's app was closed and they got a notification
 * instead: time to see it, open Quple, and answer (its invite is kept 2 min).
 */
export const NOTIFIED_NO_ANSWER_MS = 100_000;
/** The other side's heartbeats stopped this long ago, and they're not in the room: they're gone. */
export const PEER_LOST_MS = 45_000;
/** Not in the Jitsi room this long after (re)joining: start the SDK over. */
export const JOIN_TIMEOUT_MS = 45_000;
/**
 * Alone in the room this long while the other side's call screen has been
 * up just as long (their heartbeats): one of us is stuck, rejoin. Counted
 * from whichever came later, so a callee still loading Jitsi isn't it.
 */
export const ALONE_REJOIN_MS = 30_000;
/** Alone in the room this long, whatever else: end. */
export const ALONE_END_MS = 120_000;
/** Times the SDK is started over before the call is given up. */
export const MAX_REJOINS = 3;

/**
 * Whether the other side hung up: the server's peerEnded (in a call to
 * yourself, endedBy is you either way), or, from a server without it,
 * endedBy not being me.
 */
export function peerEnded(st, me) {
  return st.peerEnded ?? (!!st.endedBy && st.endedBy !== me);
}

export function decide(s) {
  const st = s.status;
  // Fresh enough to act on: an answer from the last two polls or so.
  const fresh = st !== null && s.statusAt !== null && s.now - s.statusAt < 10_000;

  // Hung up or declined, from either app: always final.
  if (st && peerEnded(st, s.me)) {
    return { action: 'end', reason: st.peerSeenMsAgo === null ? `${st.peer} didn't answer` : `${st.peer} hung up` };
  }

  // Nobody's here. Is the other side coming?
  if (s.remotes === 0 && fresh && st) {
    if (st.peerSeenMsAgo === null && s.now - s.startedAt > NO_ANSWER_MS) {
      return { action: 'end', reason: `${st.peer} didn't answer` };
    }
    if (st.peerSeenMsAgo !== null && st.peerSeenMsAgo > PEER_LOST_MS) {
      return { action: 'end', reason: `Lost the connection to ${st.peer}` };
    }
  }

  // Never got into the room: start the SDK over, a few times.
  if (!s.joined && s.now - s.attemptStartedAt > JOIN_TIMEOUT_MS) {
    return s.rejoins < MAX_REJOINS
      ? { action: 'rejoin', why: 'not joined' }
      : { action: 'end', reason: "Couldn't connect the call" };
  }

  if (s.joined && s.remotes === 0 && s.aloneSince !== null) {
    const alone = s.now - s.aloneSince;
    if (alone > ALONE_END_MS) {
      return { action: 'end', reason: st ? `Lost the connection to ${st.peer}` : 'Lost the connection' };
    }
    // They're in the call by Quple's server, but not in our room: one of us
    // is stuck in a stale conference. Rejoining is cheap.
    const peerHere = fresh && st && st.peerSeenMsAgo !== null && st.peerSeenMsAgo < 10_000 && s.peerSince !== null;
    if (peerHere && s.now - Math.max(s.aloneSince, s.peerSince) > ALONE_REJOIN_MS && s.rejoins < MAX_REJOINS) {
      return { action: 'rejoin', why: 'peer in the call but not in the room' };
    }
  }

  return { action: 'none' };
}
