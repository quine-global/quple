// Where Quple's servers are, and how it signs in. The defaults are the
// official ones; Advanced settings can point the app elsewhere (settings.ts).

export const DEFAULTS = {
  /** Quine accounts: Keycloak's realm `public` (petersweb-infra docs/LOGIN.md). */
  identityUrl: 'https://login.quineglobal.com/realms/public',
  /** The signaling server (../server). */
  serverUrl: 'https://meet.quineglobal.com',
};

/** Quple's client at the identity server, shared with the desktop app. */
export const CLIENT_ID = 'quple';

/** Registered with the `quple` client; Info.plist claims the scheme. */
export const REDIRECT_URL = 'com.quineglobal.quple:/oauth';

/** How often to ask the signaling server for calls while the app is open. */
export const POLL_MS = 3000;
