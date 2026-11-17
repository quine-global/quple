import { h, render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { decide, NO_ANSWER_MS } from "./watchdog.js";

const html = htm.bind(h);
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const DEFAULTS = {
  serverUrl: "https://meet.quineglobal.com",
  identityUrl: "https://login.quineglobal.com/realms/public",
  // Blank: the signaling server's default Jitsi (/me's defaultJitsiUrl).
  jitsiBase: "",
};
const PUBLIC_JITSI = "https://meet.jit.si";

const POLL_INTERVAL_MS = 3000;
const CONTACTS_REFRESH_MS = 4000;
/** An incoming call rings this long, as on the iPhone (CallKit). */
const INCOMING_RING_MS = 45_000;

// ---- Backend helpers ---------------------------------------------------------

async function loadConfig() {
  const saved = await invoke("load_config");
  return {
    serverUrl: saved.server_url || DEFAULTS.serverUrl,
    identityUrl: saved.identity_url || DEFAULTS.identityUrl,
    jitsiBase: (saved.jitsi_base || DEFAULTS.jitsiBase).trim(),
  };
}

async function saveConfig(config) {
  await invoke("save_config", {
    config: { server_url: config.serverUrl, identity_url: config.identityUrl, jitsi_base: config.jitsiBase },
  });
}

const sameUrl = (a, b) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * A fetch wrapper for the signaling server that sends the Quine access token,
 * retrying once with a fresh token if it's rejected.
 */
function makeApi(serverUrl, accessToken) {
  return async (path, options = {}) => {
    const send = async (token) =>
      fetch(serverUrl.replace(/\/+$/, "") + path, {
        ...options,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
    let res = await send(await accessToken());
    if (res.status === 401) {
      // The token may have been revoked or the key rotated; retry once fresh.
      res = await send(await accessToken(true));
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || res.statusText || `request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  };
}

/** The host of a Jitsi server URL, for display; "" if it isn't one. */
function jitsiHost(url) {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch (_) {
    return "";
  }
}

/**
 * Meetings on the public meet.jit.si only start once a signed-in user joins,
 * so it's worth signing in to it once before calling there.
 */
const isPublicJitsi = (url) => jitsiHost(url) === "meet.jit.si";

function openMeeting(me, jitsiUrl, meetingId, peer) {
  return invoke("open_meeting", { jitsiBase: jitsiUrl, room: meetingId, displayName: me.username, peer });
}

const callPath = (meetingId) => `/calls/${encodeURIComponent(meetingId)}`;

/**
 * Which device this is, to Quple's server: a random ID kept for good, so a
 * call can be moved between your devices (README "Moving a call").
 */
function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem("quple.device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("quple.device", id);
    }
  } catch (_) {}
  return id || "desktop";
}
const DEVICE = deviceId();
/** What your other devices call this one: "In a call with bob on your Mac". */
const DEVICE_NAME = /Mac/.test(navigator.userAgent) ? "Mac" : "computer";

/** The watchdog's state for a call that's just been (re)joined (watchdog.js). */
function newWatch() {
  const now = Date.now();
  return {
    startedAt: now,
    attemptStartedAt: now,
    rejoins: 0,
    joined: false,
    remotes: 0,
    aloneSince: null,
    peerSince: null,
    status: null,
    statusAt: null,
  };
}

// ---- App: gates everything behind Quine ------------------------------------

function App() {
  const [config, setConfig] = useState(null);
  /** @type {[{username: string, accessToken: string, expiresAt: number} | null, Function]} */
  const [session, setSession] = useState(null);
  /** Who the signaling server says we are: {username, defaultJitsiUrl}. */
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState("");
  const [jitsiSignedIn, setJitsiSignedIn] = useState(false);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    (async () => {
      const cfg = await loadConfig();
      setConfig(cfg);
      setJitsiSignedIn(await invoke("jitsi_signed_in"));
      try {
        setSession(await invoke("quine_restore", { issuer: cfg.identityUrl }));
      } catch (err) {
        setBootError(String(err));
      }
      setBooting(false);
    })();
    const unlisten = listen("jitsi-auth-changed", (e) => setJitsiSignedIn(e.payload === true));
    return () => unlisten.then((f) => f());
  }, []);

  /**
   * Returns a current access token, refreshing as needed. If the Quine
   * sign-in has lapsed (expired, revoked, account removed), drops back to the
   * sign-in screen and throws.
   */
  const accessToken = useCallback(async (force = false) => {
    try {
      const fresh = await invoke("quine_access_token", { force });
      setSession(fresh);
      return fresh.accessToken;
    } catch (err) {
      if (String(err) === "signed_out") setSession(null);
      throw new Error(String(err));
    }
  }, []);

  const signedIn = session !== null;
  const api = config ? makeApi(config.serverUrl, accessToken) : null;

  // Once signed in, check the signaling server accepts us.
  const loadMe = useCallback(async () => {
    setMeError("");
    try {
      setMe(await api("/me"));
    } catch (err) {
      if (signedIn) setMeError(err.message);
    }
  }, [config, signedIn]);
  useEffect(() => {
    setMe(null);
    if (signedIn && config) loadMe();
  }, [signedIn, config && config.serverUrl]);

  /** Signs out of everything: Quine, and meet.jit.si with it. */
  const signOut = useCallback(async () => {
    setSession(null);
    setMe(null);
    setShowSettings(false);
    await invoke("jitsi_sign_out").catch(() => {});
    await invoke("quine_sign_out");
  }, []);

  const updateConfig = useCallback(
    async (next) => {
      const identityChanged = !sameUrl(next.identityUrl, config.identityUrl);
      await saveConfig(next);
      setConfig(next);
      // A different identity server means a different account.
      if (identityChanged && session) await signOut();
    },
    [config, session, signOut],
  );

  if (booting || !config) {
    return html`<${Message} text="Signing you in…" />`;
  }
  if (!session) {
    return html`<${SignIn} config=${config} initialError=${bootError} onConfig=${updateConfig} onSignedIn=${setSession} />`;
  }
  if (meError) {
    return html`<${Message} text=${`Can't use ${config.serverUrl}: ${meError}`}>
      <button type="button" onClick=${loadMe}>Try again</button>
      <button type="button" class="secondary" onClick=${signOut}>Sign out</button>
    <//>`;
  }
  if (!me) {
    return html`<${Message} text="Connecting…" />`;
  }
  if (showSettings) {
    return html`<${Settings}
      config=${config}
      me=${me}
      canSignOutOfJitsi=${jitsiSignedIn}
      onSave=${async (next) => {
        await updateConfig(next);
        setShowSettings(false);
      }}
      onCancel=${() => setShowSettings(false)}
      onSignOut=${signOut}
    />`;
  }
  return html`<${Dashboard}
    me=${me}
    api=${api}
    jitsiBase=${config.jitsiBase}
    jitsiSignedIn=${jitsiSignedIn}
    onJitsiBase=${(jitsiBase) => updateConfig({ ...config, jitsiBase })}
    onSettings=${() => setShowSettings(true)}
  />`;
}

function Message({ text, children }) {
  return html`
    <section class="screen">
      <p class="muted center">${text}</p>
      ${children}
    </section>
  `;
}

// ---- Step 1: Quine sign-in ---------------------------------------------------

function SignIn({ config, initialError, onConfig, onSignedIn }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState(initialError);

  const signIn = async () => {
    setError("");
    setWaiting(true);
    try {
      onSignedIn(await invoke("quine_sign_in", { issuer: config.identityUrl }));
    } catch (err) {
      if (String(err) !== "cancelled") setError(String(err));
    }
    setWaiting(false);
  };

  return html`
    <section class="screen">
      <div class="card">
        <h1>Welcome to Quple</h1>
        <p class="muted">
          Sign in with your Quine account. Your Quine username is what people call you by.
        </p>
        ${error && html`<p class="error">${error}</p>`}
        ${waiting
          ? html`
              <p class="muted">Finish signing in in your browser, then come back here.</p>
              <button type="button" class="secondary" onClick=${() => invoke("quine_cancel_sign_in")}>Cancel</button>
            `
          : html`<button type="button" onClick=${signIn}>Sign in with Quine</button>`}
        <details>
          <summary>Advanced settings</summary>
          <${ServerFields} config=${config} submitLabel="Save" onSubmit=${onConfig} />
        </details>
      </div>
    </section>
  `;
}

/** The identity and signaling server URLs, as a form. */
function ServerFields({ config, submitLabel, onSubmit, onCancel }) {
  const [fields, setFields] = useState(config);
  useEffect(() => setFields(config), [config]);
  const bind = (key) => ({
    value: fields[key],
    onInput: (e) => setFields({ ...fields, [key]: e.currentTarget.value }),
    autocomplete: "off",
    spellcheck: false,
  });

  const submit = (e) => {
    e.preventDefault();
    const clean = (key) => fields[key].trim() || DEFAULTS[key];
    onSubmit({ ...config, identityUrl: clean("identityUrl"), serverUrl: clean("serverUrl") });
  };

  return html`
    <form onSubmit=${submit}>
      <label for="identity-url">Quine sign-in server (OIDC issuer) URL</label>
      <input id="identity-url" ...${bind("identityUrl")} />
      <label for="server-url">Signaling server URL</label>
      <input id="server-url" ...${bind("serverUrl")} />
      <div class="button-row">
        ${onCancel && html`<button type="button" class="secondary" onClick=${onCancel}>Cancel</button>`}
        <button type="submit" class=${onCancel ? "" : "secondary"}>${submitLabel}</button>
      </div>
    </form>
  `;
}

// ---- Dashboard ---------------------------------------------------------------

/** Like setInterval, but runs immediately and always calls the latest fn. */
function useInterval(fn, ms) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    latest.current();
    const id = setInterval(() => latest.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function Dashboard({ me, api, jitsiBase, jitsiSignedIn, onJitsiBase, onSettings }) {
  const [contacts, setContacts] = useState(null);
  const [status, setStatus] = useState({ text: "", state: "" });
  const [invites, setInvites] = useState([]);
  const invitesRef = useRef(invites);
  invitesRef.current = invites;
  // Why the last call ended, when it wasn't you.
  const [notice, setNotice] = useState("");
  // Your calls on your other devices (the iPhone), to move here.
  const [elsewhere, setElsewhere] = useState([]);
  const [target, setTarget] = useState("");
  // The Jitsi server the next call happens on; whoever answers joins it there.
  const [server, setServer] = useState(jitsiBase);

  const refreshContacts = async () => {
    try {
      const { contacts } = await api("/contacts");
      setContacts(contacts || []);
      setStatus({ text: `Connected as ${me.username}`, state: "online" });
    } catch (err) {
      setStatus({ text: `Can't reach signaling server: ${err.message}`, state: "offline" });
    }
  };
  useInterval(refreshContacts, CONTACTS_REFRESH_MS);

  // Polling also tells the server we're online.
  useInterval(async () => {
    try {
      const { invites, calls } = await api(`/poll?device=${encodeURIComponent(DEVICE)}`);
      setElsewhere(calls || []);
      if (invites && invites.length > 0) {
        const now = Date.now();
        setInvites((queue) => [...queue, ...invites.map((inv) => ({ ...inv, receivedAt: now }))]);
      }
    } catch (_) {
      // Failures are already surfaced by the contacts refresh above.
    }
  }, POLL_INTERVAL_MS);

  // ---- The call: ringing out, then in its meeting window ----
  //
  // As on the iPhone (README "Ringing", "Ending"): an outgoing call rings
  // here until the other side's call screen sends its first heartbeat, and
  // only then opens the Jitsi window. During the call, a heartbeat every
  // few seconds and the room's state (reported by the meeting window,
  // lib.rs) go to the watchdog, which ends or rejoins the call.

  /** {meetingId, peer, jitsiUrl, outgoing, phase: "ringing" | "in-call", startedAt}, or null. */
  const [active, setActive] = useState(null);
  const activeRef = useRef(null);
  const watch = useRef(null);
  const ticking = useRef(false);

  const setCall = (c) => {
    activeRef.current = c;
    setActive(c);
  };

  /** From the call: this device is in it (`joined`: in the Jitsi room). */
  const heartbeat = (meetingId) =>
    api(`${callPath(meetingId)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ device: DEVICE, name: DEVICE_NAME, joined: !!(watch.current && watch.current.joined) }),
    });

  /**
   * Ends the call: tells the server (the other app ends it too) and closes
   * its window. `hangUp: false` when it goes on elsewhere (moved).
   */
  const endCall = (why = "", { closeWindow = true, hangUp = true } = {}) => {
    const c = activeRef.current;
    if (!c) return;
    setCall(null);
    watch.current = null;
    if (hangUp) api(`${callPath(c.meetingId)}/hangup`, { method: "POST" }).catch(() => {});
    if (closeWindow) invoke("close_meeting", { room: c.meetingId }).catch(() => {});
    setNotice(why);
  };
  const endCallRef = useRef(endCall);
  endCallRef.current = endCall;

  /** Answered: open the meeting window, and start watching. */
  const startInCall = async (c) => {
    const next = { ...c, phase: "in-call" };
    setCall(next);
    watch.current = newWatch();
    // A heartbeat now: for the callee, it's what tells the caller's app the
    // call was answered.
    heartbeat(c.meetingId).catch(() => {});
    try {
      await openMeeting(me, c.jitsiUrl, c.meetingId, c.peer);
    } catch (err) {
      endCall(`Couldn't open the call: ${err}`, { closeWindow: false });
    }
  };

  useInterval(async () => {
    const c = activeRef.current;
    if (!c || ticking.current) return;
    ticking.current = true;
    try {
      let st = null;
      try {
        st = await heartbeat(c.meetingId);
      } catch (err) {
        // The server down, or restarted and forgot the call: go on what the
        // room says.
        console.log(`quple: heartbeat failed: ${err.message}`);
      }
      if (activeRef.current !== c) return; // ended meanwhile
      if (c.phase === "ringing") {
        if (st && st.endedBy && st.endedBy !== me.username) {
          endCall(`${c.peer} didn't answer`, { closeWindow: false });
        } else if (st && st.peerSeenMsAgo !== null) {
          await startInCall(c);
        } else if (Date.now() - c.startedAt > NO_ANSWER_MS) {
          endCall(`${c.peer} didn't answer`, { closeWindow: false });
        }
        return;
      }
      const w = watch.current;
      // Taken over by another of your devices: mute at once (they may be
      // side by side), and leave once it's in the room. Not hanging up: the
      // call goes on there.
      if (st && st.movedTo) {
        if (!w.mutedForMove) {
          w.mutedForMove = true;
          invoke("set_meeting_muted", { room: c.meetingId, muted: true }).catch(() => {});
        }
        if (st.movedJoined) endCall(`Moved to your ${st.movedTo}`, { hangUp: false });
        return;
      }
      if (st) {
        w.status = st;
        w.statusAt = Date.now();
        if (st.peerSeenMsAgo !== null && w.peerSince === null) w.peerSince = Date.now();
      }
      const v = decide({ ...w, now: Date.now(), me: me.username });
      if (v.action === "end") {
        console.log(`quple: ending the call: ${v.reason}`);
        endCall(v.reason);
      } else if (v.action === "rejoin") {
        console.log(`quple: rejoining (${v.why})`);
        Object.assign(w, { rejoins: w.rejoins + 1, joined: false, remotes: 0, aloneSince: null, attemptStartedAt: Date.now() });
        invoke("rejoin_meeting", { room: c.meetingId }).catch(() => {});
      }
    } finally {
      ticking.current = false;
    }
  }, POLL_INTERVAL_MS);

  // The meeting window: who's in the room, and whether it closed.
  useEffect(() => {
    const unState = listen("meeting-state", (e) => {
      const c = activeRef.current;
      const w = watch.current;
      if (!c || !w || e.payload.room !== c.meetingId) return;
      const { joined, remotes } = e.payload;
      w.joined = joined;
      w.remotes = remotes;
      if (!joined || remotes > 0) w.aloneSince = null;
      else if (w.aloneSince === null) w.aloneSince = Date.now();
    });
    // Its close button, or Jitsi's hang-up: you hung up.
    const unClosed = listen("meeting-closed", (e) => {
      const c = activeRef.current;
      if (c && c.phase === "in-call" && e.payload.room === c.meetingId) endCallRef.current("", { closeWindow: false });
    });
    return () => {
      unState.then((f) => f());
      unClosed.then((f) => f());
    };
  }, []);

  // An incoming call stops ringing when the caller gives up (GET, which
  // isn't answering), or after INCOMING_RING_MS.
  const dropInvite = (inv, why) => {
    setInvites((queue) => queue.filter((x) => x !== inv));
    api(`${callPath(inv.meetingId)}/hangup`, { method: "POST" }).catch(() => {});
    if (why) setNotice(why);
  };
  useInterval(async () => {
    const inv = invitesRef.current[0];
    if (!inv) return;
    let gone = Date.now() - inv.receivedAt > INCOMING_RING_MS;
    if (!gone) {
      try {
        gone = !!(await api(callPath(inv.meetingId))).endedBy;
      } catch (_) {}
    }
    if (gone && invitesRef.current[0] === inv) dropInvite(inv, `Missed a call from ${inv.from}`);
  }, POLL_INTERVAL_MS);

  // Takes a call over from another device: this one joins the room, and
  // the other leaves once it has.
  const moveHere = async (ac) => {
    if (activeRef.current) {
      setNotice("Hang up the call you're in first.");
      return;
    }
    try {
      const moved = await api(`${callPath(ac.meetingId)}/move`, {
        method: "POST",
        body: JSON.stringify({ device: DEVICE, name: DEVICE_NAME }),
      });
      setElsewhere([]);
      setNotice("");
      await startInCall({ meetingId: moved.meetingId, peer: moved.peer, jitsiUrl: moved.jitsiUrl, outgoing: true });
    } catch (err) {
      setNotice(`Couldn't move the call here: ${err.message}`);
    }
  };

  const call = async (who) => {
    who = who.trim().toLowerCase();
    if (!who) return;
    if (activeRef.current) {
      setNotice("Hang up the call you're in first.");
      return;
    }
    setNotice("");
    try {
      const { meetingId, jitsiUrl } = await api("/call", {
        method: "POST",
        body: JSON.stringify({ to: who, jitsiUrl: server.trim() || me.defaultJitsiUrl }),
      });
      setCall({ meetingId, peer: who, jitsiUrl, outgoing: true, phase: "ringing", startedAt: Date.now() });
      // Remember the server as typed for next time; blank stays blank (the
      // server's default), as on the iPhone.
      const typed = server.trim();
      if (typed !== jitsiBase) onJitsiBase(typed);
    } catch (err) {
      setStatus({ text: `Couldn't call ${who}: ${err.message}`, state: "offline" });
    }
  };

  const addContact = async (username) => {
    try {
      await api("/contacts", { method: "POST", body: JSON.stringify({ username: username.trim() }) });
      setTarget("");
      await refreshContacts();
    } catch (err) {
      setStatus({ text: `Couldn't add ${username.trim()}: ${err.message}`, state: "offline" });
    }
  };

  const removeContact = async (username) => {
    try {
      await api(`/contacts/${encodeURIComponent(username)}`, { method: "DELETE" });
      await refreshContacts();
    } catch (err) {
      setStatus({ text: `Couldn't remove ${username}: ${err.message}`, state: "offline" });
    }
  };

  const [incoming, ...rest] = invites;
  const isContact = (name) => (contacts || []).some((c) => c.username === name);

  return html`
    <section class="screen">
      <header>
        <div>
          <div class="me-label">You</div>
          <div class="me-username">${me.username}</div>
        </div>
        <button class="icon-btn" title="Settings" type="button" onClick=${onSettings}>⚙</button>
      </header>

      <div class="card">
        <label for="call-target">Call or add someone</label>
        <form
          id="call-form"
          onSubmit=${(e) => {
            e.preventDefault();
            call(target);
            setTarget("");
          }}
        >
          <input
            id="call-target"
            autocomplete="off"
            spellcheck=${false}
            placeholder="Quine username"
            required
            value=${target}
            onInput=${(e) => setTarget(e.currentTarget.value)}
          />
          <button type="submit">Call</button>
        </form>
        <button
          type="button"
          class="secondary"
          disabled=${!target.trim()}
          onClick=${() => addContact(target)}
        >
          Add to contacts
        </button>
        <label for="call-server">On server</label>
        <input
          id="call-server"
          list="known-servers"
          autocomplete="off"
          spellcheck=${false}
          placeholder=${me.defaultJitsiUrl}
          value=${server}
          onInput=${(e) => setServer(e.currentTarget.value)}
        />
        <datalist id="known-servers">
          ${[...new Set([me.defaultJitsiUrl, PUBLIC_JITSI, jitsiBase].filter(Boolean))].map((u) => html`<option value=${u} />`)}
        </datalist>
        ${isPublicJitsi(server || me.defaultJitsiUrl) &&
        !jitsiSignedIn &&
        html`<p class="muted">
          meet.jit.si only starts a meeting once someone signed in joins it.${" "}
          <button type="button" class="link-btn" onClick=${() =>
              invoke("jitsi_sign_in").catch((err) => setStatus({ text: String(err), state: "offline" }))}
          >
            Sign in to meet.jit.si
          </button>
        </p>`}
      </div>

      ${notice && html`<p class="notice">${notice}</p>`}

      ${!active &&
      elsewhere.map(
        (ac) => html`<div class="card in-call" key=${ac.meetingId}>
          <span>In a call with <strong>${ac.peer}</strong>${ac.device ? ` on your ${ac.device}` : ""}</span>
          <button type="button" onClick=${() => moveHere(ac)}>Move to this ${DEVICE_NAME}</button>
        </div>`,
      )}

      ${active &&
      active.phase === "in-call" &&
      html`<div class="card in-call">
        <span>In a call with <strong>${active.peer}</strong></span>
        <div class="button-row">
          <button type="button" class="secondary" onClick=${() => openMeeting(me, active.jitsiUrl, active.meetingId, active.peer)}>
            Show
          </button>
          <button type="button" onClick=${() => endCall()}>Hang up</button>
        </div>
      </div>`}

      <div class="card">
        <div class="list-header">
          <span>Contacts</span>
          <span class=${`status-dot ${status.state}`} title=${status.text || "Connecting…"}></span>
        </div>
        <ul class="user-list">
          ${contacts === null
            ? html`<li class="empty">Loading…</li>`
            : contacts.length === 0
              ? html`<li class="empty">No contacts yet. Add someone by their username above.</li>`
              : contacts.map(
                  (c) => html`
                    <li class="user-row" key=${c.username}>
                      <span class=${`presence ${c.online ? "online" : ""}`} title=${c.online ? "Online" : "Offline"}></span>
                      <span class="name">${c.username}</span>
                      <button type="button" onClick=${() => call(c.username)}>Call</button>
                      <button
                        type="button"
                        class="icon-btn remove"
                        title=${`Remove ${c.username}`}
                        onClick=${() => removeContact(c.username)}
                      >
                        ×
                      </button>
                    </li>
                  `,
                )}
        </ul>
      </div>

      <p class="muted status-text">${status.text}</p>
    </section>

    ${active &&
    active.phase === "ringing" &&
    html`<div class="overlay">
      <div class="card call-card">
        <div class="ringing">Calling</div>
        <div class="incoming-from">${active.peer}</div>
        <div class="muted">on ${jitsiHost(active.jitsiUrl)}</div>
        <div class="button-row">
          <button type="button" class="secondary" onClick=${() => endCall("", { closeWindow: false })}>Cancel</button>
        </div>
      </div>
    </div>`}

    ${incoming &&
    html`<${IncomingCall}
      from=${incoming.from}
      server=${jitsiHost(incoming.jitsiUrl)}
      canAdd=${!isContact(incoming.from)}
      onAdd=${() => addContact(incoming.from)}
      onAccept=${() => {
        setInvites(rest);
        setNotice("");
        // One call at a time: answering hangs up the one you're in.
        if (activeRef.current) endCall();
        startInCall({ meetingId: incoming.meetingId, peer: incoming.from, jitsiUrl: incoming.jitsiUrl, outgoing: false });
      }}
      onDecline=${() => dropInvite(incoming, "")}
    />`}
  `;
}

function IncomingCall({ from, server, canAdd, onAdd, onAccept, onDecline }) {
  return html`
    <div class="overlay">
      <div class="card call-card">
        <div class="ringing">Incoming call</div>
        <div class="incoming-from">${from}</div>
        <div class="muted">on ${server}</div>
        <div class="button-row">
          <button type="button" class="secondary" onClick=${onDecline}>Decline</button>
          <button type="button" onClick=${onAccept}>Accept</button>
        </div>
        ${canAdd && html`<button type="button" class="link-btn add-contact" onClick=${onAdd}>Add to contacts</button>`}
      </div>
    </div>
  `;
}

// ---- Settings ----------------------------------------------------------------

function Settings({ config, me, canSignOutOfJitsi, onSave, onCancel, onSignOut }) {
  return html`
    <section class="screen">
      <div class="card">
        <h1>Settings</h1>
        <p class="muted">
          Signed in as <strong>${me.username}</strong>.
        </p>
        <${ServerFields} config=${config} submitLabel="Save" onSubmit=${onSave} onCancel=${onCancel} />
      </div>
      <div class="card">
        <div class="button-row">
          ${canSignOutOfJitsi &&
          html`<button type="button" class="secondary" onClick=${() => invoke("jitsi_sign_out")}>
            Sign out of meet.jit.si
          </button>`}
          <button type="button" class="secondary" onClick=${onSignOut}>Sign out</button>
        </div>
      </div>
    </section>
  `;
}

render(html`<${App} />`, document.getElementById("app"));
