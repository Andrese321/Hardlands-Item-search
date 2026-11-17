// Versión visible al pie de cada página: sirve para saber si el móvil ya tiene la última.
export const VERSION = '2026.11.17-e';

const el = document.getElementById('app-version');
if (el) el.textContent = 'Versión ' + VERSION;
