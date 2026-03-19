# GHIN Analysis

A static web app that visualizes your golf scoring history from GHIN — hole-by-hole averages, round score distributions, and scoring trends for any course you've played.

**Live app:** [https://supernole1.github.io/ghin-analysis](https://supernole1.github.io/ghin-analysis)

## Features

- **Hole-by-Hole Bar Chart** — average score vs par per hole, with ±1 std dev error bars
- **Round Score Distribution** — summary stat cards (count, mean, median, std dev, best, worst, range) + histogram of 18-hole round totals + 20-round moving average line chart
- **Hole-by-Hole Table** — sortable by hole, par, avg score, vs par, std dev, best, worst, or rounds played
- **Box Plot view** — quartile distribution per hole inside the Hole-by-Hole tab

## Architecture

```
Browser (GitHub Pages)  →  Cloudflare Worker (proxy)  →  GHIN API (api2.ghin.com)
```

- **Frontend**: Vanilla HTML/CSS/JS + Chart.js 4, served from GitHub Pages
- **Proxy**: Cloudflare Worker (free tier) — forwards requests to `api2.ghin.com/api/v1`, injects required headers, handles CORS
- **Credentials**: You enter your GHIN # and password at runtime — stored in browser memory only, never in code or repos

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML / CSS / JavaScript (vanilla) |
| Charts | Chart.js 4 |
| Proxy | Cloudflare Worker (ES module) |
| Hosting | GitHub Pages |
| API | GHIN REST API (`api2.ghin.com/api/v1`) |

## File Structure

```
├── index.html        ← single-page app entry point
├── app.js            ← auth, data fetching, aggregation, chart rendering
├── styles.css        ← responsive layout
├── worker/
│   └── index.js      ← Cloudflare Worker CORS proxy
├── CLAUDE.md         ← developer notes for AI assistant
└── .gitignore
```

## Local Development

1. Clone the repo
2. Set `ALLOWED_ORIGIN = '*'` in `worker/index.js` and redeploy the Cloudflare Worker (or use your own worker)
3. Serve the frontend locally:
   ```bash
   python -m http.server 8080
   ```
4. Open `http://localhost:8080` in your browser

> **Note:** If you see stale content after deploying changes, bump the version query string on the `<script src="app.js?v=N">` tag in `index.html` to bust the CDN cache.

## Deployment

### GitHub Pages

1. Push all files to the `master` branch (excluding `ScrapeGHIN.R` — it's gitignored)
2. In repo Settings → Pages, set Source to **master branch, root `/`**

### Cloudflare Worker

1. Go to [cloudflare.com](https://cloudflare.com) → Workers & Pages → your worker
2. Set `ALLOWED_ORIGIN` to `https://supernole1.github.io` for production (or `*` for local dev)
3. Worker URL: `https://ghin-proxy.supernole1.workers.dev`

## Security

- Credentials are never stored in code or version control — entered at runtime and held in JS memory only (cleared on page refresh or sign-out)
- JWT token lives in a JS variable — not persisted to localStorage or cookies
- The Cloudflare Worker restricts `Access-Control-Allow-Origin` to the GitHub Pages origin in production

## Data Notes

- Only **18-hole rounds** (exactly 18 `hole_details` entries) are included in the round distribution panel
- Rounds where any hole score is `<= 0` are excluded (GHIN stores missing holes as `0`, not `null`)
- Scores use `adjusted_gross_score` with fallback to `raw_score`
