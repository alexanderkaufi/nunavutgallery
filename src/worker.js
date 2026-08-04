const PROFILE_URL = "https://www.instagram.com/nunavutgallery/";
const FRESH_TTL_SECONDS = 21600;
const STALE_TTL_SECONDS = 604800;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/instagram") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed", posts: [] }, 405, { Allow: "GET" });
      }
      return handleInstagram(request, ctx);
    }
    return env.ASSETS.fetch(request);
  }
};

async function handleInstagram(request, ctx) {
  const cache = caches.default;
  const cacheUrl = new URL("/api/instagram-cache", request.url);
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cachedResponse = await cache.match(cacheKey);
  let cachedBody = null;

  if (cachedResponse) {
    try {
      cachedBody = await cachedResponse.json();
    } catch {
      cachedBody = null;
    }
  }

  if (cachedBody && isFresh(cachedBody.fetchedAt)) {
    return json({ ...cachedBody, stale: false }, 200, clientCacheHeaders());
  }

  try {
    const posts = await scrapePublicProfile();
    if (posts.length) {
      const body = {
        source: "public-instagram-html",
        fetchedAt: new Date().toISOString(),
        stale: false,
        posts
      };
      const storedResponse = json(body, 200, {
        "Cache-Control": `public, max-age=${STALE_TTL_SECONDS}`
      });
      ctx.waitUntil(cache.put(cacheKey, storedResponse));
      return json(body, 200, clientCacheHeaders());
    }

    if (cachedBody) return staleResponse(cachedBody);
    return json({
      error: "Instagram returned no readable public post data.",
      posts: []
    }, 502, noStoreHeaders());
  } catch (error) {
    if (cachedBody) return staleResponse(cachedBody);
    return json({
      error: String(error?.message || error),
      posts: []
    }, 502, noStoreHeaders());
  }
}

function isFresh(fetchedAt) {
  const timestamp = Date.parse(fetchedAt || "");
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_TTL_SECONDS * 1000;
}

function staleResponse(body) {
  return json({ ...body, stale: true }, 200, clientCacheHeaders());
}

function clientCacheHeaders() {
  return { "Cache-Control": "public, max-age=900" };
}

function noStoreHeaders() {
  return { "Cache-Control": "no-store" };
}

async function scrapePublicProfile() {
  const response = await fetch(PROFILE_URL, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-CA,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; NunavutGalleryWebsite/1.0; +https://www.nunavutgallery.com/)"
    },
    cf: { cacheTtl: FRESH_TTL_SECONDS, cacheEverything: true }
  });

  if (!response.ok) throw new Error(`Instagram responded with ${response.status}`);
  return extractPostsFromHtml(await response.text());
}

export function extractPostsFromHtml(html) {
  const candidates = [];

  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectFromJson(JSON.parse(decodeHtml(match[1])), candidates);
    } catch {}
  }

  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1].trim();
    if (!body || body.length < 50 || (!body.startsWith("{") && !body.startsWith("["))) continue;
    try {
      collectFromJson(JSON.parse(body), candidates);
    } catch {}
  }

  if (!candidates.length) {
    const images = [...html.matchAll(/"(?:display_url|image_url|thumbnail_src|thumbnail_url)"\s*:\s*"(https:[^"]+)"/g)];
    const captions = [...html.matchAll(/"(?:caption|accessibility_caption|text)"\s*:\s*"([^"]{3,2000})"/g)];
    const codes = [...html.matchAll(/"(?:shortcode|code)"\s*:\s*"([A-Za-z0-9_-]{5,})"/g)];
    for (let index = 0; index < Math.min(images.length, 30); index += 1) {
      candidates.push({
        image: unescapeJsonUrl(images[index][1]),
        caption: captions[index] ? decodeHtml(captions[index][1]) : "",
        url: codes[index] ? `https://www.instagram.com/p/${codes[index][1]}/` : PROFILE_URL
      });
    }
  }

  const unique = new Map();
  for (const item of candidates) {
    const post = normalizePost(item);
    if (!post.image) continue;
    const key = post.url !== PROFILE_URL ? post.url : post.image;
    if (!unique.has(key)) unique.set(key, post);
  }
  return [...unique.values()].slice(0, 30);
}

function collectFromJson(value, output, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  const image = firstString(
    value.display_url,
    value.image_url,
    value.thumbnail_src,
    value.thumbnail_url,
    value.contentUrl,
    value.image?.url,
    value.node?.display_url
  );
  const caption = firstString(
    value.caption,
    value.description,
    value.articleBody,
    value.accessibility_caption,
    value.edge_media_to_caption?.edges?.[0]?.node?.text,
    value.node?.edge_media_to_caption?.edges?.[0]?.node?.text
  );
  const shortcode = firstString(value.shortcode, value.code, value.node?.shortcode);
  const url = firstString(
    value.url,
    value.mainEntityOfPage,
    shortcode ? `https://www.instagram.com/p/${shortcode}/` : ""
  );

  if (image && /^https?:\/\//.test(image)) output.push({ image, caption, url });
  if (Array.isArray(value)) {
    for (const child of value) collectFromJson(child, output, seen);
  } else {
    for (const child of Object.values(value)) collectFromJson(child, output, seen);
  }
}

export function normalizePost(item) {
  const caption = decodeHtml(String(item.caption || "")).trim();
  const lower = caption.toLowerCase();
  let status = "available";
  let statusLabel = "";

  if (/\b(sold|verkauft)\b|#sold\b/.test(lower)) {
    status = "sold";
    statusLabel = "Sold";
  } else if (/\b(reserved|on hold|sale pending|pending)\b|#reserved\b/.test(lower)) {
    status = "reserved";
    statusLabel = "Reserved";
  }

  const price = extractPrice(caption);
  const priceLabel = price || "Price and availability on request";
  const url = /^https:\/\/www\.instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?/.test(item.url || "")
    ? item.url
    : PROFILE_URL;

  return {
    image: unescapeJsonUrl(String(item.image || "")),
    caption,
    url,
    status,
    statusLabel,
    price,
    priceLabel,
    label: statusLabel || priceLabel
  };
}

export function extractPrice(caption) {
  const amount = "(?:[\\d]{1,3}(?:[,.][\\d]{3})+|[\\d]+)(?:\\.[\\d]{2})?";
  const match = String(caption).match(new RegExp(`(?:CAD\\s*)?\\$\\s?${amount}(?:\\s*CAD)?|\\b${amount}\\s*CAD\\b`, "i"));
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function unescapeJsonUrl(value) {
  return decodeHtml(value)
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}
