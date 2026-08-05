# Nunavut Gallery Project Notes

## Main project rule

The gallery team should only maintain Instagram. They should not have to learn or operate a second product catalogue, spreadsheet, CMS, image uploader, or API tool for the interim version.

The website should mirror the public Instagram account as automatically as possible. Public prices must stay hidden. The public wording is:

```text
Price and availability on request
```

## What we tried

### GitHub Pages

GitHub Pages can serve the static website, but it cannot run the server code needed to request Instagram and turn it into JSON.

This URL works as a static site:

```text
https://alexanderkaufi.github.io/nunavutgallery/
```

But this cannot work on GitHub Pages:

```text
/api/instagram
```

Reason: GitHub Pages only serves static files. It does not execute `src/worker.js`.

### Cloudflare Worker scraper

We built and deployed a Cloudflare Worker:

```text
https://nunavutgallery.nunavutgallery.workers.dev
```

The Worker can run server-side code and has an API route:

```text
https://nunavutgallery.nunavutgallery.workers.dev/api/instagram
```

We also created the R2 bucket:

```text
nunavut-gallery-artwork-cache
```

The Worker was designed to:

- request the public Instagram profile;
- extract images, captions, post links, and status hints;
- hide/redact public price patterns;
- save the last good JSON response;
- mirror images into R2 when Instagram data is available.

What happened:

```json
{"error":"Instagram responded with 429","posts":[]}
```

Instagram blocked Cloudflare's automatic request with HTTP `429`. We waited several hours and tested again; the result stayed `429`. This means the custom public scraper is not reliable enough as the main production path.

The Worker code is still useful as a fallback or future import layer, but the visible website should not depend on it for now.

## What worked

### SociableKIT

SociableKIT accepted the public Instagram username:

```text
nunavutgallery
```

It showed real Nunavut Gallery images and captions without requiring us to log into the Instagram account.

The created widget is:

```text
https://app.sociablekit.com/widgets/update/25702890
```

The embed code is:

```html
<div class="sk-instagram-feed" data-embed-id="25702890"></div>
<script src="https://widgets.sociablekit.com/instagram-feed/widget.js" defer></script>
```

We embedded this into:

```text
public/index.html
```

The Cloudflare site now uses the SociableKIT feed for the visible gallery instead of the blocked `/api/instagram` scraper.

Live site:

```text
https://nunavutgallery.nunavutgallery.workers.dev
```

Cache-busted test URL:

```text
https://nunavutgallery.nunavutgallery.workers.dev/?v=sociablekit-25702890
```

## Why we changed direction

The original goal was automatic mirroring from Instagram with no extra work for the Instagram maintainers.

Our own scraper matched that goal in theory, but Instagram blocked it from Cloudflare. SociableKIT matched the same user workflow better in practice:

```text
Instagram team posts only on Instagram
        ↓
SociableKIT reads the public feed
        ↓
Cloudflare website embeds the feed
```

This keeps the gallery team from learning a second system.

## Current limitations

- The free SociableKIT plan may show SociableKIT branding.
- The free plan may require manual sync.
- Paid plans may be needed for automatic sync, more views, or no branding.
- Captions come from Instagram and may include text exactly as posted.
- Public price hiding is handled by our own Worker scraper, but the SociableKIT embed displays the Instagram feed as provided by SociableKIT. If prices are never posted on Instagram, this is fine.

## August 5, 2026 update

The attached raven artwork, which is also used as an Instagram-style profile image, was added as the prominent first-viewport image:

```text
public/images/nunavut-gallery-raven-profile.jpg
```

SociableKIT was also adjusted because the widget initially showed only 9 posts before the visitor had to click **Load more posts**. The setting **Default Photos Count** was changed from `9` to `24` in the SociableKIT widget so more images load immediately.

If some images still do not appear, likely causes are:

- SociableKIT free-plan sync/cache limits;
- browser lazy-loading while scrolling;
- individual Instagram media not yet synced by SociableKIT;
- temporary CDN/image loading delays.

## August 5, 2026 collection layout update

The earlier static catalog design had useful visitor orientation: sculptures, prints, drawings, and wallhangings were easy to understand at a glance. We did not restore the old manual item grid because that would create a second system for the gallery team to maintain.

Instead, the public page now uses a hybrid layout:

```text
Short collection-type guide
        ↓
Automatic latest Instagram posts from SociableKIT
```

This keeps the site simple for visitors while preserving the operating rule: the gallery team only posts to Instagram, and the website mirrors that public feed.

The fixed page text also avoids public "Price on request" wording. Availability is framed as something confirmed by the gallery.

The raven hero image is now cropped in a fixed portrait frame with CSS (`object-fit: cover`) so the photographed white side edges are less visible on the front page.

## Important commits

```text
522dcc4 Add resilient Instagram mirror cache
5772780 Embed SociableKIT Instagram feed
1b9121a Add raven hero image and expand feed
```

## Local note

The local Synology folder has a README case-conflict issue:

```text
D README.md
?? README_Mac.fritz.box_..._CaseConflict.md
```

This is local sync behavior. GitHub already received the intended `README.md` in commit `522dcc4`.
