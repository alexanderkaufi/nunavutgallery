const PROFILE_URL = "https://www.instagram.com/nunavutgallery/";
const FRESH_TTL_SECONDS = 21600;
const STALE_TTL_SECONDS = 604800;
const LAST_GOOD_KEY = "data/latest-instagram.json";
const MEDIA_PREFIX = "media/instagram/";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/instagram") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed", posts: [] }, 405, { Allow: "GET" });
      }
      return handleInstagram(request, env, ctx);
    }
    if (url.pathname.startsWith("/media/")) {
      return handleMedia(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};

async function handleInstagram(request, env, ctx) {
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
      const mirroredPosts = await mirrorPostImages(posts, env);
      const body = {
        source: "public-instagram-html",
        fetchedAt: new Date().toISOString(),
        stale: false,
        mirroredImages: hasArtworkCache(env),
        posts: mirroredPosts
      };
      const storedResponse = json(body, 200, {
        "Cache-Control": `public, max-age=${STALE_TTL_SECONDS}`
      });
      ctx.waitUntil(Promise.all([
        cache.put(cacheKey, storedResponse),
        saveLastGood(env, body)
      ]));
      return json(body, 200, clientCacheHeaders());
    }

    if (cachedBody) return staleResponse(cachedBody);
    const lastGood = await loadLastGood(env);
    if (lastGood) return staleResponse(lastGood, "Instagram returned no readable public post data.");
    return json({
      error: "Instagram returned no readable public post data.",
      posts: []
    }, 502, noStoreHeaders());
  } catch (error) {
    if (cachedBody) return staleResponse(cachedBody);
    const lastGood = await loadLastGood(env);
    if (lastGood) return staleResponse(lastGood, String(error?.message || error));
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

function staleResponse(body, fallbackReason = "") {
  return json({ ...body, stale: true, fallbackReason }, 200, clientCacheHeaders());
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

async function handleMedia(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
  }
  if (!hasArtworkCache(env)) return new Response("Media cache is not configured.", { status: 404 });

  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.slice(1));
  if (!key.startsWith(MEDIA_PREFIX) || key.includes("..")) {
    return new Response("Not found.", { status: 404 });
  }

  const object = await env.ARTWORK_CACHE.get(key);
  if (!object) return new Response("Not found.", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function mirrorPostImages(posts, env) {
  if (!hasArtworkCache(env)) return posts;

  const mirrored = [];
  for (let index = 0; index < posts.length; index += 1) {
    mirrored.push(await mirrorPostImage(posts[index], index, env));
  }
  return mirrored;
}

async function mirrorPostImage(post, index, env) {
  const key = mediaObjectKeyForPost(post, index);
  if (!key) return post;

  try {
    const existing = await env.ARTWORK_CACHE.head(key);
    if (existing) return { ...post, image: `/${key}` };

    const response = await fetch(post.image, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; NunavutGalleryWebsite/1.0; +https://www.nunavutgallery.com/)"
      },
      cf: { cacheTtl: STALE_TTL_SECONDS, cacheEverything: true }
    });
    if (!response.ok) return post;

    const contentType = response.headers.get("Content-Type") || "image/jpeg";
    if (!contentType.toLowerCase().startsWith("image/")) return post;

    const contentLength = Number(response.headers.get("Content-Length") || "0");
    if (contentLength > 10 * 1024 * 1024) return post;

    await env.ARTWORK_CACHE.put(key, response.body, {
      httpMetadata: { contentType },
      customMetadata: {
        source: "instagram",
        sourceUrl: post.url,
        cachedAt: new Date().toISOString()
      }
    });
    return { ...post, image: `/${key}` };
  } catch {
    return post;
  }
}

async function saveLastGood(env, body) {
  if (!hasArtworkCache(env)) return;
  await env.ARTWORK_CACHE.put(LAST_GOOD_KEY, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { savedAt: new Date().toISOString() }
  });
}

async function loadLastGood(env) {
  if (!hasArtworkCache(env)) return null;
  try {
    return await env.ARTWORK_CACHE.get(LAST_GOOD_KEY, "json");
  } catch {
    return null;
  }
}

function hasArtworkCache(env) {
  return Boolean(env?.ARTWORK_CACHE);
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
  const originalCaption = decodeHtml(String(item.caption || "")).trim();
  const caption = redactPriceMentions(originalCaption);
  const lower = originalCaption.toLowerCase();
  let status = "available";
  let statusLabel = "";

  if (/\b(sold|verkauft)\b|#sold\b/.test(lower)) {
    status = "sold";
    statusLabel = "Sold";
  } else if (/\b(reserved|on hold|sale pending|pending)\b|#reserved\b/.test(lower)) {
    status = "reserved";
    statusLabel = "Reserved";
  }

  const priceLabel = "Price and availability on request";
  const url = /^https:\/\/www\.instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?/.test(item.url || "")
    ? item.url
    : PROFILE_URL;

  return {
    image: unescapeJsonUrl(String(item.image || "")),
    caption,
    url,
    status,
    statusLabel,
    price: null,
    priceLabel,
    label: statusLabel || priceLabel
  };
}

export function redactPriceMentions(caption) {
  const amount = "(?:[\\d]{1,3}(?:[,.][\\d]{3})+|[\\d]+)(?:\\.[\\d]{2})?";
  const label = "(?:\\b(?:price|asking)\\s*:?\\s*)?";
  return String(caption)
    .replace(new RegExp(`${label}(?:CAD\\s*)?\\$\\s?${amount}(?:\\s*CAD)?|${label}\\b${amount}\\s*CAD\\b`, "gi"), "Price on request")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function mediaObjectKeyForPost(post, index = 0) {
  if (!post?.image || !/^https?:\/\//.test(post.image)) return "";
  const shortcode = instagramShortcode(post.url);
  const base = shortcode || stableHash(post.image);
  const extension = imageExtension(post.image);
  return `${MEDIA_PREFIX}${base}-${index + 1}${extension}`;
}

function instagramShortcode(url) {
  const match = String(url || "").match(/^https:\/\/www\.instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?/);
  return match ? match[1] : "";
}

function imageExtension(url) {
  try {
    const extension = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[0];
    return extension ? extension.toLowerCase().replace(".jpeg", ".jpg") : ".jpg";
  } catch {
    return ".jpg";
  }
}

function stableHash(value) {
  let hash = 5381;
  for (const character of String(value)) {
    hash = ((hash << 5) + hash + character.codePointAt(0)) >>> 0;
  }
  return hash.toString(36);
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
