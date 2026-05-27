const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'command-center.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function getDefaults() {
  return {
    version: '1.0.0',
    lastModified: new Date().toISOString(),
    nodes: {
      greene: { id: 'greene', name: 'Greene', title: 'Deals & Funding', role: 'Partner', description: 'Finds locations, builds partnerships, secures funding.', active: true },
      greenhalgh: { id: 'greenhalgh', name: 'Greenhalgh', title: 'Build & Operate', role: 'Partner', description: 'Feasibility analysis, site approval, operations oversight.', active: true },
      locfund: { id: 'locfund', name: 'Location Cooperation & Funding', title: 'Partnerships & Capital', role: 'Function', description: 'Negotiates leases, secures funding, manages investor relations.', active: true },
      construction: { id: 'construction', name: 'Construction Mgr', title: 'Build & Install', role: 'Manager', description: 'Manages all installation teams across sites.', active: true },
      operations: { id: 'operations', name: 'Operations Mgr', title: 'Run & Report', role: 'Manager', description: 'Oversees day-to-day clinic operations. Will be replaced by dedicated hire.', active: true },
      marketing: { id: 'marketing', name: 'Marketing Mgr', title: 'Grow & Retain', role: 'Manager', description: 'Assesses marketing needs per clinic, rolls out campaigns, maintains brand presence across all locations.', active: true },
      teamA: { id: 'teamA', name: 'Install Team A', title: 'Site Build', role: 'Team', description: 'Handles initial construction, equipment install, site commissioning.', active: true },
      teamB: { id: 'teamB', name: 'Install Team B', title: 'Site Build', role: 'Team', description: 'Handles initial construction, equipment install, site commissioning.', active: true },
      teamC: { id: 'teamC', name: 'Install Team C', title: 'Site Build', role: 'Team', description: 'Handles initial construction, equipment install, site commissioning.', active: true },
      mktgAsst: { id: 'mktgAsst', name: 'Mktg Assistant', title: 'Support', role: 'Assistant', description: 'Supports marketing campaigns, social media, collateral production.', active: true }
    },
    clinics: [
      { id: 'c1', name: 'Austin Hyperbaric', city: 'Austin, TX', lat: 30.2672, lng: -97.7431, status: 'operational', type: 'independent', notes: 'Running 12 chambers, 3 staff', assignedTo: 'teamA', revenue: 45000, expenses: 28000, patientsMonth: 85 },
      { id: 'c2', name: 'Phoenix Wellness', city: 'Phoenix, AZ', lat: 33.4484, lng: -112.0740, status: 'operational', type: 'independent', notes: 'Fully staffed, expanding hours', assignedTo: 'teamB', revenue: 38000, expenses: 24000, patientsMonth: 72 },
      { id: 'c3', name: 'Portland O2 Center', city: 'Portland, OR', lat: 45.5152, lng: -122.6784, status: 'partly', type: 'independent', notes: 'Partial staff, hiring 2 techs', assignedTo: 'teamC', revenue: 22000, expenses: 21000, patientsMonth: 45 },
      { id: 'c4', name: 'Nashville Recovery', city: 'Nashville, TN', lat: 36.1627, lng: -86.7816, status: 'startup', type: 'partnered', notes: 'Equipment ordered, opening Q3', assignedTo: 'construction', revenue: 0, expenses: 15000, patientsMonth: 0 },
      { id: 'c5', name: 'Denver O2 Hub', city: 'Denver, CO', lat: 39.7392, lng: -104.9903, status: 'prospective', type: 'partnered', notes: 'Lease negotiations ongoing', assignedTo: 'greene', revenue: 0, expenses: 5000, patientsMonth: 0 },
      { id: 'c6', name: 'Miami HBOT', city: 'Miami, FL', lat: 25.7617, lng: -80.1918, status: 'prospective', type: 'independent', notes: 'Market analysis complete', assignedTo: 'marketing', revenue: 0, expenses: 3000, patientsMonth: 0 }
    ],
    referrals: [
      { id: 'r1', patientName: 'John Doe', source: 'Dr. Smith', clinicId: 'c1', status: 'active', date: '2026-05-15', notes: 'Chronic wound, 20 sessions prescribed' },
      { id: 'r2', patientName: 'Jane Miller', source: 'Self', clinicId: 'c2', status: 'active', date: '2026-05-18', notes: 'Sports injury, 10 sessions' },
      { id: 'r3', patientName: 'Robert Chen', source: 'Dr. Patel', clinicId: 'c1', status: 'completed', date: '2026-04-10', notes: 'Post-surgical recovery, 15 sessions' },
      { id: 'r4', patientName: 'Sarah Wilson', source: 'Dr. Johnson', clinicId: 'c2', status: 'pending', date: '2026-05-25', notes: 'Awaiting insurance approval' }
    ],
    tasks: [
      { id: 't1', title: 'Finalize Denver lease', assignee: 'greene', due: '2026-06-15', status: 'in-progress', priority: 'high', module: 'map' },
      { id: 't2', title: 'Hire 2 techs for Portland', assignee: 'operations', due: '2026-06-01', status: 'in-progress', priority: 'high', module: 'org-chart' },
      { id: 't3', title: 'Launch Miami marketing campaign', assignee: 'marketing', due: '2026-06-30', status: 'not-started', priority: 'medium', module: 'referrals' }
    ],
    alerts: [
      { id: 'a1', type: 'warning', message: 'Portland O2 Center operating below capacity', module: 'map', time: '2026-05-26T10:00:00Z' },
      { id: 'a2', type: 'info', message: 'Nashville equipment delivery scheduled June 5', module: 'org-chart', time: '2026-05-25T14:00:00Z' },
      { id: 'a3', type: 'urgent', message: 'Denver lease expires in 45 days', module: 'map', time: '2026-05-27T08:00:00Z' }
    ]
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

/* Static files */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HMS Command Center running on http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
