const PROFILE_URL = "https://www.instagram.com/nunavutgallery/";
const FRESH_TTL_SECONDS = 21600;
const STALE_TTL_SECONDS = 604800;
const DEFAULT_POST_LIMIT = 100;
const MAX_POST_LIMIT = 100;
const LAST_GOOD_KEY = "data/latest-instagram.json";
const MEDIA_PREFIX = "media/instagram/";
const AUTOMATION_STATE_KEY = "state/automation-policy.json";
const DEFAULT_ACTION_LIMITS = {
  perHour: 6,
  perDay: 30
};
const CRITICAL_ACTIONS = new Set([
  "like",
  "follow",
  "comment",
  "send_message",
  "mass_download"
]);
const PROTECTED_STATUS_CODES = new Set([401, 403, 407, 423, 429]);
const PROTECTED_BODY_PATTERNS = [
  /\bcaptcha\b/i,
  /\bcloudflare\b/i,
  /\bchecking your browser\b/i,
  /\bchallenge-platform\b/i,
  /\blog in\b/i,
  /\blogin_required\b/i,
  /\bsign in\b/i,
  /\btemporarily blocked\b/i,
  /\brate limit\b/i,
  /\btoo many requests\b/i
];
const LEGACY_ASSET_PATHS = new Set([
  "/images/category-sculptures.jpg",
  "/images/category-prints.jpg",
  "/images/category-drawings.jpg",
  "/images/category-wallhangings.jpg"
]);

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
    if (LEGACY_ASSET_PATHS.has(url.pathname)) {
      return new Response("Not found.", {
        status: 404,
        headers: noStoreHeaders()
      });
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

  const config = automationConfig(env, request);
  try {
    const posts = await loadInstagramPosts(env, config);
    if (posts.length) {
      const mirroredPosts = await mirrorPostImages(posts, env, config);
      const body = {
        source: config.officialApiConfigured ? "official-instagram-api" : "public-instagram-html",
        fetchedAt: new Date().toISOString(),
        stale: false,
        mirroredImages: canStoreSourceContent(env, config),
        posts: mirroredPosts
      };
      const storedResponse = json(body, 200, {
        "Cache-Control": `public, max-age=${STALE_TTL_SECONDS}`
      });
      ctx.waitUntil(Promise.all([
        cache.put(cacheKey, storedResponse),
        saveLastGood(env, body, config)
      ]));
      return json(body, 200, clientCacheHeaders());
    }

    if (cachedBody) return staleResponse(cachedBody);
    const lastGood = await loadLastGood(env, config);
    if (lastGood) return staleResponse(lastGood, "Instagram returned no readable public post data.");
    return json({
      error: "Instagram returned no readable public post data.",
      posts: []
    }, 502, noStoreHeaders());
  } catch (error) {
    if (cachedBody) return staleResponse(cachedBody);
    const lastGood = await loadLastGood(env, config);
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

function automationConfig(env = {}, request = null) {
  const officialApiConfigured = Boolean(env.INSTAGRAM_ACCESS_TOKEN && env.INSTAGRAM_IG_USER_ID);
  const requestedLimit = request ? new URL(request.url).searchParams.get("limit") : "";
  return {
    officialApiConfigured,
    officialApiUrl: env.INSTAGRAM_API_URL || "https://graph.instagram.com",
    accessToken: env.INSTAGRAM_ACCESS_TOKEN || "",
    igUserId: env.INSTAGRAM_IG_USER_ID || "",
    postLimit: boundedPositiveInteger(requestedLimit || env.INSTAGRAM_POST_LIMIT, DEFAULT_POST_LIMIT, MAX_POST_LIMIT),
    maxActionsPerHour: positiveInteger(env.AUTOMATION_MAX_ACTIONS_PER_HOUR, DEFAULT_ACTION_LIMITS.perHour),
    maxActionsPerDay: positiveInteger(env.AUTOMATION_MAX_ACTIONS_PER_DAY, DEFAULT_ACTION_LIMITS.perDay),
    initialBackoffSeconds: positiveInteger(env.AUTOMATION_INITIAL_BACKOFF_SECONDS, 300),
    maxBackoffSeconds: positiveInteger(env.AUTOMATION_MAX_BACKOFF_SECONDS, 21600),
    sourceContentStorageAllowed: env.SOURCE_CONTENT_STORAGE_ALLOWED === "true",
    userAgent: env.AUTOMATION_USER_AGENT || "NunavutGalleryWebsite/1.0 (+https://www.nunavutgallery.com/)"
  };
}

async function loadInstagramPosts(env, config) {
  if (config.officialApiConfigured) return fetchOfficialInstagramMedia(env, config);
  return scrapePublicProfile(env, config);
}

async function fetchOfficialInstagramMedia(env, config) {
  const url = new URL(`${config.officialApiUrl.replace(/\/$/, "")}/${encodeURIComponent(config.igUserId)}/media`);
  url.searchParams.set("fields", "id,caption,media_url,thumbnail_url,permalink,media_type,timestamp");
  url.searchParams.set("limit", String(config.postLimit));
  url.searchParams.set("access_token", config.accessToken);

  const posts = [];
  let nextUrl = url.toString();

  while (nextUrl && posts.length < config.postLimit) {
    const body = await respectfulTextFetch(nextUrl, {
      env,
      config,
      action: "official_api_fetch",
      headers: { Accept: "application/json" }
    });
    const payload = JSON.parse(body);
    for (const item of payload.data || []) {
      const image = item.thumbnail_url || item.media_url;
      if (!image || !item.permalink) continue;
      posts.push({
        image,
        caption: item.caption || "",
        url: item.permalink
      });
      if (posts.length >= config.postLimit) break;
    }
    nextUrl = posts.length < config.postLimit ? payload.paging?.next || "" : "";
  }

  return posts;
}

async function scrapePublicProfile(env, config) {
  const html = await respectfulTextFetch(PROFILE_URL, {
    env,
    config,
    action: "public_profile_fetch",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-CA,en;q=0.9",
      "User-Agent": config.userAgent
    },
    cf: { cacheTtl: FRESH_TTL_SECONDS, cacheEverything: true }
  });
  return extractPostsFromHtml(html, config.postLimit);
}

async function respectfulTextFetch(url, options) {
  const { env, config, action } = options;
  await assertAutomationAllowed(env, config, action);
  await recordAutomationAction(env, config, action, "attempt", { host: hostForLog(url) });

  const response = await fetch(url, {
    headers: options.headers,
    cf: options.cf
  });
  const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
  const contentType = response.headers.get("Content-Type") || "";
  const text = contentType.includes("text/") || contentType.includes("json") || contentType.includes("html")
    ? await response.text()
    : "";
  const protection = classifyProtection(response, text);

  if (protection) {
    await pauseAutomation(env, config, action, protection, retryAfterSeconds);
    await recordAutomationAction(env, config, action, "blocked", {
      status: response.status,
      protection,
      retryAfterSeconds
    });
    throw new Error(`${action} stopped: ${protection}${retryAfterSeconds ? `; retry after ${retryAfterSeconds}s` : ""}`);
  }

  if (!response.ok) {
    await noteAutomationFailure(env, config, action);
    await recordAutomationAction(env, config, action, "failed", { status: response.status });
    throw new Error(`${action} failed with HTTP ${response.status}`);
  }

  await clearAutomationFailure(env, action);
  await recordAutomationAction(env, config, action, "success", { status: response.status });
  return text;
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

async function mirrorPostImages(posts, env, config) {
  if (!canStoreSourceContent(env, config)) return posts;

  const mirrored = [];
  for (let index = 0; index < posts.length; index += 1) {
    mirrored.push(await mirrorPostImage(posts[index], index, env, config));
  }
  return mirrored;
}

async function mirrorPostImage(post, index, env, config) {
  const key = mediaObjectKeyForPost(post, index);
  if (!key) return post;

  try {
    const existing = await env.ARTWORK_CACHE.head(key);
    if (existing) return { ...post, image: `/${key}` };

    const response = await respectfulBinaryFetch(post.image, {
      env,
      config,
      action: "media_fetch",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": config.userAgent
      },
      cf: { cacheTtl: STALE_TTL_SECONDS, cacheEverything: true }
    });

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

async function respectfulBinaryFetch(url, options) {
  const { env, config, action } = options;
  await assertAutomationAllowed(env, config, action);
  await recordAutomationAction(env, config, action, "attempt", { host: hostForLog(url) });

  const response = await fetch(url, {
    headers: options.headers,
    cf: options.cf
  });
  const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
  const protection = classifyProtection(response, "");

  if (protection) {
    await pauseAutomation(env, config, action, protection, retryAfterSeconds);
    await recordAutomationAction(env, config, action, "blocked", {
      status: response.status,
      protection,
      retryAfterSeconds
    });
    throw new Error(`${action} stopped: ${protection}`);
  }

  if (!response.ok) {
    await noteAutomationFailure(env, config, action);
    await recordAutomationAction(env, config, action, "failed", { status: response.status });
    throw new Error(`${action} failed with HTTP ${response.status}`);
  }

  await clearAutomationFailure(env, action);
  await recordAutomationAction(env, config, action, "success", { status: response.status });
  return response;
}

async function saveLastGood(env, body, config = automationConfig(env)) {
  if (!canStoreSourceContent(env, config)) return;
  await env.ARTWORK_CACHE.put(LAST_GOOD_KEY, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { savedAt: new Date().toISOString() }
  });
}

async function loadLastGood(env, config = automationConfig(env)) {
  if (!canStoreSourceContent(env, config)) return null;
  try {
    return await env.ARTWORK_CACHE.get(LAST_GOOD_KEY, "json");
  } catch {
    return null;
  }
}

function canStoreSourceContent(env, config = automationConfig(env)) {
  return hasArtworkCache(env) && config.sourceContentStorageAllowed;
}

function hasArtworkCache(env) {
  return Boolean(env?.ARTWORK_CACHE);
}

async function assertAutomationAllowed(env, config, action, confirmation = {}) {
  requireManualConfirmation(action, confirmation);
  const state = await loadAutomationState(env);
  const now = Date.now();
  const pauseUntil = Date.parse(state.pausedUntilByAction?.[action] || "");
  if (Number.isFinite(pauseUntil) && pauseUntil > now) {
    throw new Error(`${action} paused until ${new Date(pauseUntil).toISOString()}`);
  }

  const actionTimes = (state.actionHistory?.[action] || []).filter((timestamp) => now - timestamp < 24 * 60 * 60 * 1000);
  const hourCount = actionTimes.filter((timestamp) => now - timestamp < 60 * 60 * 1000).length;
  if (hourCount >= config.maxActionsPerHour) {
    await pauseAutomationUntil(env, action, actionTimes[0] + 60 * 60 * 1000, "hourly_limit");
    throw new Error(`${action} hourly limit reached`);
  }
  if (actionTimes.length >= config.maxActionsPerDay) {
    await pauseAutomationUntil(env, action, actionTimes[0] + 24 * 60 * 60 * 1000, "daily_limit");
    throw new Error(`${action} daily limit reached`);
  }

  state.actionHistory = state.actionHistory || {};
  state.actionHistory[action] = [...actionTimes, now];
  await saveAutomationState(env, state);
}

export function requireManualConfirmation(action, confirmation = {}) {
  if (!CRITICAL_ACTIONS.has(action)) return;
  if (confirmation.confirmed === true && confirmation.reason) return;
  throw new Error(`${action} requires manual confirmation`);
}

async function pauseAutomation(env, config, action, reason, retryAfterSeconds) {
  const state = await loadAutomationState(env);
  if (!retryAfterSeconds) {
    state.failuresByAction = state.failuresByAction || {};
    state.failuresByAction[action] = (state.failuresByAction[action] || 0) + 1;
  }
  const backoffSeconds = retryAfterSeconds || nextBackoffSeconds(state, config, action);
  state.pausedUntilByAction = state.pausedUntilByAction || {};
  state.pauseReasonsByAction = state.pauseReasonsByAction || {};
  state.pausedUntilByAction[action] = new Date(Date.now() + backoffSeconds * 1000).toISOString();
  state.pauseReasonsByAction[action] = reason;
  await saveAutomationState(env, state);
}

async function pauseAutomationUntil(env, action, until, reason) {
  const state = await loadAutomationState(env);
  state.pausedUntilByAction = state.pausedUntilByAction || {};
  state.pauseReasonsByAction = state.pauseReasonsByAction || {};
  state.pausedUntilByAction[action] = new Date(until).toISOString();
  state.pauseReasonsByAction[action] = reason;
  await saveAutomationState(env, state);
}

async function noteAutomationFailure(env, config, action) {
  const state = await loadAutomationState(env);
  state.failuresByAction = state.failuresByAction || {};
  state.failuresByAction[action] = (state.failuresByAction[action] || 0) + 1;
  const backoffSeconds = nextBackoffSeconds(state, config, action);
  state.pausedUntilByAction = state.pausedUntilByAction || {};
  state.pauseReasonsByAction = state.pauseReasonsByAction || {};
  state.pausedUntilByAction[action] = new Date(Date.now() + backoffSeconds * 1000).toISOString();
  state.pauseReasonsByAction[action] = "transient_failure_backoff";
  await saveAutomationState(env, state);
}

async function clearAutomationFailure(env, action) {
  const state = await loadAutomationState(env);
  if (!state.failuresByAction?.[action] && !state.pausedUntilByAction?.[action]) return;
  if (state.failuresByAction) delete state.failuresByAction[action];
  if (state.pausedUntilByAction) delete state.pausedUntilByAction[action];
  if (state.pauseReasonsByAction) delete state.pauseReasonsByAction[action];
  await saveAutomationState(env, state);
}

function nextBackoffSeconds(state, config, action) {
  const failures = Math.max(1, state.failuresByAction?.[action] || 1);
  const exponential = Math.min(config.maxBackoffSeconds, config.initialBackoffSeconds * 2 ** (failures - 1));
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.round(exponential * jitter));
}

async function loadAutomationState(env) {
  if (!hasArtworkCache(env)) return {};
  try {
    return (await env.ARTWORK_CACHE.get(AUTOMATION_STATE_KEY, "json")) || {};
  } catch {
    return {};
  }
}

async function saveAutomationState(env, state) {
  if (!hasArtworkCache(env)) return;
  await env.ARTWORK_CACHE.put(AUTOMATION_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { updatedAt: new Date().toISOString() }
  });
}

async function recordAutomationAction(env, config, action, outcome, details = {}) {
  const logEntry = {
    level: outcome === "success" ? "info" : "warn",
    at: new Date().toISOString(),
    action,
    outcome,
    details
  };
  console.log(JSON.stringify(logEntry));
  if (!hasArtworkCache(env) || env.AUTOMATION_PERSIST_LOGS !== "true") return;
  const key = `logs/automation/${logEntry.at.replace(/[:.]/g, "-")}-${action}-${outcome}.json`;
  await env.ARTWORK_CACHE.put(key, JSON.stringify(logEntry), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { action, outcome }
  });
}

export function classifyProtection(response, body = "") {
  if (response.headers.get("cf-mitigated") === "challenge") return "cloudflare_challenge";
  if (PROTECTED_STATUS_CODES.has(response.status)) {
    return response.status === 429 ? "rate_limited" : "access_protected";
  }
  const sample = String(body).slice(0, 250000);
  return PROTECTED_BODY_PATTERNS.some((pattern) => pattern.test(sample)) ? "access_protected" : "";
}

export function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveInteger(value, fallback, max) {
  return Math.min(positiveInteger(value, fallback), max);
}

function hostForLog(value) {
  try {
    return new URL(value).host;
  } catch {
    return "unknown";
  }
}

export function extractPostsFromHtml(html, limit = DEFAULT_POST_LIMIT) {
  const postLimit = boundedPositiveInteger(limit, DEFAULT_POST_LIMIT, MAX_POST_LIMIT);
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
    for (let index = 0; index < Math.min(images.length, postLimit); index += 1) {
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
  return [...unique.values()].slice(0, postLimit);
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
