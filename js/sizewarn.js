// Avisos según el tamaño del archivo del mundo.
//
// En el móvil el navegador tiene poca memoria y un procesador más lento: un
// mundo de varios GB puede tardar muchísimo o hacer que la página se cierre.
// Este módulo calcula el aviso, lo muestra bien visible y recuerda si la
// página se cerró a mitad de un archivo grande (casi siempre por memoria).

const MB = 1024 * 1024;
const GB = 1024 * MB;

export function isMobile() {
  if (typeof navigator === 'undefined') return false;
  if (navigator.userAgentData?.mobile) return true;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  // iPad moderno se presenta como Mac con pantalla táctil
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

export function sizeText(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function minutesText(seconds) {
  if (seconds < 90) return 'alrededor de un minuto';
  const m = Math.round(seconds / 60);
  return m < 60 ? `unos ${m} minutos` : `más de ${Math.floor(m / 60)} hora${m >= 120 ? 's' : ''}`;
}

/**
 * Calcula el aviso para un archivo.
 * @param size bytes del archivo (o de la carpeta)
 * @param opts.tar si es .tar.gz/.tar (hay que descomprimirlo entero en el navegador)
 * @param opts.tool 'items' | 'chunks' | 'files' | 'seed'
 * @param opts.mobile si es un móvil (por defecto se detecta)
 * @returns null o { level: 'info'|'warn'|'danger', title, lines: [] }
 */
export function sizeAdvice(size, { tar = false, tool = 'items', mobile = isMobile() } = {}) {
  // En «Semilla» un .zip solo necesita el level.dat: el tamaño da igual.
  if (tool === 'seed' && !tar) return null;
  const limits = mobile
    ? (tar ? [200 * MB, 500 * MB, 1.5 * GB] : [500 * MB, 1.5 * GB, 4 * GB])
    : (tar ? [1 * GB, 3 * GB, 8 * GB] : [2 * GB, 6 * GB, 16 * GB]);
  const level = size >= limits[2] ? 'danger' : size >= limits[1] ? 'warn' : size >= limits[0] ? 'info' : null;
  if (!level) return null;

  const speed = (mobile ? 12 : 40) * MB; // bytes por segundo, medido aproximado
  const passes = tool === 'chunks' ? 2 : 1; // chunks: analizar + vista satélite
  const time = minutesText((size / speed) * passes);
  const where = mobile ? 'en el móvil' : 'en este ordenador';
  const lines = [];

  if (level === 'danger') {
    lines.push(mobile
      ? `Con un archivo de ${sizeText(size)}, en el móvil es MUY PROBABLE QUE NO FUNCIONE: el navegador puede quedarse sin memoria y cerrar la página sin avisar.`
      : `Con un archivo de ${sizeText(size)} puede que el navegador se quede sin memoria y cierre la página.`);
  } else if (level === 'warn') {
    lines.push(mobile
      ? `Es un mundo grande (${sizeText(size)}). En el móvil puede tardar mucho o cerrarse la página por falta de memoria.`
      : `Es un mundo grande (${sizeText(size)}): tardará un buen rato.`);
  } else {
    lines.push(`Mundo grande (${sizeText(size)}): puede tardar ${time} ${where}.`);
  }
  if (level !== 'info') lines.push(`Tiempo aproximado ${where}: ${time}. No cierres la página ni cambies de app mientras tanto.`);
  if (tar) {
    lines.push('Los .tar.gz hay que descomprimirlos enteros dentro del navegador, lo que gasta mucha más memoria. Si puedes, descarga la copia en .zip: la app la lee por partes.');
  }
  if ((tool === 'chunks' || tool === 'files') && level !== 'info') {
    lines.push(`Para descargar el mundo modificado necesitarás otros ${sizeText(size)} libres (y Minecraft necesita espacio parecido al importarlo).`);
  }
  if (mobile && level !== 'info') {
    lines.push('Para mundos así es mucho mejor usar un ordenador: abre esta misma web en Chrome o Edge.');
  }
  const title = level === 'danger'
    ? (mobile ? '⚠️ Archivo demasiado grande para el móvil' : '⚠️ Archivo muy grande')
    : level === 'warn' ? '⚠️ Archivo grande' : 'Archivo grande';
  return { level, title, lines };
}

// ---------------------------------------------------------------- aviso en la página

function banner() {
  let el = document.getElementById('size-alert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'size-alert';
    el.setAttribute('role', 'alert');
    document.querySelector('main')?.prepend(el);
  }
  return el;
}

/** Muestra (o quita, con null) el aviso grande al principio de la página. */
export function showSizeAlert(advice) {
  const el = banner();
  if (!advice) {
    el.hidden = true;
    return;
  }
  el.className = 'size-alert size-alert-' + advice.level;
  el.hidden = false;
  const title = document.createElement('strong');
  title.textContent = advice.title;
  const list = document.createElement('ul');
  for (const line of advice.lines) {
    const li = document.createElement('li');
    li.textContent = line;
    list.append(li);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn small';
  close.textContent = 'Entendido';
  close.addEventListener('click', () => (el.hidden = true));
  el.replaceChildren(title, list, close);
}

/**
 * Antes de abrir un archivo: calcula el aviso, lo muestra y, si el riesgo es
 * alto, pide confirmación. Devuelve false si el usuario prefiere no seguir.
 */
export function checkBeforeOpen(size, opts) {
  const advice = sizeAdvice(size, opts);
  showSizeAlert(advice);
  if (advice?.level === 'danger') {
    return window.confirm(`${advice.title}\n\n${advice.lines.join('\n\n')}\n\n¿Intentarlo de todos modos?`);
  }
  return true;
}

/** ¿Es un .tar.gz / .tgz / .tar? (por el nombre; el contenido se comprueba al abrir) */
export function looksLikeTar(name) {
  return /\.(tar\.gz|tgz|tar|gz)$/i.test(name || '');
}

// ---------------------------------------------------------------- cierres inesperados

const KEY = 'hardlands-procesando';

/** Recuerda que se está procesando un archivo grande (para detectar si la página se cierra). */
export function markStart(what, size) {
  if (size < 200 * MB) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ what, size, page: location.pathname, at: Date.now() }));
  } catch {
    /* sin almacenamiento */
  }
}

export function markDone() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* sin almacenamiento */
  }
}

/** Si la última vez la página se cerró a mitad de un archivo grande, avisa. */
export function checkPreviousCrash() {
  let info = null;
  try {
    info = JSON.parse(localStorage.getItem(KEY) || 'null');
    localStorage.removeItem(KEY);
  } catch {
    return;
  }
  if (!info || Date.now() - info.at > 6 * 3600 * 1000) return;
  showSizeAlert({
    level: 'danger',
    title: '⚠️ La última vez no terminó',
    lines: [
      `La página se cerró mientras procesaba ${info.what} (${sizeText(info.size)}).`,
      isMobile()
        ? 'Si se cerró sola, casi seguro fue porque el móvil se quedó sin memoria con un archivo tan grande. Prueba en un ordenador (esta misma web en Chrome o Edge), o con una copia más pequeña del mundo.'
        : 'Si se cerró sola, seguramente fue por falta de memoria. Cierra otras pestañas y vuelve a intentarlo, o prueba con una copia más pequeña.',
    ],
  });
}

/** Mensaje de error más útil cuando el navegador se queda sin memoria. */
export function explainError(message) {
  if (/memory|allocation|Array buffer|RangeError|out of|quota|NotReadableError/i.test(message || '')) {
    return `${message}. Parece que el navegador se quedó sin memoria o espacio con este archivo. ` +
      (isMobile() ? 'En el móvil, prueba en un ordenador o con una copia más pequeña del mundo.' : 'Cierra otras pestañas o prueba con una copia más pequeña.');
  }
  return message;
}
