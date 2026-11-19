// Quple for iPhone: sign in with Quine, keep contacts, call people by
// username, and take calls on iOS's own call screen. Calls happen in the
// Jitsi Meet SDK, on whichever Jitsi server the caller picked.
//
// Screens: settings → sign-in → home (contacts, calling) → call.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  ScrollView,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { getBuildNumber, getVersion } from 'react-native-device-info';
import Clipboard from '@react-native-clipboard/clipboard';
import { dump } from './src/logs';
import { JitsiMeeting, JitsiRefProps } from '@jitsi/react-native-sdk';

import { ActiveCall, Api, CallStatus, Contact, Invite, Me } from './src/api';
import { SignedOut, restore, signIn, signOut } from './src/auth';
import { connected, finish, onHangUp, ring, setupCallKit, startOutgoing, stopRinging } from './src/callkit';
import { POLL_MS } from './src/config';
import { lastMedia, rememberMedia } from './src/media';
import { Settings, cleanUrl, loadSettings, saveSettings } from './src/settings';
import { NOTIFIED_NO_ANSWER_MS, NO_ANSWER_MS, decide, peerEnded } from './src/watchdog';
import { NTFY_APP_STORE_URL, dismissForThisLaunch, dismissedThisLaunch, isSetUp, markSetUp } from './src/notifications';

/**
 * A call to join: where, the name to show in it, and its CallKit call
 * (callkit.ts), which lasts as long as the meeting.
 */
type Meeting = {
  jitsiUrl: string;
  meetingId: string;
  displayName: string;
  callUUID: string;
  outgoing: boolean;
  /** Who's on the other end. */
  peer: string;
  /**
   * An outgoing call rings (RingingScreen) until the other side answers;
   * only then does the app join the Jitsi room. Incoming calls start answered.
   */
  answered: boolean;
  /** The callee's app was closed: they got a notification, and it rings longer. */
  notified?: boolean;
};

export default function App() {
  const dark = useColorScheme() === 'dark';
  const c = dark ? darkColors : lightColors;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  // Why the last call ended, when it wasn't you: shown on the home screen.
  const [notice, setNotice] = useState('');

  // Settings, then the saved sign-in.
  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      setSettings(s);
      try {
        setSignedIn(await restore(s.identityUrl));
      } catch (e: any) {
        setError(String(e?.message ?? e));
        setSignedIn(false);
      }
    })();
    setupCallKit().catch(() => {});
  }, []);

  const onSignedOut = useCallback(() => setSignedIn(false), []);

  if (!settings || signedIn === null) {
    return (
      <Shell c={c} dark={dark}>
        <ActivityIndicator style={{ flex: 1 }} />
      </Shell>
    );
  }

  if (meeting && !meeting.answered) {
    return (
      <Shell c={c} dark={dark}>
        <RingingScreen
          c={c}
          meeting={meeting}
          serverUrl={settings.serverUrl}
          onAnswered={() => setMeeting({ ...meeting, answered: true })}
          onEnd={why => {
            setMeeting(null);
            setNotice(why ?? '');
          }}
        />
      </Shell>
    );
  }

  if (meeting) {
    return (
      <CallScreen
        meeting={meeting}
        serverUrl={settings.serverUrl}
        onEnd={why => {
          setMeeting(null);
          setNotice(why ?? '');
        }}
      />
    );
  }

  if (showSettings) {
    return (
      <Shell c={c} dark={dark}>
        <SettingsScreen
          c={c}
          settings={settings}
          onCancel={() => setShowSettings(false)}
          onSave={async next => {
            const identityChanged = next.identityUrl !== settings.identityUrl;
            await saveSettings(next);
            setSettings(next);
            setShowSettings(false);
            // A different identity server is a different account.
            if (identityChanged && signedIn) {
              await signOut();
              setSignedIn(false);
            }
          }}
          onSignOut={
            signedIn
              ? async () => {
                  await signOut();
                  setSignedIn(false);
                  setShowSettings(false);
                }
              : undefined
          }
        />
      </Shell>
    );
  }

  if (!signedIn) {
    return (
      <Shell c={c} dark={dark}>
        <SignInScreen
          c={c}
          error={error}
          onSignIn={async () => {
            setError('');
            try {
              await signIn(settings.identityUrl);
              setSignedIn(true);
            } catch (e: any) {
              // Closing the sheet isn't an error worth showing.
              if (!/cancel/i.test(String(e?.message))) setError(String(e?.message ?? e));
            }
          }}
          onSettings={() => setShowSettings(true)}
        />
      </Shell>
    );
  }

  return (
    <Shell c={c} dark={dark}>
      <HomeScreen
        c={c}
        settings={settings}
        notice={notice}
        onSettings={() => setShowSettings(true)}
        onSignedOut={onSignedOut}
        onJoin={setMeeting}
        onRemember={async jitsiUrl => {
          const next = { ...settings, jitsiUrl };
          setSettings(next);
          await saveSettings(next);
        }}
      />
    </Shell>
  );
}

// ---- Home: who you are, calling, contacts, incoming calls -----------------

function HomeScreen(props: {
  c: Colors;
  settings: Settings;
  /** Why the last call ended, if it wasn't you. */
  notice: string;
  onSettings: () => void;
  onSignedOut: () => void;
  onJoin: (m: Meeting) => void;
  onRemember: (jitsiUrl: string) => Promise<void>;
}) {
  const { c, settings, onSignedOut, onJoin } = props;
  const api = useRef(new Api(settings.serverUrl)).current;
  const [me, setMe] = useState<Me | null>(null);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [target, setTarget] = useState('');
  const [jitsi, setJitsi] = useState(settings.jitsiUrl);
  const [status, setStatus] = useState(props.notice);
  // Your calls on your other devices (the Mac), to move here.
  const [elsewhere, setElsewhere] = useState<ActiveCall[]>([]);
  // Setting up call notifications (ntfy): asked at launch until done.
  const [showNotifications, setShowNotifications] = useState(false);
  useEffect(() => {
    const topic = me?.ntfyTopic;
    if (!topic || dismissedThisLaunch()) return;
    isSetUp(topic).then(done => {
      if (!done) setShowNotifications(true);
    });
  }, [me?.ntfyTopic]);

  // Takes a call over from another device: this one joins the room, and
  // the other leaves once it has (README "Moving a call").
  const moveHere = async (ac: ActiveCall) => {
    const callUUID = startOutgoing(ac.peer);
    try {
      const moved = await api.move(ac.meetingId);
      setElsewhere([]);
      onJoin({
        jitsiUrl: moved.jitsiUrl,
        meetingId: moved.meetingId,
        displayName: me?.username ?? '',
        callUUID,
        outgoing: true,
        peer: moved.peer,
        answered: true,
      });
    } catch (e) {
      finish(callUUID);
      fail(e);
    }
  };
  // Invites already rung, so a poll doesn't ring the same one twice.
  const seen = useRef(new Set<string>());
  const meRef = useRef<Me | null>(null);
  meRef.current = me;

  const fail = useCallback(
    (e: any) => {
      if (e instanceof SignedOut) onSignedOut();
      else setStatus(String(e?.message ?? e));
    },
    [onSignedOut],
  );

  const refreshContacts = useCallback(() => {
    api.contacts().then(setContacts).catch(fail);
  }, [api, fail]);

  useEffect(() => {
    api.me().then(setMe).catch(fail);
    refreshContacts();
  }, [api, fail, refreshContacts]);

  // Calls ringing here: how to stop one, by meeting, when we call its
  // caller back and the server answers it for us (a crossed call).
  const ringingHere = useRef(new Map<string, () => void>());

  const incoming = useCallback(
    (inv: Invite) => {
      if (seen.current.has(inv.meetingId)) return;
      seen.current.add(inv.meetingId);
      // While it rings, check whether the caller gave up (GET, which
      // doesn't count as answering), whatever the app's state: iOS's
      // incoming-call screen takes the app out of the foreground.
      let watch: ReturnType<typeof setInterval> | null = null;
      const stopWatching = () => {
        if (watch) clearInterval(watch);
        watch = null;
        ringingHere.current.delete(inv.meetingId);
      };
      const id = ring(
        inv.from,
        callUUID => {
          stopWatching();
          onJoin({
            jitsiUrl: inv.jitsiUrl,
            meetingId: inv.meetingId,
            displayName: meRef.current?.username ?? '',
            callUUID,
            outgoing: false,
            peer: inv.from,
            answered: true,
          });
        },
        () => {
          stopWatching();
          setStatus(`Missed a call from ${inv.from}`);
          // Declined, or rang out: the caller's app stops ringing.
          api.hangUp(inv.meetingId).catch(() => {});
        },
      );
      ringingHere.current.set(inv.meetingId, () => {
        stopWatching();
        stopRinging(id, true);
      });
      watch = setInterval(() => {
        api
          .callStatus(inv.meetingId)
          .then(st => {
            if (st.answeredOn) {
              // Answered on another of your devices: not a missed call.
              stopWatching();
              stopRinging(id, true);
              setStatus(`Answered on your ${st.answeredOn}`);
            } else if (st.endedBy) {
              stopRinging(id);
            }
          })
          .catch(() => {});
      }, POLL_MS);
    },
    [api, onJoin],
  );

  // Poll while the app is in the foreground: that's both "I'm online" and
  // "did anyone call me?". iOS suspends a backgrounded app, so it stops there.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      api
        .poll()
        .then(r => {
          r.invites.forEach(incoming);
          setElsewhere(r.calls);
        })
        .catch(fail);
    };
    const start = () => {
      if (timer) return;
      tick();
      timer = setInterval(tick, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') {
        start();
        refreshContacts();
      } else {
        stop();
      }
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [api, incoming, fail, refreshContacts]);

  const call = async (to: string) => {
    to = to.trim().toLowerCase();
    if (!to) return;
    setStatus(`Calling ${to}…`);
    const callUUID = startOutgoing(to);
    try {
      const server = jitsi.trim() ? cleanUrl(jitsi) : undefined;
      const res = await api.call(to, server);
      // Remember the server for next time, or forget it when the field was
      // emptied: blank means the signaling server's default (ours).
      await props.onRemember(server ?? '');
      setStatus('');
      if (res.joined) {
        // They were calling us at the same time: the server answered their
        // call for us (README "Crossed calls"). Stop it ringing here, as
        // answered, so it never counts as a decline.
        seen.current.add(res.meetingId);
        ringingHere.current.get(res.meetingId)?.();
      }
      onJoin({
        jitsiUrl: res.jitsiUrl,
        meetingId: res.meetingId,
        displayName: me?.username ?? '',
        callUUID,
        outgoing: true,
        peer: to,
        answered: !!res.joined,
        notified: res.notified,
      });
    } catch (e) {
      finish(callUUID);
      fail(e);
    }
  };

  const isContact = (name: string) => (contacts ?? []).some(x => x.username === name);

  if (showNotifications && me?.ntfyServer && me.ntfyTopic) {
    return (
      <NotificationsScreen
        c={c}
        server={me.ntfyServer}
        topic={me.ntfyTopic}
        onDone={async () => {
          await markSetUp(me.ntfyTopic!);
          setShowNotifications(false);
        }}
        onLater={() => {
          dismissForThisLaunch();
          setShowNotifications(false);
        }}
      />
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.muted, { color: c.muted }]}>Signed in as</Text>
          <Text style={[styles.title, { color: c.text }]}>{me?.username ?? '…'}</Text>
        </View>
        <View style={styles.headerLinks}>
          {me?.ntfyTopic ? (
            <Pressable onPress={() => setShowNotifications(true)} hitSlop={12}>
              <Text style={[styles.link, { color: c.accent }]}>Notifications</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={props.onSettings} hitSlop={12}>
            <Text style={[styles.link, { color: c.accent }]}>Settings</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: c.card }]}>
        <TextInput
          style={[styles.input, { color: c.text, borderColor: c.border }]}
          placeholder="Quine username"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          value={target}
          onChangeText={setTarget}
          onSubmitEditing={() => call(target)}
          returnKeyType="go"
        />
        <TextInput
          style={[styles.input, { color: c.text, borderColor: c.border }]}
          placeholder={`On server: ${me?.defaultJitsiUrl ?? 'default'}`}
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={jitsi}
          onChangeText={setJitsi}
        />
        <View style={styles.row}>
          <Button c={c} title="Call" onPress={() => call(target)} />
          {target.trim() && !isContact(target.trim().toLowerCase()) ? (
            <Button
              c={c}
              secondary
              title="Add contact"
              onPress={() =>
                api
                  .addContact(target.trim())
                  .then(() => {
                    setTarget('');
                    refreshContacts();
                  })
                  .catch(fail)
              }
            />
          ) : null}
        </View>
      </View>

      {status ? <Text style={[styles.status, { color: c.muted }]}>{status}</Text> : null}

      {elsewhere.map(ac => (
        <View key={ac.meetingId} style={[styles.card, styles.elsewhere, { backgroundColor: c.card }]}>
          <Text style={[styles.name, { color: c.text }]}>
            In a call with {ac.peer}
            {ac.device ? ` on your ${ac.device}` : ''}
          </Text>
          <Button c={c} title="Move here" onPress={() => moveHere(ac)} />
        </View>
      ))}

      <FlatList
        data={contacts ?? []}
        keyExtractor={x => x.username}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        ListEmptyComponent={
          <Text style={[styles.muted, { color: c.muted, textAlign: 'center', marginTop: 24 }]}>
            {contacts === null ? 'Loading…' : 'No contacts yet. Add someone by their username above.'}
          </Text>
        }
        onRefresh={refreshContacts}
        refreshing={false}
        renderItem={({ item }) => (
          <View style={[styles.contact, { borderColor: c.border }]}>
            <View style={[styles.dot, { backgroundColor: item.online ? c.online : c.border }]} />
            <Text style={[styles.name, { color: c.text }]}>{item.username}</Text>
            <Button c={c} title="Call" onPress={() => call(item.username)} />
            <Pressable
              hitSlop={8}
              onPress={() => api.removeContact(item.username).then(refreshContacts).catch(fail)}
              accessibilityLabel={`Remove ${item.username}`}
            >
              <Text style={[styles.remove, { color: c.muted }]}>✕</Text>
            </Pressable>
          </View>
        )}
      />
    </KeyboardAvoidingView>
  );
}

// ---- Call notifications: setting up ntfy ------------------------------------

// Quple only rings while it's open. For calls while it's closed, you
// subscribe to your own topic in the ntfy app (src/notifications.ts). Its
// iPhone app has no subscribe links, hence the steps and copy buttons.
function NotificationsScreen(props: {
  c: Colors;
  server: string;
  topic: string;
  onDone: () => void;
  onLater: () => void;
}) {
  const { c, server, topic } = props;
  const [copied, setCopied] = useState('');
  const copy = (what: string, value: string) => {
    Clipboard.setString(value);
    setCopied(what);
  };
  const row = (label: string, value: string) => (
    <View style={[styles.copyRow, { borderColor: c.border }]}>
      <View style={styles.copyText}>
        <Text style={[styles.muted, { color: c.muted }]}>{label}</Text>
        <Text style={[styles.mono, { color: c.text }]} selectable>
          {value}
        </Text>
      </View>
      <Button c={c} secondary title={copied === label ? 'Copied' : 'Copy'} onPress={() => copy(label, value)} />
    </View>
  );
  return (
    <ScrollView contentContainerStyle={styles.setup}>
      <Text style={[styles.title, { color: c.text }]}>Get calls when Quple is closed</Text>
      <Text style={[styles.body, { color: c.text }]}>
        Quple can only ring while it's open. For calls when it isn't, subscribe to your own private topic in the free
        ntfy app: you'll get a notification saying who's calling, and tapping it opens Quple to answer.
      </Text>

      <Text style={[styles.step, { color: c.text }]}>1. Install ntfy</Text>
      <Button c={c} title="Get ntfy from the App Store" onPress={() => Linking.openURL(NTFY_APP_STORE_URL)} />

      <Text style={[styles.step, { color: c.text }]}>
        2. In ntfy, tap +, enter your topic, turn on "Use another server", enter the server, and tap Subscribe
      </Text>
      {row('Topic', topic)}
      {row('Server', server)}

      <Text style={[styles.step, { color: c.text }]}>3. Allow ntfy's notifications when it asks</Text>
      <Text style={[styles.muted, { color: c.muted }]}>
        Keep your topic to yourself: anyone who has it can see who calls you.
      </Text>

      <View style={styles.setupButtons}>
        <Button c={c} title="I've subscribed" onPress={props.onDone} />
        <Button c={c} secondary title="Not now" onPress={props.onLater} />
      </View>
    </ScrollView>
  );
}

// ---- Ringing: an outgoing call, until it's answered ---------------------------

// The caller stays out of the Jitsi room while the other phone rings. Its
// heartbeats (Quple's server) say when the other side's call screen opens,
// which is answering; a decline or ring-out arrives as their hang-up.
function RingingScreen(props: {
  c: Colors;
  meeting: Meeting;
  serverUrl: string;
  onAnswered: () => void;
  onEnd: (notice?: string) => void;
}) {
  const { c, meeting, onAnswered, onEnd } = props;
  const api = useRef(new Api(props.serverUrl)).current;
  const done = useRef(false);
  // A ref, so re-rendering (new callbacks from App) doesn't restart the clock.
  const startedAt = useRef(Date.now());

  // Hang up the ringing call: tell the callee's phone (it stops ringing)
  // and iOS.
  const stop = useCallback(
    (notice?: string) => {
      if (done.current) return;
      done.current = true;
      api.hangUp(meeting.meetingId).catch(() => {});
      finish(meeting.callUUID);
      onEnd(notice);
    },
    [api, meeting.meetingId, meeting.callUUID, onEnd],
  );

  // Ended from iOS's call screen.
  useEffect(() => onHangUp(meeting.callUUID, () => stop()), [meeting.callUUID, stop]);

  useEffect(() => {
    let busy = false;
    const tick = async () => {
      if (busy || done.current) return;
      busy = true;
      try {
        const st = await api.heartbeat(meeting.meetingId);
        if (done.current) return;
        if (peerEnded(st, meeting.displayName)) {
          stop(`${meeting.peer} didn't answer`);
        } else if (st.peerSeenMsAgo !== null) {
          done.current = true;
          onAnswered();
        }
      } catch (e: any) {
        console.log(`[quple] ringing: heartbeat failed: ${e?.message ?? e}`);
      } finally {
        busy = false;
      }
      // Their phone rang out without telling us (it never got the call).
      const limit = meeting.notified ? NOTIFIED_NO_ANSWER_MS : NO_ANSWER_MS;
      if (!done.current && Date.now() - startedAt.current > limit) stop(`${meeting.peer} didn't answer`);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [api, meeting, onAnswered, stop]);

  return (
    <View style={styles.center}>
      <Text style={[styles.muted, { color: c.muted }]}>Calling</Text>
      <Text style={[styles.hero, { color: c.text }]}>{meeting.peer}</Text>
      {meeting.notified ? (
        <Text style={[styles.muted, styles.centerText, { color: c.muted }]}>
          Quple isn't open on their phone, so they got a notification. Waiting for them to open it…
        </Text>
      ) : null}
      <ActivityIndicator style={styles.ringing} />
      <Button c={c} title="Cancel" onPress={() => stop()} />
    </View>
  );
}

// ---- The call: Jitsi Meet SDK -----------------------------------------------

function CallScreen(props: { meeting: Meeting; serverUrl: string; onEnd: (notice?: string) => void }) {
  const { meeting, onEnd } = props;
  const api = useRef(new Api(props.serverUrl)).current;
  const jitsi = useRef<JitsiRefProps>(null);
  const ended = useRef(false);
  // Each (re)start of the SDK is an attempt; events from an earlier one's
  // teardown are ignored.
  const [attempt, setAttempt] = useState(0);
  const current = useRef(0);
  // What the watchdog (src/watchdog.ts) goes on.
  const w = useRef({
    startedAt: Date.now(),
    attemptStartedAt: Date.now(),
    rejoins: 0,
    joined: false,
    remotes: new Set<string>(),
    aloneSince: null as number | null,
    peerSince: null as number | null,
    status: null as CallStatus | null,
    statusAt: null as number | null,
    reportedConnected: false,
  });

  // Every way a call ends goes through here, and tells Quple's server, so
  // the other side's app ends it too.
  const end = useCallback(
    (notice?: string, hangUp = true) => {
      if (ended.current) return;
      ended.current = true;
      if (hangUp) api.hangUp(meeting.meetingId).catch(() => {});
      finish(meeting.callUUID);
      onEnd(notice);
    },
    [api, meeting.meetingId, meeting.callUUID, onEnd],
  );
  // Moved to another device: muted once, then gone when it's joined.
  const mutedForMove = useRef(false);
  // The mic and camera start as they were at the end of the last call.
  const startMedia = useRef(lastMedia()).current;
  const jitsiConfig = useRef({
    startWithAudioMuted: startMedia.audioMuted,
    startWithVideoMuted: startMedia.videoMuted,
  }).current;
  // Only what you switch yourself counts: not Quple muting you for a move,
  // nor Jitsi turning the camera off while the app is in the background
  // (hanging up from the lock screen would otherwise start the next call
  // with the camera off).
  const remember = (change: { audioMuted?: boolean; videoMuted?: boolean }) => {
    if (mutedForMove.current || AppState.currentState !== 'active' || !w.current.joined) return;
    rememberMedia(change);
  };
  useEffect(() => {
    console.log(`[quple] call screen: ${meeting.outgoing ? 'outgoing' : 'incoming'} ${meeting.jitsiUrl} ${meeting.meetingId}`);
  }, [meeting]);
  const trace = (name: string) => (e?: unknown) => console.log(`[quple] jitsi ${name}`, e ?? '');
  // Hung up from iOS's call screen or the lock screen: leave the meeting.
  useEffect(() => {
    onHangUp(meeting.callUUID, () => {
      end();
      jitsi.current?.close();
    });
  }, [meeting.callUUID, end]);

  // The watchdog: a heartbeat to Quple's server every few seconds (also in
  // the background, which the CallKit call keeps the app running in), then
  // decide() on that and on the room.
  useEffect(() => {
    let busy = false;
    const tick = async () => {
      if (busy || ended.current) return;
      busy = true;
      const s = w.current;
      try {
        s.status = await api.heartbeat(meeting.meetingId, s.joined);
        s.statusAt = Date.now();
        if (s.status.peerSeenMsAgo !== null && s.peerSince === null) s.peerSince = Date.now();
      } catch (e: any) {
        // Quple's server down, or restarted and forgot the call: go on what
        // the room says.
        console.log(`[quple] heartbeat failed: ${e?.message ?? e}`);
      } finally {
        busy = false;
      }
      if (ended.current) return;
      // Taken over by another of your devices: mute at once (the two may be
      // side by side), and leave once it's in the room. Not hanging up: the
      // call goes on there.
      const movedTo = s.status?.movedTo;
      if (movedTo && s.statusAt && Date.now() - s.statusAt < 10_000) {
        if (!mutedForMove.current) {
          mutedForMove.current = true;
          jitsi.current?.setAudioMuted?.(true);
        }
        if (s.status?.movedJoined) {
          console.log(`[quple] moved to ${movedTo}`);
          // end() before close(): closing makes the SDK fire
          // onReadyToClose, whose end() would hang up the call that's
          // going on on the other device (it did: the other side's app
          // saw "hung up" and ended too). Ended first, that end() does
          // nothing.
          end(`Moved to your ${movedTo}`, false);
          jitsi.current?.close();
        }
        return;
      }
      const v = decide({ ...s, now: Date.now(), remotes: s.remotes.size, me: meeting.displayName });
      if (v.action === 'end') {
        console.log(`[quple] watchdog: ending: ${v.reason}`);
        end(v.reason); // before close(), as above: keeps v.reason
        jitsi.current?.close();
      } else if (v.action === 'rejoin') {
        console.log(`[quple] watchdog: rejoining (${v.why})`);
        s.rejoins += 1;
        s.joined = false;
        s.remotes.clear();
        s.aloneSince = null;
        s.attemptStartedAt = Date.now();
        current.current += 1;
        // A new key mounts a fresh SDK, which joins the same room; the old
        // one unmounts and leaves.
        setAttempt(current.current);
      }
    };
    // The first one now: for the callee, it's what tells the caller's
    // phone the call was answered.
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [api, meeting.meetingId, meeting.displayName, end]);

  // Only the current attempt's events count.
  const live = (fn: (e?: any) => void) => (e?: any) => {
    if (attempt === current.current) fn(e);
  };

  return (
    <View style={{ flex: 1, backgroundColor: 'black' }}>
      <StatusBar barStyle="light-content" />
      <JitsiMeeting
        key={attempt}
        ref={jitsi}
        serverURL={meeting.jitsiUrl}
        room={meeting.meetingId}
        config={jitsiConfig}
        userInfo={{ displayName: meeting.displayName } as any}
        flags={{
          'welcomepage.enabled': false,
          'prejoinpage.enabled': false,
          // Off: Quple's own CallKit call carries it (callkit.ts); with the
          // SDK's on too, each call showed up twice.
          'call-integration.enabled': false,
          'pip.enabled': true,
        }}
        // (No onConferenceLeft: this SDK never calls it.)
        eventListeners={{
          onConferenceWillJoin: trace('conference will join'),
          onConferenceJoined: live(e => {
            trace('conference joined')(e);
            const s = w.current;
            s.joined = true;
            if (s.remotes.size === 0) s.aloneSince = Date.now();
            if (meeting.outgoing && !s.reportedConnected) {
              s.reportedConnected = true;
              connected(meeting.callUUID);
            }
          }),
          // The hang-up button.
          onReadyToClose: live(e => {
            trace('ready to close')(e);
            end();
          }),
          onAudioMutedChanged: live(muted => remember({ audioMuted: !!muted })),
          onVideoMutedChanged: live(muted => remember({ videoMuted: !!muted })),
          onParticipantJoined: live(e => {
            trace('participant joined')(e);
            if (e?.isLocal || !e?.participantId) return;
            w.current.remotes.add(e.participantId);
            w.current.aloneSince = null;
          }),
          onParticipantLeft: live(e => {
            trace('participant left')(e);
            const s = w.current;
            s.remotes.delete(e?.id);
            if (s.remotes.size === 0 && s.joined) s.aloneSince = Date.now();
          }),
        }}
        style={{ flex: 1 }}
      />
    </View>
  );
}

// ---- Sign-in and settings --------------------------------------------------

function SignInScreen(props: {
  c: Colors;
  error: string;
  onSignIn: () => Promise<void>;
  onSettings: () => void;
}) {
  const { c } = props;
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.center}>
      <Text style={[styles.hero, { color: c.text }]}>Quple</Text>
      <Text style={[styles.muted, { color: c.muted, textAlign: 'center', marginBottom: 24 }]}>
        Sign in with your Quine account. Your Quine username is what people call you by.
      </Text>
      {props.error ? <Text style={[styles.error, { color: c.error }]}>{props.error}</Text> : null}
      {busy ? (
        <ActivityIndicator />
      ) : (
        <Button
          c={c}
          title="Sign in with Quine"
          onPress={async () => {
            setBusy(true);
            await props.onSignIn();
            setBusy(false);
          }}
        />
      )}
      <Pressable onPress={props.onSettings} style={{ marginTop: 24 }}>
        <Text style={[styles.link, { color: c.accent }]}>Advanced settings</Text>
      </Pressable>
    </View>
  );
}

function SettingsScreen(props: {
  c: Colors;
  settings: Settings;
  onSave: (s: Settings) => Promise<void>;
  onCancel: () => void;
  onSignOut?: () => Promise<void>;
}) {
  const { c, settings } = props;
  const [identityUrl, setIdentityUrl] = useState(settings.identityUrl);
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ padding: 16 }}>
      <Text style={[styles.title, { color: c.text, marginBottom: 16 }]}>Settings</Text>
      <Text style={[styles.label, { color: c.muted }]}>Quine sign-in server (OIDC issuer)</Text>
      <TextInput
        style={[styles.input, { color: c.text, borderColor: c.border }]}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={identityUrl}
        onChangeText={setIdentityUrl}
      />
      <Text style={[styles.label, { color: c.muted }]}>Signaling server</Text>
      <TextInput
        style={[styles.input, { color: c.text, borderColor: c.border }]}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={serverUrl}
        onChangeText={setServerUrl}
      />
      <View style={styles.row}>
        <Button
          c={c}
          title="Save"
          onPress={() =>
            props.onSave({ ...settings, identityUrl: cleanUrl(identityUrl), serverUrl: cleanUrl(serverUrl) })
          }
        />
        <Button c={c} secondary title="Cancel" onPress={props.onCancel} />
      </View>
      {props.onSignOut ? (
        <Pressable onPress={props.onSignOut} style={{ marginTop: 32 }}>
          <Text style={[styles.link, { color: c.error }]}>Sign out</Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={() => {
          Clipboard.setString(`Quple ${getVersion()} (build ${getBuildNumber()})\n${dump()}`);
          setCopied(true);
        }}
        style={{ marginTop: 32 }}
      >
        <Text style={[styles.link, { color: c.accent }]}>{copied ? 'Copied' : 'Copy debug log'}</Text>
      </Pressable>
      <Text style={[styles.muted, { color: c.muted, marginTop: 16 }]}>
        Quple {getVersion()} (build {getBuildNumber()})
      </Text>
    </View>
  );
}

// ---- Bits ------------------------------------------------------------------

function Shell({ c, dark, children }: { c: Colors; dark: boolean; children: React.ReactNode }) {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>{children}</SafeAreaView>
    </SafeAreaProvider>
  );
}

function Button(props: { c: Colors; title: string; onPress: () => void; secondary?: boolean }) {
  const { c } = props;
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.secondary
          ? { backgroundColor: 'transparent', borderColor: c.accent, borderWidth: 1 }
          : { backgroundColor: c.accent },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.buttonText, { color: props.secondary ? c.accent : c.onAccent }]}>
        {props.title}
      </Text>
    </Pressable>
  );
}

type Colors = typeof lightColors;
const lightColors = {
  bg: '#f4f5f7',
  card: '#ffffff',
  text: '#16181d',
  muted: '#6b7280',
  border: '#d6d9df',
  accent: '#2f6fed',
  onAccent: '#ffffff',
  online: '#22a35a',
  error: '#c62828',
};
const darkColors: Colors = {
  bg: '#0f1115',
  card: '#1a1d23',
  text: '#eef0f3',
  muted: '#9aa1ad',
  border: '#343944',
  accent: '#5b8cff',
  onAccent: '#0f1115',
  online: '#3ccf7a',
  error: '#ff6b6b',
};

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { fontSize: 20, fontWeight: '600' },
  hero: { fontSize: 40, fontWeight: '700', marginBottom: 12 },
  muted: { fontSize: 14 },
  label: { fontSize: 13, marginTop: 8, marginBottom: 4 },
  link: { fontSize: 16, fontWeight: '500' },
  card: { marginHorizontal: 16, padding: 12, borderRadius: 12, gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  row: { flexDirection: 'row', gap: 8, marginTop: 4 },
  button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
  status: { marginHorizontal: 16, marginTop: 12, fontSize: 14 },
  contact: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { flex: 1, fontSize: 16 },
  remove: { fontSize: 16, paddingHorizontal: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  ringing: { marginVertical: 24 },
  centerText: { textAlign: 'center', marginTop: 8 },
  headerLinks: { flexDirection: 'row', gap: 16 },
  setup: { padding: 24, gap: 12 },
  body: { fontSize: 16, lineHeight: 22 },
  step: { fontSize: 16, fontWeight: '600', marginTop: 12 },
  copyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 10, padding: 10 },
  copyText: { flex: 1 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13 },
  setupButtons: { gap: 8, marginTop: 16 },
  elsewhere: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  error: { marginBottom: 16, textAlign: 'center' },
});
