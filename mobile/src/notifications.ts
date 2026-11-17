// Call notifications while Quple is closed: Quple only rings while it's
// open (no VoIP push without a paid Apple account), so Quple's server also
// sends each call to the callee's own ntfy topic (petersweb-infra
// docs/NTFY.md), which the ntfy app shows. Tapping it opens Quple, which
// polls and rings as usual. The ntfy app has no subscribe links on iOS, so
// setting it up is a few steps the app walks you through (App.tsx,
// NotificationsScreen), and it can't tell whether you did; it remembers
// that you said so, per topic.

import AsyncStorage from '@react-native-async-storage/async-storage';

export const NTFY_APP_STORE_URL = 'https://apps.apple.com/app/ntfy/id1625396347';

const KEY = 'quple.ntfy-subscribed';

/** Whether you said you subscribed to `topic`. */
export async function isSetUp(topic: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY)) === topic;
  } catch {
    return false;
  }
}

export async function markSetUp(topic: string): Promise<void> {
  await AsyncStorage.setItem(KEY, topic).catch(() => {});
}

/** "Not now": no more asking until the app is next launched. */
let dismissed = false;
export const dismissedThisLaunch = () => dismissed;
export function dismissForThisLaunch() {
  dismissed = true;
}
