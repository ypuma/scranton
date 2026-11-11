// What the page can tell about the OS, for the labels that name a key. The key handlers take Ctrl or Cmd alike.
// Read as window-controls.js reads it: WKWebView says MacIntel, and the page has no other hint of the OS.
export const isMac = (nav = globalThis.navigator) => /^Mac/.test(nav?.platform ?? '');

// -> 'Cmd+Enter' on a Mac, 'Ctrl+Enter' anywhere else
export const shortcut = (key, nav = globalThis.navigator) => `${isMac(nav) ? 'Cmd' : 'Ctrl'}+${key}`;
