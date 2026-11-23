import { deadMidFn } from './dead-mid.js';

export function deadRootFn() {
  // A local named `url`: live.js also holds the string 'url', but a
  // local is not the file's public name, so it must not keep this
  // dead file alive (umami's SettingsButton.tsx was kept at REVIEW
  // the same way, by its local `url` matching 116 files).
  const url = 'https://example.com';
  deadMidFn();
  return url;
}
