// The Jitsi SDK publishes its TypeScript sources, which don't type-check
// outside jitsi-meet's own tree; tsconfig.json maps the package here
// instead. Its public API (node_modules/@jitsi/react-native-sdk/index.tsx).
declare module '@jitsi/react-native-sdk' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { StyleProp, ViewStyle } from 'react-native';

  export interface IEventListeners {
    onAudioMutedChanged?: Function;
    onVideoMutedChanged?: Function;
    onConferenceBlurred?: Function;
    onConferenceFocused?: Function;
    onConferenceJoined?: Function;
    onConferenceLeft?: Function;
    onConferenceWillJoin?: Function;
    onEnterPictureInPicture?: Function;
    onEndpointMessageReceived?: Function;
    onParticipantJoined?: Function;
    onParticipantLeft?: Function;
    onReadyToClose?: Function;
    onScreenShareToggled?: Function;
  }

  export interface IUserInfo {
    avatarURL?: string;
    displayName?: string;
    email?: string;
  }

  export interface IAppProps {
    config: object;
    eventListeners?: IEventListeners;
    flags?: object;
    room: string;
    serverURL?: string;
    style?: StyleProp<ViewStyle>;
    token?: string;
    userInfo?: IUserInfo;
  }

  export interface JitsiRefProps {
    close: () => void;
    setAudioMuted: (muted: boolean) => void;
    setVideoMuted: (muted: boolean) => void;
    setLowBandwidthMode: (value: boolean) => void;
  }

  export const JitsiMeeting: ForwardRefExoticComponent<IAppProps & RefAttributes<JitsiRefProps>>;
}
