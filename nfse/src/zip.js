'use strict';
const zlib = require('node:zlib');

// Gerador de ZIP mínimo (deflate), sem dependências. Nomes em UTF-8.
function dosDataHora(d) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, data };
}

function criarZip(entradas, agora = new Date()) {
  const { hora, data } = dosDataHora(agora);
  const locais = []; const central = []; let deslocamento = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.nome, 'utf8');
    const bruto = Buffer.isBuffer(e.dados) ? e.dados : Buffer.from(e.dados, 'utf8');
    const comp = zlib.deflateRawSync(bruto);
    const crc = zlib.crc32(bruto);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt16LE(hora, 10); loc.writeUInt16LE(data, 12); loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(bruto.length, 22); loc.writeUInt16LE(nome.length, 26);
    locais.push(loc, nome, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(hora, 12); cen.writeUInt16LE(data, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(bruto.length, 24); cen.writeUInt16LE(nome.length, 28);
    cen.writeUInt32LE(deslocamento, 42);
    central.push(cen, nome);
    deslocamento += 30 + nome.length + comp.length;
  }
  const dirCentral = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(entradas.length, 8); fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(dirCentral.length, 12); fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, dirCentral, fim]);
}

module.exports = { criarZip };
