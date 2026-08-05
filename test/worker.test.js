import test from "node:test";
import assert from "node:assert/strict";
import { extractPostsFromHtml, mediaObjectKeyForPost, normalizePost, redactPriceMentions } from "../src/worker.js";

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
