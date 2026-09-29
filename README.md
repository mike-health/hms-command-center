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
| Pleasant Hill | `public/modules/pleasant-hill.html` | ✅ Live (Linear, read-only) |
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
| `LINEAR_API_KEY` | For live data | Linear API key (workspace **healtho2**, team **HEA**). The server calls `https://api.linear.app/graphql` and never sends the key to the browser. **Without this key the Pleasant Hill page shows “Linear not configured”** (it does not crash). The Ops board still falls back to documented mock issues. |
| `LINEAR_PROJECT_NAME` | No | Ops cadence project name. Defaults to `Ops cadence`. |
| `LINEAR_PROJECT_ID` | No | Ops cadence project id. |
| `LINEAR_TEAM_KEY` | No | Defaults to `HEA`. |
| `LINEAR_PLEASANT_HILL_PROJECT` | No | Primary clinic-build project. Defaults to `Clinic Development - Todd`. |
| `LINEAR_PLEASANT_HILL_PROJECTS` | No | Comma-separated Linear projects to scan. Defaults to `Clinic Development - Todd,Supervision Standard Rollout`. |

Do not put the API key in client JavaScript or commit it.

### Pleasant Hill page (PM filing convention)

Page: `/modules/pleasant-hill.html` (one click from the Org Chart hub via **Pleasant Hill build**). Data: `GET /api/pleasant-hill` (3-minute cache, read-only GraphQL).

**Which issues appear**

1. Team **HEA**, title starts with `Pleasant Hill:` (exact prefix), in **Clinic Development - Todd** or **Supervision Standard Rollout**.
2. In **Supervision Standard Rollout** only: titles that contain `Pleasant Hill` even without the prefix (so the parent “Bring Pleasant Hill to supervision standard” is included).
3. Do **not** file Pleasant Hill work as `Pleasanton:` — that prefix is excluded.

**Owners (Todd and Leddy have no Linear seats)**

- If the issue is unassigned, put the owner at the end of the title: `(Owner: Todd)`, `(Owner: Leddy)`, `(Owner: owner-side / Todd)`, `(Owner: Leddy/Todd)`.
- The board parses that suffix and **strips it from the displayed title**.
- Assigned issues use the Linear assignee (Mike, Rudy, …). `(Ops Director)` / `(Managing Director)` in the title also map to Rudy / Mike.

**M1–M4 gates**

Prefer Linear **project milestones** named with `M1`–`M4` if they exist. Otherwise the board parses `\bM1\b` … `\bM4\b` from the **issue title** (do not rely on issue ids):

| Gate | Meaning (no dollar amounts on the page) | Filed title marker |
|------|------------------------------------------|--------------------|
| M1 | Agreement signed | `Pleasant Hill: M1 — …` |
| M2 | Equipment delivered | `Pleasant Hill: M2 — …` |
| M3 | Rough-in complete | `Pleasant Hill: M3 — …` |
| M4 | Startup / first-patient ready | `Pleasant Hill: M4 — …` |

The page never shows `$` amounts, capital-call percents, or `40/30/20/10` splits even if they appear in Linear text.

**Optional:** `?fixture=1` renders the synthetic snapshot in `data/pleasant-hill-fixture.json` (tests/screenshots only; fake ids, no Linear URLs). Production Render should set `LINEAR_API_KEY` and omit fixture mode.

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
