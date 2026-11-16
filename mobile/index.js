/**
 * @format
 */

// First: records the console from here on (Settings → Copy debug log).
import './src/logs';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
