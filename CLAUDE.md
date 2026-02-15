# GHIN Analysis

## Overview
A web app that shows **hole-by-hole scoring averages** for any course you've played, using data from your GHIN account. Originally an R-based web scraper (`ScrapeGHIN.R`), now a static web app hosted on GitHub Pages with a Cloudflare Worker proxy.

## Architecture

```
Browser (GitHub Pages)  →  Cloudflare Worker (proxy)  →  GHIN API (api2.ghin.com)
```

- **Frontend**: Static HTML/CSS/JS served from GitHub Pages
- **Proxy**: Cloudflare Worker (free tier) forwards requests to `api2.ghin.com/api/v1`, adds required headers, handles CORS
- **Credentials**: User enters GHIN # and password at runtime — stored in browser memory only (session lifetime), never in code or repos

## Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS, Chart.js for visualizations
- **Proxy**: Cloudflare Worker (ES module format)
- **API**: GHIN REST API at `api2.ghin.com/api/v1`
- **Hosting**: GitHub Pages (static files)

## File Structure
```
├── CLAUDE.md          ← this file
├── .gitignore         ← excludes ScrapeGHIN.R, .env, R artifacts
├── index.html         ← single-page app
├── app.js             ← auth, data fetching, aggregation, chart rendering
├── styles.css         ← responsive layout
├── worker/
│   └── index.js       ← Cloudflare Worker CORS proxy
└── ScrapeGHIN.R       ← original R script (gitignored, not committed)
```

## Security
- Never commit plaintext credentials to version control
- `ScrapeGHIN.R` contains hardcoded credentials — excluded via `.gitignore`
- The `.gitignore` excludes: `.env`, `*.Rhistory`, `.Rproj.user/`, `ScrapeGHIN.R`
- JWT token is held in a JS variable (memory only) — cleared on page refresh or sign-out
- Worker should restrict `Access-Control-Allow-Origin` to your GitHub Pages URL in production

## GHIN API Endpoints (via proxy)
- **Login**: `POST /golfer_login.json` — body: `{ user: { email_or_ghin, password, remember_me } }`
- **Scores**: `GET /scores.json?golfer_id=<id>&per_page=50&page=<n>` — returns paginated scores with `hole_details` arrays (each entry has `hole_number`, `par`, `raw_score`, `adjusted_gross_score`)
- **Required header**: `source: GHINcom` (added by the worker)

## Deployment Steps
1. **GitHub**: `git init`, commit all files (sans `ScrapeGHIN.R`), push to GitHub
2. **GitHub Pages**: Enable in repo Settings → Pages → Source: main branch, root `/`
3. **Cloudflare Worker**:
   - Create free account at cloudflare.com → Workers & Pages → Create Worker
   - Paste contents of `worker/index.js` → Deploy
   - Note the Worker URL (e.g., `https://ghin-proxy.<you>.workers.dev`)
4. **Connect them**: Update `WORKER_URL` in `app.js` with your Worker URL
5. **Lock down CORS**: Update `ALLOWED_ORIGIN` in `worker/index.js` to your GitHub Pages URL

## Original R Script (ScrapeGHIN.R)
- Uses selenider/chromote for browser automation to scrape score history from ghin.com
- Extracts: Score, Date, Course Rating/Slope, Differential
- Filters by past 12 months of scores
- **Contains credentials — do NOT commit to a public repo**
