/**
 * Stock TGA — Alerta de auto en exposición vendido
 *
 * Este script vive en una planilla SEPARADA y lee la planilla maestra por ID.
 * Planilla maestra (donde está la hoja "stock"):
 *   https://docs.google.com/spreadsheets/d/1KvuRZzHuVpWSppZqT8xDf8WSrplR-vYzeY0gQPftlpQ
 *
 * Hoja: "stock"
 * Columnas relevantes:
 *   A=1  serie
 *   C=3  unidad (modelo + versión exacto)
 *   D=4  color
 *   G=7  vendido (#N/A si no, modelo si ya se vendió)
 *   P=16 salón en exposición (ENTRE RIOS / INDEPENDENCIA)
 *
 * Trigger: ejecutar `notificarExposicionesVendidas` cada 5 minutos
 * (Triggers → Add Trigger → Time-driven → Minutes timer → Every 5 minutes).
 *
 * Setup inicial:
 *   1) Crear una planilla NUEVA aparte y abrir su Apps Script (Extensiones → Apps Script).
 *   2) Pegar este código.
 *   3) Ir a Project Settings → Script Properties y agregar:
 *        - STOCK_NOTIF_SECRET = <mismo valor que el secret en Supabase>
 *        - EDGE_FN_URL = https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/notify-exposicion-vendida
 *   4) Ejecutar UNA VEZ la función `bootstrapMarcarTodoNotificado()` para que
 *      la primera ejecución no avise todas las ventas viejas que ya están en G.
 *   5) Crear el trigger time-based cada 5 minutos sobre `notificarExposicionesVendidas`.
 *
 * Helpers manuales (correr a mano si hace falta):
 *   - testEnvioManual()           → manda 1 mensaje de prueba con datos dummy
 *   - listarPendientes()          → loguea qué filas detectaría como nuevas
 *   - resetSnapshot()             → borra el snapshot (CUIDADO: la próxima corrida re-notifica todo)
 */

const PLANILLA_STOCK_ID = '1KvuRZzHuVpWSppZqT8xDf8WSrplR-vYzeY0gQPftlpQ';
const HOJA_STOCK = 'stock';
const COL = { SERIE: 1, UNIDAD: 3, COLOR: 4, VENDIDO: 7, SALON: 16 };
const SALONES_EXPOSICION = ['ENTRE RIOS', 'INDEPENDENCIA'];
const SNAPSHOT_KEY = 'stock_notif_snapshot_v1';

function abrirHojaStock() {
  const ss = SpreadsheetApp.openById(PLANILLA_STOCK_ID);
  const hoja = ss.getSheetByName(HOJA_STOCK);
  if (!hoja) throw new Error(`No existe la hoja "${HOJA_STOCK}" en la planilla maestra.`);
  return hoja;
}

function notificarExposicionesVendidas() {
  const props = PropertiesService.getScriptProperties();
  const edgeUrl = props.getProperty('EDGE_FN_URL');
  const secret = props.getProperty('STOCK_NOTIF_SECRET');
  if (!edgeUrl || !secret) {
    throw new Error('Faltan EDGE_FN_URL o STOCK_NOTIF_SECRET en Script Properties.');
  }

  const hoja = abrirHojaStock();
  const snapshotPrevio = leerSnapshot();
  const { pendientes, snapshotActualizado, removidas } = procesarFilas(hoja, snapshotPrevio);

  if (removidas.length > 0) {
    Logger.log(`Limpiadas del snapshot (des-vendidas o fuera de expo): ${removidas.join(', ')}`);
  }

  if (pendientes.length === 0) {
    Logger.log('Sin novedades.');
    guardarSnapshot(snapshotActualizado);
    return;
  }

  for (const item of pendientes) {
    const ok = enviarAviso(edgeUrl, secret, item);
    if (ok) {
      snapshotActualizado[item.serie] = new Date().toISOString();
      Logger.log(`OK — ${item.serie} ${item.unidad} (${item.salon})`);
    } else {
      Logger.log(`FALLÓ — ${item.serie} ${item.unidad} (queda pendiente, se reintentará)`);
    }
  }

  guardarSnapshot(snapshotActualizado);
}

function procesarFilas(hoja, snapshotPrevio) {
  const snapshot = Object.assign({}, snapshotPrevio);
  const pendientes = [];
  const removidas = [];
  const lastRow = hoja.getLastRow();
  if (lastRow < 2) return { pendientes, snapshotActualizado: snapshot, removidas };

  const valores = hoja.getRange(2, 1, lastRow - 1, COL.SALON).getValues();

  for (const fila of valores) {
    const serie = String(fila[COL.SERIE - 1] || '').trim();
    if (!serie) continue;

    const salon = String(fila[COL.SALON - 1] || '').trim().toUpperCase();
    const enExpo = SALONES_EXPOSICION.includes(salon);
    const vendida = esVendido(fila[COL.VENDIDO - 1]);

    if (!enExpo) {
      if (snapshot[serie]) {
        delete snapshot[serie];
        removidas.push(serie);
      }
      continue;
    }

    if (vendida) {
      if (!snapshot[serie]) {
        pendientes.push({
          serie,
          unidad: String(fila[COL.UNIDAD - 1] || '').trim() || '—',
          color: String(fila[COL.COLOR - 1] || '').trim() || '—',
          salon,
        });
      }
    } else {
      if (snapshot[serie]) {
        delete snapshot[serie];
        removidas.push(serie);
      }
    }
  }
  return { pendientes, snapshotActualizado: snapshot, removidas };
}

function detectarPendientes(hoja, snapshot) {
  return procesarFilas(hoja, snapshot).pendientes;
}

function esVendido(g) {
  if (g === null || g === undefined || g === '') return false;
  const s = String(g).trim();
  if (!s) return false;
  if (s === '#N/A' || s === 'N/A' || s.startsWith('#')) return false;
  return true;
}

function enviarAviso(edgeUrl, secret, item) {
  const payload = {
    serie: item.serie,
    unidad: item.unidad,
    color: item.color,
    salon: item.salon,
  };
  try {
    const res = UrlFetchApp.fetch(edgeUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-stock-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const txt = res.getContentText();
    Logger.log(`Edge fn → ${code}: ${txt}`);
    return code >= 200 && code < 300;
  } catch (e) {
    Logger.log(`Error fetch: ${e}`);
    return false;
  }
}

function leerSnapshot() {
  const raw = PropertiesService.getScriptProperties().getProperty(SNAPSHOT_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

function guardarSnapshot(snapshot) {
  PropertiesService.getScriptProperties().setProperty(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

// === Helpers manuales ===

function bootstrapMarcarTodoNotificado() {
  const hoja = abrirHojaStock();
  const lastRow = hoja.getLastRow();
  const valores = hoja.getRange(2, 1, lastRow - 1, COL.SALON).getValues();
  const snapshot = {};
  let n = 0;
  for (const fila of valores) {
    const serie = String(fila[COL.SERIE - 1] || '').trim();
    if (!serie) continue;
    const salon = String(fila[COL.SALON - 1] || '').trim().toUpperCase();
    if (!SALONES_EXPOSICION.includes(salon)) continue;
    if (!esVendido(fila[COL.VENDIDO - 1])) continue;
    snapshot[serie] = 'bootstrap';
    n++;
  }
  guardarSnapshot(snapshot);
  Logger.log(`Snapshot inicial guardado con ${n} series ya marcadas como notificadas.`);
}

function listarPendientes() {
  const hoja = abrirHojaStock();
  const pend = detectarPendientes(hoja, leerSnapshot());
  Logger.log(`Pendientes: ${pend.length}`);
  pend.forEach((p) => Logger.log(JSON.stringify(p)));
}

function resetSnapshot() {
  PropertiesService.getScriptProperties().deleteProperty(SNAPSHOT_KEY);
  Logger.log('Snapshot borrado. ATENCIÓN: la próxima corrida re-notifica todo.');
}

function testEnvioManual() {
  const props = PropertiesService.getScriptProperties();
  const edgeUrl = props.getProperty('EDGE_FN_URL');
  const secret = props.getProperty('STOCK_NOTIF_SECRET');
  enviarAviso(edgeUrl, secret, {
    serie: 'TEST-0000',
    unidad: 'Polo Track MSI',
    color: 'Blanco Candy',
    salon: 'ENTRE RIOS',
  });
}
