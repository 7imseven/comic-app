import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.reader.comic',
  appName: '百度',
  webDir: 'www',
  server: {
    androidScheme: 'https'
  },
  ios: {
    contentInset: 'always'
  }
};

export default config;
