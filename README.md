# gmb-osint

A Tampermonkey / Violentmonkey userscript that pulls Google Business Profile
data out of the Knowledge Panel on `google.com/search` and turns it into a
copy/paste workbench: identifiers, all the PlePer-style URL variants, social
profiles, a responsive embed snippet, and JSON / CSV / Markdown exports — all
generated locally with no API key and no third-party calls.

> **v13** is a near-rewrite of v12 (the original
> [Greasy Fork release](https://greasyfork.org/en/scripts/475060-extract-google-business-data-v12)).
> v12 is included in this repo for reference.

---

## Why

[PlePer's CID converter](https://pleper.com/index.php?do=tools&sdo=cid_converter)
is the OSINT/local-SEO standard for turning a Google CID or Place ID into a
full set of links — Maps, Reviews, Write Review, Claim, Request Access,
Bing/Apple/Yelp/etc. This script does the same work *in-page* whenever you
land on a Knowledge Panel, without leaving Google or pasting CIDs into another
tool.

It will not invent fields. Anything Google doesn't expose in the page DOM is
labelled **Not found** rather than fabricated, and best-effort URLs (e.g. the
`maps/uv?pb=…` images URL whose full signature is server-generated) are
flagged with an amber **best-effort** badge and an explanatory note.

---

## Features

- Slide-out **420px workbench panel** (collapsible sections, persisted state)
- Per-field **Copy** button + section-level export buttons
- Status badges per field: `extracted` / `generated` / `best-effort` / `missing`
- Page-injection of CID / Place ID / Maps / Reviews / Write Review / Claim /
  Request Access buttons next to the business title (toggleable, idempotent —
  no more duplicate buttons after MutationObserver fires)
- **CID decimal → hexadecimal** via `BigInt` — no precision loss on 19-digit CIDs
- **Multi-strategy extraction** for every field; missing data never crashes
- **Exports**: JSON · CSV · Markdown report · "all URLs" list · embed code ·
  client-handoff plain-text summary
- **Debounced** MutationObserver (1 s) + content-signature gate, so re-renders
  only happen on real changes
- **Debug mode** (toggle in panel) shows which selectors were tried per field

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Brave / Firefox / Safari) or [Violentmonkey](https://violentmonkey.github.io/) (Chrome / Firefox / Edge).
2. Open the raw v13 script:
   [`Extract Google Business Data (v13).js`](./Extract%20Google%20Business%20Data%20%28v13%29.js)
   → click the **Raw** button on GitHub → the userscript manager will offer to install.
3. Search for any business on Google. Click the **📊** tab on the right edge of the page to open the panel.

The script matches:

```text
https://www.google.com/search*
https://www.google.com/maps*
https://local.google.com/*
```

---

## What's extracted vs. generated

| Category    | Field                                    | Source                                                              |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------- |
| extracted   | Business name                            | knowledge-panel `[data-attrid="title"]`                             |
| extracted   | CID (decimal)                            | `data-rc_ludocids`, anchor `cid=`/`ludocid=`, HTML regex            |
| extracted   | Place ID                                 | `[data-pid]`, anchor `placeid=`/`place_id=`/`q=place_id:`, HTML regex |
| extracted   | kgmid                                    | anchor `kgmid=`, `[data-kgmid]`, HTML regex                         |
| extracted   | Coordinates (lat / lng)                  | `meta itemprop`, anchor `@lat,lng`/`!3d!4d`, JSON-LD `geo`          |
| extracted   | Address                                  | `[data-attrid*="kc:/location/location:address"] .LrzXr`             |
| extracted   | Phone                                    | `a[href^="tel:"]`, `[data-attrid*="phone"]`                         |
| extracted   | Website                                  | attrid selectors → `<a>`-text="Website" → `/url?q=…` unwrap → KP-scope fallback |
| extracted   | Rating + review count                    | `[role="img"][aria-label*="star"]`, `.Aq14fc`, "(N reviews)" text   |
| extracted   | Social profiles                          | anchor host match (YouTube / IG / FB / X / LinkedIn / TikTok / Pinterest) |
| generated   | CID hexadecimal                          | `BigInt(cid).toString(16)`                                          |
| generated   | All `cid=` Google URLs                   | local string interpolation                                          |
| generated   | All Place-ID Google URLs                 | local string interpolation                                          |
| generated   | Bing / Apple / Yelp / FB / Foursquare / OSM | local string interpolation (needs name + coords)                 |
| generated   | 16:9 responsive embed snippet            | local string interpolation                                          |
| best-effort | Images-in-Maps URL (`uv?pb=…`)           | only the `0x0:0x{hex}` prefix; PlePer's full `pb` signature is server-generated |
| best-effort | Posts URL                                | works when kgmid is detected; without kgmid the panel may not render |

Anything else (opening hours, services list, Q&A, populartimes, exact
historical review-count snapshots, etc.) is **not** in the panel. Those
require an external lookup (Places API, Outscraper, PlePer, etc.) and the
script explicitly does not fabricate them.

---

## Known limitations

- Google's Knowledge Panel selectors change without notice. The script tries
  multiple fallbacks per field and uses HTML regex as a last resort, but
  individual fields may go missing as Google ships UI updates. When a field
  shows **Not found**, toggle **Debug log** in the panel to see which
  selectors were tried.
- The script focuses on the **Knowledge Panel on `google.com/search`**. The
  same data is sometimes available on `google.com/maps`, but the Maps DOM is
  app-shell-driven (rendered late, different selector tree) and many
  extractors will return `null` there. The `@match` is included so the panel
  still loads while you navigate.
- The "Images in Maps" URL only contains the `0x0:0x{hex}` prefix of PlePer's
  full `uv?pb=…` signature. PlePer's full signature includes server-generated
  segments (`!2m5!2m2!1i80!2i80!3m1!2i100!3m1!7e114s`) that can't be derived
  from the CID alone. Marked **best-effort**.
- Social-profile detection is host-based — verify visually before pasting
  into a deliverable.

---

## Development

There is no build step — the script is a single self-contained userscript file.

To sanity-check changes:

```bash
node --check "Extract Google Business Data (v13).js"
```

To verify CID → hex conversion:

```bash
node -e 'console.log(BigInt("5845732394351185949").toString(16))'
# expected: 512036a4014bd01d
```

The full architecture and per-field strategy notes live in
[`CHANGELOG.md`](./CHANGELOG.md).

---

## Credits

Built by **sharmanhall**. v12 lives on Greasy Fork; v13 is hosted here.

- [PlePer's CID converter](https://pleper.com/index.php?do=tools&sdo=cid_converter) — the URL-pattern reference this script reproduces locally.
- [Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/) — the userscript hosts.

---

## License

[MIT](./LICENSE) © sharmanhall
