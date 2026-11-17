import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeAdvice, sizeText, looksLikeTar } from '../js/sizewarn.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const level = (size, opts) => sizeAdvice(size, opts)?.level ?? null;

test('niveles de aviso en el móvil', () => {
  const m = { mobile: true, tool: 'items' };
  assert.equal(level(100 * MB, m), null);
  assert.equal(level(600 * MB, m), 'info');
  assert.equal(level(2 * GB, m), 'warn');
  assert.equal(level(9 * GB, m), 'danger');
  // un .tar.gz avisa antes: hay que descomprimirlo entero
  assert.equal(level(300 * MB, { ...m, tar: true }), 'info');
  assert.equal(level(700 * MB, { ...m, tar: true }), 'warn');
  assert.equal(level(2 * GB, { ...m, tar: true }), 'danger');
});

test('en un ordenador los límites son más altos', () => {
  const d = { mobile: false, tool: 'items' };
  assert.equal(level(1 * GB, d), null);
  assert.equal(level(9 * GB, d), 'warn');
  assert.equal(level(20 * GB, d), 'danger');
});

test('textos: memoria, tiempo, espacio libre y recomendación de ordenador', () => {
  const a = sizeAdvice(9 * GB, { mobile: true, tool: 'chunks' });
  const all = a.lines.join(' ');
  assert.match(a.title, /demasiado grande para el móvil/);
  assert.match(all, /MUY PROBABLE QUE NO FUNCIONE/);
  assert.match(all, /9,0 GB libres/);
  assert.match(all, /ordenador/);
  assert.match(all, /minutos|hora/);
  assert.match(sizeAdvice(2 * GB, { mobile: true, tar: true }).lines.join(' '), /\.zip/);
  // «Semilla» con .zip solo lee el level.dat: sin aviso
  assert.equal(sizeAdvice(9 * GB, { mobile: true, tool: 'seed' }), null);
  assert.equal(level(9 * GB, { mobile: true, tool: 'seed', tar: true }), 'danger');
});

test('utilidades', () => {
  assert.equal(sizeText(9 * GB), '9,0 GB');
  assert.equal(sizeText(512 * MB), '512 MB');
  assert.ok(looksLikeTar('copia.tar.gz') && looksLikeTar('x.TGZ') && looksLikeTar('a.tar'));
  assert.ok(!looksLikeTar('mundo.mcworld') && !looksLikeTar('mundo.zip'));
});
