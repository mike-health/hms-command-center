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

async function fetchSummary() {
  try {
    const res = await fetch('/api/summary');
    const j = await res.json();
    return j.success ? j.data : {};
  } catch {
    return {};
  }
}

/** Partner-facing KPI strip (dashboard + map). */
function renderPartnerKpiStrip(partner, options = {}) {
  const showSource = options.showSource !== false;
  const rev = partner.monthlyRevenue || {};
  const patients = partner.activePatients || {};
  const refs = partner.activeReferrals || {};
  const monterey = partner.monterey || {};
  const site = partner.siteProjection || {};
  const revClass = rev.isDraft ? 'sum-card kpi-draft' : 'sum-card';
  const netClass =
    !rev.isDraft && typeof rev.net === 'number'
      ? rev.net >= 0
        ? 'positive'
        : 'negative'
      : '';
  const siteClass = site.isDraft ? 'sum-card kpi-draft' : 'sum-card';
  const sourceBlock = (text) =>
    showSource ? `<div class="sum-source">${esc(text)}</div>` : '';

  return `
    <div class="summary-grid partner-kpis">
      <div class="${revClass}">
        <div class="sum-label">Monthly Revenue</div>
        <div class="sum-value">${esc(rev.display || '—')}</div>
        <div class="sum-sub ${netClass}">${esc(rev.isDraft ? rev.periodLabel || 'Draft estimate' : rev.netLabel || 'From clinic revenue fields')}</div>
        ${rev.netLabel && rev.isDraft ? `<div class="sum-sub">${esc(rev.netLabel)}</div>` : ''}
        ${sourceBlock((rev.source || 'clinics[].revenue from /api/state') + (rev.caveat ? ' — ' + rev.caveat : ''))}
      </div>
      <div class="sum-card">
        <div class="sum-label">Active Patients</div>
        <div class="sum-value">${esc(patients.display != null ? String(patients.display) : '—')}</div>
        <div class="sum-sub">${esc(patients.sub || '')}</div>
        ${sourceBlock(patients.source || 'clinics[].patientsMonth from /api/state')}
      </div>
      <div class="sum-card">
        <div class="sum-label">Active Referrals</div>
        <div class="sum-value">${esc(refs.display != null ? String(refs.display) : '—')}</div>
        <div class="sum-sub">${esc(refs.sub || '')}</div>
        ${sourceBlock(refs.source || 'open/active referrals from /api/state')}
      </div>
      <div class="sum-card kpi-monterey">
        <div class="sum-label">Monterey Operator</div>
        <div class="sum-value" style="font-size:18px;">${esc(monterey.operatorName || 'See clinic note')}</div>
        <div class="sum-sub">${esc(monterey.label || '')}</div>
        ${sourceBlock('Monterey clinic on /api/state')}
      </div>
      <div class="${siteClass}">
        <div class="sum-label">Site projection</div>
        <div class="sum-value" style="font-size:20px;">${esc(site.displayValue || '—/2 this mo')}</div>
        <div class="sum-sub">${esc(site.marginLabel || 'Margin TBD · $200k/site · max 2/mo')}</div>
        <div class="sum-sub">${esc(site.sixMoLabel || '')}</div>
        ${sourceBlock(site.source || site.assumptions || '')}
      </div>
    </div>`;
}

/* Init nav on page load */
document.addEventListener('DOMContentLoaded', setActiveNav);
