// The signaling server's API (../server, README "Server API"), with the
// Quine access token on every request.

import { accessToken } from './auth';

export type Me = { username: string; defaultJitsiUrl: string };
export type Contact = { username: string; online: boolean };
export type Invite = { from: string; meetingId: string; jitsiUrl: string; createdAt: string };
export type Call = { meetingId: string; jitsiUrl: string };
/** A call as one side sees it (the server's /calls/{id}/heartbeat). */
export type CallStatus = {
  peer: string;
  /** Since the other side's last heartbeat; null if it never sent one (not answered). */
  peerSeenMsAgo: number | null;
  /** Who hung up or declined; "" while the call is on. */
  endedBy: string;
};

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
  poll() {
    return this.request<{ invites: Invite[] }>('/poll').then(r => r.invites ?? []);
  }
  call(to: string, jitsiUrl?: string) {
    return this.request<Call>('/call', { method: 'POST', body: JSON.stringify({ to, jitsiUrl }) });
  }
  heartbeat(meetingId: string) {
    return this.request<CallStatus>(`/calls/${encodeURIComponent(meetingId)}/heartbeat`, { method: 'POST' });
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
