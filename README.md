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
| Ops board | `public/modules/ops-board.html` | ✅ Live (Linear) |
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

## Environment variables

Copy `.env.example` and set values in the host (Render, Railway, or a local `.env` you never commit).

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_API_KEY` | For live data | Linear API key (workspace **healthi**, team **Healthai / HEA**). The server calls `https://api.linear.app/graphql`. Without this key the Ops board serves documented mock issues. |
| `LINEAR_PROJECT_NAME` | No | Defaults to `Ops cadence`. |
| `LINEAR_PROJECT_ID` | No | Defaults to `91532ea3-24e8-4e10-981e-03b6fb245cd6`. |

Do not put the API key in client JavaScript or commit it.

### Tagging issues for the Ops board

1. Put the issue in Linear project **[Ops cadence](https://linear.app/healthi/project/ops-cadence-ebb195e01b21)**.
2. Add a **Cadence** label: `Daily`, `Weekly`, or `Monthly` (matches the board tabs).
3. Add one or more **Owner** labels (`Rudy`, `Stacey`, `Mike`, …). The people filter uses these labels, not Linear assignees.

Only **open** issues (not completed or canceled) appear. Confirm-before-spend rules stay in Linear issue text; the board does not change that workflow.

```bash
npm test
npm start
# Open http://localhost:3000/modules/ops-board.html
```
