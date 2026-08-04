# Nunavut Gallery

A Cloudflare Worker prototype that displays artwork data extracted from Nunavut Gallery's public Instagram profile. The gallery continues to maintain its catalogue on Instagram; this project provides a separate website and a replaceable import layer.

> This is an experimental interim solution. It does not use the official Instagram API, a Meta app, or access tokens. Instagram can block public requests or change its page structure at any time.

## Architecture

```text
Public Instagram profile
        ↓
Cloudflare Worker (`src/worker.js`)
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
- explicit CAD price;
- status terms such as `Sold`, `Reserved`, `On hold`, and `Sale pending`.

When no explicit price is found, the website displays **Price and availability on request**. A post without a sold or reserved term is classified internally as `available`, but this means only that no contrary status was detected.

## Cache and fallback

A successful result is treated as fresh for six hours. The cached result is retained for up to seven days so it can be returned with `stale: true` if a later Instagram request fails. This cache improves resilience but is not a permanent database.

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
│   └── worker.test.js     # Parser/status/price tests
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

## API response

A successful response has this shape:

```json
{
  "source": "public-instagram-html",
  "fetchedAt": "2026-08-05T00:00:00.000Z",
  "stale": false,
  "posts": [
    {
      "image": "https://...",
      "caption": "...",
      "url": "https://www.instagram.com/p/.../",
      "status": "sold",
      "statusLabel": "Sold",
      "price": "$1,850 CAD",
      "priceLabel": "$1,850 CAD"
    }
  ]
}
```

## Limitations

- Instagram may return no post data to Cloudflare.
- Public HTML structures can change without notice.
- Extracted statuses and prices are heuristic and should not be treated as guaranteed inventory information.
- A durable production catalogue should eventually use the official Instagram API or a separately maintained database.
