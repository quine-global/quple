// Calls on iOS's own call screen (CallKit, via react-native-callkeep): one
// CallKit call per conversation, owned by Quple from the first ring (or the
// call button) to hanging up. The meeting itself runs in the Jitsi SDK with
// its own CallKit integration off: with it on, answering ended our ringing
// call and Jitsi reported a second one, so every call showed up twice.
//
// Without VoIP push (a free Apple account can't have it, so Quple is
// installed with AltStore), calls only arrive while the app is open: the
// signaling server is polled in the foreground (App.tsx).

import 'react-native-get-random-values';
import RNCallKeep, { CONSTANTS } from 'react-native-callkeep';

const RING_MS = 45_000;

type Ringing = {
  onAnswer: (callUUID: string) => void;
  onDecline: () => void;
  timer: ReturnType<typeof setTimeout>;
};
/** Incoming calls ringing now. */
const ringing = new Map<string, Ringing>();
/** Calls in progress (answered or placed), and what to do if iOS ends one. */
const active = new Map<string, { onHangUp: () => void }>();

export function uuid(): string {
  const b = new Uint8Array(16);
  (globalThis as any).crypto.getRandomValues(b); // react-native-get-random-values
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

let ready: Promise<boolean> | null = null;

export function setupCallKit(): Promise<boolean> {
  if (ready) return ready;
  ready = RNCallKeep.setup({
    ios: {
      appName: 'Quple',
      supportsVideo: true,
      maximumCallGroups: '1',
      maximumCallsPerCallGroup: '1',
      includesCallsInRecents: true,
    },
    android: {
      alertTitle: 'Permissions required',
      alertDescription: 'Quple needs to access your phone accounts',
      cancelButton: 'Cancel',
      okButton: 'OK',
      additionalPermissions: [],
    },
  });
  // Answered (in the app or on the lock screen): the ringing call becomes
  // the call in progress.
  RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
    const id = callUUID.toUpperCase();
    const r = takeRinging(id);
    if (!r) return;
    active.set(id, { onHangUp: () => {} });
    r.onAnswer(id);
  });
  // Ended from iOS's call screen: a ringing call is declined, a call in
  // progress is hung up (the meeting closes). Calls Quple ends itself
  // (finish) are already gone from `active` when this arrives.
  RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
    const id = callUUID.toUpperCase();
    const r = takeRinging(id);
    if (r) {
      r.onDecline();
      return;
    }
    const a = active.get(id);
    if (a) {
      active.delete(id);
      a.onHangUp();
    }
  });
  return ready;
}

function takeRinging(id: string): Ringing | undefined {
  const r = ringing.get(id);
  if (r) {
    clearTimeout(r.timer);
    ringing.delete(id);
  }
  return r;
}

/** Rings for a call from `from`; calls back once: answered (with the call's id), or declined/unanswered. */
export function ring(from: string, onAnswer: (callUUID: string) => void, onDecline: () => void): string {
  const id = uuid();
  const timer = setTimeout(() => {
    if (takeRinging(id)) {
      RNCallKeep.reportEndCallWithUUID(id, CONSTANTS.END_CALL_REASONS.UNANSWERED);
      onDecline();
    }
  }, RING_MS);
  ringing.set(id, { onAnswer, onDecline, timer });
  RNCallKeep.displayIncomingCall(id, from, from, 'generic', true);
  return id;
}

/** Reports a call Quple is placing to `to`; returns its id. */
export function startOutgoing(to: string): string {
  const id = uuid();
  active.set(id, { onHangUp: () => {} });
  RNCallKeep.startCall(id, to, to, 'generic', true);
  return id;
}

/** The meeting of an outgoing call has started. */
export function connected(id: string) {
  RNCallKeep.reportConnectedOutgoingCallWithUUID(id);
}

/** What to do when iOS ends the call (its red button, the lock screen). */
export function onHangUp(id: string, fn: () => void) {
  const a = active.get(id);
  if (a) a.onHangUp = fn;
}

/** Quple ended the call (the meeting closed): tell iOS. */
export function finish(id: string) {
  if (!active.delete(id)) return;
  RNCallKeep.endCall(id);
}
