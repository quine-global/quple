const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration: the Jitsi SDK imports its icons as .svg modules,
 * which react-native-svg-transformer turns into components (the SDK's
 * README, "Installation").
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const defaults = getDefaultConfig(__dirname);

const config = {
  transformer: {
    babelTransformerPath: require.resolve('react-native-svg-transformer/react-native'),
  },
  resolver: {
    assetExts: defaults.resolver.assetExts.filter(ext => ext !== 'svg'),
    sourceExts: [...defaults.resolver.sourceExts, 'svg'],
  },
};

module.exports = mergeConfig(defaults, config);
