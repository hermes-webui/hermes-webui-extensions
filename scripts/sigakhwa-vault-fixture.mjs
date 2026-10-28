import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

export function readExtension() {
  return fs.readFileSync(new URL('../extensions/sigakhwa-vault/assets/sigakhwa-vault.js', import.meta.url), 'utf8');
}

export function loadVault(opts = {}) {
  const win = opts.window || {};
  const document = Object.hasOwn(opts, 'document') ? opts.document : {
    documentElement: { lang: 'ko' }, readyState: 'loading', addEventListener() {}
  };
  // Leave boot under test control, while executing the shipped script unchanged.
  const add = document && document.addEventListener;
  if (document) document.addEventListener = function (name, ...args) {
    if (name !== 'DOMContentLoaded') return add.call(this, name, ...args);
  };
  try {
    new Function('window', 'document', 'crypto', 'TextEncoder', 'fetch', 'MutationObserver', 'ResizeObserver', 'S', '_oldestIdx', 'console', readExtension())(
      win, document, Object.hasOwn(opts, 'crypto') ? opts.crypto : webcrypto, TextEncoder,
      opts.fetch, opts.MutationObserver || win.MutationObserver, opts.ResizeObserver || win.ResizeObserver,
      opts.state, opts.offset, opts.console || console
    );
  } finally {
    if (document) document.addEventListener = add;
  }
  return { window: win, vault: win.SigakhwaVault };
}
