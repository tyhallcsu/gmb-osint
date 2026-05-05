// ==UserScript==
// @name         Extract Google Business Data (v13)
// @namespace    https://github.com/tyhallcsu/gmb-osint
// @version      13.2
// @description  Extract Google Business Profile data from Knowledge Panel + generate PlePer-style CID/Place ID links and exports (JSON/CSV/Markdown/embed) in a slide-out workbench panel.
// @author       sharmanhall
// @match        https://www.google.com/search*
// @match        https://www.google.com/maps*
// @match        https://local.google.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=google.com
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------
    const VERSION = '13.2';
    const PANEL_ID = 'gmb-osint-panel';
    const INJECT_ID = 'gmb-osint-injected';
    const TOAST_ID = 'gmb-osint-toast';
    const STORAGE = {
        inject: 'gmb_osint_inject',
        debug: 'gmb_osint_debug',
        panelOpen: 'gmb_osint_panel_open',
        sectionsClosed: 'gmb_osint_sections_closed',
    };

    // ------------------------------------------------------------------
    // Settings (GM storage with safe fallback)
    // ------------------------------------------------------------------
    function gmGet(key, fallback) {
        try {
            const v = (typeof GM_getValue === 'function') ? GM_getValue(key, undefined) : undefined;
            return v === undefined ? fallback : v;
        } catch (_) { return fallback; }
    }
    function gmSet(key, value) {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (_) {}
    }

    // ------------------------------------------------------------------
    // Utilities
    // ------------------------------------------------------------------
    function debounce(fn, wait) {
        let t = null;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // Tracking parameters to strip from extracted external URLs.
    // Generated URLs (we construct ourselves) never carry trackers, so this
    // only runs on extracted website + social-profile links.
    const TRACKING_PARAMS = new Set([
        // UTM family (Google Analytics / Urchin)
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'utm_id', 'utm_name', 'utm_brand', 'utm_social', 'utm_social-type',
        'utm_creative_format', 'utm_marketing_tactic',
        // Ad-network click IDs
        'gclid', 'gclsrc', 'dclid', 'wbraid', 'gbraid',
        'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
        'msclkid', 'yclid', 'twclid', 'ttclid',
        // Email / marketing automation
        'mc_cid', 'mc_eid',
        '_hsenc', '_hsmi', '_hsfp', 'hsCtaTracking',
        'mkt_tok',
        'vero_conv', 'vero_id',
        'oly_anon_id', 'oly_enc_id',
        's_cid',
        // Social
        'igshid', 'igsh', 'ref_src', 'ref_url',
        // Pinterest / Microsoft / etc.
        'epik',
        // Google Ads HSA
        'hsa_acc', 'hsa_cam', 'hsa_grp', 'hsa_ad', 'hsa_src', 'hsa_tgt',
        'hsa_kw', 'hsa_mt', 'hsa_net', 'hsa_ver',
        // Matomo / Piwik
        'pk_campaign', 'pk_kwd', 'pk_source', 'pk_medium', 'pk_content',
        'mtm_campaign', 'mtm_keyword', 'mtm_source', 'mtm_medium',
        'mtm_content', 'mtm_cid',
        // GA4
        '_ga', '_gl',
    ]);

    function stripTrackingParams(url) {
        if (!url) return url;
        try {
            const u = new URL(url);
            // Collect keys to delete (also catches any utm_*/fb_* we missed).
            const toDelete = [];
            for (const k of u.searchParams.keys()) {
                const lower = k.toLowerCase();
                if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
                    toDelete.push(k);
                }
            }
            if (!toDelete.length) return url;
            for (const k of toDelete) u.searchParams.delete(k);
            const qs = u.searchParams.toString();
            return u.origin + u.pathname + (qs ? '?' + qs : '') + (u.hash || '');
        } catch (_) {
            return url;
        }
    }

    function cidToHex(cidDecimal) {
        if (cidDecimal === null || cidDecimal === undefined || cidDecimal === '') return null;
        try {
            const big = BigInt(String(cidDecimal));
            return big.toString(16);
        } catch (_) { return null; }
    }

    async function copyToClipboard(text) {
        if (text === null || text === undefined) return false;
        const str = String(text);
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(str);
                return true;
            }
        } catch (_) {}
        try {
            const ta = document.createElement('textarea');
            ta.value = str;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (_) { return false; }
    }

    function escapeHTML(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function csvEscape(v) {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    function downloadBlob(text, filename, mime) {
        const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    function safeFilename(name) {
        return (name || 'business')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'business';
    }

    // ------------------------------------------------------------------
    // Debug log
    // ------------------------------------------------------------------
    const debugLog = [];
    function dbg(field, message, details) {
        debugLog.push({ ts: new Date().toISOString(), field, message, details });
        if (debugLog.length > 250) debugLog.shift();
        if (gmGet(STORAGE.debug, false)) {
            // eslint-disable-next-line no-console
            console.debug(`[GMB-OSINT] ${field}: ${message}`, details ?? '');
        }
    }

    // ------------------------------------------------------------------
    // Toast
    // ------------------------------------------------------------------
    let toastTimer = null;
    function toast(msg, ms) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), ms || 1800);
    }

    // ------------------------------------------------------------------
    // Extractors
    // Each returns { value, source } or null. Never throws.
    // ------------------------------------------------------------------
    function extractBusinessName() {
        const sels = [
            'h2[data-attrid="title"] span',
            'h2[data-attrid="title"]',
            'div[data-attrid="title"] span',
            'div[data-attrid="title"]',
            '.PZPZlf[data-attrid="title"]',
            '.qrShPb',
            'div.SPZz6b h2',
        ];
        for (const sel of sels) {
            try {
                const el = document.querySelector(sel);
                if (el && el.textContent && el.textContent.trim()) {
                    return { value: el.textContent.trim(), source: sel };
                }
            } catch (_) {}
        }
        dbg('businessName', 'no name selector matched', { tried: sels });
        return null;
    }

    function extractCID() {
        // 1) data-rc_ludocids on any element
        try {
            const el = document.querySelector('[data-rc_ludocids]');
            if (el) {
                const v = el.getAttribute('data-rc_ludocids');
                if (v && /^\d{10,25}$/.test(v)) return { value: v, source: 'data-rc_ludocids' };
            }
        } catch (_) {}

        // 2) Scan all anchors for cid= or ludocid=
        try {
            const anchors = document.querySelectorAll('a[href]');
            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                const full = a.href || href;
                let m = full.match(/[?&](?:cid|ludocid)=(\d{10,25})/);
                if (m) return { value: m[1], source: 'anchor[cid|ludocid]' };
                m = href.match(/[?&](?:cid|ludocid)=(\d{10,25})/);
                if (m) return { value: m[1], source: 'anchor-rel[cid|ludocid]' };
            }
        } catch (_) {}

        // 3) HTML regex fallback (covers inline JSON, jslog payloads)
        try {
            const html = document.documentElement.innerHTML;
            let m = html.match(/[?&"](?:cid|ludocid)["']?\s*[:=]\s*"?(\d{12,25})"?/);
            if (m) return { value: m[1], source: 'html regex (key)' };
            // CID hex pattern 0x...:0x{hex} — convert hex back to decimal as last resort
            m = html.match(/0x0:0x([0-9a-f]{8,20})/i);
            if (m) {
                try {
                    const dec = BigInt('0x' + m[1]).toString();
                    return { value: dec, source: 'html regex (0x0:0xhex)' };
                } catch (_) {}
            }
        } catch (_) {}

        dbg('cid', 'no CID found via any strategy');
        return null;
    }

    function extractPlaceId() {
        // 1) data-pid on any element (was #wrkpb in older Google UI)
        try {
            const els = document.querySelectorAll('[data-pid]');
            for (const el of els) {
                const v = el.getAttribute('data-pid');
                if (v && /^Ch[A-Za-z0-9_-]{20,}$/.test(v)) {
                    return { value: v, source: 'data-pid' };
                }
            }
        } catch (_) {}

        // 2) Anchor scan: placeid=, place_id=, q=place_id:
        try {
            const anchors = document.querySelectorAll('a[href]');
            for (const a of anchors) {
                const href = a.href || a.getAttribute('href') || '';
                let m = href.match(/[?&]placeid=([A-Za-z0-9_-]{20,})/);
                if (m && /^Ch/.test(m[1])) return { value: m[1], source: 'href[placeid]' };
                m = href.match(/[?&]place_id=([A-Za-z0-9_-]{20,})/);
                if (m && /^Ch/.test(m[1])) return { value: m[1], source: 'href[place_id]' };
                m = href.match(/[?&]q=place_id:([A-Za-z0-9_-]{20,})/);
                if (m) return { value: m[1], source: 'href[q=place_id]' };
                // /maps/place/.../data=...!1s<hex>:<hex>!... NOT a Place ID, skip.
            }
        } catch (_) {}

        // 3) HTML regex fallback for ChIJ-style IDs
        try {
            const html = document.documentElement.innerHTML;
            const m = html.match(/\b(Ch[IJ][A-Za-z0-9_-]{20,})\b/);
            if (m) return { value: m[1], source: 'html regex' };
        } catch (_) {}

        dbg('placeId', 'no Place ID found via any strategy');
        return null;
    }

    function extractKgmid() {
        try {
            const anchors = document.querySelectorAll('a[href*="kgmid="]');
            for (const a of anchors) {
                const m = (a.href || '').match(/[?&]kgmid=([^&#]+)/);
                if (m) return { value: decodeURIComponent(m[1]), source: 'href[kgmid]' };
            }
            const el = document.querySelector('[data-kgmid]');
            if (el) {
                const v = el.getAttribute('data-kgmid');
                if (v) return { value: v, source: 'data-kgmid' };
            }
            const html = document.documentElement.innerHTML;
            const m = html.match(/kgmid=(\/g\/[A-Za-z0-9_-]+)/);
            if (m) return { value: m[1], source: 'html regex' };
        } catch (_) {}
        return null;
    }

    function findGeoInJSON(obj, depth) {
        if (depth > 8 || !obj || typeof obj !== 'object') return null;
        if (obj.geo && obj.geo.latitude !== undefined && obj.geo.longitude !== undefined) {
            const lat = parseFloat(obj.geo.latitude);
            const lng = parseFloat(obj.geo.longitude);
            if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
        }
        if (Array.isArray(obj)) {
            for (const v of obj) {
                const g = findGeoInJSON(v, depth + 1);
                if (g) return g;
            }
        } else {
            for (const k of Object.keys(obj)) {
                const g = findGeoInJSON(obj[k], depth + 1);
                if (g) return g;
            }
        }
        return null;
    }

    function extractCoordinates() {
        // 1) meta itemprop
        try {
            const lat = document.querySelector('meta[itemprop="latitude"]');
            const lng = document.querySelector('meta[itemprop="longitude"]');
            if (lat && lng && lat.content && lng.content) {
                const f = { lat: parseFloat(lat.content), lng: parseFloat(lng.content) };
                if (!Number.isNaN(f.lat) && !Number.isNaN(f.lng)) {
                    return { value: f, source: 'meta itemprop' };
                }
            }
        } catch (_) {}

        // 2) Anchors with @lat,lng or ll= or !3d!4d
        try {
            for (const a of document.querySelectorAll('a[href*="@"], a[href*="ll="], a[href*="!3d"]')) {
                const href = a.href || '';
                let m = href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
                if (!m) m = href.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
                if (!m) m = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
                if (m) {
                    const lat = parseFloat(m[1]);
                    const lng = parseFloat(m[2]);
                    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
                        return { value: { lat, lng }, source: 'anchor href' };
                    }
                }
            }
        } catch (_) {}

        // 3) JSON-LD geo
        try {
            const ldjsons = document.querySelectorAll('script[type="application/ld+json"]');
            for (const s of ldjsons) {
                try {
                    const obj = JSON.parse(s.textContent);
                    const g = findGeoInJSON(obj, 0);
                    if (g) return { value: g, source: 'ld+json' };
                } catch (_) {}
            }
        } catch (_) {}

        // 4) HTML regex: !3d<lat>!4d<lng> in inline JS payloads
        try {
            const html = document.documentElement.innerHTML;
            const m = html.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
            if (m) {
                const lat = parseFloat(m[1]);
                const lng = parseFloat(m[2]);
                if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
                    return { value: { lat, lng }, source: 'html regex (!3d!4d)' };
                }
            }
        } catch (_) {}

        dbg('coordinates', 'no coordinates found');
        return null;
    }

    function extractAddress() {
        const sels = [
            '[data-attrid*="kc:/location/location:address"] .LrzXr',
            '[data-attrid*="kc:/location/location:address"] span.LrzXr',
            '[data-attrid*="address"] .LrzXr',
            'span.LrzXr',
            '[data-attrid*="kc:/location/location:address"]',
        ];
        for (const sel of sels) {
            try {
                const el = document.querySelector(sel);
                if (el && el.textContent && el.textContent.trim().length > 4) {
                    return { value: el.textContent.trim(), source: sel };
                }
            } catch (_) {}
        }
        dbg('address', 'no address selector matched', { tried: sels });
        return null;
    }

    function extractPhone() {
        // 1) tel: link
        try {
            const tel = document.querySelector('a[href^="tel:"]');
            if (tel) {
                const v = (tel.getAttribute('href') || '').replace(/^tel:/i, '').trim();
                if (v) return { value: v, source: 'a[href^=tel:]' };
            }
        } catch (_) {}
        // 2) data-attrid containing phone
        try {
            const blocks = document.querySelectorAll('[data-attrid*="phone"]');
            for (const b of blocks) {
                const text = (b.textContent || '').trim();
                const m = text.match(/[+(]?\d[\d\s\-.()]{6,}\d/);
                if (m) return { value: m[0].trim(), source: 'data-attrid[phone]' };
            }
        } catch (_) {}
        return null;
    }

    function extractWebsite() {
        // Hosts we never want returned as a "website" — handled by other extractors.
        const isExcludedHost = (url) => {
            try {
                const h = new URL(url).hostname.toLowerCase();
                return /(?:^|\.)(?:google\.[a-z.]+|gstatic\.com|googleusercontent\.com|youtube\.com|youtu\.be|facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|tiktok\.com|pinterest\.com|yelp\.com|bing\.com|apple\.com|openstreetmap\.org|foursquare\.com|wikipedia\.org)$/.test(h);
            } catch (_) { return true; }
        };
        // Google sometimes wraps outbound links as /url?q=... or /aclk?u=... — peel them.
        const unwrapGoogle = (href) => {
            try {
                if (/^https?:\/\/(?:www\.)?google\.[a-z.]+\/(?:url|aclk|imgres)\?/i.test(href)) {
                    const u = new URL(href);
                    const real = u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('u');
                    if (real && /^https?:\/\//.test(real)) return real;
                }
            } catch (_) {}
            return href;
        };

        // 1) Direct attribute selectors (old + new layouts).
        const attrSelectors = [
            'a[data-attrid="visit_official_site"]',
            'a[data-attrid*="kc:/common/topic:website"]',
            'a[data-attrid*="website"]',
            'a[aria-label="Website"]',
            'a[aria-label^="Website:"]',
            'a[aria-label^="Website "]',
            'a[title="Website"]',
            'a[data-pcl="website"]',
        ];
        for (const sel of attrSelectors) {
            try {
                const a = document.querySelector(sel);
                if (!a || !a.href) continue;
                const real = unwrapGoogle(a.href);
                if (/^https?:\/\//.test(real) && !isExcludedHost(real)) {
                    return { value: stripTrackingParams(real), source: sel };
                }
            } catch (_) {}
        }

        // 2) Anchor whose visible text is exactly "Website" (modern KP action strip).
        try {
            const anchors = document.querySelectorAll('a[href]');
            for (const a of anchors) {
                const text = (a.textContent || '').trim();
                if (text !== 'Website') continue;
                const real = unwrapGoogle(a.href);
                if (/^https?:\/\//.test(real) && !isExcludedHost(real)) {
                    return { value: stripTrackingParams(real), source: 'a:text=Website' };
                }
            }
        } catch (_) {}

        // 3) Inside a [data-attrid*="website"] block, take the first http link.
        try {
            const block = document.querySelector('[data-attrid*="website"]');
            if (block) {
                const a = block.querySelector('a[href^="http"]');
                if (a) {
                    const real = unwrapGoogle(a.href);
                    if (/^https?:\/\//.test(real) && !isExcludedHost(real)) {
                        return { value: stripTrackingParams(real), source: '[data-attrid*=website] a' };
                    }
                }
            }
        } catch (_) {}

        // 4) Knowledge-panel-scoped fallback: first non-social external link near the title.
        try {
            const titleEl = document.querySelector('[data-attrid="title"]');
            let scope = titleEl;
            for (let i = 0; i < 6 && scope && scope.parentElement; i++) {
                scope = scope.parentElement;
            }
            if (scope) {
                for (const a of scope.querySelectorAll('a[href^="http"], a[href^="/url"]')) {
                    const real = unwrapGoogle(a.href);
                    if (!real || !/^https?:\/\//.test(real)) continue;
                    if (isExcludedHost(real)) continue;
                    return {
                        value: stripTrackingParams(real),
                        source: 'kp-scope scan',
                        note: 'first non-social external link near title; verify',
                    };
                }
            }
        } catch (_) {}

        dbg('website', 'no website link found');
        return null;
    }

    function extractRatingReviewCount() {
        let rating = null;
        let count = null;
        let source = [];
        try {
            const r = document.querySelector('[role="img"][aria-label*="star"], [role="img"][aria-label*="Star"]');
            if (r) {
                const m = r.getAttribute('aria-label').match(/([\d.]+)\s*(?:out of|star)/i);
                if (m) { rating = parseFloat(m[1]); source.push('aria-label[star]'); }
            }
        } catch (_) {}
        try {
            if (rating === null) {
                const span = document.querySelector('.Aq14fc, span.Aq14fc');
                if (span) {
                    const m = (span.textContent || '').match(/([\d.]+)/);
                    if (m) { rating = parseFloat(m[1]); source.push('.Aq14fc'); }
                }
            }
        } catch (_) {}
        try {
            // Find a "(NNN reviews)" or "NNN Google reviews" anywhere near the title
            const candidates = document.querySelectorAll('a, span');
            for (const e of candidates) {
                const t = (e.textContent || '').trim();
                const m = t.match(/^[(]?([\d,]+)[)]?\s*(?:Google\s*)?reviews?$/i);
                if (m) { count = parseInt(m[1].replace(/,/g, ''), 10); source.push('reviews-text'); break; }
            }
        } catch (_) {}
        if (rating === null && count === null) return null;
        return { value: { rating, count }, source: source.join(',') };
    }

    function extractSocialProfiles() {
        const found = {};
        const patterns = [
            ['youtube',   /(?:^|\.)youtube\.com\/(channel|c|user|@)\//i],
            ['instagram', /(?:^|\.)instagram\.com\//i],
            ['facebook',  /(?:^|\.)facebook\.com\/(?!sharer|tr|share|search|plugins|dialog|login|profile\.php\?[^=]*=share)/i],
            ['twitter',   /(?:^|\.)(?:twitter\.com|x\.com)\/(?!search|hashtag|intent|home|share|i\/)/i],
            ['linkedin',  /(?:^|\.)linkedin\.com\/(company|in|school)\//i],
            ['tiktok',    /(?:^|\.)tiktok\.com\/@/i],
            ['pinterest', /(?:^|\.)pinterest\.com\//i],
        ];
        try {
            const anchors = document.querySelectorAll('a[href]');
            for (const a of anchors) {
                let href = a.href || '';
                if (!href || href.startsWith('javascript:')) continue;
                // Unwrap Google /url? redirects
                if (/^https?:\/\/(?:www\.)?google\.com\/url\?/.test(href)) {
                    try {
                        const u = new URL(href);
                        const real = u.searchParams.get('q') || u.searchParams.get('url');
                        if (real) href = real;
                    } catch (_) {}
                }
                if (/google\.com|gstatic\.com/i.test(href)) continue;
                const host = (() => { try { return new URL(href).hostname; } catch (_) { return ''; } })();
                if (!host) continue;
                for (const [key, re] of patterns) {
                    if (found[key]) continue;
                    if (re.test(host + new URL(href).pathname)) {
                        found[key] = stripTrackingParams(href.split('#')[0]);
                    }
                }
            }
        } catch (_) {}
        if (!Object.keys(found).length) return null;
        return { value: found, source: 'anchor scan' };
    }

    // ------------------------------------------------------------------
    // Generated link builders
    // ------------------------------------------------------------------
    function generateDerivedLinks(d) {
        const out = {};
        const enc = encodeURIComponent;
        const cid = d.cid && d.cid.value;
        const cidHex = d.cidHex && d.cidHex.value;
        const placeId = d.placeId && d.placeId.value;
        const name = d.businessName && d.businessName.value;
        const kgmid = d.kgmid && d.kgmid.value;
        const coords = d.coordinates && d.coordinates.value;
        const addr = d.address && d.address.value;

        if (cid) {
            out.googleMapsUrl    = { value: `https://www.google.com/maps?cid=${cid}`, status: 'generated' };
            out.mapsGoogleUrl    = { value: `https://maps.google.com/maps?cid=${cid}`, status: 'generated' };
            out.localGoogleCidUrl = { value: `https://local.google.com/place?id=${cid}&use=srp`, status: 'generated' };
            out.claimBusinessUrl = { value: `https://business.google.com/create?fp=${cid}`, status: 'generated' };
            out.embedSrc         = { value: `https://www.google.com/maps?cid=${cid}&output=embed`, status: 'generated' };
            if (cidHex) {
                // PlePer's full pb signature varies; we provide the working prefix.
                out.imagesInMapsUrl = {
                    value: `https://www.google.com/maps/uv?pb=!1s0x0:0x${cidHex}`,
                    status: 'best-effort',
                    note: 'partial pb signature; Google may render differently than PlePer\'s full uv URL',
                };
            }
        }

        if (placeId) {
            out.localGoogleSearchUrl = { value: `https://local.google.com/place?id=${placeId}&use=srp`, status: 'generated' };
            out.reviewsUrl           = { value: `https://search.google.com/local/reviews?placeid=${placeId}`, status: 'generated' };
            out.writeReviewUrl       = { value: `https://search.google.com/local/writereview?placeid=${placeId}`, status: 'generated' };
            out.requestAccessUrl     = { value: `https://business.google.com/arc/p/${placeId}`, status: 'generated' };
            out.placeIdUrl           = { value: `https://www.google.com/maps/place/?q=place_id:${placeId}`, status: 'generated' };
        }

        if (name) {
            out.googleSearchUrl = { value: `https://www.google.com/search?q=${enc(name)}`, status: 'generated' };
            if (kgmid) {
                out.postsUrl = { value: `https://www.google.com/search?q=${enc(name)}&kgmid=${enc(kgmid)}#lpstate=pid:-1,av`, status: 'generated' };
            } else {
                out.postsUrl = {
                    value: `https://www.google.com/search?q=${enc(name)}#lpstate=pid:-1,av`,
                    status: 'best-effort',
                    note: 'kgmid not detected; Posts panel may not render without it',
                };
            }
        }

        if (name && coords) {
            const { lat, lng } = coords;
            const addrStr = addr || '';
            out.bingMapsUrl     = { value: `https://www.bing.com/maps/?q=${enc(name)}&lat=${lat}&lon=${lng}&cp=${lat}~${lng}`, status: 'generated' };
            out.appleMapsUrl    = { value: `https://maps.apple.com/place?q=${enc(name)}&address=${enc(addrStr)}&ll=${lat},${lng}`, status: 'generated' };
            out.yelpUrl         = { value: `https://www.yelp.com/search?find_desc=${enc(name)}&find_loc=${enc(addrStr || `${lat},${lng}`)}`, status: 'generated' };
            out.facebookSearchUrl = { value: `https://www.facebook.com/search/places/?q=${enc(name)}`, status: 'generated' };
            out.foursquareUrl   = { value: `https://foursquare.com/explore?ll=${lat}%2C${lng}&mode=url&near=&q=${enc(name)}`, status: 'generated' };
            out.openStreetMapUrl = { value: `https://www.openstreetmap.org/search?query=${enc(name)}#map=17/${lat}/${lng}`, status: 'generated' };
        } else if (name) {
            out.yelpUrl         = { value: `https://www.yelp.com/search?find_desc=${enc(name)}`, status: 'generated' };
            out.facebookSearchUrl = { value: `https://www.facebook.com/search/places/?q=${enc(name)}`, status: 'generated' };
            out.openStreetMapUrl = { value: `https://www.openstreetmap.org/search?query=${enc(name)}`, status: 'generated' };
        }

        // Embed code (HTML+CSS string) - 16:9 responsive
        if (cid) {
            const embedHTML = [
                '<div class="google-maps">',
                `  <iframe src="https://www.google.com/maps?cid=${cid}&output=embed" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`,
                '</div>',
                '',
                '<style>',
                '.google-maps {',
                '  position: relative;',
                '  padding-bottom: 56.25%;',
                '  height: 0;',
                '  overflow: hidden;',
                '}',
                '.google-maps iframe {',
                '  position: absolute;',
                '  top: 0;',
                '  left: 0;',
                '  width: 100%;',
                '  height: 100%;',
                '  border: 0;',
                '}',
                '</style>',
            ].join('\n');
            out.embedCode = { value: embedHTML, status: 'generated' };
        }

        return out;
    }

    // ------------------------------------------------------------------
    // Master pipeline
    // ------------------------------------------------------------------
    function runExtraction() {
        const data = {
            businessName: extractBusinessName(),
            cid: extractCID(),
            placeId: extractPlaceId(),
            kgmid: extractKgmid(),
            coordinates: extractCoordinates(),
            address: extractAddress(),
            phone: extractPhone(),
            website: extractWebsite(),
            ratingReviews: extractRatingReviewCount(),
            socialProfiles: extractSocialProfiles(),
        };

        // Mark extracted statuses
        for (const k of Object.keys(data)) {
            if (data[k]) data[k].status = 'extracted';
        }

        // CID hex (generated)
        if (data.cid && data.cid.value) {
            const hex = cidToHex(data.cid.value);
            if (hex) data.cidHex = { value: hex, source: 'BigInt(cid).toString(16)', status: 'generated' };
        }

        const links = generateDerivedLinks(data);
        return Object.assign({}, data, links, {
            _meta: {
                version: VERSION,
                pageUrl: location.href,
                extractedAt: new Date().toISOString(),
            },
        });
    }

    function makeSignature(d) {
        return [
            d.businessName?.value || '',
            d.cid?.value || '',
            d.placeId?.value || '',
        ].join('|');
    }

    // ------------------------------------------------------------------
    // Page injection (idempotent)
    // ------------------------------------------------------------------
    function clearInjected() {
        document.querySelectorAll('#' + INJECT_ID).forEach(n => n.remove());
    }

    function renderInjected(data) {
        clearInjected();
        if (!gmGet(STORAGE.inject, true)) return;

        const target = document.querySelector('h2[data-attrid="title"]')
                    || document.querySelector('div[data-attrid="title"]')
                    || document.querySelector('[data-attrid="title"]');
        if (!target) return;

        const container = document.createElement('div');
        container.id = INJECT_ID;
        container.style.cssText = 'margin:8px 0 12px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font:12px/1.4 system-ui,Arial,sans-serif;';

        const idLine = document.createElement('div');
        idLine.style.cssText = 'flex-basis:100%;font-family:ui-monospace,Menlo,Monaco,monospace;font-size:12px;color:#5f6368;';
        const idParts = [];
        if (data.cid?.value)    idParts.push(`<span style="color:#1a73e8">CID:${escapeHTML(data.cid.value)}</span>`);
        if (data.cidHex?.value) idParts.push(`<span style="color:#9334e6">0x${escapeHTML(data.cidHex.value)}</span>`);
        if (data.placeId?.value) idParts.push(`<span style="color:#188038">PID:${escapeHTML(data.placeId.value)}</span>`);
        idLine.innerHTML = idParts.join(' &nbsp;|&nbsp; ');
        if (idParts.length) container.appendChild(idLine);

        const buttons = [
            ['Maps',          data.googleMapsUrl?.value],
            ['Reviews',       data.reviewsUrl?.value],
            ['Write Review',  data.writeReviewUrl?.value],
            ['Claim',         data.claimBusinessUrl?.value],
            ['Request Access', data.requestAccessUrl?.value],
            ['Place ID URL',  data.placeIdUrl?.value],
            ['local.google',  data.localGoogleCidUrl?.value || data.localGoogleSearchUrl?.value],
        ];
        for (const [label, href] of buttons) {
            if (!href) continue;
            const a = document.createElement('a');
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = label;
            a.style.cssText = 'padding:4px 10px;background:#F14E13;color:#fff !important;border-radius:4px;text-decoration:none;font-weight:500;font-size:12px;';
            container.appendChild(a);
        }

        // Insert after the title
        if (target.parentElement) {
            target.parentElement.insertBefore(container, target.nextSibling);
        } else {
            target.appendChild(container);
        }
    }

    // ------------------------------------------------------------------
    // Panel UI
    // ------------------------------------------------------------------
    function buildStyles() {
        if (typeof GM_addStyle !== 'function') {
            const s = document.createElement('style');
            s.textContent = STYLES;
            document.head.appendChild(s);
        } else {
            GM_addStyle(STYLES);
        }
    }

    const STYLES = `
        #${PANEL_ID} {
            position: fixed; top: 0; right: -440px; width: 420px; max-width: calc(100vw - 40px);
            height: 100vh; background:#1d1d1d; color:#eee;
            transition: right .25s ease; z-index: 2147483600;
            font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
            box-shadow: -4px 0 14px rgba(0,0,0,.35); display:flex; flex-direction:column;
        }
        #${PANEL_ID}.open { right: 0; }
        #${PANEL_ID} .gmb-toggle {
            position: absolute; left: -32px; top: 50%; transform: translateY(-50%);
            width: 32px; height: 64px; background:#F14E13; color:#fff; cursor:pointer;
            display:flex; align-items:center; justify-content:center; font-size:18px;
            border-radius: 6px 0 0 6px; user-select:none;
        }
        #${PANEL_ID} .gmb-header {
            padding: 12px 14px; border-bottom: 1px solid #333;
            display:flex; flex-direction:column; gap:8px;
        }
        #${PANEL_ID} .gmb-header h3 { margin:0; color:#F14E13; font-size:15px; font-weight:600; }
        #${PANEL_ID} .gmb-actions { display:flex; flex-wrap:wrap; gap:6px; }
        #${PANEL_ID} button.gmb-btn {
            background:#F14E13; color:#fff; border:none; padding:6px 10px;
            border-radius:4px; cursor:pointer; font-size:12px; font-weight:500;
        }
        #${PANEL_ID} button.gmb-btn:hover { background:#ff6a3c; }
        #${PANEL_ID} button.gmb-btn.secondary { background:#2d2d2d; border:1px solid #444; }
        #${PANEL_ID} button.gmb-btn.secondary:hover { background:#3a3a3a; }
        #${PANEL_ID} .gmb-toggles { display:flex; gap:14px; font-size:12px; color:#bbb; }
        #${PANEL_ID} .gmb-toggles label { cursor:pointer; user-select:none; }
        #${PANEL_ID} .gmb-body { flex:1; overflow-y:auto; padding: 8px 12px 24px 12px; }
        #${PANEL_ID} details.gmb-section {
            background:#252525; border:1px solid #333; border-radius:6px;
            margin-bottom: 8px;
        }
        #${PANEL_ID} details.gmb-section[open] { background:#222; }
        #${PANEL_ID} summary.gmb-section-title {
            cursor:pointer; padding:8px 12px; font-weight:600; color:#F14E13;
            list-style:none; font-size:13px; user-select:none;
        }
        #${PANEL_ID} summary.gmb-section-title::-webkit-details-marker { display:none; }
        #${PANEL_ID} summary.gmb-section-title::before { content:"▸ "; color:#888; }
        #${PANEL_ID} details[open] summary.gmb-section-title::before { content:"▾ "; color:#888; }
        #${PANEL_ID} .gmb-section-body { padding: 4px 12px 10px 12px; }
        #${PANEL_ID} .gmb-field {
            display:flex; flex-direction:column; gap:3px; padding:6px 0;
            border-bottom: 1px dashed #2f2f2f;
        }
        #${PANEL_ID} .gmb-field:last-child { border-bottom:none; }
        #${PANEL_ID} .gmb-field-row {
            display:flex; align-items:center; gap:8px; justify-content:space-between;
        }
        #${PANEL_ID} .gmb-field-label {
            font-weight:600; color:#ddd; font-size:12px;
            display:flex; gap:6px; align-items:center;
        }
        #${PANEL_ID} .gmb-badge {
            font-size:9px; padding:1px 6px; border-radius:8px; text-transform:uppercase;
            letter-spacing:.4px; font-weight:600;
        }
        #${PANEL_ID} .gmb-badge.extracted   { background:#0d652d; color:#c8e6c9; }
        #${PANEL_ID} .gmb-badge.generated   { background:#1a4480; color:#c5d8f7; }
        #${PANEL_ID} .gmb-badge.best-effort { background:#7a4900; color:#ffe0a3; }
        #${PANEL_ID} .gmb-badge.missing     { background:#4d4d4d; color:#aaa; }
        #${PANEL_ID} .gmb-field-value {
            font-family: ui-monospace, Menlo, Monaco, monospace; font-size: 11.5px;
            word-break: break-all; color:#cfcfcf; padding:2px 0;
        }
        #${PANEL_ID} .gmb-field-value.muted { color:#777; font-style: italic; }
        #${PANEL_ID} .gmb-field-value a { color:#80b3ff; text-decoration:none; }
        #${PANEL_ID} .gmb-field-value a:hover { text-decoration:underline; }
        #${PANEL_ID} .gmb-field-note { color:#aaa; font-size:11px; font-style:italic; }
        #${PANEL_ID} .gmb-mini-copy {
            background:transparent; color:#aaa; border:1px solid #444;
            padding:2px 8px; border-radius:3px; cursor:pointer; font-size:11px;
        }
        #${PANEL_ID} .gmb-mini-copy:hover { color:#fff; border-color:#F14E13; }
        #${PANEL_ID} pre.gmb-embed {
            background:#111; border:1px solid #333; border-radius:4px;
            padding:8px; overflow:auto; font-size:11px; max-height:200px;
            color:#cfcfcf;
        }
        #${PANEL_ID} .gmb-debug-log {
            background:#111; border:1px solid #333; border-radius:4px;
            padding:8px; max-height:240px; overflow:auto;
            font:11px ui-monospace,Menlo,Monaco,monospace;
        }
        #${PANEL_ID} .gmb-debug-log .row { padding:2px 0; border-bottom:1px dotted #222; color:#aaa; }
        #${PANEL_ID} .gmb-debug-log .row .field { color:#F14E13; font-weight:600; }
        #${PANEL_ID} .gmb-credits { text-align:center; color:#666; padding:10px 0; font-size:11px; }

        #${TOAST_ID} {
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background:#F14E13; color:#fff; padding:8px 16px; border-radius:4px;
            z-index: 2147483647; opacity:0; pointer-events:none; transition: opacity .2s;
            font:13px system-ui,Arial,sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.3);
        }
        #${TOAST_ID}.show { opacity:1; }
    `;

    function buildPanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="gmb-toggle" title="Toggle GMB OSINT panel">📊</div>
            <div class="gmb-header">
                <h3>GMB OSINT — v${VERSION}</h3>
                <div class="gmb-actions">
                    <button class="gmb-btn" data-action="rescan">Rescan</button>
                    <button class="gmb-btn secondary" data-action="clear-injected">Clear injected</button>
                    <button class="gmb-btn secondary" data-action="copy-json">JSON</button>
                    <button class="gmb-btn secondary" data-action="copy-csv">CSV</button>
                    <button class="gmb-btn secondary" data-action="copy-md">MD</button>
                </div>
                <div class="gmb-toggles">
                    <label><input type="checkbox" data-toggle="inject"> Inject buttons in page</label>
                    <label><input type="checkbox" data-toggle="debug"> Debug log</label>
                </div>
            </div>
            <div class="gmb-body" id="${PANEL_ID}-body">
                <div style="color:#888;padding:20px 4px;">Scanning…</div>
            </div>
        `;
        document.body.appendChild(panel);

        // Toggle open/close
        panel.querySelector('.gmb-toggle').addEventListener('click', () => {
            const open = panel.classList.toggle('open');
            gmSet(STORAGE.panelOpen, open);
        });
        if (gmGet(STORAGE.panelOpen, false)) panel.classList.add('open');

        // Settings checkboxes
        const injectCb = panel.querySelector('[data-toggle="inject"]');
        const debugCb = panel.querySelector('[data-toggle="debug"]');
        injectCb.checked = gmGet(STORAGE.inject, true);
        debugCb.checked = gmGet(STORAGE.debug, false);
        injectCb.addEventListener('change', () => {
            gmSet(STORAGE.inject, injectCb.checked);
            // Re-render injection state
            if (window.__gmbOsintLastData) renderInjected(window.__gmbOsintLastData);
            else if (!injectCb.checked) clearInjected();
        });
        debugCb.addEventListener('change', () => {
            gmSet(STORAGE.debug, debugCb.checked);
            renderPanel(window.__gmbOsintLastData);
        });

        // Header buttons (delegated)
        panel.querySelector('.gmb-actions').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const data = window.__gmbOsintLastData || runExtraction();
            switch (action) {
                case 'rescan':
                    scan('manual');
                    toast('Rescanned');
                    break;
                case 'clear-injected':
                    clearInjected();
                    toast('Injected buttons cleared');
                    break;
                case 'copy-json':
                    copyToClipboard(buildExportJSON(data)).then(ok => toast(ok ? 'JSON copied' : 'Copy failed'));
                    break;
                case 'copy-csv':
                    copyToClipboard(buildExportCSV(data)).then(ok => toast(ok ? 'CSV row copied' : 'Copy failed'));
                    break;
                case 'copy-md':
                    copyToClipboard(buildExportMarkdown(data)).then(ok => toast(ok ? 'Markdown copied' : 'Copy failed'));
                    break;
            }
        });

        return panel;
    }

    // ------------------------------------------------------------------
    // Section / field configuration
    // ------------------------------------------------------------------
    const SECTIONS = [
        {
            id: 'core', title: 'Core Business Data',
            fields: [
                { key: 'businessName',  label: 'Business Name' },
                { key: 'address',       label: 'Address' },
                { key: 'phone',         label: 'Phone' },
                { key: 'website',       label: 'Website', isLink: true },
                { key: 'ratingReviews', label: 'Rating / Reviews', formatter: v => `${v.rating ?? '?'} ★  •  ${v.count ?? '?'} reviews` },
                { key: 'coordinates',   label: 'Coordinates', formatter: v => `${v.lat}, ${v.lng}` },
            ],
        },
        {
            id: 'ids', title: 'Google Identifiers',
            fields: [
                { key: 'cid',     label: 'CID (decimal)' },
                { key: 'cidHex',  label: 'CID (hexadecimal)', formatter: v => `0x${v}` },
                { key: 'placeId', label: 'Place ID' },
                { key: 'kgmid',   label: 'kgmid' },
            ],
        },
        {
            id: 'glinks', title: 'Google Links',
            fields: [
                { key: 'googleMapsUrl',      label: 'google.com/maps?cid=', isLink: true },
                { key: 'mapsGoogleUrl',      label: 'maps.google.com/maps?cid=', isLink: true },
                { key: 'localGoogleCidUrl',  label: 'local.google (CID)', isLink: true },
                { key: 'localGoogleSearchUrl', label: 'local.google (Place ID)', isLink: true },
                { key: 'placeIdUrl',         label: 'maps/place ?q=place_id:', isLink: true },
                { key: 'imagesInMapsUrl',    label: 'Images in Maps (uv pb)', isLink: true },
                { key: 'googleSearchUrl',    label: 'Google Search', isLink: true },
                { key: 'postsUrl',           label: 'Posts', isLink: true },
            ],
        },
        {
            id: 'review', title: 'Review / Manage Links',
            fields: [
                { key: 'reviewsUrl',       label: 'Reviews', isLink: true },
                { key: 'writeReviewUrl',   label: 'Write Review', isLink: true },
                { key: 'claimBusinessUrl', label: 'Claim Business', isLink: true },
                { key: 'requestAccessUrl', label: 'Request Access', isLink: true },
            ],
        },
        {
            id: 'social', title: 'Social Profiles',
            fields: [
                { key: 'socialProfiles.youtube',   label: 'YouTube', isLink: true },
                { key: 'socialProfiles.instagram', label: 'Instagram', isLink: true },
                { key: 'socialProfiles.facebook',  label: 'Facebook', isLink: true },
                { key: 'socialProfiles.twitter',   label: 'X / Twitter', isLink: true },
                { key: 'socialProfiles.linkedin',  label: 'LinkedIn', isLink: true },
                { key: 'socialProfiles.tiktok',    label: 'TikTok', isLink: true },
                { key: 'socialProfiles.pinterest', label: 'Pinterest', isLink: true },
            ],
        },
        {
            id: 'other', title: 'Other Search Engines',
            fields: [
                { key: 'bingMapsUrl',      label: 'Bing Maps', isLink: true },
                { key: 'appleMapsUrl',     label: 'Apple Maps', isLink: true },
                { key: 'yelpUrl',          label: 'Yelp', isLink: true },
                { key: 'facebookSearchUrl', label: 'Facebook Search', isLink: true },
                { key: 'foursquareUrl',    label: 'Foursquare', isLink: true },
                { key: 'openStreetMapUrl', label: 'OpenStreetMap', isLink: true },
            ],
        },
    ];

    function getNested(d, path) {
        const parts = path.split('.');
        let cur = d;
        for (const p of parts) {
            if (cur === null || cur === undefined) return undefined;
            cur = cur[p];
        }
        return cur;
    }

    // Get a field record from the data given a (possibly nested) key.
    // Returns { value, status, source?, note? } or null.
    function resolveField(data, key) {
        if (!data) return null;
        if (key.startsWith('socialProfiles.')) {
            const sub = key.split('.')[1];
            if (data.socialProfiles && data.socialProfiles.value && data.socialProfiles.value[sub]) {
                return { value: data.socialProfiles.value[sub], status: 'extracted' };
            }
            return null;
        }
        return data[key] || null;
    }

    function formatFieldDisplay(field, record) {
        if (!record || record.value === null || record.value === undefined || record.value === '') {
            return null;
        }
        try {
            return field.formatter ? field.formatter(record.value) : String(record.value);
        } catch (_) { return String(record.value); }
    }

    function rawCopyValue(field, record) {
        if (!record || record.value === null || record.value === undefined) return '';
        if (field.formatter) {
            try {
                // Coordinates copy as "lat,lng", rating as the formatted text
                if (field.key === 'coordinates') return `${record.value.lat},${record.value.lng}`;
                if (field.key === 'cidHex') return `0x${record.value}`;
                return field.formatter(record.value);
            } catch (_) {}
        }
        return String(record.value);
    }

    // ------------------------------------------------------------------
    // Panel render
    // ------------------------------------------------------------------
    function renderPanel(data) {
        const body = document.getElementById(PANEL_ID + '-body');
        if (!body) return;
        if (!data) {
            body.innerHTML = '<div style="color:#888;padding:20px 4px;">No data extracted yet.</div>';
            return;
        }

        const closedSet = new Set(gmGet(STORAGE.sectionsClosed, []) || []);
        const html = [];

        for (const section of SECTIONS) {
            const isOpen = !closedSet.has(section.id);
            html.push(`<details class="gmb-section" data-section="${section.id}"${isOpen ? ' open' : ''}>`);
            html.push(`<summary class="gmb-section-title">${escapeHTML(section.title)}</summary>`);
            html.push('<div class="gmb-section-body">');

            for (const field of section.fields) {
                const rec = resolveField(data, field.key);
                const display = formatFieldDisplay(field, rec);
                const status = rec?.status || 'missing';
                const note = rec?.note || '';

                html.push('<div class="gmb-field">');
                html.push('<div class="gmb-field-row">');
                html.push(`<div class="gmb-field-label">${escapeHTML(field.label)} <span class="gmb-badge ${status}">${status}</span></div>`);
                if (display !== null) {
                    html.push(`<button class="gmb-mini-copy" data-copy-key="${escapeHTML(field.key)}">Copy</button>`);
                }
                html.push('</div>');

                if (display === null) {
                    html.push('<div class="gmb-field-value muted">Not found</div>');
                } else if (field.isLink) {
                    html.push(`<div class="gmb-field-value"><a href="${escapeHTML(display)}" target="_blank" rel="noopener noreferrer">${escapeHTML(display)}</a></div>`);
                } else {
                    html.push(`<div class="gmb-field-value">${escapeHTML(display)}</div>`);
                }
                if (note) html.push(`<div class="gmb-field-note">${escapeHTML(note)}</div>`);
                html.push('</div>');
            }

            html.push('</div></details>');
        }

        // Embed Code section
        const embed = data.embedCode;
        const isOpenEmbed = !closedSet.has('embed');
        html.push(`<details class="gmb-section" data-section="embed"${isOpenEmbed ? ' open' : ''}>`);
        html.push('<summary class="gmb-section-title">Embed Code</summary>');
        html.push('<div class="gmb-section-body">');
        if (embed?.value) {
            html.push(`<div class="gmb-field-row" style="margin-bottom:6px;">`);
            html.push(`<div class="gmb-field-label">Responsive iframe (16:9) <span class="gmb-badge generated">generated</span></div>`);
            html.push(`<button class="gmb-mini-copy" data-copy-key="embedCode">Copy</button>`);
            html.push(`</div>`);
            html.push(`<pre class="gmb-embed">${escapeHTML(embed.value)}</pre>`);
        } else {
            html.push('<div class="gmb-field-value muted">No CID — embed code unavailable</div>');
        }
        html.push('</div></details>');

        // Export section
        const isOpenExport = !closedSet.has('export');
        html.push(`<details class="gmb-section" data-section="export"${isOpenExport ? ' open' : ''}>`);
        html.push('<summary class="gmb-section-title">Export</summary>');
        html.push('<div class="gmb-section-body">');
        html.push('<div class="gmb-actions" style="flex-wrap:wrap;">');
        html.push('<button class="gmb-btn" data-export="copy-json">Copy JSON</button>');
        html.push('<button class="gmb-btn" data-export="download-json">Download JSON</button>');
        html.push('<button class="gmb-btn secondary" data-export="copy-csv">Copy CSV row</button>');
        html.push('<button class="gmb-btn secondary" data-export="download-csv">Download CSV</button>');
        html.push('<button class="gmb-btn secondary" data-export="copy-md">Copy Markdown</button>');
        html.push('<button class="gmb-btn secondary" data-export="copy-urls">Copy all URLs</button>');
        html.push('<button class="gmb-btn secondary" data-export="copy-embed">Copy embed</button>');
        html.push('<button class="gmb-btn secondary" data-export="copy-handoff">Copy handoff summary</button>');
        html.push('</div>');
        html.push('</div></details>');

        // Debug Log section
        const isOpenDebug = !closedSet.has('debug');
        html.push(`<details class="gmb-section" data-section="debug"${isOpenDebug ? ' open' : ''}>`);
        html.push('<summary class="gmb-section-title">Debug Log</summary>');
        html.push('<div class="gmb-section-body">');
        if (debugLog.length === 0) {
            html.push('<div class="gmb-field-value muted">No debug entries (toggle Debug log to see selector attempts).</div>');
        } else {
            html.push('<div class="gmb-debug-log">');
            for (const e of debugLog.slice(-80)) {
                const detailStr = e.details ? ` <span style="color:#666">${escapeHTML(JSON.stringify(e.details))}</span>` : '';
                html.push(`<div class="row"><span class="field">${escapeHTML(e.field)}</span> ${escapeHTML(e.message)}${detailStr}</div>`);
            }
            html.push('</div>');
        }
        html.push('</div></details>');

        html.push(`<div class="gmb-credits">v${VERSION} • by sharmanhall • <a href="https://github.com/tyhallcsu/gmb-osint" target="_blank" style="color:#888;">github</a></div>`);

        body.innerHTML = html.join('');

        // Wire up: persist section open/close
        body.querySelectorAll('details.gmb-section').forEach(d => {
            d.addEventListener('toggle', () => {
                const closed = Array.from(body.querySelectorAll('details.gmb-section'))
                    .filter(x => !x.open).map(x => x.dataset.section);
                gmSet(STORAGE.sectionsClosed, closed);
            });
        });

        // Wire up: per-field copy buttons
        body.querySelectorAll('.gmb-mini-copy[data-copy-key]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const key = btn.dataset.copyKey;
                let text = '';
                if (key === 'embedCode') {
                    text = data.embedCode?.value || '';
                } else {
                    // Find the field in SECTIONS
                    let field = null;
                    for (const sec of SECTIONS) {
                        for (const f of sec.fields) {
                            if (f.key === key) { field = f; break; }
                        }
                        if (field) break;
                    }
                    const rec = resolveField(data, key);
                    text = field ? rawCopyValue(field, rec) : (rec?.value ?? '');
                }
                const ok = await copyToClipboard(text);
                toast(ok ? 'Copied' : 'Copy failed');
            });
        });

        // Wire up: export buttons
        body.querySelectorAll('button[data-export]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const action = btn.dataset.export;
                const fname = safeFilename(data.businessName?.value);
                let ok = false;
                switch (action) {
                    case 'copy-json':     ok = await copyToClipboard(buildExportJSON(data)); toast(ok ? 'JSON copied' : 'Copy failed'); break;
                    case 'download-json': downloadBlob(buildExportJSON(data), `${fname}.gmb.json`, 'application/json'); toast('JSON downloaded'); break;
                    case 'copy-csv':      ok = await copyToClipboard(buildExportCSV(data)); toast(ok ? 'CSV row copied' : 'Copy failed'); break;
                    case 'download-csv':  downloadBlob(buildExportCSV(data, true), `${fname}.gmb.csv`, 'text/csv'); toast('CSV downloaded'); break;
                    case 'copy-md':       ok = await copyToClipboard(buildExportMarkdown(data)); toast(ok ? 'Markdown copied' : 'Copy failed'); break;
                    case 'copy-urls':     ok = await copyToClipboard(buildExportURLs(data)); toast(ok ? 'URLs copied' : 'Copy failed'); break;
                    case 'copy-embed':    ok = await copyToClipboard(data.embedCode?.value || ''); toast(ok ? 'Embed copied' : 'No embed (need CID)'); break;
                    case 'copy-handoff':  ok = await copyToClipboard(buildExportHandoff(data)); toast(ok ? 'Handoff copied' : 'Copy failed'); break;
                }
            });
        });
    }

    // ------------------------------------------------------------------
    // Export builders
    // ------------------------------------------------------------------
    function flattenForExport(data) {
        // Flatten the data tree into a stable record of label -> {value, status, note}
        const out = {};
        for (const section of SECTIONS) {
            for (const f of section.fields) {
                const rec = resolveField(data, f.key);
                let value = null;
                if (rec && rec.value !== null && rec.value !== undefined && rec.value !== '') {
                    try { value = f.formatter ? f.formatter(rec.value) : String(rec.value); }
                    catch (_) { value = String(rec.value); }
                    if (f.key === 'coordinates' && rec.value) value = `${rec.value.lat},${rec.value.lng}`;
                    if (f.key === 'cidHex') value = `0x${rec.value}`;
                }
                out[f.label] = {
                    value: value,
                    status: rec ? rec.status : 'missing',
                    note: rec?.note || null,
                    source: rec?.source || null,
                };
            }
        }
        return out;
    }

    function buildExportJSON(data) {
        const flat = flattenForExport(data);
        const obj = {
            meta: data._meta,
            fields: flat,
            embedCode: data.embedCode?.value || null,
        };
        return JSON.stringify(obj, null, 2);
    }

    function buildExportCSV(data, withHeader) {
        const flat = flattenForExport(data);
        const labels = Object.keys(flat);
        const headerRow = ['_extracted_at', '_page_url', '_script_version', ...labels];
        const dataRow = [
            data._meta.extractedAt,
            data._meta.pageUrl,
            data._meta.version,
            ...labels.map(l => flat[l].value || ''),
        ];
        const lines = [];
        if (withHeader) lines.push(headerRow.map(csvEscape).join(','));
        lines.push(dataRow.map(csvEscape).join(','));
        return lines.join('\n');
    }

    function buildExportMarkdown(data) {
        const flat = flattenForExport(data);
        const lines = [];
        const name = data.businessName?.value || 'Unknown business';
        lines.push(`# GMB OSINT — ${name}`);
        lines.push('');
        lines.push(`*Extracted ${data._meta.extractedAt} from* \`${data._meta.pageUrl}\` *(script v${data._meta.version})*`);
        lines.push('');

        for (const section of SECTIONS) {
            lines.push(`## ${section.title}`);
            for (const f of section.fields) {
                const cell = flat[f.label];
                if (!cell || !cell.value) {
                    lines.push(`- **${f.label}:** _not found_`);
                } else {
                    const badge = cell.status === 'extracted' ? '' : ` _(${cell.status}${cell.note ? '; ' + cell.note : ''})_`;
                    lines.push(`- **${f.label}:** ${cell.value}${badge}`);
                }
            }
            lines.push('');
        }

        if (data.embedCode?.value) {
            lines.push('## Embed Code');
            lines.push('```html');
            lines.push(data.embedCode.value);
            lines.push('```');
            lines.push('');
        }

        return lines.join('\n');
    }

    function buildExportURLs(data) {
        const flat = flattenForExport(data);
        const lines = [];
        for (const section of SECTIONS) {
            const urlFields = section.fields.filter(f => f.isLink);
            if (!urlFields.length) continue;
            const sectionLines = [];
            for (const f of urlFields) {
                const cell = flat[f.label];
                if (cell && cell.value) sectionLines.push(`${f.label}: ${cell.value}`);
            }
            if (sectionLines.length) {
                lines.push(`# ${section.title}`);
                lines.push(...sectionLines);
                lines.push('');
            }
        }
        return lines.join('\n').trim();
    }

    function buildExportHandoff(data) {
        const flat = flattenForExport(data);
        const name = data.businessName?.value || 'Unknown business';
        const lines = [];
        lines.push(`Client handoff: ${name}`);
        lines.push('====');
        const core = ['Business Name', 'Address', 'Phone', 'Website', 'Coordinates', 'Rating / Reviews'];
        for (const k of core) {
            const v = flat[k];
            lines.push(`${k}: ${v?.value || '(not found)'}`);
        }
        lines.push('');
        lines.push('Identifiers');
        lines.push(`  CID: ${flat['CID (decimal)']?.value || '-'}`);
        lines.push(`  CID hex: ${flat['CID (hexadecimal)']?.value || '-'}`);
        lines.push(`  Place ID: ${flat['Place ID']?.value || '-'}`);
        lines.push(`  kgmid: ${flat['kgmid']?.value || '-'}`);
        lines.push('');
        lines.push('Key links');
        const keyLinks = ['google.com/maps?cid=', 'Reviews', 'Write Review', 'Claim Business', 'Request Access'];
        for (const k of keyLinks) {
            const v = flat[k];
            if (v?.value) lines.push(`  ${k}: ${v.value}`);
        }
        lines.push('');
        lines.push(`Source: ${data._meta.pageUrl}`);
        lines.push(`Extracted: ${data._meta.extractedAt} (v${data._meta.version})`);
        return lines.join('\n');
    }

    // ------------------------------------------------------------------
    // Scan controller
    // ------------------------------------------------------------------
    let lastSignature = null;

    function scan(reason) {
        const data = runExtraction();
        const sig = makeSignature(data);
        if (sig === lastSignature && reason !== 'manual') {
            // Same data - no point re-rendering
            return;
        }
        lastSignature = sig;
        window.__gmbOsintLastData = data;
        try { renderPanel(data); } catch (e) { dbg('render', 'panel render failed', String(e)); }
        try { renderInjected(data); } catch (e) { dbg('render', 'inject render failed', String(e)); }
    }

    const debouncedScan = debounce(() => scan('observer'), 1000);

    function startObserver() {
        const obs = new MutationObserver(() => debouncedScan());
        obs.observe(document.body, { childList: true, subtree: true });
        // Also do a one-time delayed scan for late content
        setTimeout(() => scan('late-init'), 2500);
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    function init() {
        try {
            buildStyles();
            buildPanel();
            scan('initial');
            startObserver();
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[GMB-OSINT] init failed', e);
        }
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init, { once: true });
    }
})();
