import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULTS } from './config';

/** What the app remembers between launches. Nothing secret: the sign-in is in the Keychain (auth.ts). */
export type Settings = {
  identityUrl: string;
  serverUrl: string;
  /** The Jitsi Meet server of the last call placed; the next starts there. */
  jitsiUrl: string;
};

const KEY = 'quple.settings';

export async function loadSettings(): Promise<Settings> {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}');
  } catch {}
  return {
    identityUrl: saved.identityUrl || DEFAULTS.identityUrl,
    serverUrl: saved.serverUrl || DEFAULTS.serverUrl,
    jitsiUrl: saved.jitsiUrl || '',
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(settings));
}

/** A URL as the user typed it, made comparable: no trailing slash, https:// assumed. */
export function cleanUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !u.includes('://')) u = `https://${u}`;
  return u;
}
