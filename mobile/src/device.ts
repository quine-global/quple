// Which device this is, to Quple's server: a random ID kept for good, so a
// call can be moved between your devices (README "Moving a call").

import AsyncStorage from '@react-native-async-storage/async-storage';
import { uuid } from './callkit';

const KEY = 'quple.device';

/** What your other devices call this one: "In a call with bob on your iPhone". */
export const DEVICE_NAME = 'iPhone';

let id: Promise<string> | null = null;

export function deviceId(): Promise<string> {
  if (!id) {
    id = (async () => {
      try {
        const saved = await AsyncStorage.getItem(KEY);
        if (saved) return saved;
      } catch {}
      const fresh = uuid();
      await AsyncStorage.setItem(KEY, fresh).catch(() => {});
      return fresh;
    })();
  }
  return id;
}
