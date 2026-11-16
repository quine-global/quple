// Quple for iPhone: sign in with Quine, keep contacts, call people by
// username, and take calls on iOS's own call screen. Calls happen in the
// Jitsi Meet SDK, on whichever Jitsi server the caller picked.
//
// Screens: settings → sign-in → home (contacts, calling) → call.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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

import { Api, Contact, Invite, Me } from './src/api';
import { SignedOut, restore, signIn, signOut } from './src/auth';
import { connected, finish, onHangUp, ring, setupCallKit, startOutgoing } from './src/callkit';
import { POLL_MS } from './src/config';
import { Settings, cleanUrl, loadSettings, saveSettings } from './src/settings';

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
};

export default function App() {
  const dark = useColorScheme() === 'dark';
  const c = dark ? darkColors : lightColors;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');
  const [meeting, setMeeting] = useState<Meeting | null>(null);

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

  if (meeting) {
    return <CallScreen meeting={meeting} onEnd={() => setMeeting(null)} />;
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
  const [status, setStatus] = useState('');
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

  const incoming = useCallback(
    (inv: Invite) => {
      if (seen.current.has(inv.meetingId)) return;
      seen.current.add(inv.meetingId);
      ring(
        inv.from,
        callUUID =>
          onJoin({
            jitsiUrl: inv.jitsiUrl,
            meetingId: inv.meetingId,
            displayName: meRef.current?.username ?? '',
            callUUID,
            outgoing: false,
          }),
        () => setStatus(`Missed a call from ${inv.from}`),
      );
    },
    [onJoin],
  );

  // Poll while the app is in the foreground: that's both "I'm online" and
  // "did anyone call me?". iOS suspends a backgrounded app, so it stops there.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      api
        .poll()
        .then(invites => invites.forEach(incoming))
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
      onJoin({
        jitsiUrl: res.jitsiUrl,
        meetingId: res.meetingId,
        displayName: me?.username ?? '',
        callUUID,
        outgoing: true,
      });
    } catch (e) {
      finish(callUUID);
      fail(e);
    }
  };

  const isContact = (name: string) => (contacts ?? []).some(x => x.username === name);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.muted, { color: c.muted }]}>Signed in as</Text>
          <Text style={[styles.title, { color: c.text }]}>{me?.username ?? '…'}</Text>
        </View>
        <Pressable onPress={props.onSettings} hitSlop={12}>
          <Text style={[styles.link, { color: c.accent }]}>Settings</Text>
        </Pressable>
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

// ---- The call: Jitsi Meet SDK -----------------------------------------------

function CallScreen({ meeting, onEnd }: { meeting: Meeting; onEnd: () => void }) {
  const jitsi = useRef<JitsiRefProps>(null);
  const ended = useRef(false);
  const end = useCallback(() => {
    if (ended.current) return;
    ended.current = true;
    finish(meeting.callUUID);
    onEnd();
  }, [meeting.callUUID, onEnd]);
  useEffect(() => {
    console.log(`[quple] call screen: ${meeting.outgoing ? 'outgoing' : 'incoming'} ${meeting.jitsiUrl} ${meeting.meetingId}`);
  }, [meeting]);
  const trace = (name: string) => (e?: unknown) => console.log(`[quple] jitsi ${name}`, e ?? '');
  // Hung up from iOS's call screen or the lock screen: leave the meeting.
  useEffect(() => {
    onHangUp(meeting.callUUID, () => {
      jitsi.current?.close();
      end();
    });
  }, [meeting.callUUID, end]);
  return (
    <View style={{ flex: 1, backgroundColor: 'black' }}>
      <StatusBar barStyle="light-content" />
      <JitsiMeeting
        ref={jitsi}
        serverURL={meeting.jitsiUrl}
        room={meeting.meetingId}
        config={{}}
        userInfo={{ displayName: meeting.displayName } as any}
        flags={{
          'welcomepage.enabled': false,
          'prejoinpage.enabled': false,
          // Off: Quple's own CallKit call carries it (callkit.ts); with the
          // SDK's on too, each call showed up twice.
          'call-integration.enabled': false,
          'pip.enabled': true,
        }}
        eventListeners={{
          onConferenceWillJoin: trace('conference will join'),
          onConferenceJoined: (e: unknown) => {
            trace('conference joined')(e);
            if (meeting.outgoing) connected(meeting.callUUID);
          },
          onReadyToClose: (e: unknown) => {
            trace('ready to close')(e);
            end();
          },
          onConferenceLeft: (e: unknown) => {
            trace('conference left')(e);
            end();
          },
          onParticipantJoined: trace('participant joined'),
          onParticipantLeft: trace('participant left'),
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
  error: { marginBottom: 16, textAlign: 'center' },
});
