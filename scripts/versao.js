// Gera uma versão nova e a aplica no index.html (endereços dos arquivos com ?v=) e no version.json.
// Rode antes de cada publicação:  node scripts/versao.js
// Com endereços novos, o cache do navegador (10 min no GitHub Pages) não segura a versão antiga,
// e o app aberto percebe pelo version.json que existe versão nova e oferece atualizar.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = path.join(root, 'index.html'), vjson = path.join(root, 'version.json');
const today = new Date().toISOString().slice(0, 10);
let prev = null; try { prev = JSON.parse(fs.readFileSync(vjson, 'utf8')).version; } catch (_) { /* primeira vez */ }
const n = prev && prev.startsWith(today) ? +prev.split('.')[1] + 1 : 1;
const version = process.argv[2] || `${today}.${n}`;
let s = fs.readFileSync(html, 'utf8');
s = s.replace(/(<(?:script|link)[^>]+(?:src|href)="(?:js|css)\/[^"?]+)(?:\?v=[^"]*)?"/g, `$1?v=${version}"`);
s = s.replace(/window\.COLDIGO_VERSION = '[^']*'/, `window.COLDIGO_VERSION = '${version}'`);
fs.writeFileSync(html, s);
fs.writeFileSync(vjson, JSON.stringify({ version }, null, 2) + '\n');
console.log('versão', version);
