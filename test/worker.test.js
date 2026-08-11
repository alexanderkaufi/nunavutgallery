import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  classifyProtection,
  extractPostsFromHtml,
  mediaObjectKeyForPost,
  normalizePost,
  parseRetryAfter,
  redactPriceMentions,
  requireManualConfirmation
} from "../src/worker.js";

test("recognizes sold status and hides explicit prices", () => {
  const post = normalizePost({
    image: "https://cdn.example/art.jpg",
    caption: "Stone carving — SOLD — $1,850 CAD",
    url: "https://www.instagram.com/p/ABC123/"
  });
  assert.equal(post.status, "sold");
  assert.equal(post.statusLabel, "Sold");
  assert.equal(post.price, null);
  assert.equal(post.priceLabel, "Price and availability on request");
  assert.equal(post.caption, "Stone carving — SOLD — Price on request");
});

test("maps hold terminology to reserved", () => {
  for (const caption of ["Reserved", "On hold", "Sale pending", "#reserved"]) {
    const post = normalizePost({ image: "https://cdn.example/art.jpg", caption });
    assert.equal(post.status, "reserved");
    assert.equal(post.statusLabel, "Reserved");
  }
});

test("uses the request message when status and price are unknown", () => {
  const post = normalizePost({ image: "https://cdn.example/art.jpg", caption: "New stone sculpture" });
  assert.equal(post.status, "available");
  assert.equal(post.price, null);
  assert.equal(post.priceLabel, "Price and availability on request");
});

test("redacts supported CAD price formats from public captions", () => {
  assert.equal(redactPriceMentions("Price $1,850"), "Price on request");
  assert.equal(redactPriceMentions("Price: CAD $2,400"), "Price on request");
  assert.equal(redactPriceMentions("Asking 1850 CAD"), "Price on request");
});

test("extracts and deduplicates posts from JSON-LD", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    image: { url: "https://cdn.example/art.jpg" },
    description: "Reserved — 950 CAD",
    url: "https://www.instagram.com/p/TEST123/"
  })}</script>`;
  const posts = extractPostsFromHtml(html);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].status, "reserved");
  assert.equal(posts[0].price, null);
  assert.equal(posts[0].priceLabel, "Price and availability on request");
});

test("extracts more than thirty posts when the source provides them", () => {
  const items = Array.from({ length: 35 }, (_, index) => ({
    image: { url: `https://cdn.example/art-${index}.jpg` },
    description: `Artwork ${index}`,
    url: `https://www.instagram.com/p/TEST${index}/`
  }));
  const html = `<script type="application/ld+json">${JSON.stringify(items)}</script>`;
  assert.equal(extractPostsFromHtml(html, 100).length, 35);
});

test("rejects non-Instagram post links", () => {
  const post = normalizePost({
    image: "https://cdn.example/art.jpg",
    caption: "Available",
    url: "https://malicious.example/"
  });
  assert.equal(post.url, "https://www.instagram.com/nunavutgallery/");
});

test("creates stable media cache keys for Instagram posts", () => {
  const key = mediaObjectKeyForPost({
    image: "https://cdn.example/images/work.jpeg?size=l",
    url: "https://www.instagram.com/p/ABC123/"
  });
  assert.equal(key, "media/instagram/ABC123-1.jpg");
});

test("creates hashed media cache keys when no shortcode is available", () => {
  const key = mediaObjectKeyForPost({
    image: "https://cdn.example/images/work.webp",
    url: "https://www.instagram.com/nunavutgallery/"
  }, 2);
  assert.match(key, /^media\/instagram\/[a-z0-9]+-3\.webp$/);
});

test("blocks legacy category artwork assets", async () => {
  const response = await worker.fetch(new Request("https://example.com/images/category-sculptures.jpg"), {
    ASSETS: { fetch: () => new Response("legacy asset") }
  });
  assert.equal(response.status, 404);
});

test("classifies rate limits and access protection as stop signals", () => {
  assert.equal(classifyProtection(new Response("", { status: 429 })), "rate_limited");
  assert.equal(classifyProtection(new Response("", { status: 403 })), "access_protected");
  assert.equal(
    classifyProtection(new Response("", { status: 200 }), "<html>Captcha required</html>"),
    "access_protected"
  );
  assert.equal(
    classifyProtection(new Response("", { status: 200, headers: { "cf-mitigated": "challenge" } })),
    "cloudflare_challenge"
  );
});

test("parses Retry-After seconds and dates", () => {
  assert.equal(parseRetryAfter("120"), 120);

  const previousNow = Date.now;
  Date.now = () => Date.parse("2026-08-11T10:00:00Z");
  try {
    assert.equal(parseRetryAfter("Tue, 11 Aug 2026 10:02:00 GMT"), 120);
  } finally {
    Date.now = previousNow;
  }
});

test("requires manual confirmation for critical actions", () => {
  assert.throws(() => requireManualConfirmation("comment"), /requires manual confirmation/);
  assert.doesNotThrow(() => requireManualConfirmation("comment", {
    confirmed: true,
    reason: "Gallery owner approved this single reply."
  }));
  assert.doesNotThrow(() => requireManualConfirmation("public_profile_fetch"));
});
