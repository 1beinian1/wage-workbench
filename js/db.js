/* ============================================================
   db.js — IndexedDB Data Access Layer
   Database: wage-workbench (v1)
   Stores: workRecords, payCycles, settings
   Index: by_period (on workRecords, derived from date prefix)
   ============================================================ */

const DB_NAME = 'wage-workbench';
const DB_VERSION = 1;
const SCHEMA_VERSION = 1;

let _db = null;

/* ===== Open / Init ===== */
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // workRecords store
      if (!db.objectStoreNames.contains('workRecords')) {
        const store = db.createObjectStore('workRecords', { keyPath: 'date' });
        store.createIndex('by_period', 'period', { unique: false });
      }

      // payCycles store
      if (!db.objectStoreNames.contains('payCycles')) {
        db.createObjectStore('payCycles', { keyPath: 'periodKey' });
      }

      // settings store
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };

    req.onerror = (e) => reject(e.target.error);
  });
}

/* ===== Generic helpers ===== */
function _tx(storeName, mode = 'readonly') {
  return _db.transaction(storeName, mode).objectStore(storeName);
}

function _req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ===== Settings ===== */
async function getSettings() {
  const store = _tx('settings');
  const result = await _req(store.get('app'));
  if (!result) {
    // First-run defaults
    return {
      id: 'app',
      hourlyRate: 13,
      payday: 11,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now()
    };
  }
  return result;
}

async function saveSettings(partial) {
  const current = await getSettings();
  const updated = {
    ...current,
    ...partial,
    id: 'app',
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now()
  };
  const store = _tx('settings', 'readwrite');
  await _req(store.put(updated));
  return updated;
}

/* ===== Work Records ===== */
function _derivePeriod(date) {
  return date.substring(0, 7); // 'YYYY-MM'
}

async function getWorkRecord(date) {
  const store = _tx('workRecords');
  return _req(store.get(date));
}

async function getRecordsByPeriod(periodKey) {
  const store = _tx('workRecords');
  const idx = store.index('by_period');
  return _req(idx.getAll(periodKey));
}

async function getAllWorkRecords() {
  const store = _tx('workRecords');
  return _req(store.getAll());
}

async function saveWorkRecord(record) {
  const now = Date.now();
  const period = _derivePeriod(record.date);
  const data = {
    ...record,
    period,
    createdAt: record.createdAt || now,
    updatedAt: now
  };
  const store = _tx('workRecords', 'readwrite');
  await _req(store.put(data));
  return data;
}

async function deleteWorkRecord(date) {
  const store = _tx('workRecords', 'readwrite');
  await _req(store.delete(date));
}

/* ===== Pay Cycles ===== */
async function getPayCycle(periodKey) {
  const store = _tx('payCycles');
  return _req(store.get(periodKey));
}

async function getAllPayCycles() {
  const store = _tx('payCycles');
  return _req(store.getAll());
}

async function savePayCycle(cycle) {
  const store = _tx('payCycles', 'readwrite');
  await _req(store.put(cycle));
  return cycle;
}

/* ===== Wage calculation (should-send = real-time) ===== */
async function calcExpectedWage(periodKey) {
  const records = await getRecordsByPeriod(periodKey);
  // Only count hours > 0 (rest days excluded)
  return records
    .filter((r) => r.hours > 0)
    .reduce((sum, r) => sum + r.hours * r.rate, 0);
}

async function getPeriodStats(periodKey) {
  const records = await getRecordsByPeriod(periodKey);
  const workRecords = records.filter((r) => r.hours > 0);
  const totalHours = workRecords.reduce((sum, r) => sum + r.hours, 0);
  const expectedWage = workRecords.reduce((sum, r) => sum + r.hours * r.rate, 0);
  const days = workRecords.length;
  const avgHours = days > 0 ? totalHours / days : 0;
  return { days, totalHours, expectedWage, avgHours };
}

/* ===== Export / Import (C7) ===== */
async function exportData() {
  const [records, cycles, settings] = await Promise.all([
    getAllWorkRecords(),
    getAllPayCycles(),
    getSettings()
  ]);

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    data: {
      workRecords: records,
      payCycles: cycles,
      settings: settings
    }
  };
}

async function importData(jsonData) {
  // Validate structure
  if (!jsonData || !jsonData.data) throw new Error('Invalid JSON structure');
  const { workRecords = [], payCycles = [], settings } = jsonData.data;

  // Preview: count affected dates
  const affectedDates = workRecords.map((r) => r.date);
  const affectedPeriods = payCycles.map((c) => c.periodKey);

  return { affectedDates, affectedPeriods, workRecords, payCycles, settings };
}

async function applyImport(parsed) {
  const { workRecords, payCycles, settings } = parsed;

  // Overwrite: clear existing then put all
  const tx = _db.transaction(
    ['workRecords', 'payCycles', 'settings'],
    'readwrite'
  );

  // Clear all stores
  tx.objectStore('workRecords').clear();
  tx.objectStore('payCycles').clear();
  tx.objectStore('settings').clear();

  // Insert work records
  for (const r of workRecords) {
    const period = _derivePeriod(r.date);
    tx.objectStore('workRecords').put({ ...r, period });
  }

  // Insert pay cycles
  for (const c of payCycles) {
    tx.objectStore('payCycles').put(c);
  }

  // Insert settings
  if (settings) {
    tx.objectStore('settings').put({
      ...settings,
      id: 'app',
      updatedAt: Date.now()
    });
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/* ===== Missing days detection (C4) ===== */
async function getMissingDays() {
  const today = new Date();
  const missing = [];

  for (let day = 1; day < today.getDate(); day++) {
    const d = new Date(today.getFullYear(), today.getMonth(), day);
    const dateStr = formatDateKey(d);
    const record = await getWorkRecord(dateStr);

    if (!record) {
      // No record at all → missing (not marked as rest)
      missing.push(dateStr);
    }
  }

  return missing;
}

/* ===== Payday check (C4) ===== */
async function checkPaydayReminder() {
  const settings = await getSettings();
  const today = new Date();

  if (today.getDate() !== settings.payday) return null;

  // Check if previous period is unpaid
  const prevPeriod = getPreviousPeriod(today);
  const cycle = await getPayCycle(prevPeriod);

  if (!cycle || !cycle.isPaid) {
    return { type: 'payday', period: prevPeriod };
  }

  return null;
}

/* ===== Utility functions ===== */
function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getPeriodKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getPreviousPeriod(date) {
  const d = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return getPeriodKey(d);
}

// Compute payday ISO date for a given period = next month's payday
function computePaydayISO(periodKey, payday) {
  const [y, m] = periodKey.split('-').map(Number);
  const nextMonth = new Date(y, m, payday); // m is 0-based → m = actual month, new Date(y, m, payday) = next month
  return formatDateKey(nextMonth);
}
