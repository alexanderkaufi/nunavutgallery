Version 0.2

Added artwork page

Added Cloudinary support

Improved mobile layout

Version 0.3

Started Instagram integration

Version 0.4

Deployed Cloudflare Worker and R2 cache.

Instagram public scraping was blocked by HTTP 429.

Created SociableKIT Instagram Profile widget 25702890.

Embedded SociableKIT feed in public/index.html and deployed it to Cloudflare.

Version 0.5

Added raven artwork as prominent front-page hero image.

Changed SociableKIT Default Photos Count from 9 to 24 so more Instagram posts appear before Load more.

Version 0.6

Added a short collection-type guide for sculptures, prints, drawings, and wallhangings before the Instagram feed.

Kept the actual gallery grid as latest Instagram posts so the website still follows Instagram automatically.

Cropped the raven hero image with CSS so the photographed side edges are less visible.

Removed fixed public "Price on request" wording from the page copy.

Version 0.7

Changed the collection-type guide from text-only boxes to visual object cards.

Stored four representative category images locally so those areas show actual works and do not depend on broken old image paths.

Version 0.8

Added collection tabs for Newest, All works, Sculptures, Prints, Drawings, and Wallhangings.

Temporarily tried the pasted static HTML as a filterable archive, with public prices removed. This was later replaced because it was not the current Instagram source.

Kept Newest as the automatic SociableKIT Instagram feed.

Version 0.9

Made archive work images larger and reduced card label typography so the objects are more prominent.

Moved category and status labels from the artwork image area into the lower card text area.

Removed visible category labels from archive cards and replaced the unclear availability text with Instagram and email inquiry links.

Version 0.10

Replaced the temporary static archive with the current SociableKIT Instagram feed JSON as the source for filtered cards.

Each card now links to its exact Instagram post and shows "Price on request" instead of the unclear availability text.

Version 0.11

Removed legacy website fallback traces from the public site: root fallback HTML and representative category images are gone.

Changed the filter label from "All works" to "All synced" because the current source is only the synced Instagram feed, not a confirmed complete Instagram archive.

Checked the source limit: SociableKIT currently provides 30 synced posts, while Instagram has more posts available. Getting every item requires a complete Instagram sync source, not legacy website data.
