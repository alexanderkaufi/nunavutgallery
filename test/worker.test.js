import test from "node:test";
import assert from "node:assert/strict";
import { extractPostsFromHtml, extractPrice, normalizePost } from "../src/worker.js";

test("recognizes sold status and keeps an explicit price", () => {
  const post = normalizePost({
    image: "https://cdn.example/art.jpg",
    caption: "Stone carving — SOLD — $1,850 CAD",
    url: "https://www.instagram.com/p/ABC123/"
  });
  assert.equal(post.status, "sold");
  assert.equal(post.statusLabel, "Sold");
  assert.equal(post.price, "$1,850 CAD");
  assert.equal(post.priceLabel, "$1,850 CAD");
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

test("extracts supported CAD price formats", () => {
  assert.equal(extractPrice("Price $1,850"), "$1,850");
  assert.equal(extractPrice("Price: CAD $2,400"), "CAD $2,400");
  assert.equal(extractPrice("Asking 1850 CAD"), "1850 CAD");
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
  assert.equal(posts[0].price, "950 CAD");
});

test("rejects non-Instagram post links", () => {
  const post = normalizePost({
    image: "https://cdn.example/art.jpg",
    caption: "Available",
    url: "https://malicious.example/"
  });
  assert.equal(post.url, "https://www.instagram.com/nunavutgallery/");
});
