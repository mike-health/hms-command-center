# HMS Command Center

## Architecture
Single Express app with modular HTML pages. One JSON data file. Zero build step.

**Folder:** `~/.openclaw/workspace/hms-command-center/`

## Modules (Current)
| Module | File | Status |
|--------|------|--------|
| Dashboard | `public/index.html` | ✅ Live |
| Org Chart | `public/modules/org-chart.html` | ✅ Live |
| Clinic Map | `public/modules/map.html` | ✅ Live |
| Referrals | `public/modules/referrals.html` | ✅ Live |
| Tasks | `public/modules/tasks.html` | ✅ Live |
| Reports | `public/modules/reports.html` | ✅ Live |

## How to Add a Module
1. Create `public/modules/your-module.html`
2. Copy sidebar nav from any existing module
3. Add your module link to the sidebar
4. Add data defaults to `server.js` `getDefaults()`
5. Add API endpoint if needed
6. Done — no build, no deploy step, just refresh

## Future Modules (Planned)
- **Billing Extraction** — EHR integration, automated billing/receipt capture
- **Camera App** — Location photos, site documentation, equipment photos
- (More to come)

## Live URL (Temporary)
https://thumbnail-possession-guy-condos.trycloudflare.com

## Deploy
```bash
cd hms-command-center
npm install
node server.js
```

Or deploy folder to Render/Railway/VPS (Dockerfile + configs included).
