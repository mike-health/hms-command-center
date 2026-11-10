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
| `VISIT_HMAC_SECRET` | For IP hashing | HMAC secret used to hash client IPs. Raw IPs are never stored. If this and `VISIT_INGEST_URL` are both unset, `POST /api/visit-log` returns **204** and does nothing. |
| `VISIT_INGEST_URL` | For durable logs | HTTPS endpoint that receives each visit (`need: "partner_visit_log"`, fields compatible with `partner-visits.db`). Render disk is ephemeral, so this is the durable store. |
| `VISIT_INGEST_AUTH` | No | Optional `Authorization` value for the ingest URL (a bare token is sent as `Bearer …`). |

Do not put the API key, HMAC secret, ingest URL, or ingest token in client JavaScript or commit them.

### Visitor fingerprint log

Every live HTML page loads `public/js/visit-log.js`. It builds a local fingerprint plus screen, timezone, language, and path, then `POST`s to `/api/visit-log` with `keepalive`. Failures are swallowed; pages never gate or change appearance.

`site` is always `"hms-command-center"`. Persistence: forward to `VISIT_INGEST_URL` (same payload the owner syncs into `partner-visits.db`). In-process memory counts hits for the current Render instance; if ingest is unset or fails, the same ingest JSON is written to stdout as `visit-log {…}` so log drains can recover it. Do not rely on the container filesystem.

```bash
# After setting VISIT_HMAC_SECRET (and optionally ingest vars) on the host:
curl -sS -D - -o /tmp/visit-log-body.json \
  -H 'content-type: application/json' \
  -H 'x-forwarded-for: 203.0.113.9' \
  -d '{"fp":"verifyfp01","ua":"curl","screen":"1x1","tz":"UTC","lang":"en","path":"/"}' \
  http://localhost:3000/api/visit-log
# Expect HTTP 200 and {"ok":true,"hits":1,"whitelist":false}
```

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
