import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadVault } from './sigakhwa-vault-fixture.mjs';

for (const mode of ['ok', 'fail', 'throw', 'absent']) {
  test('saved Mermaid creates no temporary DOM or render calls (' + mode + ')', () => {
    const dom = new JSDOM('<html><body><div id="drawer"></div><div id="host"></div></body></html>');
    const doc = dom.window.document;
    let calls = 0;
    if (mode !== 'absent') dom.window.mermaid = { render() {
      calls++;
      if (mode === 'throw') throw Error('parse error');
      return mode === 'fail' ? Promise.reject(Error('parse error')) : Promise.resolve({ svg: '<svg></svg>' });
    } };
    const { vault } = loadVault({ window: dom.window, document: doc });
    try {
      vault.renderSnapshotInto(doc.getElementById('host'), { contentType: 'mermaid', content: 'flowchart TD\nA["<b>x</b>"] --> B' });
      assert.equal(calls, 0);
      assert.equal(doc.querySelector('pre code').textContent, 'flowchart TD\nA["<b>x</b>"] --> B');
      assert.equal(doc.querySelector('svg,b'), null);
      assert.deepEqual([...doc.body.children].map(node => node.id), ['drawer', 'host']);
    } finally { dom.window.close(); }
  });
}
