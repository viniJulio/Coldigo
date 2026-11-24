const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

test('versão: index.html, endereços dos arquivos e version.json batem', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
  assert.ok(/^\d{4}-\d{2}-\d{2}\.\d+$/.test(version), version);
  assert.ok(html.includes(`window.COLDIGO_VERSION = '${version}'`));
  const refs = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 9);
  for (const r of refs) assert.ok(r.endsWith(`?v=${version}`), 'sem versão: ' + r);
});
