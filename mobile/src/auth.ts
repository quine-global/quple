// Quine sign-in, as an OpenID Connect native app (react-native-app-auth:
// the sign-in page in the system's secure browser sheet, PKCE). The refresh
// token is the long-lived credential and lives in the iOS Keychain; access
// tokens stay in memory and go to the signaling server.

import { authorize, refresh, revoke } from 'react-native-app-auth';
import * as Keychain from 'react-native-keychain';
import { CLIENT_ID, REDIRECT_URL } from './config';

const SERVICE = 'com.quineglobal.quple.session';

type Saved = { issuer: string; refreshToken: string };

let saved: Saved | null = null;
let access: { token: string; expires: number } | null = null;

/** Thrown when the person has to sign in again (refresh token gone or refused). */
export class SignedOut extends Error {
  constructor() {
    super('signed_out');
  }
}

const config = (issuer: string) => ({
  issuer,
  clientId: CLIENT_ID,
  redirectUrl: REDIRECT_URL,
  scopes: ['openid', 'profile', 'offline_access'],
});

function remember(token: string, expiration: string | undefined) {
  const expires = expiration ? Date.parse(expiration) : Date.now() + 5 * 60_000;
  access = { token, expires };
}

async function store(next: Saved) {
  saved = next;
  await Keychain.setGenericPassword('quple', JSON.stringify(next), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

/** Signs in through the browser sheet. */
export async function signIn(issuer: string): Promise<void> {
  const result = await authorize(config(issuer));
  if (!result.refreshToken) throw new Error('The identity server returned no refresh token.');
  await store({ issuer, refreshToken: result.refreshToken });
  remember(result.accessToken, result.accessTokenExpirationDate);
}

/** Resumes the saved sign-in for this issuer, if any. False: sign in. */
export async function restore(issuer: string): Promise<boolean> {
  const creds = await Keychain.getGenericPassword({ service: SERVICE });
  if (!creds) return false;
  let s: Saved;
  try {
    s = JSON.parse(creds.password);
  } catch {
    return false;
  }
  if (s.issuer !== issuer) return false;
  saved = s;
  try {
    await accessToken(true);
    return true;
  } catch (e) {
    if (e instanceof SignedOut) return false;
    throw e;
  }
}

/** A usable access token; refreshes when nearly expired, or when `force` (the server refused one). */
export async function accessToken(force = false): Promise<string> {
  if (!force && access && access.expires - Date.now() > 60_000) return access.token;
  if (!saved) throw new SignedOut();
  let result;
  try {
    result = await refresh(config(saved.issuer), { refreshToken: saved.refreshToken });
  } catch (e: any) {
    // Refused (expired, revoked, account gone) as opposed to unreachable.
    if (/invalid_grant/i.test(String(e?.message ?? e))) {
      await forget();
      throw new SignedOut();
    }
    throw new Error(`Can't reach the Quine sign-in server: ${e?.message ?? e}`);
  }
  if (result.refreshToken && result.refreshToken !== saved.refreshToken) {
    await store({ issuer: saved.issuer, refreshToken: result.refreshToken });
  }
  remember(result.accessToken, result.accessTokenExpirationDate);
  return result.accessToken;
}

async function forget() {
  saved = null;
  access = null;
  await Keychain.resetGenericPassword({ service: SERVICE });
}

/** Signs out: revokes the refresh token (best effort) and forgets it. */
export async function signOut(): Promise<void> {
  if (saved) {
    try {
      await revoke(config(saved.issuer), { tokenToRevoke: saved.refreshToken, sendClientId: true });
    } catch {}
  }
  await forget();
}
