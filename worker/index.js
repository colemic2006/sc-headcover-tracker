/**
 * Scotty Cameron Headcover Market Tracker
 * Cloudflare Worker - eBay Browse API Proxy
 *
 * Deploy: wrangler deploy
 * Env vars required (wrangler secret put):
 *   EBAY_APP_ID   - eBay Developer App ID (Client ID)
 *   EBAY_CERT_ID  - eBay Cert ID (Client Secret)
 *
 * Endpoints:
 *   GET /search?q=...&filter=...&sort=...&type=sold|active|all
 *   GET /stats?q=...
 *   GET /health
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

// eBay category ID 1513 = Golf Equipment (covers headcovers)
const EBAY_CATEGORY_ID = "1513";

// Token cache (lives for the duration of the worker instance)
let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken(env) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const creds = btoa(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`);
  const resp = await fetch(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`eBay auth failed: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function buildQuery(userQuery) {
  const base = "Scotty Cameron headcover";
  if (!userQuery || userQuery.trim() === "") return base;
  // If user already included "scotty cameron" don't double it
  const q = userQuery.toLowerCase();
  if (q.includes("scotty cameron")) return userQuery;
  return `${base} ${userQuery}`;
}

async function searchEbay(token, { q, sort, type, limit = 20, offset = 0 }) {
  const query = buildQuery(q);

  // Build filter string
  const filters = [];
  if (type === "sold") {
    filters.push("buyingOptions:{FIXED_PRICE|AUCTION}");
    filters.push("itemLocationCountry:US");
  } else if (type === "active") {
    filters.push("buyingOptions:{FIXED_PRICE|AUCTION}");
    filters.push("itemLocationCountry:US");
  }

  const params = new URLSearchParams({
    q: query,
    category_ids: EBAY_CATEGORY_ID,
    limit: String(limit),
    offset: String(offset),
    fieldgroups: "MATCHING_ITEMS,EXTENDED",
  });

  if (filters.length) params.set("filter", filters.join(","));

  // eBay sort options
  const sortMap = {
    price_asc: "price",
    price_desc: "-price",
    recent: "-itemEndDate",
    best_match: "bestMatch",
  };
  params.set("sort", sortMap[sort] || "bestMatch");

  // For sold items, use the Sold Items endpoint variant
  const url =
    type === "sold"
      ? `${EBAY_SEARCH_URL}?${params}&filter=buyingOptions:{FIXED_PRICE|AUCTION},soldItems:true`
      : `${EBAY_SEARCH_URL}?${params}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=US",
    },
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`eBay search failed: ${resp.status} ${txt}`);
  }

  return resp.json();
}

function normalizeItem(item) {
  const price =
    item.price?.value ||
    item.currentBidPrice?.value ||
    item.marketPrice?.value ||
    null;

  const soldDate = item.itemEndDate || item.soldDate || null;
  const type =
    item.buyingOptions?.includes("AUCTION") && !item.soldDate
      ? "auction"
      : item.soldDate
      ? "sold"
      : "bin";

  return {
    id: item.itemId,
    title: item.title,
    price: price ? parseFloat(price) : null,
    currency: item.price?.currency || "USD",
    type,
    url: item.itemWebUrl,
    imageUrl: item.thumbnailImages?.[0]?.imageUrl || item.image?.imageUrl || null,
    condition: item.condition,
    shippingCost:
      item.shippingOptions?.[0]?.shippingCost?.value === "0.0"
        ? 0
        : parseFloat(item.shippingOptions?.[0]?.shippingCost?.value || 0),
    location: item.itemLocation?.country || null,
    endDate: soldDate,
    seller: item.seller?.username || null,
    sellerFeedback: item.seller?.feedbackScore || null,
    bids: item.bidCount || null,
  };
}

function computeStats(items) {
  const prices = items
    .filter((i) => i.price !== null && i.price > 0)
    .map((i) => i.price)
    .sort((a, b) => a - b);

  if (!prices.length) return null;

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const median = prices[Math.floor(prices.length / 2)];
  const min = prices[0];
  const max = prices[prices.length - 1];
  const p25 = prices[Math.floor(prices.length * 0.25)];
  const p75 = prices[Math.floor(prices.length * 0.75)];

  return {
    count: prices.length,
    avg: Math.round(avg * 100) / 100,
    median: Math.round(median * 100) / 100,
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    p25: Math.round(p25 * 100) / 100,
    p75: Math.round(p75 * 100) / 100,
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return jsonResponse({ status: "ok", worker: "sc-headcover-tracker" });
    }

    try {
      const token = await getEbayToken(env);

      // GET /search
      if (path === "/search") {
        const q = url.searchParams.get("q") || "";
        const sort = url.searchParams.get("sort") || "best_match";
        const type = url.searchParams.get("type") || "all";
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 50);
        const offset = parseInt(url.searchParams.get("offset") || "0");

        const raw = await searchEbay(token, { q, sort, type, limit, offset });
        const items = (raw.itemSummaries || []).map(normalizeItem);
        const stats = computeStats(items);

        return jsonResponse({
          total: raw.total || items.length,
          offset,
          limit,
          query: buildQuery(q),
          items,
          stats,
        });
      }

      // GET /stats - fetch both sold + active and compute comparison
      if (path === "/stats") {
        const q = url.searchParams.get("q") || "";

        const [soldRaw, activeRaw] = await Promise.all([
          searchEbay(token, { q, sort: "recent", type: "sold", limit: 50 }),
          searchEbay(token, { q, sort: "best_match", type: "active", limit: 50 }),
        ]);

        const soldItems = (soldRaw.itemSummaries || []).map(normalizeItem);
        const activeItems = (activeRaw.itemSummaries || []).map(normalizeItem);

        const soldStats = computeStats(soldItems);
        const activeStats = computeStats(activeItems);

        const sellThrough =
          soldItems.length > 0
            ? Math.round(
                (soldItems.length / (soldItems.length + activeItems.length)) * 100
              )
            : null;

        const arbitrage =
          soldStats && activeStats
            ? activeItems
                .filter((i) => i.price && i.price < soldStats.median * 0.8)
                .slice(0, 5)
            : [];

        return jsonResponse({
          query: buildQuery(q),
          sold: { total: soldRaw.total || soldItems.length, stats: soldStats, items: soldItems.slice(0, 10) },
          active: { total: activeRaw.total || activeItems.length, stats: activeStats, items: activeItems.slice(0, 10) },
          sellThrough,
          arbitrage,
        });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};
