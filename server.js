const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { getOpsCadenceBoard } = require('./lib/ops-cadence');
const { applyOpsPlan, previewOpsInstruction } = require('./lib/ops-chat');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Resolve public directory
const PUBLIC_DIR = path.join(__dirname, 'public');
console.log('Server starting from:', __dirname);
console.log('Public directory:', PUBLIC_DIR);
console.log('Public exists:', fs.existsSync(PUBLIC_DIR));

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'command-center.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Factory defaults captured at process start from committed seed (immune to runtime saves)
const FACTORY_DEFAULTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'command-center.json'), 'utf-8')
);

function getDefaults() {
  return {
    ...JSON.parse(JSON.stringify(FACTORY_DEFAULTS)),
    lastModified: new Date().toISOString()
  };
}

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
    catch (e) { console.error('Data corrupt, resetting'); }
  }
  const d = getDefaults();
  save(d);
  return d;
}

function save(data) {
  data.lastModified = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = load();

/* ===== API ===== */
app.get('/api/state', (req, res) => res.json({ success: true, data }));

app.post('/api/state', (req, res) => {
  const { nodes, clinics, referrals, tasks, alerts } = req.body;
  if (nodes) data.nodes = nodes;
  if (clinics) data.clinics = clinics;
  if (referrals) data.referrals = referrals;
  if (tasks) data.tasks = tasks;
  if (alerts) data.alerts = alerts;
  save(data);
  res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
  data = getDefaults();
  save(data);
  res.json({ success: true, data });
});

/* Module-specific APIs */
app.get('/api/clinics', (req, res) => res.json({ success: true, data: data.clinics }));
app.get('/api/referrals', (req, res) => res.json({ success: true, data: data.referrals }));
app.get('/api/tasks', (req, res) => res.json({ success: true, data: data.tasks }));
app.get('/api/alerts', (req, res) => res.json({ success: true, data: data.alerts }));

app.get('/api/ops-cadence', async (req, res) => {
  try {
    const board = await getOpsCadenceBoard();
    res.json({ success: true, ...board });
  } catch (err) {
    console.error('Ops cadence fetch failed:', err.message);
    res.status(502).json({ success: false, error: err.message || 'Failed to load Linear issues' });
  }
});

app.post('/api/ops-cadence/preview', async (req, res) => {
  try {
    const result = await previewOpsInstruction(req.body || {});
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Ops chat preview failed:', err.message);
    res.status(502).json({ success: false, error: err.message || 'Preview failed' });
  }
});

app.post('/api/ops-cadence/apply', async (req, res) => {
  try {
    const result = await applyOpsPlan(req.body || {});
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Ops chat apply failed:', err.message);
    res.status(502).json({ success: false, error: err.message || 'Apply failed' });
  }
});
app.get('/api/summary', (req, res) => {
  const totalRevenue = data.clinics.reduce((s, c) => s + (c.revenue || 0), 0);
  const totalExpenses = data.clinics.reduce((s, c) => s + (c.expenses || 0), 0);
  const totalPatients = data.clinics.reduce((s, c) => s + (c.patientsMonth || 0), 0);
  const activeReferrals = data.referrals.filter(r => r.status === 'active').length;
  const pendingTasks = data.tasks.filter(t => t.status !== 'completed').length;
  const urgentAlerts = data.alerts.filter(a => a.type === 'urgent').length;
  res.json({
    success: true,
    data: {
      totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses,
      totalPatients, activeReferrals, pendingTasks, urgentAlerts,
      clinicCount: data.clinics.length,
      operationalClinics: data.clinics.filter(c => c.status === 'operational').length
    }
  });
});

/* ===== STATIC FILES ===== */
// Explicitly serve each HTML module page (works even if static middleware fails)
const modulePages = ['index.html', 'modules/org-chart.html', 'modules/map.html', 'modules/referrals.html', 'modules/tasks.html', 'modules/ops-board.html', 'modules/reports.html'];

modulePages.forEach(page => {
  const filePath = path.join(PUBLIC_DIR, page);
  const route = page === 'index.html' ? '/' : '/' + page;
  app.get(route, (req, res) => {
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).send(`File not found: ${filePath}`);
    }
  });
});

// Static assets (CSS, JS, images)
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));
app.use('/modules', express.static(path.join(PUBLIC_DIR, 'modules')));

// Fallback for SPA routes
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ success: false, error: 'Not found' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HMS Command Center running on http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
