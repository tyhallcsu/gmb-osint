# Changelog

## v13.1 — 2026-05-05

- **Fix: Website often "Not found"** in modern Knowledge Panels. The Website
  button doesn't always carry `aria-label="Website"` — sometimes only the
  visible text is `"Website"`, and the `href` may be a `/url?q=…` redirect.
  The extractor now:
  - tries the older attrid-based selectors first,
  - then matches any `<a>` whose visible text is exactly "Website",
  - then unwraps `google.com/url?q=…` and `/aclk?u=…` redirects,
  - finally falls back to the first non-social external link near the title
    (marked with a "verify" note).
  - Excluded hosts list expanded to cover `google.*`, `gstatic`,
    `googleusercontent`, plus the social/maps/yelp/wikipedia hosts already
    handled by other extractors.

## v13.0 — 2026-05-05

A near-rewrite focused on robustness, dedupe, and PlePer-style link generation.
The v12 file is left in place for reference (`Extract Google Business Data (v12).js`).

### Fixed

- **No more "Could not find the 'Write a Review' button on the page" failure.** Place ID
  extraction no longer hard-depends on `#wrkpb`. It now tries, in order:
  1. `[data-pid]` (any element)
  2. `placeid=`, `place_id=`, `q=place_id:` in any anchor's `href`
  3. `\bCh[IJ][A-Za-z0-9_-]{20,}\b` regex over the page HTML
- **No more duplicate injected buttons / log spam after MutationObserver fires.**
  - Injected DOM uses a single stable container `#gmb-osint-injected`. Each scan
    removes the previous container before adding a new one (idempotent).
  - The MutationObserver is debounced (1000ms) and gated on a content signature
    (`businessName | cid | placeId`). Re-renders only happen when the signature
    actually changes (or when the user clicks Rescan).
- **Missing fields no longer crash the script.** Every extractor returns
  `null` instead of throwing; the panel renders "Not found" for absent fields.
- **CID extraction works on more layouts.** No longer relies on a single
  `a[jscontroller="wuU7pb"]`; it scans all anchors plus an HTML regex fallback.

### Added

- **CID decimal → hexadecimal** using `BigInt`. No precision loss on 19-digit CIDs.
  Verified: `5845732394351185949` → `0x512036a4014bd01d`.
- **PlePer-style link generator** (all built locally, no external API):
  - `https://www.google.com/maps?cid={cid}`
  - `https://maps.google.com/maps?cid={cid}`
  - `https://local.google.com/place?id={cid}&use=srp`
  - `https://business.google.com/create?fp={cid}`         *(Claim)*
  - `https://www.google.com/maps/uv?pb=!1s0x0:0x{cidHex}` *(Images, best-effort)*
  - `https://search.google.com/local/reviews?placeid={pid}`
  - `https://search.google.com/local/writereview?placeid={pid}`
  - `https://business.google.com/arc/p/{pid}`             *(Request Access)*
  - `https://www.google.com/maps/place/?q=place_id:{pid}`
  - `https://local.google.com/place?id={pid}&use=srp`
  - Bing Maps, Apple Maps, Yelp, Facebook Search, Foursquare, OpenStreetMap
- **Responsive 16:9 Google Maps embed** (HTML+CSS string, copy-paste ready).
- **kgmid extraction** to build a working Posts URL when present (best-effort
  otherwise — kgmid is required for the Posts panel to render).
- **Coordinates extraction** via 4 strategies: `meta itemprop`, anchor
  `@lat,lng`/`ll=`/`!3d!4d`, `application/ld+json` `geo`, HTML regex.
- **Address / phone / website / rating-and-review-count / social-profile**
  extractors (YouTube, Instagram, Facebook, X/Twitter, LinkedIn, TikTok,
  Pinterest).
- **Workbench panel UI**:
  - 420px wide (responsive `max-width: calc(100vw - 40px)`)
  - Collapsible sections (state persisted via `GM_setValue`):
    Core Business Data · Google Identifiers · Google Links ·
    Review/Manage Links · Social Profiles · Other Search Engines ·
    Embed Code · Export · Debug Log
  - Per-field **Copy** button
  - Status badges per field: `extracted` (green) / `generated` (blue) /
    `best-effort` (amber) / `missing` (grey)
  - Field notes for best-effort URLs (e.g. why the kgmid Posts URL is partial)
- **Settings toggles** in the panel header:
  - "Inject buttons in page" (default ON)
  - "Debug log" (default OFF — when ON, records selectors tried and failed)
  - Panel open state persisted across pages.
- **Export buttons**:
  - Copy/Download JSON (full structured object incl. status + source per field)
  - Copy/Download CSV (header + single row, easy to append to a sheet)
  - Copy Markdown report (sectioned, includes embed code)
  - Copy all URLs (grouped by section)
  - Copy embed code
  - Copy "client handoff" summary (plain-text, paste into email/Slack)
- **Clipboard fallback**: uses `navigator.clipboard` when available, falls back
  to a hidden `<textarea>` + `execCommand('copy')` for older Tampermonkey
  contexts.
- Expanded `@match` to `https://www.google.com/maps*` and
  `https://local.google.com/*` in addition to `/search*`.

### Field source reference

This is what the script can pull *from the Google page DOM alone* (no API):

| Category   | Field                              | Source                             |
|------------|------------------------------------|------------------------------------|
| extracted  | Business name                      | knowledge-panel `[data-attrid="title"]` |
| extracted  | CID (decimal)                      | `data-rc_ludocids`, anchor `cid=`/`ludocid=`, HTML regex |
| extracted  | Place ID                           | `[data-pid]`, anchor `placeid=`/`place_id=`/`q=place_id:`, HTML regex |
| extracted  | kgmid                              | anchor `kgmid=`, `[data-kgmid]`, HTML regex |
| extracted  | Coordinates (lat / lng)            | `meta itemprop`, anchor `@lat,lng`/`!3d!4d`, JSON-LD `geo` |
| extracted  | Address                            | `[data-attrid*="kc:/location/location:address"] .LrzXr` |
| extracted  | Phone                              | `a[href^="tel:"]`, `[data-attrid*="phone"]` |
| extracted  | Website                            | `a[aria-label="Website"]`, `[data-attrid*="website"]` |
| extracted  | Rating + review count              | `[role="img"][aria-label*="star"]`, `.Aq14fc`, "(N reviews)" text |
| extracted  | Social profiles                    | anchor host match against known social-network hosts |
| generated  | CID hexadecimal                    | `BigInt(cid).toString(16)` |
| generated  | All `cid=` Google URLs             | local string interpolation |
| generated  | All Place-ID Google URLs           | local string interpolation |
| generated  | Bing/Apple/Yelp/Facebook/Foursquare/OSM | local string interpolation (needs name + coords) |
| generated  | 16:9 responsive embed              | local string interpolation |
| best-effort| Images-in-Maps URL (`uv?pb=…`)     | only the `0x0:0x{hex}` prefix; PlePer's full `pb` signature is server-generated |
| best-effort| Posts URL                          | works when kgmid is detected; without kgmid the panel may not render |

Anything else (e.g. opening hours, services list, Q&A, populartimes,
exact review-count snapshots over time) is **not** in the panel — it would need
an external lookup (Places API, Outscraper, PlePer, etc.) and the script
explicitly does not fabricate those fields.

### Known limitations / TODOs

- Google's Knowledge Panel selectors change without notice. The script tries
  multiple fallback paths per field and uses HTML regex as a last resort, but
  individual fields may go missing as Google ships UI updates. When a field is
  missing, toggle **Debug log** in the panel to see which selectors were tried.
- The script focuses on the **Knowledge Panel on `google.com/search`**. The
  same data is sometimes available on `google.com/maps`, but the Maps DOM is
  app-shell-driven (rendered late, different selector tree) — many extractors
  may return `null` there. The `@match` is included so the panel still loads
  if you keep the script running while navigating.
- The "Images in Maps" URL uses only the `0x0:0x{hex}` part of PlePer's full
  `uv?pb=…` signature. PlePer's full signature includes server-generated
  segments (`!2m5!2m2!1i80!2i80!3m1!2i100!3m1!7e114s`) that can't be derived
  from the CID alone. Marked **best-effort**.
- Social-profile detection is host-based and may pick up unrelated links if a
  business links to e.g. a generic Facebook share button. The patterns try to
  filter the obvious share/intent endpoints, but verify visually before
  copying into a deliverable.
- BigInt requires a modern JS engine (Chrome 67+ / Firefox 68+). All currently
  supported Tampermonkey/Violentmonkey hosts ship with it.

### Validation performed

- `node --check` passes on the script.
- BigInt round-trip:
  - `5845732394351185949` → `512036a4014bd01d` ✓
  - `1` → `1` ✓
  - `18446744073709551615` (max uint64) → `ffffffffffffffff` ✓
  - `0` → `0` ✓
- Generated URLs for the Roof Bros sample match the PlePer reference output
  (modulo `%20` vs `+` for spaces — both are valid; we use
  `encodeURIComponent`).

### Still needs live browser testing

- Live load on a Google Knowledge Panel — confirm:
  - the panel actually opens, sections expand/collapse, settings persist,
  - per-field Copy and the export buttons round-trip through the clipboard,
  - injected buttons appear once and only once (no duplicates) after the
    MutationObserver fires several times,
  - flipping "Inject buttons in page" OFF clears them and ON re-injects.
- Live load on a knowledge panel that exposes social profiles — confirm
  YouTube/Instagram/Facebook/X are detected.
- Live load on a knowledge panel **without** a CID (e.g. SAB/service-area
  business) — confirm the script does not crash and shows "Not found" badges.
