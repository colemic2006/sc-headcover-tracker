# Scotty Cameron Headcover Market Tracker

Secondary market price tracker for Scotty Cameron putter headcovers. Pulls real-time sold listings, active listings, market stats, and arbitrage detection from eBay.

## Architecture

```
GitHub Pages (docs/index.html)
        |
        | fetch()
        v
Cloudflare Worker (worker/index.js)   <-- proxy + auth
        |
        | eBay Browse API
        v
eBay (sold items, active listings, item details)
```

Same pattern as the Role Analyzer. The Worker handles eBay OAuth and keeps credentials out of the browser.

---

## Setup

### 1. Get a free eBay Developer account

1. Go to https://developer.ebay.com
2. Create an account and a new Application
3. Copy your **App ID (Client ID)** and **Cert ID (Client Secret)**
4. Make sure the app has access to the **Browse API** (it should by default)

> The Browse API is free with no per-call fees for basic usage.

### 2. Deploy the Cloudflare Worker

```bash
cd worker
npm install -g wrangler
wrangler login

# Deploy
wrangler deploy

# Set your eBay credentials as secrets (never in code)
wrangler secret put EBAY_APP_ID
wrangler secret put EBAY_CERT_ID
```

Your Worker URL will be something like:
`https://sc-headcover-tracker.YOUR-SUBDOMAIN.workers.dev`

### 3. Update the frontend

In `docs/index.html`, find this line near the top of the `<script>` block:

```javascript
const WORKER_URL = "https://sc-headcover-tracker.YOUR-SUBDOMAIN.workers.dev";
```

Replace it with your actual Worker URL.

### 4. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/colemic2006/sc-headcover-tracker.git
git push -u origin main
```

In GitHub repo settings, enable Pages from the `docs/` folder on `main`.

Your tracker will be live at:
`https://colemic2006.github.io/sc-headcover-tracker/`

---

## Features

- **Market Overview** - search + filter by model, sort by price/recency
- **Sold History** - completed/sold eBay listings with price stats (avg, median, range)
- **Active Listings** - current BIN and auction listings
- **Popular Models** - pre-built model cards with avg prices and one-click market pull
- **Arbitrage Detection** - flags active listings priced below 80% of median sold price
- **Sell-through Rate** - ratio of sold vs. active, a demand signal

## Worker API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Worker health check |
| `GET /search?q=...&type=sold|active|all&sort=...&limit=...` | Search listings |
| `GET /stats?q=...` | Full stats: sold + active + arbitrage in one call |

## Notes

- The eBay Browse API returns "completed" items when `soldItems:true` is set. This covers standard sold listings. For granular sold-only filtering the Finding API (legacy) is more reliable but requires a different auth flow.
- eBay limits free Browse API calls to 5,000/day per app. That is well above personal use.
- The Worker caches the OAuth token in memory for its lifetime, so token refreshes are rare.
- Prices shown are eBay sold prices and do not include buyer's premium or tax.
