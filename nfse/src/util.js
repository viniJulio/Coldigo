'use strict';

const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

function cnpjValido(entrada) {
  const c = soDigitos(entrada);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = (base) => {
    let soma = 0; let peso = base.length - 7;
    for (const d of base) { soma += Number(d) * peso--; if (peso < 2) peso = 9; }
    const r = soma % 11; return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(c.slice(0, 12));
  const d2 = dv(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

// Gera um CNPJ válido a partir de 12 dígitos-base (usado só pelo simulador e testes).
function cnpjComDv(base12) {
  const dv = (base) => {
    let soma = 0; let peso = base.length - 7;
    for (const d of base) { soma += Number(d) * peso--; if (peso < 2) peso = 9; }
    const r = soma % 11; return r < 2 ? 0 : 11 - r;
  };
  const b = String(base12).padStart(12, '0').slice(0, 12);
  const d1 = dv(b); return `${b}${d1}${dv(b + d1)}`;
}

const fmtCnpj = (c) => soDigitos(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const competenciaDe = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const competenciaValida = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(c || '');
function competenciaAnterior(d = new Date()) {
  return competenciaDe(new Date(d.getFullYear(), d.getMonth() - 1, 1));
}
const emailValido = (e) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e || '') && e.length <= 254;

module.exports = { soDigitos, cnpjValido, cnpjComDv, fmtCnpj, competenciaDe, competenciaValida, competenciaAnterior, emailValido };
