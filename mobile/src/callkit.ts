// Incoming calls on iOS's own call screen (CallKit, via react-native-callkeep).
//
// CallKit here only rings: answering ends this ringing call and the meeting
// starts in the Jitsi SDK, whose own CallKit integration then carries it
// (audio session, the green status bar, Recents). That keeps WebRTC's audio
// in the hands of the code written for it.
//
// Without VoIP push (a free Apple account can't have it, so Quple is
// installed with AltStore), calls only arrive while the app is open: the
// signaling server is polled in the foreground (App.tsx).

import 'react-native-get-random-values';
import RNCallKeep, { CONSTANTS } from 'react-native-callkeep';

const RING_MS = 45_000;

type Ringing = { onAnswer: () => void; onDecline: () => void; timer: ReturnType<typeof setTimeout> };
const ringing = new Map<string, Ringing>();

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
      includesCallsInRecents: false, // the Jitsi call that follows is the one to remember
    },
    android: {
      alertTitle: 'Permissions required',
      alertDescription: 'Quple needs to access your phone accounts',
      cancelButton: 'Cancel',
      okButton: 'OK',
      additionalPermissions: [],
    },
  });
  RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
    const r = take(callUUID);
    if (!r) return;
    RNCallKeep.endCall(callUUID);
    r.onAnswer();
  });
  RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
    take(callUUID)?.onDecline();
  });
  return ready;
}

function take(id: string): Ringing | undefined {
  const r = ringing.get(id.toUpperCase());
  if (r) {
    clearTimeout(r.timer);
    ringing.delete(id.toUpperCase());
  }
  return r;
}

/** Rings for a call from `from`; calls back once with the person's answer, or a decline when it times out. */
export function ring(from: string, onAnswer: () => void, onDecline: () => void): string {
  const id = uuid();
  const timer = setTimeout(() => {
    if (take(id)) {
      RNCallKeep.reportEndCallWithUUID(id, CONSTANTS.END_CALL_REASONS.UNANSWERED);
      onDecline();
    }
  }, RING_MS);
  ringing.set(id, { onAnswer, onDecline, timer });
  RNCallKeep.displayIncomingCall(id, from, from, 'generic', true);
  return id;
}
