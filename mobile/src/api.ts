// The signaling server's API (../server, README "Server API"), with the
// Quine access token on every request.

import { accessToken } from './auth';
import { DEVICE_NAME, deviceId } from './device';

export type Me = {
  username: string;
  defaultJitsiUrl: string;
  /** Where to subscribe (the ntfy app) for calls while Quple is closed; absent if the server has none. */
  ntfyServer?: string;
  ntfyTopic?: string;
};
export type Contact = { username: string; online: boolean };
export type Invite = { from: string; meetingId: string; jitsiUrl: string; createdAt: string };
/** `notified`: the callee's app was closed, so they got a notification instead. */
export type Call = { meetingId: string; jitsiUrl: string; notified?: boolean };
/** A call as one side sees it (the server's /calls/{id}/heartbeat). */
export type CallStatus = {
  peer: string;
  /** Since the other side's last heartbeat; null if it never sent one (not answered). */
  peerSeenMsAgo: number | null;
  /** Who hung up or declined; "" while the call is on. */
  endedBy: string;
  /**
   * Set when the call has moved to another of your devices (its name): mute
   * now, and leave the room (without hanging up) once `movedJoined`.
   */
  movedTo?: string;
  movedJoined?: boolean;
};
/** A call of yours on another of your devices, which this one can take over. */
export type ActiveCall = { meetingId: string; peer: string; jitsiUrl: string; device: string };

export class Api {
  constructor(private serverUrl: string) {}

  private async request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await accessToken(retried);
    const res = await fetch(this.serverUrl + path, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
    });
    // A token refused once may just be stale: refresh and try once more.
    if (res.status === 401 && !retried) return this.request<T>(path, init, true);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body as T;
  }

  me() {
    return this.request<Me>('/me');
  }
  /** Calls for you, and your calls on your other devices. */
  async poll() {
    const device = await deviceId();
    const r = await this.request<{ invites?: Invite[]; calls?: ActiveCall[] }>(`/poll?device=${encodeURIComponent(device)}`);
    return { invites: r.invites ?? [], calls: r.calls ?? [] };
  }
  call(to: string, jitsiUrl?: string) {
    return this.request<Call>('/call', { method: 'POST', body: JSON.stringify({ to, jitsiUrl }) });
  }
  /** The call, without counting as a heartbeat (answering): for a phone that's ringing. */
  callStatus(meetingId: string) {
    return this.request<CallStatus>(`/calls/${encodeURIComponent(meetingId)}`);
  }
  /** From a call screen: this device is in the call (`joined`: in the Jitsi room). */
  async heartbeat(meetingId: string, joined = false) {
    const body = JSON.stringify({ device: await deviceId(), name: DEVICE_NAME, joined });
    return this.request<CallStatus>(`/calls/${encodeURIComponent(meetingId)}/heartbeat`, { method: 'POST', body });
  }
  /** Moves your side of a call to this device; the other one leaves once this one's joined. */
  async move(meetingId: string) {
    const body = JSON.stringify({ device: await deviceId(), name: DEVICE_NAME });
    return this.request<ActiveCall>(`/calls/${encodeURIComponent(meetingId)}/move`, { method: 'POST', body });
  }
  hangUp(meetingId: string) {
    return this.request<{ ok: boolean }>(`/calls/${encodeURIComponent(meetingId)}/hangup`, { method: 'POST' });
  }
  contacts() {
    return this.request<{ contacts: Contact[] }>('/contacts').then(r => r.contacts ?? []);
  }
  addContact(username: string) {
    return this.request<Contact>('/contacts', { method: 'POST', body: JSON.stringify({ username }) });
  }
  removeContact(username: string) {
    return this.request<{ ok: boolean }>(`/contacts/${encodeURIComponent(username)}`, { method: 'DELETE' });
  }
}
