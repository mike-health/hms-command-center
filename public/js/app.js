/* ===== HMS Command Center — Shared JS ===== */

const API_URL = '';
const HUB_URL = 'https://hms-partner-news.netlify.app/';

function mountHubBar() {
  if (document.querySelector('a.hms-hub-return')) return;
  const bar = document.createElement('a');
  bar.className = 'hms-hub-return';
  bar.href = HUB_URL;
  bar.textContent = '← Back to HMS hub';
  document.body.insertBefore(bar, document.body.firstChild);
}

async function loadState() {
  try {
    const res = await fetch(`${API_URL}/api/state`);
    const json = await res.json();
    if (json.success) return json;
  } catch (e) {
    console.error('Load failed:', e);
  }
  return { success: false };
}

async function saveState(data) {
  try {
    const res = await fetch(`${API_URL}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (e) {
    console.error('Save failed:', e);
    return { success: false };
  }
}

const NOT_YET_AVAILABLE = 'not yet available';

function isBlankValue(value) {
  return value == null || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

function displayValue(value) {
  if (isBlankValue(value)) return NOT_YET_AVAILABLE;
  return String(value);
}

function formatUsd(amount) {
  if (isBlankValue(amount)) return NOT_YET_AVAILABLE;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));
}

function statusBadgeTone(status) {
  if (isBlankValue(status)) return 'gray';
  const s = String(status).toLowerCase();
  if (s === 'open' || s.startsWith('open ') || s === 'operational') return 'green';
  if (s.includes('opening') || s === 'startup') return 'blue';
  if (s === 'build' || s === 'partly') return 'amber';
  return 'gray';
}

function hasMapPoint(clinic) {
  return clinic && clinic.lat != null && clinic.lng != null
    && !Number.isNaN(Number(clinic.lat)) && !Number.isNaN(Number(clinic.lng));
}

function snapshotAsOf(state) {
  const snap = state && (state.clinicSnapshot || state);
  return (snap && (snap.asOf || snap.generated))
    || (state && state.dataNotes && state.dataNotes.clinicAsOf)
    || null;
}

function asOfHtml(state) {
  const asOf = snapshotAsOf(state);
  if (!asOf) return '';
  return `<span class="as-of-pill">As of ${esc(asOf)}</span>`;
}

function clinicStatusNote(clinic) {
  if (!clinic || !clinic.statusNote || !clinic.statusNote.text) return null;
  return clinic.statusNote;
}

function clinicStatusNoteHtml(clinic) {
  const note = clinicStatusNote(clinic);
  if (!note) return '';
  const source = note.source
    ? `<span class="clinic-status-source">${esc(note.source)}</span>`
    : '';
  return `<div class="clinic-status-note">${esc(note.text)}${source}</div>`;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function showStatus(elId, type, text) {
  const el = document.getElementById(elId || 'status-text');
  if (el) el.textContent = text;
  const dot = document.getElementById('status-dot');
  if (dot) {
    dot.className = 'status-dot' + (type === 'saving' ? ' saving' : type === 'error' ? ' error' : '');
  }
}

function setActiveNav() {
  const path = window.location.pathname;
  let page = 'dashboard';
  if (path.includes('org-chart') || path.includes('pm-chart')) page = 'org-chart';
  else if (path.includes('map') || path.includes('clinic-detail')) page = 'map';
  else if (path.includes('referrals')) page = 'referrals';
  else if (path.includes('ops-board')) page = 'ops-board';
  else if (path.includes('tasks')) page = 'tasks';
  else if (path.includes('reports')) page = 'reports';

  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
}

async function exportData() {
  try {
    const res = await fetch('/api/state');
    const json = await res.json();
    if (!json.success) throw new Error('Failed');
    const data = JSON.stringify(json.data, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hms-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export failed');
  }
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.nodes || !data.clinics) throw new Error('Invalid format');
      await saveState(data);
      alert('Imported successfully. Reloading...');
      window.location.reload();
    } catch (err) {
      alert('Invalid JSON file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function resetAll() {
  if (!confirm('Reset ALL data to defaults? This cannot be undone.')) return;
  try {
    await fetch('/api/reset', { method: 'POST' });
    alert('Reset complete. Reloading...');
    window.location.reload();
  } catch {
    alert('Reset failed');
  }
}

/* Init nav + hub bar on page load */
document.addEventListener('DOMContentLoaded', () => {
  setActiveNav();
  mountHubBar();
});
