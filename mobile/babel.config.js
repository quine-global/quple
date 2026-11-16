module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // The Jitsi SDK loads a server's config.js in a separate JS context
    // (react-native-worklets-core); this plugin compiles the functions it
    // sends there into worklets. Without it, loading the config throws "not a
    // valid worklet" and every call ends at once ("You have been
    // disconnected").
    'react-native-worklets-core/plugin',
  ],
};
