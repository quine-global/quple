// Whether the mic and camera were off at the end of the last call: the next
// call starts the same way. Loaded once at launch, so a call screen has it
// straight away.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type Media = { audioMuted: boolean; videoMuted: boolean };

const KEY = 'quple.media';

let current: Media = { audioMuted: false, videoMuted: false };

AsyncStorage.getItem(KEY)
  .then(saved => {
    if (!saved) return;
    const m = JSON.parse(saved);
    current = { audioMuted: !!m.audioMuted, videoMuted: !!m.videoMuted };
  })
  .catch(() => {});

export function lastMedia(): Media {
  return current;
}

export function rememberMedia(change: Partial<Media>) {
  current = { ...current, ...change };
  AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
}
