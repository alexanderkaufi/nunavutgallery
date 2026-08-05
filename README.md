# Nunavut Gallery

A Cloudflare Worker prototype that displays artwork data extracted from Nunavut Gallery's public Instagram profile. The gallery continues to maintain its catalogue on Instagram; this project provides a separate website and a replaceable import layer.

> This is an experimental interim solution. It does not use the official Instagram API, a Meta app, or access tokens. Instagram can block public requests or change its page structure at any time.

## Product principle

The people maintaining the gallery content only maintain Instagram and should not have to learn or operate a second catalogue system. For the interim version, Instagram is the source of truth and the website should mirror it as automatically as possible.

This means the website should import public Instagram images, captions, post links, and obvious status hints whenever Instagram makes them available. The public website must not show prices; it should always use **Price and availability on request**.

Later, this import layer can be replaced with the official Instagram API or another simple source, but the current goal is to avoid adding extra work for the Instagram maintainers.

## Architecture

```text
Public Instagram profile
        ↓
Cloudflare Worker (`src/worker.js`)
        ↓                  ↘
Cloudflare R2 cache         `GET /media/...`
last good JSON + images     mirrored images
        ↓
`GET /api/instagram`
        ↓
Website (`public/index.html`)
```

The root `index.html` remains available for the existing GitHub Pages website. Cloudflare serves `public/index.html` and runs the Worker API.

## Imported information

When Instagram exposes readable public post data, the Worker extracts:

- image URL;
- caption;
- Instagram post URL;
- status terms such as `Sold`, `Reserved`, `On hold`, and `Sale pending`.

The website always displays **Price and availability on request**. Even if a caption contains a visible CAD price pattern, the Worker redacts that text from the public caption and does not expose a price in the API response. A post without a sold or reserved term is classified internally as `available`, but this means only that no contrary status was detected.

## Cache and fallback

A successful result is treated as fresh for six hours in the Worker cache. The cached result is retained for up to seven days so it can be returned with `stale: true` if a later Instagram request fails.

When the `ARTWORK_CACHE` R2 binding is configured, the Worker also saves:

- the last successful JSON response at `data/latest-instagram.json`;
- mirrored image files under `media/instagram/`.

If Instagram later returns no readable data, the API can still return the last good R2 response. If an Instagram image was mirrored successfully, the website uses the local `/media/...` copy instead of depending on the live Instagram image URL.

If neither current nor cached post data is available, the API returns an error with an empty `posts` array. The website then displays a direct link to `@nunavutgallery`.

## Project structure

```text
.
├── index.html             # Existing GitHub Pages fallback
├── public/
│   └── index.html         # Cloudflare website
├── src/
│   └── worker.js          # Worker, importer, parser and cache
├── test/
│   └── worker.test.js     # Parser/status tests
├── package.json
├── package-lock.json
├── wrangler.jsonc
└── .gitignore
```

## Local development

Requires Node.js and npm.

```bash
npm install
npm test
npm run dev
```

Then open `http://localhost:8787`. The API is available at `http://localhost:8787/api/instagram`.

## Deployment

Authenticate Wrangler with a Cloudflare account and deploy:

```bash
npx wrangler login
npm run deploy
```

Wrangler publishes the static assets in `public/` together with the Worker in `src/worker.js`.

The current `wrangler.jsonc` expects an R2 bucket named:

```text
nunavut-gallery-artwork-cache
```

Create that bucket in Cloudflare before deploying, or remove the `r2_buckets` block until the bucket is ready. Without R2, the Worker can still read Instagram, but it cannot persist the last good gallery or mirrored images.

## API response

A successful response has this shape:

```json
{
  "source": "public-instagram-html",
  "fetchedAt": "2026-08-05T00:00:00.000Z",
  "stale": false,
  "mirroredImages": true,
  "posts": [
    {
      "image": "/media/instagram/ABC123-1.jpg",
      "caption": "...",
      "url": "https://www.instagram.com/p/.../",
      "status": "sold",
      "statusLabel": "Sold",
      "price": null,
      "priceLabel": "Price and availability on request"
    }
  ]
}
```

## Limitations

- Instagram may return no post data to Cloudflare.
- Public HTML structures can change without notice.
- Extracted statuses are heuristic and should not be treated as guaranteed inventory information.
- A durable production catalogue should eventually use the official Instagram API or a separately maintained database.
