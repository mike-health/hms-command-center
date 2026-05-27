/* ===== HMS Command Center — Shared JS ===== */

const API_URL = '';

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

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Debug logging helper
function log(msg, data) {
  if (typeof console !== 'undefined') {
    console.log('[HMS]', msg, data || '');
  }
}
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
  if (path.includes('org-chart')) page = 'org-chart';
  else if (path.includes('map')) page = 'map';
  else if (path.includes('referrals')) page = 'referrals';
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

/* Init nav on page load */
document.addEventListener('DOMContentLoaded', setActiveNav);
