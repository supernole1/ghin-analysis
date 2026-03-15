# GHIN Analysis

## Overview
A web app that shows hole-by-hole scoring averages, round score distributions, and scoring trends for any course you've played, using data from your GHIN account. Originally an R-based web scraper (`ScrapeGHIN.R`), now a static web app hosted on GitHub Pages with a Cloudflare Worker proxy.

## Architecture

```
Browser (GitHub Pages)  →  Cloudflare Worker (proxy)  →  GHIN API (api2.ghin.com)
```

- **Frontend**: Static HTML/CSS/JS served from GitHub Pages
- **Proxy**: Cloudflare Worker (free tier) forwards requests to `api2.ghin.com/api/v1`, adds required headers, handles CORS
- **Credentials**: User enters GHIN # and password at runtime — stored in browser memory only (session lifetime), never in code or repos

## Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS, Chart.js 4 for visualizations
- **Proxy**: Cloudflare Worker (ES module format)
- **API**: GHIN REST API at `api2.ghin.com/api/v1`
- **Hosting**: GitHub Pages (static files)

## UI Panels (in order)
1. **Hole-by-Hole Bar Chart** — avg score vs par per hole, with ±1 std dev error bars
2. **Round Score Distribution** — descriptor stat cards (count, mean, median, std dev, best, worst, range) + histogram of 18-hole round totals + 20-round moving average line chart
3. **Hole-by-Hole Table** — sortable: hole, par, avg score, vs par, std dev, best, worst, rounds

## Key Data Rules
- Only **18-hole rounds** (exactly 18 `hole_details` entries) are included in the round distribution panel
- Rounds where any hole has a score `<= 0` are excluded (GHIN stores missing holes as 0, not null)
- Scores use `adjusted_gross_score` with fallback to `raw_score`
- Login requires a Firebase Installation token first; if that call fails the login proceeds without it

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
1. **GitHub**: commit all files (sans `ScrapeGHIN.R`), push to GitHub
2. **GitHub Pages**: Enable in repo Settings → Pages → Source: master branch, root `/`
   - Live URL: `https://supernole1.github.io/ghin-analysis`
3. **Cloudflare Worker**:
   - Dashboard: cloudflare.com → Workers & Pages → your worker
   - Worker URL: `https://ghin-proxy.supernole1.workers.dev`
   - `ALLOWED_ORIGIN` is set to `https://supernole1.github.io` — change to `*` for local dev, then redeploy
4. **Local dev**: run `python -m http.server 8080` in the project root; requires worker `ALLOWED_ORIGIN = '*'`
5. **Cache busting**: bump `?v=N` on the `<script src="app.js?v=...">` tag in `index.html` when CDN caching is suspected

## Original R Script (ScrapeGHIN.R)
- Uses selenider/chromote for browser automation to scrape score history from ghin.com
- Extracts: Score, Date, Course Rating/Slope, Differential
- Filters by past 12 months of scores
- **Contains credentials — do NOT commit to a public repo**
