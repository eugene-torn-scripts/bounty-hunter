// ==UserScript==
// @name         Bounty Hunter
// @namespace    https://github.com/eugene-torn-scripts/bounty-hunter
// @version      1.15.2
// @description  Live Torn bounty board filter — min reward, FFScouter fair-fight range, Okay/Hospital status, med-out watchlist — with clickable attack toasts. Desktop + Torn PDA.
// @author       lannav
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// @connect      ffscouter.com
// @connect      eugene-torn-donors.sytnik-evhen.workers.dev
// @license      GPL-3.0-or-later
// @downloadURL  https://update.greasyfork.org/scripts/574289/Bounty%20Hunter.user.js
// @updateURL    https://update.greasyfork.org/scripts/574289/Bounty%20Hunter.meta.js
// ==/UserScript==

/*
 * Bounty Hunter
 * Copyright (C) 2026 lannav
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details: https://www.gnu.org/licenses/gpl-3.0.html
 *
 * Source: https://github.com/eugene-torn-scripts/bounty-hunter
 */

/* eslint-disable no-undef */

(function () {
    "use strict";

    // ════════════════════════════════════════════════════════════
    //  CONSTANTS & CONFIG
    // ════════════════════════════════════════════════════════════

    // Torn PDA substitutes this literal at load time with the user's public key.
    // On desktop / non-PDA, it stays as the placeholder and we fall back to
    // localStorage (optionally reusing Supply Pack Analyzer's saved key).
    const PDA_API_KEY = "###PDA-APIKEY###";
    const PDA_PLACEHOLDER = "###" + "PDA-APIKEY" + "###"; // split to avoid self-substitution

    const VERSION = "1.15.2";
    const LS = {
        apiKey:    "bh_apiKey",
        ffKey:     "bh_ffscouterKey",
        settings:  "bh_settings",
        shared:    "bh_shared",      // cross-tab: last refresh result (matches + metadata)
        debug:     "bh_debug",       // "1" when the debug log is on; undefined/"" otherwise
        donorCache:"bh_donorCache",  // { userId, donor, lastDonationTs, fetchedAt } — 6h client cache
        donorAck:  "bh_donorAck",    // unix-ts of last donation the user dismissed the banner for
        userId:    "bh_userId",      // resolved Torn user id (cached so DonorClient doesn't race Hunter.start)
        blacklist: "bh_blacklist",   // { "<id>": { name, note, addedAt } } — players excluded from matches
        watchlist: "bh_watchlist",   // { "<id>": { name, reward, lastState, addedAt } } — med-out watch targets
        apiCallPrefix: "bh_apiCalls_", // per-tab ring of recent API-call timestamps; summed cross-tab for the rate counter
    };
    // Every open BH tab records its own API-call timestamps under a distinct
    // key so the rolling rate counter can sum across tabs without a
    // read-modify-write race on one shared array. The id is per page load.
    const TAB_ID = Math.random().toString(36).slice(2, 10);
    // Cloudflare Worker that powers the donor "thank-you" banner. Read-only,
    // takes only the requester's Torn user id (no API key, no PII), returns
    // { donor, lastDonationTs }. Cached for 6h in localStorage and shared
    // across all torn.com tabs (one origin → one localStorage), so a typical
    // user hits this at most ~4 times/day.
    const DONOR_API_BASE = "https://eugene-torn-donors.sytnik-evhen.workers.dev";
    // When shared data is younger than (refreshSec * SHARED_FRESH_RATIO) ms,
    // a tab skips its own refresh and free-rides on the writer's result.
    // 0.8 leaves headroom for clock drift between tabs that started close
    // together — we'd rather free-ride than double-fetch.
    const SHARED_FRESH_RATIO = 0.8;
    const SPA_LS_APIKEY = "spa_apiKey"; // reuse SPA's key on desktop if present

    // ════════════════════════════════════════════════════════════
    //  DEBUG LOG — opt-in ring buffer surfaced in the Settings tab.
    //  Goal: let the user SEE requests firing and rate-limit hits
    //  in real time without opening devtools.
    // ════════════════════════════════════════════════════════════

    const debugLog = [];
    const MAX_DEBUG_LOG = 150;
    // Cheap pub-sub so the Settings tab can re-render the log as new
    // entries land. document is always present before the IIFE runs.
    const debugBus = document.createElement("div");

    function isDebugOn() {
        try { return localStorage.getItem(LS.debug) === "1"; } catch { return false; }
    }

    // Strip host noise and redact the `key=` query param so Torn/FFScouter
    // API keys never end up in a log the user might screenshot or paste.
    function redactUrl(url) {
        try {
            const u = new URL(url);
            const params = new URLSearchParams(u.search);
            for (const k of ["key", "apikey"]) {
                if (params.has(k)) params.set(k, "***");
            }
            const q = params.toString();
            return `${u.host}${u.pathname}${q ? "?" + q : ""}`;
        } catch {
            return url;
        }
    }

    // `level` is one of "info" | "ok" | "warn" | "err" — drives the row colour.
    function logDebug(label, level = "info", ms = null) {
        if (!isDebugOn()) return;
        debugLog.push({
            ts: new Date().toISOString().slice(11, 19),
            label,
            level,
            ms: (typeof ms === "number") ? Math.round(ms) : null,
        });
        if (debugLog.length > MAX_DEBUG_LOG) debugLog.shift();
        debugBus.dispatchEvent(new CustomEvent("entry"));
    }

    const API_BASE = "https://api.torn.com/v2";
    const FF_BASE  = "https://ffscouter.com/api/v1";
    const API_DELAY_MS = 750;
    // Direct attack URL — lands on the fight page for the target. Torn
    // auto-credits the bounty when the target is hospitalised, so we don't
    // need `&bounty=<contract_id>` (which isn't in the public API anyway).
    const ATTACK_URL  = "https://www.torn.com/page.php?sid=attack&user2ID=";
    const PROFILE_URL = "https://www.torn.com/profiles.php?XID=";

    const DEFAULT_SETTINGS = {
        minPrice: 500_000,
        minFF:    1.0,
        maxFF:    3.0,
        hospitalMaxMin: 5,
        // When on, hospitalised targets match regardless of remaining hospital
        // time — the "Hospital max" minutes cap is ignored. Default off so the
        // existing behaviour (queue only near-out targets) is unchanged.
        hospNoLimit: false,
        // Country filter. Default on = only surface targets in the same country
        // as you (reachable from an attack page right now). Off includes
        // different-country targets and in-transit ("Traveling"/"Abroad") ones —
        // not attackable until you're co-located, shown for planning/awareness.
        sameCountryOnly: true,
        refreshSec: 60,
        // Med-out watchlist poll interval, seconds. Floor 1. Each watched
        // target costs one request per poll; with the 750 ms global gate the
        // real cadence for K targets is ~max(interval, K*0.75s). The Hunt-tab
        // counter warns when total calls approach Torn's ~100/min ceiling.
        watchlistIntervalSec: 5,
        toastsEnabled: true,
        includeUnknownFF: false,
        // Master kill-switch for the refresh loop. When off, auto-refresh
        // and cross-tab free-ride are both skipped; last-known matches stay
        // on screen and manual "Refresh now" still works.
        searchEnabled: true,
        // Skip auto-refresh when the player can't attack anyway. Requires a
        // Torn API key with Minimal access or higher (`/user/bars`). Opt-in
        // so existing Public-key users aren't forced to regenerate.
        pauseOnLowEnergy: false,
        // Standard attack costs 25 energy; raise if you want to keep a buffer
        // for chains/merits. 0 is treated the same as pauseOnLowEnergy=false.
        minEnergy: 25,
        // Pause auto-refresh when WE can't act on a bounty anyway. All opt-in
        // (off by default) and free: the player's own status comes from the
        // /user/profile call refresh() already makes, so no extra API cost and
        // no key-scope bump (status is Public). State→toggle mapping:
        //   pauseInHospital   → status.state === "Hospital"
        //   pauseInJail       → status.state === "Jail"
        //   pauseWhileTraveling → status.state === "Traveling" (in transit;
        //                         "Abroad"/landed is still attackable, so not gated)
        pauseInHospital: false,
        pauseInJail: false,
        pauseWhileTraveling: false,
        // Toast notification appearance. Persisted as a nested object so
        // users who haven't touched these keep the original defaults forever.
        notifications: {
            position: "bottom-right", // bottom-right | bottom-left | top-right | top-left
            width: 300,               // card width in px (desktop only — mobile is full-width)
            maxVisible: 3,            // stack cap before "+N more" rolls up the overflow
            timeoutSec: 15,           // per-card auto-dismiss
            fields: {                 // which row to render inside each card
                level: true,
                reward: true,
                ff: true,
                bs: true,
                status: true,
                location: true,       // "📍 <country>" marker when the target is in a different country than you
                blacklist: false,     // small "🚫 Blacklist" button next to Attack
            },
        },
    };

    // Torn New Player Protection (https://wiki.torn.com/wiki/New_Player_Protection):
    //   - NPP lasts 14 days (age 0..13). At age >= 14 the player loses NPP.
    //   - A non-NPP player cannot attack an NPP player.
    //   - An NPP player CAN attack another NPP player, but not in the target's first 24 h.
    //   - (Edge case we ignore: faction-war participation lifts NPP temporarily.)
    const NPP_DAYS = 14;
    function isAttackableByAge(targetAge, myAge) {
        if (targetAge == null) return true; // unknown → don't drop, Torn will reject on attack if any
        const meUnderNPP = (myAge != null) && (myAge < NPP_DAYS);
        if (meUnderNPP) {
            // Both under NPP → target must be past the 24-hour hard block.
            return targetAge >= 1;
        }
        // We're past NPP → target must also be past NPP to be attackable.
        return targetAge >= NPP_DAYS;
    }

    // Physical-country derivation from Torn v2 status. Used to exclude targets
    // who are in a different country than us — they aren't reachable from an
    // attack page. Return values:
    //   "Torn"      — in Torn (Okay/Jail/Federal, or hospitalised in Torn)
    //   "<Country>" — abroad (state "Abroad"), or hospitalised in a specific
    //                 foreign country (description "In a <Adjective> hospital")
    //   null        — unknown or "Traveling" (in transit, unattackable anyway)
    //
    // Adjective→country map covers every Torn travel destination. If a future
    // destination ships without an entry here the target is returned as null
    // and the country filter falls open — safer than silently dropping them.
    const HOSPITAL_ADJ_TO_COUNTRY = {
        "Mexican": "Mexico",
        "Caymanian": "Cayman Islands",
        "Canadian": "Canada",
        "Hawaiian": "Hawaii",
        "British": "United Kingdom",
        "Argentinian": "Argentina",
        "Argentine": "Argentina",
        "Swiss": "Switzerland",
        "Japanese": "Japan",
        "Chinese": "China",
        "Emirati": "United Arab Emirates",
        "South African": "South Africa",
    };
    function getPlayerCountry(status) {
        if (!status || typeof status !== "object") return null;
        const state = status.state;
        const desc = status.description || "";
        if (state === "Okay" || state === "Jail" || state === "Federal") return "Torn";
        if (state === "Abroad") {
            const m = /^In\s+(.+)$/.exec(desc);
            return m ? m[1].trim() : null;
        }
        if (state === "Hospital") {
            if (/^In hospital\b/i.test(desc)) return "Torn";
            const m = /^In an?\s+(.+?)\s+hospital\b/i.exec(desc);
            if (m) {
                const adj = m[1].trim();
                return HOSPITAL_ADJ_TO_COUNTRY[adj] || null;
            }
            return null;
        }
        return null; // Traveling, or unknown state
    }

    const STATUS_CACHE_MS = 20_000;
    const STATUS_CONCURRENCY = 3;

    const IS_PDA = typeof PDA_httpGet === "function";
    const HAS_PDA_KEY = PDA_API_KEY !== PDA_PLACEHOLDER && /^[A-Za-z0-9]{16}$/.test(PDA_API_KEY);
    // Desktop userscript managers expose GM_xmlhttpRequest when the script
    // requests `@grant GM_xmlhttpRequest`. We prefer it over fetch because
    // FFScouter's CORS headers may not allow direct calls from torn.com.
    // eslint-disable-next-line no-undef
    const GM_XHR = (typeof GM_xmlhttpRequest !== "undefined") ? GM_xmlhttpRequest : null;

    // ════════════════════════════════════════════════════════════
    //  UTILITIES
    // ════════════════════════════════════════════════════════════

    const fmt = {
        money(n) {
            if (n == null) return "$0";
            const a = Math.abs(n);
            const s = a >= 1e9 ? (a / 1e9).toFixed(2) + "B"
                : a >= 1e6 ? (a / 1e6).toFixed(2) + "M"
                : a >= 1e3 ? (a / 1e3).toFixed(1) + "K"
                : a.toLocaleString();
            return (n < 0 ? "-$" : "$") + s;
        },
        moneyFull(n) { return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(); },
        num(n) { return n == null ? "" : Number(n).toLocaleString(); },
        secsToMinLabel(s) {
            if (s <= 0) return "0m";
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return m > 0 ? `${m}m ${sec}s`.replace(" 0s", "") : `${sec}s`;
        },
        hospLabel(untilSec) {
            const rem = Math.max(0, untilSec - Math.floor(Date.now() / 1000));
            if (rem <= 0) return "🏥 out";
            const m = Math.floor(rem / 60);
            const s = rem % 60;
            if (m === 0) return `🏥 ${s}s`;
            return `🏥 ${m}m ${s}s`;
        },
        // Single source of truth for a match's status badge (text + CSS class +
        // optional live-countdown attr), shared by the toast, the table row and
        // any other status render site so they never drift.
        statusMeta(b) {
            switch (b.statusState) {
                case "Hospital":
                    return { text: this.hospLabel(b.hospUntil), cls: "bh-badge-hosp", attr: ` data-hosp-until="${b.hospUntil}"` };
                case "Traveling":
                    return { text: "✈ Traveling", cls: "bh-badge-travel", attr: "" };
                case "Abroad":
                    return { text: "✈ Abroad", cls: "bh-badge-travel", attr: "" };
                default:
                    return { text: "Okay", cls: "bh-badge-ok", attr: "" };
            }
        },
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Parse FFScouter's bs_estimate_human ("3.93k" / "2.99b") to a comparable
    // number. Returns null for missing/unparseable values so callers can sort
    // them to the end.
    function parseBS(human) {
        if (!human) return null;
        const m = String(human).match(/^\s*([\d.]+)\s*([kKmMbB]?)\s*$/);
        if (!m) return null;
        const n = parseFloat(m[1]);
        if (!Number.isFinite(n)) return null;
        const s = (m[2] || "").toLowerCase();
        const mult = s === "k" ? 1e3 : s === "m" ? 1e6 : s === "b" ? 1e9 : 1;
        return n * mult;
    }

    function escHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(LS.settings);
            const stored = raw ? JSON.parse(raw) : {};
            return mergeSettings(stored);
        } catch { return mergeSettings({}); }
    }

    // Shallow-merge top-level keys, but deep-merge the nested `notifications`
    // object so a partially-stored value (or a value coming in via the
    // cross-tab storage event after a schema bump) keeps its defaults.
    function mergeSettings(stored) {
        const storedNotif = (stored && typeof stored.notifications === "object" && stored.notifications) || {};
        const storedFields = (storedNotif.fields && typeof storedNotif.fields === "object") ? storedNotif.fields : {};
        return {
            ...DEFAULT_SETTINGS,
            ...stored,
            notifications: {
                ...DEFAULT_SETTINGS.notifications,
                ...storedNotif,
                fields: { ...DEFAULT_SETTINGS.notifications.fields, ...storedFields },
            },
        };
    }

    function saveSettings(s) {
        localStorage.setItem(LS.settings, JSON.stringify(s));
    }

    // ════════════════════════════════════════════════════════════
    //  BLACKLIST — per-browser local list of Torn user ids whose
    //  bounties never appear in the Hunt list or as a toast. Schema:
    //    { "<numericId>": { name: string|null, note: string, addedAt: number } }
    //  Stored under LS.blacklist; cross-tab sync via the storage event.
    // ════════════════════════════════════════════════════════════

    function loadBlacklist() {
        try {
            const raw = localStorage.getItem(LS.blacklist);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
        } catch { return {}; }
    }

    function saveBlacklist(map) {
        try { localStorage.setItem(LS.blacklist, JSON.stringify(map)); } catch { /* quota */ }
    }

    function blAddEntry(map, id, name) {
        const key = String(Number(id));
        if (!/^\d+$/.test(key) || key === "0") return false;
        const existing = map[key];
        map[key] = {
            name: (existing && existing.name) || (name ? String(name) : null),
            note: existing ? existing.note : "",
            addedAt: existing ? existing.addedAt : Math.floor(Date.now() / 1000),
        };
        return true;
    }

    function blSetName(map, id, name) {
        const key = String(Number(id));
        if (!map[key] || !name) return false;
        if (map[key].name === name) return false;
        map[key].name = String(name);
        return true;
    }

    function blSetNote(map, id, note) {
        const key = String(Number(id));
        if (!map[key]) return false;
        map[key].note = String(note || "");
        return true;
    }

    function blRemove(map, id) {
        const key = String(Number(id));
        if (!map[key]) return false;
        delete map[key];
        return true;
    }

    // Permissive importer — accepts a JSON object exported from this script,
    // a JSON array of bare ids, or a plain comma/whitespace-separated id
    // list. Returns the number of entries added (existing entries are kept).
    function blImport(map, text) {
        const t = String(text || "").trim();
        if (!t) return 0;
        let added = 0;
        const tryAdd = (id, name) => { if (blAddEntry(map, id, name)) added++; };
        try {
            const parsed = JSON.parse(t);
            if (Array.isArray(parsed)) {
                for (const v of parsed) tryAdd(v);
                return added;
            }
            if (parsed && typeof parsed === "object") {
                for (const [k, v] of Object.entries(parsed)) {
                    tryAdd(k, v && v.name);
                    if (v && map[String(Number(k))]) {
                        if (typeof v.note === "string") map[String(Number(k))].note = v.note;
                        if (typeof v.addedAt === "number") map[String(Number(k))].addedAt = v.addedAt;
                    }
                }
                return added;
            }
        } catch { /* fall through to plain-id parse */ }
        for (const tok of t.split(/[\s,;]+/)) {
            if (/^\d+$/.test(tok)) tryAdd(tok);
        }
        return added;
    }

    // ════════════════════════════════════════════════════════════
    //  WATCHLIST — per-browser list of bounty targets to poll fast
    //  for a hospital→okay ("med-out") transition. Schema:
    //    { "<numericId>": { name, reward, lastState, addedAt } }
    //  Stored under LS.watchlist; cross-tab sync via the storage event.
    // ════════════════════════════════════════════════════════════

    function loadWatchlist() {
        try {
            const raw = localStorage.getItem(LS.watchlist);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
        } catch { return {}; }
    }

    function saveWatchlist(map) {
        try { localStorage.setItem(LS.watchlist, JSON.stringify(map)); } catch { /* quota */ }
    }

    // ════════════════════════════════════════════════════════════
    //  API-CALL RATE COUNTER — rolling 60 s window, summed across all
    //  open BH tabs. Each tab appends to its OWN key (no cross-tab RMW
    //  race); the reader sums every tab's key and drops keys that have
    //  gone quiet (their owner tab was closed).
    // ════════════════════════════════════════════════════════════

    const RATE_WINDOW_MS = 60_000;
    const RATE_WARN = 90;              // Torn's real ceiling is ~100/min
    const RATE_STALE_MS = 120_000;     // a tab silent this long is treated as gone

    function recordApiCall() {
        try {
            const key = LS.apiCallPrefix + TAB_ID;
            const now = Date.now();
            let arr = [];
            try { arr = JSON.parse(localStorage.getItem(key) || "[]"); } catch { arr = []; }
            if (!Array.isArray(arr)) arr = [];
            arr.push(now);
            const cutoff = now - RATE_WINDOW_MS;
            arr = arr.filter((t) => t >= cutoff);
            localStorage.setItem(key, JSON.stringify(arr));
        } catch { /* quota / private mode — counter just under-reports */ }
    }

    // Total API calls across all tabs in the last 60 s. Side-effect: prunes
    // this tab's own array and removes keys whose owner tab looks dead.
    function apiCallsLastMinute() {
        const now = Date.now();
        const cutoff = now - RATE_WINDOW_MS;
        let total = 0;
        let keys = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(LS.apiCallPrefix)) keys.push(k);
            }
        } catch { return 0; }
        for (const k of keys) {
            let arr = [];
            try { arr = JSON.parse(localStorage.getItem(k) || "[]"); } catch { arr = []; }
            if (!Array.isArray(arr) || arr.length === 0) { continue; }
            const recent = arr.filter((t) => t >= cutoff);
            const newest = arr[arr.length - 1];
            if (newest < now - RATE_STALE_MS && k !== LS.apiCallPrefix + TAB_ID) {
                try { localStorage.removeItem(k); } catch { /* noop */ }
                continue;
            }
            total += recent.length;
        }
        return total;
    }

    // Projected watchlist calls/min for a list size and interval, accounting
    // for the 750 ms global gate: K targets can't be polled faster than
    // K*0.75 s, so the effective period is max(interval, K*0.75s).
    function projectedWatchCallsPerMin(count, intervalSec) {
        if (count <= 0) return 0;
        const gateFloorSec = count * (API_DELAY_MS / 1000);
        const periodSec = Math.max(intervalSec, gateFloorSec);
        return Math.ceil((count * 60) / periodSec);
    }

    // Open a Torn URL in a way that works on desktop and inside the PDA webview.
    // `window.open` is unreliable in PDA — synthesising an anchor click lets the
    // platform handle the navigation natively (new tab on desktop, in-app on PDA).
    function openTornUrl(url) {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    // ════════════════════════════════════════════════════════════
    //  HTTP — uses PDA_httpGet inside PDA, fetch on desktop
    // ════════════════════════════════════════════════════════════

    function _gmGet(url) {
        return new Promise((resolve, reject) => {
            GM_XHR({
                method: "GET",
                url,
                onload: (r) => resolve({ status: r.status, text: r.responseText }),
                onerror: () => reject(new Error("network_error")),
                ontimeout: () => reject(new Error("timeout")),
            });
        });
    }

    async function _httpGetOnceRaw(url) {
        if (IS_PDA) {
            const res = await PDA_httpGet(url);
            if (res.status < 200 || res.status >= 300) {
                const err = new Error(`HTTP ${res.status}`);
                err.status = res.status;
                err.body = res.responseText;
                throw err;
            }
            return JSON.parse(res.responseText);
        }
        if (GM_XHR) {
            const res = await _gmGet(url);
            if (res.status < 200 || res.status >= 300) {
                const err = new Error(`HTTP ${res.status}`);
                err.status = res.status;
                err.body = res.text;
                throw err;
            }
            return JSON.parse(res.text);
        }
        const res = await fetch(url);
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            err.body = await res.text().catch(() => "");
            throw err;
        }
        return res.json();
    }

    // Debug-logging wrapper around the raw HTTP call. Records status + ms
    // for every request so the user can watch traffic in real time.
    async function _httpGetOnce(url) {
        const started = performance.now();
        const redacted = redactUrl(url);
        try {
            const data = await _httpGetOnceRaw(url);
            const ms = performance.now() - started;
            // Torn returns 200 OK with { error: { code: 5, error: "Too many requests" } }
            // on rate limit. Surface that in the log even though the HTTP layer saw 200.
            const tornCode = data && data.error && data.error.code;
            if (tornCode === 5) {
                logDebug(`GET ${redacted} → 200 · Torn rate limit (code 5)`, "err", ms);
            } else if (tornCode) {
                logDebug(`GET ${redacted} → 200 · Torn code ${tornCode}`, "warn", ms);
            } else {
                logDebug(`GET ${redacted} → 200`, "ok", ms);
            }
            return data;
        } catch (err) {
            const ms = performance.now() - started;
            const status = err.status || "ERR";
            const level = (status === 429) ? "err" : "warn";
            const tag = (status === 429) ? " · rate limit" : "";
            logDebug(`GET ${redacted} → ${status}${tag}`, level, ms);
            throw err;
        }
    }

    // One retry for transient / PDA-flaky failures. Real HTTP errors fall through.
    async function httpGetJson(url) {
        try { return await _httpGetOnce(url); }
        catch (err) {
            if (err.status >= 400 && err.status < 500) throw err;
            logDebug(`retry after network/5xx error`, "warn");
            await sleep(400);
            return _httpGetOnce(url);
        }
    }

    // Rate-limit signal for both Torn (JSON envelope error.code=5) and
    // FFScouter/HTTP layer (status 429). When true, the caller should abort
    // the whole refresh cycle so prior matches stay on screen instead of
    // being overwritten with a partial/empty set.
    function isRateLimitError(err) {
        if (!err) return false;
        if (err.status === 429) return true;
        if (err.tornCode === 5) return true;
        return false;
    }

    // ════════════════════════════════════════════════════════════
    //  TORN API CLIENT (rate-limited, 750 ms min gap)
    // ════════════════════════════════════════════════════════════

    class TornAPI {
        constructor(key) {
            this.key = key;
            this._lastReq = 0;
        }

        setKey(key) { this.key = key; }

        async _rateLimit() {
            const wait = API_DELAY_MS - (Date.now() - this._lastReq);
            if (wait > 0) await sleep(wait);
            this._lastReq = Date.now();
        }

        async _get(pathOrUrl, params = null) {
            await this._rateLimit();
            recordApiCall();
            const isFull = /^https?:\/\//.test(pathOrUrl);
            const url = new URL(isFull ? pathOrUrl : API_BASE + pathOrUrl);
            if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
            if (!url.searchParams.has("key")) url.searchParams.set("key", this.key);
            const data = await httpGetJson(url.toString());
            if (data && data.error) {
                const e = new Error(data.error.error || "Torn API error");
                e.tornCode = data.error.code;
                throw e;
            }
            return data;
        }

        async fetchAllBounties() {
            const all = [];
            let url = `${API_BASE}/torn/bounties?limit=100&offset=0`;
            let delay = 0;
            let safety = 10; // cap pagination at 1000 bounties
            while (url && safety-- > 0) {
                const data = await this._get(url);
                if (Array.isArray(data.bounties)) all.push(...data.bounties);
                if (typeof data.bounties_delay === "number") delay = data.bounties_delay;
                const next = data._metadata && data._metadata.links && data._metadata.links.next;
                if (!next || !data.bounties || data.bounties.length === 0) break;
                url = next;
            }
            return { bounties: all, delaySec: delay };
        }

        async fetchUserProfile(id) {
            // profile gives status + age + level + faction_id; bounties gives
            // THIS target's actual current bounty rows. Combining selections is
            // a single request (rate limit is per-request, not per-selection),
            // so the bounty re-confirmation rides along for free. Both
            // selections require only a Public key. We read the per-target
            // bounty list from the SAME snapshot as the status, which kills the
            // skew between the (separately-fetched) global board reward and a
            // staler cached status — the misalignment that surfaces a claimed
            // bounty's reward on a target who has already moved on.
            const data = await this._get(`/user/${id}?selections=profile,bounties`);
            return {
                profile: data.profile || null,
                bounties: Array.isArray(data.bounties) ? data.bounties : null,
            };
        }

        async validateKey() {
            // /user/profile gives us id + level + age + faction_id in one shot;
            // age is needed to evaluate Torn's NPP rule against bounty targets.
            const data = await this._get("/user/profile");
            return (data && data.profile) || null;
        }

        // /user/bars is declared ApiKeyMinimal in the Torn v2 spec — a Public-
        // only key returns error code 16 ("Access level of this key is not
        // high enough") or similar. Callers should catch and fall back.
        async fetchBars() {
            const data = await this._get("/user/bars");
            return (data && data.bars) || null;
        }
    }

    // ════════════════════════════════════════════════════════════
    //  FFSCOUTER — bulk fair-fight lookup (up to 205 IDs/call)
    // ════════════════════════════════════════════════════════════

    // Validates an FFScouter key via /check-key. Format-valid ≠ usable — the
    // key must also be registered on FFScouter (get-stats otherwise returns
    // code 6 and we silently filter everyone out). /check-key doesn't count
    // against the caller's usage.
    async function validateFFScouterKey(key) {
        if (!/^[A-Za-z0-9]{16}$/.test(key)) {
            return { ok: false, message: "Must be 16 alphanumeric characters." };
        }
        try {
            const data = await httpGetJson(`${FF_BASE}/check-key?key=${encodeURIComponent(key)}`);
            if (data && data.code) return { ok: false, message: data.error || `FFScouter code ${data.code}` };
            if (!data || !data.is_registered) {
                return { ok: false, message: "Key is not registered with FFScouter — sign up at ffscouter.com first." };
            }
            return { ok: true, message: data.is_premium ? "Valid — premium." : "Valid." };
        } catch (e) {
            return { ok: false, message: e && e.message ? e.message : "Could not reach FFScouter." };
        }
    }

    async function fetchFFScouterStats(key, userIds) {
        const result = { map: new Map(), error: null, nullCount: 0, totalReturned: 0 };
        if (!key) { result.error = "no_key"; return result; }
        if (userIds.length === 0) return result;
        for (let i = 0; i < userIds.length; i += 200) {
            const chunk = userIds.slice(i, i + 200);
            const url = `${FF_BASE}/get-stats?key=${encodeURIComponent(key)}&targets=${chunk.join(",")}`;
            try {
                const data = await httpGetJson(url);
                if (!Array.isArray(data)) {
                    result.error = (data && data.error) ? data.error : "unexpected_response";
                    continue;
                }
                result.totalReturned += data.length;
                for (const p of data) {
                    if (p.fair_fight == null) { result.nullCount++; continue; }
                    result.map.set(Number(p.player_id), {
                        ff: Number(p.fair_fight),
                        bs: p.bs_estimate_human || null,
                    });
                }
            } catch (e) {
                // Rate-limit aborts the cycle so prior matches stay visible —
                // partial FFScouter data would otherwise filter good targets out.
                if (isRateLimitError(e)) throw e;
                // Surface the first error but keep processing other chunks.
                if (!result.error) result.error = e.message || "network_error";
            }
        }
        return result;
    }

    // ════════════════════════════════════════════════════════════
    //  KEY RESOLVER
    // ════════════════════════════════════════════════════════════

    const KeyResolver = {
        // Returns the Torn API key if resolvable without user input, else null.
        resolveTornKey() {
            if (HAS_PDA_KEY) return PDA_API_KEY;
            return localStorage.getItem(LS.apiKey) || null;
        },
        hasSPAKey() {
            const k = localStorage.getItem(SPA_LS_APIKEY);
            return !!k && /^[A-Za-z0-9]{16}$/.test(k);
        },
        getSPAKey() { return localStorage.getItem(SPA_LS_APIKEY); },
        saveTornKey(k) { localStorage.setItem(LS.apiKey, k); },
        clearTornKey() { localStorage.removeItem(LS.apiKey); },
        getFFKey() { return localStorage.getItem(LS.ffKey) || ""; },
        saveFFKey(k) { localStorage.setItem(LS.ffKey, k); },
        clearFFKey() { localStorage.removeItem(LS.ffKey); },
        // When the PDA-injected key is in use we don't persist it — it may
        // change per session and the user controls it through PDA settings.
        isPDAKey() { return HAS_PDA_KEY; },
    };

    // ════════════════════════════════════════════════════════════
    //  DONOR CLIENT — talks to the eugene-torn-donors CF worker so the
    //  Hunt tab can show a green "thanks for the Xanax" banner to anyone
    //  who has tipped this script. Best-effort and silent on failure;
    //  the banner is a niceness, not a feature path. Cache lives in
    //  localStorage (shared across all torn.com tabs).
    // ════════════════════════════════════════════════════════════

    const DonorClient = {
        CACHE_TTL_MS: 6 * 60 * 60 * 1000,
        _inflight: null,    // dedupes concurrent fetches across re-renders

        _readCache() {
            try {
                const raw = localStorage.getItem(LS.donorCache);
                return raw ? JSON.parse(raw) : null;
            } catch { return null; }
        },
        _writeCache(obj) {
            try { localStorage.setItem(LS.donorCache, JSON.stringify(obj)); } catch { /* quota */ }
        },
        _readAck() {
            const v = parseInt(localStorage.getItem(LS.donorAck) || "0", 10);
            return Number.isFinite(v) ? v : 0;
        },
        _writeAck(ts) {
            try { localStorage.setItem(LS.donorAck, String(ts)); } catch { /* quota */ }
        },

        // Returns the cached status if it's both fresh and for this userId.
        // Switching keys (different userId) invalidates the cache so a
        // freshly-pasted account doesn't see the previous user's banner.
        cachedStatus(userId) {
            const c = this._readCache();
            if (!c || c.userId !== userId) return null;
            if ((Date.now() - (c.fetchedAt || 0)) > this.CACHE_TTL_MS) return null;
            return c;
        },

        // Resolve our own Torn user id without depending on the Hunter's
        // refresh loop having completed. Caches in localStorage so a cold
        // panel open is instant after the first session. Falls back to a
        // direct /user/?selections=basic call (api.torn.com is in Torn's
        // page CSP allowlist, so plain fetch works there).
        async getUserId() {
            const stored = localStorage.getItem(LS.userId);
            if (stored && /^\d+$/.test(stored)) return parseInt(stored, 10);
            const key = KeyResolver.resolveTornKey();
            if (!key) return null;
            try {
                // Reuse the existing PDA/GM/fetch dispatcher — native fetch
                // to api.torn.com is unreliable on Torn PDA's webview, which
                // is why the rest of the script uses PDA_httpGet there.
                const d = await _httpGetOnceRaw(`https://api.torn.com/v2/user/profile?key=${encodeURIComponent(key)}`);
                const id = d && d.profile && d.profile.id;
                if (id) {
                    try { localStorage.setItem(LS.userId, String(id)); } catch { /* quota */ }
                    return id;
                }
            } catch { /* network or HTTP error — silent on this path */ }
            return null;
        },

        // Three transports in order of preference per environment:
        //   - PDA      → PDA_httpGet (bypasses WebView restrictions; native
        //                fetch from PDA's webview can be blocked even when
        //                the BE returns CORS:*)
        //   - desktop  → GM_xmlhttpRequest (bypasses Torn's page CSP)
        //   - fallback → native fetch (only fires if both above absent)
        async _request(url) {
            try {
                if (IS_PDA) {
                    const res = await PDA_httpGet(url);
                    if (res.status < 200 || res.status >= 300) return null;
                    return JSON.parse(res.responseText);
                }
                if (typeof GM_XHR === "function") {
                    return await new Promise((resolve) => {
                        GM_XHR({
                            method: "GET",
                            url,
                            timeout: 10_000,
                            onload: (res) => {
                                if (!res || res.status < 200 || res.status >= 300) return resolve(null);
                                try { resolve(JSON.parse(res.responseText)); }
                                catch { resolve(null); }
                            },
                            onerror: () => resolve(null),
                            ontimeout: () => resolve(null),
                        });
                    });
                }
                const r = await fetch(url, { method: "GET", credentials: "omit", cache: "default" });
                return r.ok ? r.json() : null;
            } catch { return null; }
        },

        async fetchStatus(userId) {
            if (!userId) return null;
            if (this._inflight) return this._inflight;
            const url = `${DONOR_API_BASE}/donor?id=${encodeURIComponent(userId)}&script=bounty`;
            this._inflight = (async () => {
                const d = await this._request(url);
                if (!d) return null;
                const status = {
                    userId,
                    donor: !!d.donor,
                    lastDonationTs: Number(d.lastDonationTs) || 0,
                    fetchedAt: Date.now(),
                };
                this._writeCache(status);
                return status;
            })();
            try { return await this._inflight; }
            finally { this._inflight = null; }
        },

        // Banner shows only if the server reports a donation newer than the
        // ts the user has already dismissed for. New Xanax → ts advances on
        // the server → banner reappears.
        shouldShow(status) {
            if (!status || !status.donor) return false;
            if (!status.lastDonationTs) return false;
            return status.lastDonationTs > this._readAck();
        },

        dismiss(lastDonationTs) {
            this._writeAck(lastDonationTs || 0);
        },
    };

    // ════════════════════════════════════════════════════════════
    //  HUNTER — fetch → filter → render loop
    // ════════════════════════════════════════════════════════════

    class Hunter {
        constructor(api) {
            this.api = api;
            this.settings = loadSettings();
            this.blacklist = loadBlacklist();
            this.watchlist = loadWatchlist();
            this._watchTimer = null;
            this._watchNextAt = 0;
            this._watchRunning = false;
            this.onWatchToast = null;   // ui/toaster sets this — med-out alert
            this.myUserId = null;
            this.myUserLevel = null;
            this.myUserAge = null;      // days since our own signup — drives NPP rule
            this.myCountry = null;      // "Torn" | "<country>" | null — drives country filter
            this.lastMatches = [];      // last render's rows
            this.lastMatchIds = new Set();
            // The first apply from ANOTHER tab's shared data seeds lastMatchIds
            // silently rather than firing a toast for every cached match — that
            // data can be stale (already-claimed bounties). A cold-start's own
            // fresh refresh() is NOT suppressed, so the user still gets toasts
            // for the bounties that are actionable the moment they open Torn.
            this._firstApplyDone = false;
            // Set true by a filter/settings change so the very next apply
            // re-seeds silently — avoids re-toasting matches already on screen
            // under the previous filter. Consumed (reset) by _applyMatches.
            this._reseedSilent = false;
            this.lastCounts = null;     // { total, afterBasic, afterFF, withFF, ffNull, ffError, statusBreakdown }
            this._statusCache = new Map(); // id → { data, fetchedAt }
            this._timer = null;
            this._running = false;
            this._nextAt = 0;
            this.lastError = null;
            this.partialFromRateLimit = false; // true when lastMatches comes from a cycle aborted mid-scan by rate limit
            this.myEnergy = null;       // { current, maximum } when pauseOnLowEnergy is on + call succeeded
            this.lastEnergyError = null; // "scope" | "error" | null — drives the settings-panel hint
            this.mySelfState = null;    // last-known own status.state ("Okay"|"Hospital"|"Jail"|"Traveling"|…) from validateKey
            this.pausedReason = null;   // "disabled" | "low-energy" | "hospital" | "jail" | "traveling" | null — drives the Hunt-tab banner
            this.onUpdate = null;       // ui sets this
            this.onToast = null;        // toaster sets this (new matches → showMany)
            this.onMatchesApplied = null; // toaster sets this (current target ids → pruneTo)
        }

        updateSettings(next) {
            this.settings = { ...this.settings, ...next };
            saveSettings(this.settings);
            // Reset diff memory + re-seed silently on the next apply so a
            // filter tweak doesn't bombard the user with toasts for matches
            // that were already on screen under the previous filter.
            this.lastMatchIds = new Set();
            this._reseedSilent = true;
            // Invalidate the cross-tab cache — its matches were computed with the
            // previous filters, so neither this tab nor its siblings should reuse it.
            try { localStorage.removeItem(LS.shared); } catch { /* noop */ }
        }

        // --- Blacklist -----------------------------------------------------
        isBlacklisted(id) {
            if (id == null) return false;
            return Object.prototype.hasOwnProperty.call(this.blacklist, String(Number(id)));
        }

        // Add a player to the blacklist and immediately strip any of their
        // bounties from this tab's live match list. The cross-tab storage
        // event will broadcast the same prune to sibling tabs.
        addToBlacklist(id, name) {
            const ok = blAddEntry(this.blacklist, id, name);
            if (!ok) return false;
            saveBlacklist(this.blacklist);
            this._stripBlacklistedFromMatches();
            try { localStorage.removeItem(LS.shared); } catch { /* noop */ }
            if (this.onUpdate) this.onUpdate();
            return true;
        }

        removeFromBlacklist(id) {
            const ok = blRemove(this.blacklist, id);
            if (!ok) return false;
            saveBlacklist(this.blacklist);
            // The target may not be back on the bounty board, and we don't
            // want to burn a refresh just to "maybe" surface them — the next
            // tick will pick them up naturally if they reappear.
            try { localStorage.removeItem(LS.shared); } catch { /* noop */ }
            if (this.onUpdate) this.onUpdate();
            return true;
        }

        setBlacklistNote(id, note) {
            const ok = blSetNote(this.blacklist, id, note);
            if (!ok) return false;
            saveBlacklist(this.blacklist);
            return true;
        }

        // Import a JSON / id-list blob from the Settings tab. Merges into the
        // existing map (doesn't wipe). Returns the number of entries added.
        importBlacklist(text) {
            const before = Object.keys(this.blacklist).length;
            const added = blImport(this.blacklist, text);
            if (added > 0 || Object.keys(this.blacklist).length !== before) {
                saveBlacklist(this.blacklist);
                this._stripBlacklistedFromMatches();
                try { localStorage.removeItem(LS.shared); } catch { /* noop */ }
                if (this.onUpdate) this.onUpdate();
            }
            return added;
        }

        clearBlacklist() {
            this.blacklist = {};
            saveBlacklist(this.blacklist);
            try { localStorage.removeItem(LS.shared); } catch { /* noop */ }
            if (this.onUpdate) this.onUpdate();
        }

        // Called by the storage-event listener when another tab mutated the
        // blacklist. Re-reads from LS and re-prunes our visible matches.
        applyExternalBlacklist() {
            this.blacklist = loadBlacklist();
            this._stripBlacklistedFromMatches();
            if (this.onUpdate) this.onUpdate();
        }

        // --- Watchlist -----------------------------------------------------
        isWatched(id) {
            if (id == null) return false;
            return Object.prototype.hasOwnProperty.call(this.watchlist, String(Number(id)));
        }

        watchlistCount() { return Object.keys(this.watchlist).length; }

        // Add a match row to the med-out watchlist. Seeds lastState from the
        // row's current status so the next poll that flips it to Okay fires
        // the alert. Starts the poll loop if it wasn't running.
        addToWatchlist(b) {
            const key = String(Number(b.target_id));
            if (!/^\d+$/.test(key) || key === "0") return false;
            this.watchlist[key] = {
                name: b.target_name ? String(b.target_name) : (this.watchlist[key] && this.watchlist[key].name) || null,
                reward: b.reward,
                lastState: b.statusState || "Hospital",
                addedAt: Math.floor(Date.now() / 1000),
            };
            saveWatchlist(this.watchlist);
            this.ensureWatchLoop();
            if (this.onUpdate) this.onUpdate();
            return true;
        }

        removeFromWatchlist(id) {
            const key = String(Number(id));
            if (!this.watchlist[key]) return false;
            delete this.watchlist[key];
            saveWatchlist(this.watchlist);
            if (this.watchlistCount() === 0) this.stopWatch();
            if (this.onUpdate) this.onUpdate();
            return true;
        }

        // Storage-event handler — another tab changed the watchlist. Re-read
        // and (re)assess whether this tab should be polling.
        applyExternalWatchlist() {
            this.watchlist = loadWatchlist();
            if (this.watchlistCount() === 0) this.stopWatch();
            else this.ensureWatchLoop();
            if (this.onUpdate) this.onUpdate();
        }

        // Start the watch loop if there's anything to watch and it isn't
        // already running. Idempotent — safe to call from add, visibility
        // change, storage event, and boot.
        ensureWatchLoop() {
            if (this._watchRunning || this.watchlistCount() === 0) return;
            this._watchRunning = true;
            this._scheduleWatch(0);
        }

        stopWatch() {
            if (this._watchTimer) { clearTimeout(this._watchTimer); this._watchTimer = null; }
            this._watchRunning = false;
        }

        _watchIntervalMs() {
            const sec = Number(this.settings.watchlistIntervalSec);
            return Math.max(1, Number.isFinite(sec) ? sec : 5) * 1000;
        }

        _scheduleWatch(delayMs) {
            if (this._watchTimer) clearTimeout(this._watchTimer);
            this._watchNextAt = Date.now() + delayMs;
            this._watchTimer = setTimeout(() => this._watchTick(), delayMs);
        }

        secondsUntilWatchPoll() {
            if (!this._watchRunning || !this._watchNextAt) return 0;
            return Math.max(0, Math.round((this._watchNextAt - Date.now()) / 1000));
        }

        // Called on visibilitychange when this tab becomes visible — the
        // visible tab owns polling, so kick a tick immediately for a snappy
        // handoff when the user switches tabs.
        kickWatchIfVisible() {
            if (document.visibilityState !== "visible") return;
            this.watchlist = loadWatchlist(); // adopt anything a sibling added while we were hidden
            if (this.watchlistCount() === 0) { this.stopWatch(); return; }
            this._watchRunning = true;
            this._scheduleWatch(0);
        }

        async _watchTick() {
            if (!this._watchRunning) return;
            const interval = this._watchIntervalMs();
            // Only the visible tab polls, and only while bounty search is on —
            // the master switch is one kill-switch for all API usage. A hidden
            // or search-off tab keeps a cheap heartbeat timer alive (no requests)
            // so it resumes instantly on focus / re-enable. Entries are kept.
            if (document.visibilityState !== "visible" || !this.settings.searchEnabled
                || !this.api.key || this.watchlistCount() === 0) {
                if (this.watchlistCount() === 0) { this.stopWatch(); return; }
                this._scheduleWatch(interval);
                return;
            }
            let changed = false;
            const ids = Object.keys(this.watchlist);
            for (const id of ids) {
                if (!this._watchRunning) break;
                const entry = this.watchlist[id];
                if (!entry) continue;
                try {
                    const { profile, bounties } = await this.api.fetchUserProfile(Number(id));
                    if (!this.watchlist[id]) continue; // removed mid-loop
                    // Drop when the best bounty now on the target is worth less
                    // than what we signed up to watch — the original was claimed
                    // or expired and only a cheaper (or no) bounty remains. A
                    // same-or-higher replacement is kept (still worth the hit).
                    const own = Array.isArray(bounties)
                        ? bounties.filter((x) => Number(x.target_id) === Number(id))
                        : [];
                    const maxReward = own.reduce((m, x) => Math.max(m, Number(x.reward) || 0), 0);
                    if (own.length === 0 || maxReward < entry.reward) { delete this.watchlist[id]; changed = true; continue; }
                    const state = profile && profile.status ? profile.status.state : null;
                    if (state) {
                        const prev = entry.lastState;
                        if (prev && prev !== "Okay" && state === "Okay") {
                            this._fireMedOut(id, entry, profile);
                        }
                        if (state !== prev) { entry.lastState = state; changed = true; }
                    }
                } catch (e) {
                    // Transient (network / rate limit) — keep the entry and try
                    // again next tick. Don't spam the debug log per-target.
                    if (isRateLimitError(e)) { logDebug("watchlist poll hit rate limit — backing off", "warn"); break; }
                }
            }
            if (changed) {
                saveWatchlist(this.watchlist);
                if (this.onUpdate) this.onUpdate();
            }
            if (this.watchlistCount() === 0) { this.stopWatch(); return; }
            this._scheduleWatch(interval);
        }

        _fireMedOut(id, entry, profile) {
            if (!this.onWatchToast) return;
            this.onWatchToast([{
                target_id: Number(id),
                target_name: entry.name || (profile && profile.name) || String(id),
                target_level: (profile && profile.level) || "?",
                reward: entry.reward,
                ff: null,
                bs: null,
                statusState: "Okay",
                hospUntil: 0,
                bountyCount: 1,
                awayFromMe: false,
                location: null,
                medOut: true,
            }]);
            logDebug(`watchlist: ${entry.name || id} is OUT of hospital — alert fired`, "ok");
        }

        // Backfill missing display names from anything we observe on the
        // bounty board. Saves only when at least one name changed so we
        // don't write the same JSON every tick.
        _backfillBlacklistNames(bounties) {
            let changed = false;
            for (const b of bounties) {
                const key = String(Number(b.target_id));
                const entry = this.blacklist[key];
                if (!entry || entry.name === b.target_name) continue;
                if (blSetName(this.blacklist, b.target_id, b.target_name)) changed = true;
            }
            if (changed) saveBlacklist(this.blacklist);
        }

        // Drop currently-shown matches whose target is now blacklisted, then
        // re-run the toast-pruning callback so any blacklisted toast vanishes
        // from the stack immediately. Cheaper than a full refresh.
        _stripBlacklistedFromMatches() {
            const before = this.lastMatches.length;
            const filtered = this.lastMatches.filter((m) => !this.isBlacklisted(m.target_id));
            if (filtered.length === before) return;
            this.lastMatches = filtered;
            this.lastMatchIds = new Set(filtered.map((m) => `${m.target_id}|${m.reward}`));
            if (this.onMatchesApplied) {
                this.onMatchesApplied(new Set(filtered.map((m) => Number(m.target_id))));
            }
        }

        // Apply a settings change that originated in another tab (via storage
        // event). Updates in-memory state and runs the same stop/start
        // transition the local Settings UI does — but does NOT call
        // saveSettings (the other tab already persisted), to avoid a write
        // ping-pong between tabs.
        applyExternalSettings(next) {
            this.settings = { ...this.settings, ...next };
            this.lastMatchIds = new Set();
            this._reseedSilent = true;
            // Stop unconditionally, then let start() self-gate. Mirrors the
            // local persistFilters() path.
            this.stop();
            if (this.settings.searchEnabled && this.settings.refreshSec > 0) {
                this.pausedReason = null;
                this.start();
            } else if (!this.settings.searchEnabled) {
                this.pausedReason = "disabled";
            } else {
                this.pausedReason = null;
            }
            if (this.onUpdate) this.onUpdate();
        }

        // --- Cross-tab sharing ---------------------------------------------

        _readShared() {
            try {
                const raw = localStorage.getItem(LS.shared);
                if (!raw) return null;
                const s = JSON.parse(raw);
                if (!s || typeof s.writtenAt !== "number") return null;
                return s;
            } catch { return null; }
        }

        _writeShared() {
            try {
                const payload = {
                    writtenAt: Date.now(),
                    refreshSec: this.settings.refreshSec,
                    matches: this.lastMatches,
                    lastCounts: this.lastCounts,
                    myUserId: this.myUserId,
                    myUserLevel: this.myUserLevel,
                    myUserAge: this.myUserAge,
                    myCountry: this.myCountry,
                    lastError: this.lastError ? (this.lastError.message || "error") : null,
                };
                localStorage.setItem(LS.shared, JSON.stringify(payload));
            } catch { /* quota or serialization failure — non-fatal */ }
        }

        // Adopt the "who am I" hints another tab has already resolved; saves one
        // /user/profile call on a cold tab that piggybacks on a warmer one.
        _adoptSharedIdentity(s) {
            if (s.myUserId != null && this.myUserId == null) this.myUserId = s.myUserId;
            if (s.myUserLevel != null && this.myUserLevel == null) this.myUserLevel = s.myUserLevel;
            if (s.myUserAge != null && this.myUserAge == null) this.myUserAge = s.myUserAge;
            // Country is mutable — always adopt the latest writer's value.
            if (s.myCountry != null) this.myCountry = s.myCountry;
        }

        // Apply a new match list: diff against previous to fire toasts, update
        // lastMatches/lastMatchIds. Shared by the real-refresh path, the
        // cross-tab free-ride path, and the adoptSharedPayload storage event.
        //
        // Two suppression rules:
        //  1. **First-apply seed.** Right after the Hunter is constructed (or
        //     after settings change), there is no prior state to diff against.
        //     Without this guard, a fresh tab that free-rides on stale shared
        //     data fires a toast for every cached match — including bounties
        //     the user already claimed (the cached reward is stale). The Hunt
        //     tab still shows the seeded matches, so the data isn't lost.
        //  2. **Energy pause.** When the energy gate is engaged we never fire
        //     a toast, even if a path other than _tick reaches us (e.g. a
        //     manual refresh or a sibling tab's storage event). Defense in
        //     depth on top of the gate in _tick.
        _applyMatches(matches, fromShared = false) {
            const matchKey = (m) => `${m.target_id}|${m.reward}`;
            const currentIds = new Set(matches.map(matchKey));
            const firstApply = !this._firstApplyDone;
            this._firstApplyDone = true;
            // Suppress toasts only when the batch isn't trustworthy-new:
            //  - first apply sourced from another tab's shared data (may be
            //    stale/claimed) — but NOT a cold-start's own fresh refresh
            //  - the apply right after a filter change (re-seed silently)
            //  - energy pause
            const suppressed = (firstApply && fromShared)
                || this._reseedSilent
                || this.pausedReason === "low-energy";
            this._reseedSilent = false;
            if (!suppressed && this.settings.toastsEnabled && this.onToast) {
                const newOnes = matches.filter((m) => !this.lastMatchIds.has(matchKey(m)));
                if (newOnes.length > 0) this.onToast(newOnes);
            }
            this.lastMatches = matches;
            this.lastMatchIds = currentIds;
            // Keep the toast stack in sync with the Hunt-tab table. Without this,
            // a target that drops out of the match list (claimed elsewhere,
            // hospital timer expired, or a partial rate-limited cycle that
            // didn't re-confirm them) would leave its "attack me" toast on
            // screen for the rest of its 15-second TTL.
            if (this.onMatchesApplied) {
                this.onMatchesApplied(new Set(matches.map((m) => Number(m.target_id))));
            }
        }

        // Called by the `storage` event listener when another tab writes new
        // shared data. Updates our in-memory state + re-renders via onUpdate.
        adoptSharedPayload(s) {
            if (!s) return;
            this._adoptSharedIdentity(s);
            if (Array.isArray(s.matches)) {
                this.lastCounts = s.lastCounts || null;
                this.partialFromRateLimit = false; // _writeShared only fires on full cycles
                this._applyMatches(s.matches, true);
            }
            if (this.onUpdate) this.onUpdate();
        }

        stop() {
            if (this._timer) { clearTimeout(this._timer); this._timer = null; }
            this._running = false;
        }

        start() {
            if (this._running) return;
            if (!this.settings.searchEnabled) {
                // Honor the master kill-switch even on cold boot — don't start
                // the loop, and let the Hunt tab render the "disabled" banner.
                this.pausedReason = "disabled";
                if (this.onUpdate) this.onUpdate();
                return;
            }
            this._running = true;
            this._tick();
        }

        // Returns a pause reason ("hospital"|"jail"|"traveling") when the
        // matching opt-in toggle is on AND our own status is in that state,
        // else null. `state` defaults to the last-known own state so the _tick
        // free-ride gate can use it without an extra fetch; refresh() passes
        // the freshly-read state. Costs nothing — `state` rides on the
        // /user/profile call refresh() already makes.
        _selfStatusPauseReason(state) {
            const s = state !== undefined ? state : this.mySelfState;
            if (!s) return null;
            if (this.settings.pauseInHospital && s === "Hospital") return "hospital";
            if (this.settings.pauseInJail && s === "Jail") return "jail";
            if (this.settings.pauseWhileTraveling && s === "Traveling") return "traveling";
            return null;
        }

        // Returns true when "Pause when energy is below N" is enabled AND the
        // current energy reading is below N. Side-effects: updates myEnergy
        // and lastEnergyError so the Settings/Hunt UI stays accurate. Quietly
        // returns false on errors (scope-too-low key, network) so the script
        // keeps working — the user just won't see the gate apply.
        async _isPausedByEnergy() {
            if (!this.settings.pauseOnLowEnergy || this.settings.minEnergy <= 0) {
                this.myEnergy = null;
                this.lastEnergyError = null;
                return false;
            }
            try {
                const bars = await this.api.fetchBars();
                const energy = bars && bars.energy;
                if (energy && typeof energy.current === "number") {
                    this.myEnergy = { current: energy.current, maximum: energy.maximum };
                    this.lastEnergyError = null;
                    return energy.current < this.settings.minEnergy;
                }
            } catch (e) {
                // Torn code 16 = scope too low; treat anything else as
                // a transient error. Either way, don't block hunting.
                this.lastEnergyError = (e && e.tornCode === 16) ? "scope" : "error";
                logDebug(`bars fetch failed (${e && e.tornCode ? "code " + e.tornCode : "network"}): ${e && e.message || "error"}`, "err");
            }
            return false;
        }

        async _tick() {
            if (!this._running) return;
            if (!this.settings.searchEnabled) {
                // Toggled off while running — stop and let the UI update.
                this.pausedReason = "disabled";
                this._running = false;
                if (this.onUpdate) this.onUpdate();
                return;
            }
            let waitSec = this.settings.refreshSec;
            try {
                // Energy gate — runs BEFORE the free-ride decision so a tab
                // that just cold-started below the energy threshold doesn't
                // pick up another tab's cached matches and spam toasts. Also
                // drops any bounty toasts still on screen from before the
                // user's energy dropped — the Hunt-tab rows survive so the
                // data isn't lost, only the pop-ups.
                if (await this._isPausedByEnergy()) {
                    this.pausedReason = "low-energy";
                    if (this.onMatchesApplied) this.onMatchesApplied(new Set());
                    if (this.onUpdate) this.onUpdate({ loading: false });
                } else if (this.pausedReason !== "disabled") {
                    this.pausedReason = null;
                }

                // Cross-tab free-ride: if another tab refreshed recently under
                // the same settings, reuse its result instead of burning our
                // own API budget. Keeps N-tab users at ~1× call cost. Skipped
                // when paused on low energy so we don't apply fresh toasts.
                const shared = this._readShared();
                const fresh = shared
                    && (Date.now() - shared.writtenAt) < (this.settings.refreshSec * 1000 * SHARED_FRESH_RATIO);
                // If we last knew we were in hospital/jail/traveling (and the
                // matching toggle is on), don't free-ride on a sibling tab's
                // matches — fall through to refresh() so our own status
                // re-confirms this tick. refresh() is the only place mySelfState
                // updates, so gating it here would freeze the pause forever.
                const selfPauseTick = this._selfStatusPauseReason();
                if (this.pausedReason === "low-energy") {
                    // gated above; nothing else to do this tick
                } else if (fresh && !selfPauseTick) {
                    logDebug(`free-ride: reusing fresh result from another tab (${shared.matches ? shared.matches.length : 0} matches)`, "info");
                    this._adoptSharedIdentity(shared);
                    this.lastCounts = shared.lastCounts || null;
                    this.lastError = null;
                    this.partialFromRateLimit = false; // _writeShared only fires on full cycles
                    this._applyMatches(shared.matches || [], true);
                    if (this.onUpdate) this.onUpdate();
                } else {
                    const delaySec = await this.refresh();
                    waitSec = Math.max(this.settings.refreshSec, delaySec || 0);
                }
            } catch (err) {
                this.lastError = err;
                if (isRateLimitError(err)) {
                    // refresh() already logged the scanned/partial breakdown
                    // when it knew it; just note the table state here.
                    logDebug(`refresh aborted — rate limit; ${this.lastMatches.length} match${this.lastMatches.length === 1 ? "" : "es"} on screen${this.partialFromRateLimit ? " (partial)" : ""}`, "err");
                } else {
                    logDebug(`refresh failed: ${err.message || "error"}`, "err");
                }
                if (this.onUpdate) this.onUpdate();
                // Back off briefly on errors; leave auto-refresh alive.
                waitSec = Math.max(this.settings.refreshSec, 30);
            }
            if (this.settings.refreshSec <= 0) return; // "off"
            this._nextAt = Date.now() + waitSec * 1000;
            this._timer = setTimeout(() => this._tick(), waitSec * 1000);
        }

        async refresh() {
            this.lastError = null;
            const refreshStart = performance.now();
            logDebug(`refresh: start`, "info");
            if (this.onUpdate) this.onUpdate({ loading: true });

            // Resolve our ID/level/age/country. ID/level/age are near-immutable
            // so we cache them after the first success, but `country` flips
            // whenever we travel, so we re-read status on every cycle.
            try {
                const profile = await this.api.validateKey();
                if (profile) {
                    this.myUserId = profile.id || this.myUserId;
                    this.myUserLevel = (typeof profile.level === "number") ? profile.level : this.myUserLevel;
                    this.myUserAge = (typeof profile.age === "number") ? profile.age : this.myUserAge;
                    this.myCountry = getPlayerCountry(profile.status) || this.myCountry;
                    // Own status.state drives the hospital/jail/traveling pause
                    // gates below. Free — already in this profile response.
                    if (profile.status && profile.status.state) this.mySelfState = profile.status.state;
                }
            } catch { /* non-fatal — keep previous identity/country */ }

            // Self-status gate — pause when we can't act on a bounty anyway
            // (in hospital / jail / mid-flight). All opt-in, all free (uses the
            // status from the profile call above). Mirrors the energy gate:
            // skip the bounty fetch and don't write shared, so sibling tabs
            // can't free-ride this cycle either.
            const selfPause = this._selfStatusPauseReason();
            if (selfPause) {
                this.pausedReason = selfPause;
                if (this.onMatchesApplied) this.onMatchesApplied(new Set());
                logDebug(`paused — own status is ${this.mySelfState}; skipping bounty fetch`, "info");
                if (this.onUpdate) this.onUpdate({ loading: false });
                return 0;
            }

            // Energy gate — skip the (expensive) bounties fetch when the
            // player can't attack anyway. Opt-in; needs a Minimal+ key.
            // When called from _tick() the gate has already run there, but
            // a manual "Refresh now" lands here directly so we re-check.
            // Both paths share _isPausedByEnergy() which sets myEnergy /
            // lastEnergyError so the Settings hint stays accurate.
            if (await this._isPausedByEnergy()) {
                this.pausedReason = "low-energy";
                if (this.onMatchesApplied) this.onMatchesApplied(new Set());
                logDebug(`paused — energy ${this.myEnergy ? this.myEnergy.current : "?"}/${this.myEnergy ? this.myEnergy.maximum : "?"} < ${this.settings.minEnergy}; skipping bounty fetch`, "info");
                if (this.onUpdate) this.onUpdate({ loading: false });
                return 0;
            }
            this.pausedReason = null;

            const { bounties, delaySec } = await this.api.fetchAllBounties();
            logDebug(`fetched ${bounties.length} bounties (cache delay ${delaySec || 0}s)`, "ok");

            // Collapse multiple bounty rows on the same target + same reward
            // into one entry with an aggregated count. Rows with different
            // reward amounts stay separate. This avoids duplicate FFScouter
            // and profile calls AND cleans up the Hunt list.
            const grouped = new Map();
            for (const b of bounties) {
                const key = `${b.target_id}|${b.reward}`;
                if (!grouped.has(key)) {
                    grouped.set(key, { ...b, bountyCount: 0 });
                }
                const inc = (typeof b.quantity === "number" && b.quantity > 0) ? b.quantity : 1;
                grouped.get(key).bountyCount += inc;
            }
            const dedupedBounties = [...grouped.values()];

            const counts = {
                total: bounties.length,
                afterBasic: 0,
                withFF: 0,
                ffNull: 0,
                ffError: null,
                afterFF: 0,
                statusBreakdown: {},
                matches: 0,
            };

            // Opportunistically backfill blacklist entries' display names from
            // anything Torn returned this cycle. Cheap (one Map lookup per
            // bounty) and means blacklisted entries no longer show up as
            // "(unknown)" once the user has seen the target's bounty once.
            this._backfillBlacklistNames(dedupedBounties);

            // 1) Price + self + blacklist filter. Blacklist runs first so we
            // never burn FFScouter / profile API budget on a player the user
            // has chosen to exclude. Age-based "new-account" filter happens
            // later (in step 3) since target age requires a per-user profile
            // fetch anyway.
            const afterPriceAndSelf = dedupedBounties.filter((b) =>
                b.reward >= this.settings.minPrice
                && (this.myUserId == null || b.target_id !== this.myUserId)
            );
            const byBasic = afterPriceAndSelf.filter((b) => !this.isBlacklisted(b.target_id));
            counts.afterBasic = byBasic.length;
            counts.blacklisted = afterPriceAndSelf.length - byBasic.length;

            // 2) Bulk FFScouter — keep only rows with a known FF in range.
            const ffKey = KeyResolver.getFFKey();
            const ids = [...new Set(byBasic.map((b) => Number(b.target_id)))];
            logDebug(`FFScouter: requesting ${ids.length} IDs`, "info");
            const ff = await fetchFFScouterStats(ffKey, ids);
            counts.withFF = ff.map.size;
            counts.ffNull = ff.nullCount;
            counts.ffError = ff.error;
            logDebug(`FFScouter: ${ff.map.size} with FF, ${ff.nullCount} null${ff.error ? `, error: ${ff.error}` : ""}`, ff.error ? "warn" : "ok");
            const includeUnknown = !!this.settings.includeUnknownFF;
            const byFF = byBasic
                .map((b) => {
                    const e = ff.map.get(Number(b.target_id));
                    if (e) return { ...b, ff: e.ff, bs: e.bs };
                    // Target not in FF map (FFScouter returned null FF, or wasn't
                    // in the response at all). Include if the user opted in.
                    return includeUnknown ? { ...b, ff: null, bs: null } : null;
                })
                .filter((b) => {
                    if (b == null) return false;
                    if (b.ff == null) return true; // unknown — pass through
                    return b.ff >= this.settings.minFF && b.ff <= this.settings.maxFF;
                });
            counts.afterFF = byFF.length;

            // 3) Per-target profile — status, age, faction.
            const nowSec = Math.floor(Date.now() / 1000);
            const hospWindowSec = this.settings.hospitalMaxMin * 60;
            logDebug(`profiles: need ${byFF.length} (cache will absorb recent lookups)`, "info");
            const { profiles, rateLimitErr: profileRLErr } = await this._fetchProfiles(byFF.map((b) => Number(b.target_id)));
            // Number of byFF targets we actually have a resolved profile for —
            // drives the "scanned X of Y" line in the rate-limit banner.
            counts.scanned = byFF.reduce((n, b) => n + (profiles.has(Number(b.target_id)) ? 1 : 0), 0);
            const matches = [];
            counts.tooNew = 0;
            counts.differentCountry = 0;
            for (const b of byFF) {
                const p = profiles.get(Number(b.target_id));
                if (!p || !p.status) { counts.statusBreakdown["unknown"] = (counts.statusBreakdown["unknown"] || 0) + 1; continue; }
                // Torn's NPP rule — depends on our own age too. See isAttackableByAge().
                if (!isAttackableByAge(p.age, this.myUserAge)) {
                    counts.tooNew++;
                    continue;
                }
                const state = p.status.state;
                counts.statusBreakdown[state] = (counts.statusBreakdown[state] || 0) + 1;
                const until = p.status.until || 0;
                const remaining = Math.max(0, until - nowSec);
                // Country filter — must be in the same country as us to be
                // attackable. Only applied when both sides are known; if we
                // can't determine our own location (pre-first-profile, or
                // "Traveling") or the target's (unknown hospital adjective),
                // the filter falls open so we don't silently drop everyone.
                const targetCountry = getPlayerCountry(p.status);
                if (this.settings.sameCountryOnly && this.myCountry && targetCountry && targetCountry !== this.myCountry) {
                    counts.differentCountry++;
                    continue;
                }
                // Reconcile the global-board reward against THIS target's own
                // bounty list, pulled from the same call as `status`. The global
                // board row that put `b` here can be stale — a bounty claimed
                // seconds ago still lingers on the board (Torn's `bounties_delay`),
                // and our status read could be from a different instant. If the
                // target's own list no longer carries `b.reward`, that bounty is
                // gone (claimed/expired); surfacing it would notify the wrong
                // amount. Only reconcile when we actually have the list — a null
                // (selection missing / older cache entry) falls open to the board
                // reward so we never silently drop everyone.
                let row = b;
                if (Array.isArray(p.bounties)) {
                    const own = p.bounties.filter((x) => Number(x.target_id) === Number(b.target_id));
                    const liveReward = own.some((x) => x.reward === b.reward);
                    if (!liveReward) {
                        counts.staleReward = (counts.staleReward || 0) + 1;
                        continue;
                    }
                    // Refresh the ×N badge count from the authoritative list too.
                    const liveQty = own
                        .filter((x) => x.reward === b.reward)
                        .reduce((n, x) => n + ((typeof x.quantity === "number" && x.quantity > 0) ? x.quantity : 1), 0);
                    if (liveQty > 0) row = { ...b, bountyCount: liveQty };
                }
                // Online/idle/offline — from the same profile snapshot, so it
                // rides through to the row (and the shared payload) for free.
                row = { ...row, lastAction: p.lastAction || null };
                // Location marker — set when the target is somewhere you can't
                // attack from right now. "In transit" for mid-flight targets
                // (country unknown), otherwise their country name.
                const away = state === "Traveling"
                    ? { awayFromMe: true, location: "In transit" }
                    : (targetCountry && this.myCountry && targetCountry !== this.myCountry)
                        ? { awayFromMe: true, location: targetCountry }
                        : { awayFromMe: false, location: null };
                if (state === "Okay") {
                    matches.push({ ...row, statusState: "Okay", hospUntil: 0, ...away });
                } else if (state === "Hospital" && (this.settings.hospNoLimit || remaining <= hospWindowSec)) {
                    matches.push({ ...row, statusState: "Hospital", hospUntil: until, ...away });
                } else if (!this.settings.sameCountryOnly && (state === "Abroad" || state === "Traveling")) {
                    // Only surfaced in "include all locations" mode — unattackable
                    // until you're co-located, shown for planning/awareness.
                    matches.push({ ...row, statusState: state, hospUntil: 0, ...away });
                }
            }
            matches.sort((a, b) => b.reward - a.reward);
            counts.matches = matches.length;

            // 4a) Rate-limit hit mid-scan: surface partial results when they're
            // useful (we either found something this cycle, or had nothing to
            // begin with — never overwrite a known-good prior list with
            // something demonstrably worse). Cross-tab share is skipped so
            // other tabs don't free-ride on partial data.
            if (profileRLErr) {
                const replace = matches.length > 0 || this.lastMatches.length === 0;
                if (replace) {
                    this.lastCounts = counts;
                    this._applyMatches(matches);
                    this.partialFromRateLimit = true;
                }
                logDebug(`refresh aborted — rate limit at profile step; scanned ${counts.scanned}/${byFF.length}, ${matches.length} partial match${matches.length === 1 ? "" : "es"}${replace ? " (shown)" : " (kept prior)"}`, "err", performance.now() - refreshStart);
                // _tick will set lastError and trigger the (banner-bearing) re-render.
                throw profileRLErr;
            }

            // 4b) Diff for toasts + render + cross-tab broadcast.
            this.partialFromRateLimit = false;
            this.lastCounts = counts;
            this._applyMatches(matches);
            this._writeShared();
            logDebug(`refresh: done — ${matches.length} matches (of ${counts.total} bounties)${counts.staleReward ? `, dropped ${counts.staleReward} stale reward row${counts.staleReward === 1 ? "" : "s"} (claimed/expired per target's own bounty list)` : ""}`, "ok", performance.now() - refreshStart);
            if (this.onUpdate) this.onUpdate({ loading: false });
            return delaySec;
        }

        async _fetchProfiles(ids) {
            const out = new Map();
            const now = Date.now();
            const stale = [];
            // De-dupe IDs so repeated target_ids don't trigger parallel
            // fetches for the same player. The cache lookup alone isn't
            // enough — on a cold start every duplicate would still miss.
            const unique = [...new Set(ids)];
            for (const id of unique) {
                const c = this._statusCache.get(id);
                if (c) {
                    const d = c.data;
                    // Hospital with a future `until` is effectively locked in —
                    // the target can't leave hospital unless revived (rare).
                    // Trust the cache until the timestamp passes.
                    const hospLocked = d && d.status && d.status.state === "Hospital"
                        && d.status.until && (d.status.until * 1000) > now;
                    if (hospLocked || (now - c.fetchedAt < STATUS_CACHE_MS)) {
                        out.set(id, d);
                        continue;
                    }
                }
                stale.push(id);
            }
            // Bounded concurrency — 3 in-flight at a time to stay friendly.
            let i = 0;
            let rateLimitErr = null;
            const workers = Array.from({ length: STATUS_CONCURRENCY }, async () => {
                while (i < stale.length && !rateLimitErr) {
                    const id = stale[i++];
                    try {
                        const { profile, bounties } = await this.api.fetchUserProfile(id);
                        if (profile) {
                            const data = {
                                status: profile.status || null,
                                age: typeof profile.age === "number" ? profile.age : null,
                                faction_id: profile.faction_id || null,
                                // "Online" | "Idle" | "Offline" — rides the same
                                // profile call, so the row dot costs no extra request.
                                lastAction: (profile.last_action && profile.last_action.status) || null,
                                // Per-target bounty rows from the SAME snapshot as
                                // status. null = the call didn't return a bounties
                                // array (treated as "unknown", we don't reconcile);
                                // [] = the target genuinely has no bounties now.
                                bounties: bounties,
                            };
                            out.set(id, data);
                            this._statusCache.set(id, { data, fetchedAt: Date.now() });
                        }
                    } catch (err) {
                        // Rate-limit: stop all workers and surface what we have.
                        // The caller decides whether to keep prior matches or
                        // show a partial cycle, so we don't throw away `out`.
                        if (isRateLimitError(err)) { rateLimitErr = err; return; }
                        // Other per-target errors: row just won't match this cycle.
                    }
                }
            });
            await Promise.all(workers);
            return { profiles: out, rateLimitErr };
        }

        secondsUntilRefresh() {
            if (!this._nextAt) return 0;
            return Math.max(0, Math.round((this._nextAt - Date.now()) / 1000));
        }
    }

    // ════════════════════════════════════════════════════════════
    //  TOASTER
    // ════════════════════════════════════════════════════════════

    class Toaster {
        // `getSettings` returns the live hunter.settings reference each call,
        // so user-driven changes in the Settings tab take effect on the next
        // toast without rewiring anything.
        constructor(getSettings) {
            this.getSettings = getSettings || (() => DEFAULT_SETTINGS);
            this.container = null;
            this._cards = []; // { id, el, timer, remaining, enteredAt }
            this._clearAllEl = null;
        }

        _notif() {
            const s = (this.getSettings && this.getSettings()) || DEFAULT_SETTINGS;
            return s.notifications || DEFAULT_SETTINGS.notifications;
        }

        ensureContainer() {
            if (this.container && document.body.contains(this.container)) {
                this.applySettings();
                return;
            }
            const c = document.createElement("div");
            c.id = "bh-toasts";
            document.body.appendChild(c);
            this.container = c;
            this.applySettings();
        }

        // Apply position/width/alignment from settings to the live container
        // and any cards already on screen. Safe to call repeatedly — called
        // from ensureContainer() and from the Settings panel whenever the
        // notification config changes (locally or cross-tab).
        applySettings() {
            if (!this.container) return;
            const n = this._notif();
            const pos = n.position || "bottom-right";
            const c = this.container;
            // Reset all anchors before re-applying so a top↔bottom flip clears
            // the previous edge.
            c.style.top = "";
            c.style.bottom = "";
            c.style.left = "";
            c.style.right = "";
            if (pos.startsWith("top")) c.style.top = "16px";
            else c.style.bottom = "16px";
            if (pos.endsWith("right")) c.style.right = "16px";
            else c.style.left = "16px";
            // Children align to the anchor side so the stack hugs the corner.
            const alignSide = pos.endsWith("right") ? "flex-end" : "flex-start";
            c.style.alignItems = alignSide;
            // Card width — applied per card so it overrides the CSS default.
            const w = Math.max(140, Math.min(640, Number(n.width) || 300));
            for (const card of this._cards) {
                if (card.el) card.el.style.width = `${w}px`;
            }
            if (this._clearAllEl) this._clearAllEl.style.alignSelf = alignSide;
        }

        // Lightweight informational card with one optional action button —
        // used by the Hunt-list / toast "Blacklisted X — Undo" flow. Bypasses
        // the maxVisible cap because info cards are user-triggered (rare).
        showAction({ message, actionLabel, onAction, timeoutMs }) {
            this.ensureContainer();
            const el = document.createElement("div");
            el.className = "bh-toast bh-toast-info";
            const w = Math.max(140, Math.min(640, Number(this._notif().width) || 300));
            el.style.width = `${w}px`;
            el.innerHTML = `
                <button class="bh-toast-close" title="Dismiss">&times;</button>
                <div class="bh-toast-info-msg">${escHtml(message)}</div>
                ${actionLabel ? `<button class="bh-toast-info-action">${escHtml(actionLabel)}</button>` : ""}
            `;
            const remaining = Number.isFinite(timeoutMs) ? timeoutMs : 5000;
            const card = { id: null, el, timer: null, remaining, enteredAt: 0, isMore: false, isInfo: true };
            const dismiss = () => this._remove(card);
            el.querySelector(".bh-toast-close").addEventListener("click", (e) => { e.stopPropagation(); dismiss(); });
            const actionBtn = el.querySelector(".bh-toast-info-action");
            if (actionBtn) {
                actionBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    try { if (onAction) onAction(); } catch { /* noop */ }
                    dismiss();
                });
            }
            el.addEventListener("pointerenter", () => this._pauseTimer(card));
            el.addEventListener("pointerleave", () => this._resumeTimer(card));
            this._resumeTimer(card);
            this.container.appendChild(el);
            this._cards.push(card);
            this._updateClearAllButton();
        }

        showMany(bounties) {
            this.ensureContainer();
            // Clear-all / overflow cards don't count toward the bounty slot budget.
            const maxVisible = Math.max(1, Math.min(20, Number(this._notif().maxVisible) || 3));
            const existingBountyCards = this._cards.filter((c) => !c.isMore && !c.isClearAll).length;
            const slots = Math.max(0, maxVisible - existingBountyCards);
            const toShow = bounties.slice(0, slots);
            const overflow = bounties.length - toShow.length;
            for (const b of toShow) this._showOne(b);
            if (overflow > 0) this._showMoreCard(overflow);
            this._updateClearAllButton();
        }

        _toastTimeoutMs() {
            const sec = Number(this._notif().timeoutSec);
            const clamped = Number.isFinite(sec) ? Math.max(3, Math.min(120, sec)) : 15;
            return clamped * 1000;
        }

        _showOne(b) {
            const el = document.createElement("div");
            el.className = "bh-toast";
            const fields = this._notif().fields || DEFAULT_SETTINGS.notifications.fields;
            const showLevel = fields.level !== false;
            const showReward = fields.reward !== false;
            const showFF = fields.ff !== false;
            const showBS = fields.bs !== false;
            const showStatus = fields.status !== false;
            const showLocation = fields.location !== false;
            const showBlacklist = fields.blacklist === true;
            const sm = fmt.statusMeta(b);
            const statusLabel = sm.text;
            const statusClass = sm.cls;
            const hospAttr = sm.attr;
            const countBadge = b.bountyCount > 1
                ? ` <span class="bh-count">×${b.bountyCount}</span>`
                : "";
            const levelSpan = showLevel
                ? ` <span class="bh-toast-lvl">L${b.target_level}</span>`
                : "";
            const rewardCell = showReward
                ? `<div class="bh-toast-reward">${escHtml(fmt.money(b.reward))}</div>`
                : "";
            const ffChip = showFF
                ? `<span class="bh-chip">FF ${b.ff == null ? "?" : b.ff.toFixed(2)}</span>`
                : "";
            const bsChip = (showBS && b.bs)
                ? `<span class="bh-chip">BS ${escHtml(b.bs)}</span>`
                : "";
            const statusChip = showStatus
                ? `<span class="bh-chip ${statusClass}"${hospAttr}>${statusLabel}</span>`
                : "";
            const locationChip = (showLocation && b.awayFromMe && b.location)
                ? `<span class="bh-chip bh-badge-travel">📍 ${escHtml(b.location)}</span>`
                : "";
            const metaRow = (ffChip || bsChip || statusChip || locationChip)
                ? `<div class="bh-toast-meta">${ffChip}${bsChip}${statusChip}${locationChip}</div>`
                : "";
            const actionsRow = showBlacklist
                ? `<div class="bh-toast-actions">
                       <button class="bh-toast-attack">Attack →</button>
                       <button class="bh-toast-blacklist" title="Add to blacklist">🚫</button>
                   </div>`
                : `<button class="bh-toast-attack">Attack →</button>`;
            const medOutBanner = b.medOut
                ? `<div class="bh-toast-medout">🏥→✅ Out of hospital — attack now</div>`
                : "";
            if (b.medOut) el.classList.add("bh-toast-medout-card");
            el.innerHTML = `
                <button class="bh-toast-close" title="Dismiss">&times;</button>
                ${medOutBanner}
                <div class="bh-toast-head">
                    <div class="bh-toast-name">${escHtml(b.target_name)}${levelSpan}${countBadge}</div>
                    ${rewardCell}
                </div>
                ${metaRow}
                ${actionsRow}
            `;
            const w = Math.max(140, Math.min(640, Number(this._notif().width) || 300));
            el.style.width = `${w}px`;
            const card = { id: Number(b.target_id), el, timer: null, remaining: this._toastTimeoutMs(), enteredAt: 0, isMore: false };

            const dismiss = () => this._remove(card);
            el.querySelector(".bh-toast-close").addEventListener("click", (e) => {
                e.stopPropagation();
                dismiss();
            });
            const attack = (e) => {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                openTornUrl(ATTACK_URL + b.target_id);
                dismiss();
            };
            el.querySelector(".bh-toast-attack").addEventListener("click", attack);
            const blBtn = el.querySelector(".bh-toast-blacklist");
            if (blBtn) {
                blBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dismiss();
                    if (window.__bhUI) window.__bhUI._blacklistWithUndo(b.target_id, b.target_name);
                });
            }

            // Desktop: whole card is clickable for convenience. Touch devices:
            // require the explicit Attack button so a mis-tap near the close
            // button can't launch an attack.
            const isTouch = (typeof matchMedia === "function") && matchMedia("(hover: none)").matches;
            if (!isTouch) el.addEventListener("click", attack);

            this._attachSwipeToDismiss(el, card);
            el.addEventListener("pointerenter", () => this._pauseTimer(card));
            el.addEventListener("pointerleave", () => this._resumeTimer(card));

            this._resumeTimer(card);
            this.container.appendChild(el);
            this._cards.push(card);
        }

        _showMoreCard(count) {
            // One unified overflow card (don't stack multiple).
            const existing = this._cards.find((c) => c.isMore);
            if (existing) {
                existing.count += count;
                existing.el.querySelector(".bh-toast-more-label").textContent = `+${existing.count} more`;
                return;
            }
            const el = document.createElement("div");
            el.className = "bh-toast bh-toast-more";
            el.innerHTML = `
                <div class="bh-toast-more-label">+${count} more</div>
                <div class="bh-toast-more-hint">Click to open the Hunt list</div>
            `;
            const w = Math.max(140, Math.min(640, Number(this._notif().width) || 300));
            el.style.width = `${w}px`;
            const card = { id: null, el, timer: null, remaining: this._toastTimeoutMs(), enteredAt: 0, isMore: true, count };
            el.addEventListener("click", () => {
                if (window.__bhUI) window.__bhUI.toggle(true);
                this._remove(card);
            });
            this._attachSwipeToDismiss(el, card);
            el.addEventListener("pointerenter", () => this._pauseTimer(card));
            el.addEventListener("pointerleave", () => this._resumeTimer(card));
            this._resumeTimer(card);
            this.container.appendChild(el);
            this._cards.push(card);
        }

        // Touch-swipe horizontal dismiss — shared by bounty cards and the
        // overflow "+N more" card. Desktop pointer drags are ignored on
        // purpose so mouse-users' click-to-act gestures aren't hijacked.
        // `moved` is sticky once |dx|>6 and is cleared by the capture-phase
        // click swallow, so a sub-threshold swipe can't fall through to the
        // card's click handler (attack / open-hunt-list).
        _attachSwipeToDismiss(el, card) {
            let startX = 0, dx = 0, dragging = false, moved = false;
            el.addEventListener("pointerdown", (e) => {
                if (e.pointerType !== "touch") return;
                if (e.target.closest(".bh-toast-close")) return; // don't race the × tap
                dragging = true; moved = false; startX = e.clientX; dx = 0;
                el.style.transition = "none";
                try { el.setPointerCapture(e.pointerId); } catch { /* non-capturable pointer */ }
                this._pauseTimer(card);
            });
            el.addEventListener("pointermove", (e) => {
                if (!dragging) return;
                dx = e.clientX - startX;
                if (Math.abs(dx) > 6) moved = true;
                if (moved) {
                    el.style.transform = `translateX(${dx}px)`;
                    el.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 200));
                }
            });
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                el.style.transition = "transform .18s ease-out, opacity .18s ease-out";
                if (Math.abs(dx) > 80) {
                    el.style.transform = `translateX(${dx > 0 ? 400 : -400}px)`;
                    el.style.opacity = "0";
                    setTimeout(() => this._remove(card), 180);
                } else {
                    el.style.transform = ""; el.style.opacity = "";
                    this._resumeTimer(card);
                }
            };
            el.addEventListener("pointerup", endDrag);
            el.addEventListener("pointercancel", endDrag);
            el.addEventListener("click", (e) => {
                if (moved) {
                    e.stopPropagation();
                    e.preventDefault();
                    moved = false;
                }
            }, true);
        }

        // Small "Clear all" pill button, appears above the stack when 2+
        // toasts are on screen. Lives inside the container as the last DOM
        // child so the reversed column flex puts it visually on top.
        // Clicking only dismisses the toast cards — Hunt-tab matches are
        // driven by Hunter.lastMatches and are untouched.
        _updateClearAllButton() {
            const toastCount = this._cards.filter((c) => !c.isClearAll).length;
            const existing = this._clearAllEl;
            if (toastCount < 2) {
                if (existing) { existing.remove(); this._clearAllEl = null; }
                return;
            }
            if (existing) {
                // Keep it pinned to the visual top regardless of insertion order.
                this.container.appendChild(existing);
                return;
            }
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "bh-toast-clear-btn";
            btn.textContent = "✕ Clear all";
            btn.addEventListener("click", (e) => { e.stopPropagation(); this.clearAll(); });
            // Pin to the same edge as the stack (right for *-right positions,
            // left for *-left) so the pill always sits over the toasts.
            const pos = this._notif().position || "bottom-right";
            btn.style.alignSelf = pos.endsWith("right") ? "flex-end" : "flex-start";
            this.container.appendChild(btn);
            this._clearAllEl = btn;
        }

        _pauseTimer(card) {
            if (!card.timer) return;
            clearTimeout(card.timer);
            card.timer = null;
            card.remaining = Math.max(0, card.remaining - (Date.now() - card.enteredAt));
        }

        _resumeTimer(card) {
            card.enteredAt = Date.now();
            if (card.timer) clearTimeout(card.timer);
            card.timer = setTimeout(() => this._remove(card), card.remaining);
        }

        _remove(card) {
            if (card.timer) clearTimeout(card.timer);
            if (card.el && card.el.parentNode) card.el.parentNode.removeChild(card.el);
            this._cards = this._cards.filter((c) => c !== card);
            // Count dropped — maybe the Clear-all button should vanish too.
            this._updateClearAllButton();
        }

        clearAll() {
            for (const c of [...this._cards]) this._remove(c);
            if (this._clearAllEl) { this._clearAllEl.remove(); this._clearAllEl = null; }
        }

        // Remove bounty toasts whose target is no longer in the match set.
        // The "+N more" overflow card is left alone — it represents a prior
        // batch rather than a specific target, and times out on its own.
        pruneTo(currentTargetIds) {
            for (const c of [...this._cards]) {
                if (c.isMore || c.isClearAll || c.id == null) continue;
                if (!currentTargetIds.has(c.id)) this._remove(c);
            }
        }
    }

    // ════════════════════════════════════════════════════════════
    //  CSS
    // ════════════════════════════════════════════════════════════

    function injectCSS() {
        if (document.getElementById("bh-style")) return;
        const style = document.createElement("style");
        style.id = "bh-style";
        style.textContent = `
#bh-overlay{display:none;position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.7)}
#bh-panel{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;
  background:#1a1a1a;border:1px solid #444;border-radius:10px;overflow:hidden;resize:both;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#ddd;font-size:14px;
  width:760px;max-width:100vw;max-height:88vh;min-width:340px;min-height:300px;flex-direction:column}
#bh-panel.bh-open{display:flex}
#bh-overlay.bh-open{display:block}
#bh-panel *{box-sizing:border-box;color:inherit}
#bh-panel ::-webkit-scrollbar{width:6px;height:6px}
#bh-panel ::-webkit-scrollbar-track{background:#1a1a1a}
#bh-panel ::-webkit-scrollbar-thumb{background:#444;border-radius:3px}
#bh-panel ::-webkit-scrollbar-thumb:hover{background:#555}
#bh-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;
  background:#222;border-bottom:1px solid #444;flex-shrink:0}
#bh-header h2{margin:0;font-size:17px;color:#fff}
#bh-header .bh-ver{color:#666;font-size:12px;margin-left:8px}
#bh-close{background:none;border:none;color:#999;font-size:22px;cursor:pointer;padding:4px 8px}
#bh-close:hover{color:#fff}
#bh-tabs{display:flex;background:#252525;border-bottom:1px solid #444;overflow-x:auto;flex-shrink:0}
.bh-tab{padding:10px 20px;cursor:pointer;color:#999!important;border-bottom:2px solid transparent;
  white-space:nowrap;font-size:14px;transition:all .15s}
.bh-tab:hover{color:#ccc!important;background:#2a2a2a}
.bh-tab.active{color:#ef5350!important;border-bottom-color:#ef5350}
#bh-content{padding:16px;overflow-y:auto;flex:1;min-height:0}
#bh-status-line{display:flex;gap:12px;align-items:center;margin-bottom:12px;color:#888;font-size:12px;flex-wrap:wrap}
#bh-status-line .bh-err{color:#ef5350}
.bh-rl-banner{background:#2a1414;border:1px solid #ef5350;border-left:4px solid #ef5350;border-radius:4px;padding:10px 14px;margin:0 0 12px;color:#ddd;font-size:13px}
.bh-rl-title{color:#ef5350;font-weight:700;font-size:13px;margin-bottom:6px}
.bh-rl-body{color:#ccc;line-height:1.45;font-size:12px}
.bh-rl-tips{margin:6px 0 6px 20px;padding:0;color:#ddd}
.bh-rl-tips li{margin:2px 0}
.bh-rl-hint{color:#888;font-size:11px;font-style:italic}
.bh-rl-pill{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#ef5350;color:#1a0a0a;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;vertical-align:middle}
.bh-paused-banner{background:#1e2833;border:1px solid #3a5a7a;border-left:4px solid #4fa3d4;border-radius:4px;padding:8px 12px;margin:0 0 12px;color:#cfe4f2;font-size:12px}
.bh-donor-banner{background:linear-gradient(180deg,#1c2a1c,#162216);border:1px solid #2e4a2e;border-left:3px solid #4caf50;border-radius:4px;padding:8px 36px 8px 12px;margin:0 0 12px;color:#a5d6a7;font-size:13px;line-height:1.4;position:relative}
.bh-donor-banner b{color:#c5e1a5}
.bh-donor-dismiss{position:absolute;top:4px;right:6px;background:none;border:none;color:#6e836e;font-size:18px;cursor:pointer;padding:0 4px;line-height:1}
.bh-donor-dismiss:hover{color:#fff}
#bh-refresh-btn{padding:4px 10px;background:#333;border:1px solid #444;color:#ddd;border-radius:4px;cursor:pointer;font-size:12px}
#bh-refresh-btn:hover{background:#3a3a3a}
#bh-refresh-btn:disabled{opacity:.5;cursor:not-allowed}

table.bh-table{width:100%;border-collapse:collapse}
.bh-table th,.bh-table td{padding:8px 14px;text-align:left;border-bottom:1px solid #333;font-size:13px;
  color:#ddd;vertical-align:middle;white-space:nowrap}
.bh-table th{color:#999!important;font-weight:600;text-transform:uppercase;font-size:11px;position:sticky;
  top:0;background:#1a1a1a;border-bottom:2px solid #444;user-select:none}
.bh-table th[data-sort]{cursor:pointer}
.bh-table th[data-sort]:hover{color:#fff!important}
.bh-table th[data-sort]::after{content:" ⇅";color:#555;font-size:10px}
.bh-table th[data-sort].sort-asc::after{content:" ▲";color:#ef5350;font-size:10px}
.bh-table th[data-sort].sort-desc::after{content:" ▼";color:#ef5350;font-size:10px}
.bh-table tbody tr:hover td{background:#252525}
.bh-table td.num,.bh-table th.num{text-align:right;font-variant-numeric:tabular-nums}
.bh-table td.bh-col-divider,.bh-table th.bh-col-divider{padding-left:18px;border-left:1px solid #2a2a2a}
.bh-attack{display:inline-block;padding:4px 10px;background:#ef5350;color:#fff!important;border-radius:4px;
  text-decoration:none;font-weight:600;font-size:12px;border:none;cursor:pointer}
.bh-attack:hover{background:#f44336}
.bh-name-link{color:#4fc3f7!important;text-decoration:none}
.bh-name-link:hover{text-decoration:underline}
.bh-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle;flex-shrink:0}
.bh-dot-on{background:#4caf50;box-shadow:0 0 4px rgba(76,175,80,.7)}
.bh-dot-idle{background:#ffb74d}
.bh-dot-off{background:#666}
.bh-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.bh-badge-ok{background:#1e3a2a;color:#4caf50}
.bh-badge-hosp{background:#3a2a1e;color:#ffb74d}
.bh-badge-travel{background:#1e2a3a;color:#64b5f6}
.bh-count{display:inline-block;padding:1px 6px;margin-left:6px;background:#3a2a4a;color:#c49cff;border-radius:8px;font-size:10px;font-weight:700;vertical-align:middle}
.bh-empty{text-align:center;color:#888;padding:30px 8px;font-size:14px}
.bh-empty button{margin-top:10px}

.bh-section{margin-bottom:20px}
.bh-section h3{margin:0 0 8px;font-size:14px;color:#eee}
.bh-section p,.bh-hint{color:#888;font-size:12px;margin:4px 0}
.bh-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bh-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.bh-field label{color:#bbb;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.bh-input,.bh-select{background:#252525;border:1px solid #444;color:#ddd;padding:6px 10px;border-radius:4px;font-size:14px;width:100%}
/* Visual masking for API-key inputs. We intentionally avoid type="password"
   because Chrome/Safari then prompt to save the value as a login credential
   and password managers inject auto-fill UI on top. CSS masking gives the
   bullet-dot look without the browser treating the field as a login. */
.bh-input-masked{-webkit-text-security:disc;text-security:disc;font-family:monospace;letter-spacing:2px}
.bh-btn{padding:7px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;color:#ddd}
.bh-btn-primary{background:#4fc3f7;color:#111!important}.bh-btn-primary:hover{background:#29b6f6}
.bh-btn-danger{background:#ef5350;color:#fff!important}.bh-btn-danger:hover{background:#f44336}
.bh-btn-muted{background:#333;border:1px solid #444;color:#ddd}.bh-btn-muted:hover{background:#3a3a3a}
.bh-btn:disabled{opacity:.5;cursor:not-allowed}
.bh-row-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bh-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:#ccc}
.bh-check input{accent-color:#ef5350}
.bh-save-status{margin-top:8px;min-height:1em;font-size:12px}
.bh-save-ok{color:#4caf50}
.bh-save-err{color:#ef5350}
.bh-save-info{color:#bbb}
.bh-debug-log{margin-top:8px;max-height:220px;overflow-y:auto;background:#111;border:1px solid #333;border-radius:4px;padding:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5}
.bh-debug-hint{color:#666;font-size:11px}
.bh-debug-row{padding:1px 0;color:#aaa;word-break:break-all}
.bh-debug-ts{color:#666;margin-right:4px}
.bh-debug-ms{color:#4caf50;margin-left:4px}
.bh-debug-ok{color:#aaa}
.bh-debug-info{color:#bbb}
.bh-debug-warn{color:#ffb74d}
.bh-debug-err{color:#ef5350}

/* Auth screen */
#bh-auth{padding:24px;color:#ddd;line-height:1.5}
#bh-auth h3{margin:0 0 12px;color:#fff}
#bh-auth .bh-auth-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}

/* Toasts — anchor (top/bottom/left/right), align-items, and per-card width
   are all set inline by Toaster.applySettings() based on user-configured
   notifications.position / .width. Defaults match the legacy bottom-right /
   300px look. */
#bh-toasts{position:fixed;display:flex;flex-direction:column-reverse;gap:8px;
  z-index:2147483646;pointer-events:none;max-width:calc(100vw - 32px)}
.bh-toast{pointer-events:auto;width:300px;max-width:100%;background:#1e1e1e;border:1px solid #444;border-left:4px solid #ef5350;
  border-radius:8px;padding:10px 12px;color:#ddd;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.5);position:relative;cursor:pointer;
  touch-action:pan-y;user-select:none;-webkit-user-select:none;
  animation:bh-toast-in .2s ease-out}
@keyframes bh-toast-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
.bh-toast:hover{border-color:#666}
.bh-toast-close{position:absolute;top:4px;right:6px;background:none;border:none;color:#777;font-size:18px;
  cursor:pointer;padding:0 4px;line-height:1}
.bh-toast-close:hover{color:#fff}
.bh-toast-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:0 18px 4px 0}
.bh-toast-name{color:#fff;font-weight:600;overflow:hidden;text-overflow:ellipsis}
.bh-toast-lvl{color:#888;font-size:11px;font-weight:400;margin-left:4px}
.bh-toast-reward{color:#4caf50;font-weight:700;font-size:15px;white-space:nowrap}
.bh-toast-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.bh-chip{background:#2a2a2a;border:1px solid #3a3a3a;padding:2px 8px;border-radius:10px;font-size:11px;color:#bbb}
.bh-chip.bh-badge-ok{background:#1e3a2a;color:#4caf50;border-color:#1e3a2a}
.bh-chip.bh-badge-hosp{background:#3a2a1e;color:#ffb74d;border-color:#3a2a1e}
.bh-chip.bh-badge-travel{background:#1e2a3a;color:#64b5f6;border-color:#1e2a3a}
.bh-toast-attack{width:100%;padding:6px 10px;background:#ef5350;color:#fff;border:none;border-radius:4px;
  cursor:pointer;font-weight:600;font-size:12px}
.bh-toast-attack:hover{background:#f44336}
.bh-toast-more{border-left-color:#888;text-align:center}
.bh-toast-more-label{color:#fff;font-weight:700;font-size:16px}
.bh-toast-more-hint{color:#888;font-size:11px;margin-top:2px}
.bh-toast-info{border-left-color:#888;cursor:default}
.bh-toast-info-msg{color:#ddd;margin:0 18px 6px 0;font-size:13px}
.bh-toast-info-action{padding:6px 10px;background:#333;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer;font-weight:600;font-size:12px}
.bh-toast-info-action:hover{background:#3a3a3a;border-color:#777}
.bh-toast-actions{display:flex;gap:6px;align-items:stretch}
.bh-toast-actions .bh-toast-attack{flex:1;width:auto}
.bh-toast-blacklist{padding:6px 10px;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:14px;line-height:1}
.bh-toast-blacklist:hover{background:#3a2a2a;border-color:#a44}

/* Hunt-list row blacklist icon — sits next to Attack in the actions cell. */
.bh-row-actions-cell{white-space:nowrap}
.bh-row-blacklist{margin-left:6px;padding:4px 8px;background:#2a2a2a;color:#ccc;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;vertical-align:middle}
.bh-row-blacklist:hover{background:#3a2a2a;border-color:#a44;color:#fff}
.bh-row-watch{margin-left:6px;padding:4px 8px;background:#2a2a2a;color:#ccc;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;vertical-align:middle;filter:grayscale(1);opacity:.75}
.bh-row-watch:hover{background:#1e3038;border-color:#4fc3f7;color:#fff;opacity:1}
.bh-row-watch.watching{filter:none;opacity:1;background:#12303a;border-color:#4fc3f7}

/* API-call rate counter (Hunt status line) */
.bh-api-counter{font-size:11px;color:#7a8a7a;background:#1a231a;border:1px solid #2a3a2a;border-radius:10px;padding:1px 8px;font-variant-numeric:tabular-nums;cursor:default}
.bh-api-counter.warn{color:#ffb0b0;background:#2f1a1a;border-color:#5a2a2a;font-weight:600}

/* Watchlist strip (above the Hunt table) */
.bh-watchlist{background:#14232a;border:1px solid #24424f;border-left:3px solid #4fc3f7;border-radius:4px;padding:8px 10px;margin:0 0 10px}
.bh-wl-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:#cbe6f0;font-weight:600;margin-bottom:6px}
.bh-wl-proj{font-weight:600;color:#8fd0e6;background:#0f2731;border:1px solid #24424f;border-radius:10px;padding:1px 8px;font-variant-numeric:tabular-nums}
.bh-wl-proj.warn{color:#ffb0b0;background:#2f1a1a;border-color:#5a2a2a}
.bh-wl-hint{font-weight:400;color:#7a94a0}
.bh-wl-items{display:flex;flex-wrap:wrap;gap:8px}
.bh-wl-item{display:inline-flex;align-items:center;gap:6px;background:#0f2731;border:1px solid #24424f;border-radius:12px;padding:2px 6px 2px 10px;font-size:12px}
.bh-wl-remove{background:none;border:none;color:#8aa;cursor:pointer;font-size:15px;line-height:1;padding:0 2px}
.bh-wl-remove:hover{color:#ef5350}

/* Med-out alert toast */
.bh-toast-medout-card{border-color:#4caf50!important;box-shadow:0 2px 10px rgba(76,175,80,.35)!important}
.bh-toast-medout{background:#173d22;color:#8ff0a4;font-size:11px;font-weight:700;text-align:center;border-radius:4px;padding:3px 6px;margin-bottom:6px;letter-spacing:.3px}

/* Blacklist section (Script tab) — compact table layout */
.bh-bl-banner{background:#2a2418;border:1px solid #5a4a28;border-left:3px solid #c08030;border-radius:4px;padding:6px 10px;margin:0 0 8px;color:#eed8b0;font-size:11px;line-height:1.35}
.bh-bl-table{width:100%;border-collapse:collapse;font-size:12px}
.bh-bl-table th{text-align:left;padding:4px 6px;color:#888;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #333;background:#1f1f1f}
.bh-bl-table td{padding:3px 6px;border-bottom:1px solid #262626;vertical-align:middle}
.bh-bl-table tr:hover td{background:#222}
.bh-bl-table input.bh-bl-note{width:100%;padding:3px 6px;font-size:12px;background:#1a1a1a;border:1px solid transparent;border-radius:3px}
.bh-bl-table input.bh-bl-note:hover{border-color:#333}
.bh-bl-table input.bh-bl-note:focus{border-color:#4fc3f7;outline:none;background:#222}
.bh-bl-name-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
.bh-bl-name-unknown{color:#888!important;font-style:italic}
.bh-bl-x{background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:2px 6px;line-height:1;border-radius:3px}
.bh-bl-x:hover{color:#ef5350;background:#2a1818}
.bh-bl-empty{text-align:center;color:#666;font-style:italic;padding:14px 8px!important;font-size:12px}
.bh-toast-clear-btn{pointer-events:auto;align-self:flex-end;background:rgba(30,30,30,0.9);color:#aaa;
  border:1px solid #444;border-radius:14px;padding:3px 10px;font-size:11px;font-weight:600;
  letter-spacing:.5px;text-transform:uppercase;cursor:pointer;font-family:inherit;
  box-shadow:0 2px 6px rgba(0,0,0,.4)}
.bh-toast-clear-btn:hover{background:#2a2a2a;color:#fff;border-color:#666}

@media(max-width:768px){
  #bh-panel{width:100vw!important;max-width:100vw;min-width:0;border-radius:0;top:0;left:0;
    transform:none;max-height:100vh;height:100vh}
  .bh-grid-2{grid-template-columns:1fr}
  .bh-table td,.bh-table th{padding:6px 6px;font-size:12px}
  /* Comfier padding on touch screens; width still follows the user's
     setting (and max-width:calc(100vw - 32px) on the container clamps
     anything wider than the screen). */
  .bh-toast{padding:14px 12px 12px}
  /* ≥44x44 tap target so fingers don't miss into the card (which attacks). */
  .bh-toast-close{top:0;right:0;min-width:44px;min-height:44px;padding:0;font-size:26px;
    display:flex;align-items:center;justify-content:center}
  .bh-toast-head{margin-right:44px}
}
`;
        document.head.appendChild(style);
    }

    // ════════════════════════════════════════════════════════════
    //  UI
    // ════════════════════════════════════════════════════════════

    class UI {
        constructor(hunter, toaster) {
            this.hunter = hunter;
            this.toaster = toaster;
            this.activeTab = "hunt";
            this._countdownTimer = null;
            this._panel = null;
            this._overlay = null;
            this._authed = false;
            this._sortCol = "reward";
            this._sortDir = "desc";
        }

        inject() {
            injectCSS();

            const overlay = document.createElement("div");
            overlay.id = "bh-overlay";
            document.body.appendChild(overlay);

            const panel = document.createElement("div");
            panel.id = "bh-panel";
            panel.innerHTML = `
                <div id="bh-header">
                    <h2>Bounty Hunter <span class="bh-ver">v${VERSION}</span>
                        <span style="color:#888;font-size:11px;font-weight:400;margin-left:10px">
                            Like the script? Send a Xanax to
                            <a href="https://www.torn.com/profiles.php?XID=4192025" target="_blank"
                               style="color:#cc3333;text-decoration:none">eugene_s [4192025]</a>
                        </span>
                    </h2>
                    <button id="bh-close">&times;</button>
                </div>
                <div id="bh-tabs">
                    <div class="bh-tab active" data-tab="hunt">Hunt</div>
                    <div class="bh-tab" data-tab="script">Script</div>
                    <div class="bh-tab" data-tab="uiux">UI/UX</div>
                    <div class="bh-tab" data-tab="api">API</div>
                </div>
                <div id="bh-content"></div>
            `;
            document.body.appendChild(panel);
            this._panel = panel;
            this._overlay = overlay;

            overlay.addEventListener("click", () => this.toggle(false));
            panel.querySelector("#bh-close").addEventListener("click", () => this.toggle(false));
            panel.querySelector("#bh-tabs").addEventListener("click", (e) => {
                const t = e.target.closest(".bh-tab");
                if (!t) return;
                this.activeTab = t.dataset.tab;
                this._syncTabs();
                this._renderActive();
            });

            // Hook hunter updates → UI refresh.
            this.hunter.onUpdate = () => { if (this._isOpen()) this._renderActive(); };
            this.hunter.onToast = (bounties) => this.toaster.showMany(bounties);
            this.hunter.onMatchesApplied = (ids) => this.toaster.pruneTo(ids);
            // Med-out alerts bypass the "new matches" toast master switch —
            // the user explicitly asked to watch these targets.
            this.hunter.onWatchToast = (bounties) => this.toaster.showMany(bounties);

            // Countdown ticker — updates both the "next refresh in Xs" header
            // and any live hospital-countdown badges (rows + toasts). Ticks
            // every second; toasts live outside the panel so they tick too.
            this._countdownTimer = setInterval(() => {
                if (this._isOpen() && this.activeTab === "hunt") {
                    const el = document.getElementById("bh-countdown");
                    if (el) el.textContent = this.hunter.secondsUntilRefresh() + "s";
                    const cEl = document.getElementById("bh-api-counter");
                    if (cEl) {
                        const n = apiCallsLastMinute();
                        cEl.textContent = `API ${n}/min`;
                        cEl.className = n >= RATE_WARN ? "bh-api-counter warn" : "bh-api-counter";
                    }
                    const wEl = document.getElementById("bh-wl-countdown");
                    if (wEl && this.hunter.settings.searchEnabled) wEl.textContent = this.hunter.secondsUntilWatchPoll();
                }
                document.querySelectorAll("[data-hosp-until]").forEach((el) => {
                    const until = parseInt(el.dataset.hospUntil, 10);
                    if (!Number.isFinite(until)) return;
                    el.textContent = fmt.hospLabel(until);
                });
            }, 1000);
        }

        _isOpen() { return this._panel && this._panel.classList.contains("bh-open"); }

        toggle(open) {
            const isOpen = open != null ? open : !this._isOpen();
            this._panel.classList.toggle("bh-open", isOpen);
            this._overlay.classList.toggle("bh-open", isOpen);
            if (isOpen) this._renderActive();
        }

        _syncTabs() {
            for (const t of this._panel.querySelectorAll(".bh-tab")) {
                t.classList.toggle("active", t.dataset.tab === this.activeTab);
            }
        }

        _renderActive() {
            if (!this._authed) { this._renderAuth(); return; }
            switch (this.activeTab) {
                case "hunt":   this._renderHunt();   break;
                case "script": this._renderScript(); break;
                case "uiux":   this._renderUIUX();   break;
                case "api":    this._renderAPI();    break;
                // Migrate users who linked the old "settings" tab anywhere.
                case "settings": this.activeTab = "script"; this._syncTabs(); this._renderScript(); break;
                default:       this._renderHunt();
            }
        }

        setAuthed(b) {
            this._authed = b;
            if (this._isOpen()) this._renderActive();
        }

        _renderAuth() {
            const content = this._panel.querySelector("#bh-content");
            const spaAvailable = !IS_PDA && KeyResolver.hasSPAKey();
            content.innerHTML = `
                <div id="bh-auth">
                    <h3>Set your Torn API key</h3>
                    <p>Bounty Hunter needs a <b>public</b> Torn API key to read the global bounty board, each target's status, and your own user ID. The key is stored in this browser's localStorage and used only against <code>api.torn.com</code>.</p>
                    <p class="bh-hint">Get one at <a class="bh-name-link" href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">torn.com → Preferences → API Key</a>. "Public" access is sufficient.</p>
                    <div class="bh-field">
                        <label>Torn API key (16 chars)</label>
                        <input id="bh-auth-key" class="bh-input bh-input-masked" type="text" maxlength="16" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other">
                    </div>
                    <div class="bh-auth-actions">
                        <button id="bh-auth-save" class="bh-btn bh-btn-primary">Save &amp; start</button>
                        ${spaAvailable ? `<button id="bh-auth-spa" class="bh-btn bh-btn-muted">Use Supply Pack Analyzer's saved key</button>` : ""}
                    </div>
                    <p class="bh-hint" id="bh-auth-err" style="color:#ef5350;min-height:1em"></p>
                    <hr style="border:none;border-top:1px solid #333;margin:16px 0">
                    <h3>Optional: FFScouter key</h3>
                    <p>FFScouter provides the fair-fight score. Without it Bounty Hunter can't filter targets by FF — which is the whole point of the script.</p>
                    <p class="bh-hint">Get one at <a class="bh-name-link" href="https://ffscouter.com" target="_blank" rel="noopener">ffscouter.com</a>. You can set this later under Settings.</p>
                    <div class="bh-field">
                        <label>FFScouter key (16 chars)</label>
                        <input id="bh-auth-ffkey" class="bh-input bh-input-masked" type="text" maxlength="16" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" value="${escHtml(KeyResolver.getFFKey())}">
                    </div>
                </div>
            `;

            const keyInput = content.querySelector("#bh-auth-key");
            const err = content.querySelector("#bh-auth-err");
            const save = async () => {
                err.textContent = "";
                const k = keyInput.value.trim();
                if (!/^[A-Za-z0-9]{16}$/.test(k)) {
                    err.textContent = "That doesn't look like a 16-character Torn key.";
                    return;
                }
                await this._adoptKey(k, content.querySelector("#bh-auth-ffkey").value.trim());
            };
            content.querySelector("#bh-auth-save").addEventListener("click", save);
            keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });

            const spaBtn = content.querySelector("#bh-auth-spa");
            if (spaBtn) {
                spaBtn.addEventListener("click", async () => {
                    err.textContent = "";
                    const k = KeyResolver.getSPAKey();
                    if (!k) { err.textContent = "Supply Pack Analyzer's key isn't available."; return; }
                    await this._adoptKey(k, content.querySelector("#bh-auth-ffkey").value.trim());
                });
            }
        }

        async _adoptKey(tornKey, ffKey) {
            const err = this._panel.querySelector("#bh-auth-err");
            if (err) err.textContent = "Validating…";
            this.hunter.api.setKey(tornKey);
            try {
                await this.hunter.api.validateKey();
            } catch (e) {
                if (err) err.textContent = "Torn rejected that key: " + (e.message || "invalid");
                return;
            }
            KeyResolver.saveTornKey(tornKey);
            if (ffKey && /^[A-Za-z0-9]{16}$/.test(ffKey)) KeyResolver.saveFFKey(ffKey);
            this.setAuthed(true);
            this.hunter.start();
        }

        _renderHunt() {
            const content = this._panel.querySelector("#bh-content");
            const rows = this._sortMatches(this.hunter.lastMatches);
            const c = this.hunter.lastCounts;
            const nextIn = this.hunter.secondsUntilRefresh();
            const rateLimited = isRateLimitError(this.hunter.lastError);
            // Only show the generic error line when it isn't a rate-limit —
            // the rate-limit case gets its own banner below with actionable copy.
            const errLine = (this.hunter.lastError && !rateLimited)
                ? `<span class="bh-err">${escHtml(this.hunter.lastError.message || "error")}</span>`
                : "";
            const ffKeyMissing = !KeyResolver.getFFKey() && !this.hunter.settings.includeUnknownFF
                ? `<span class="bh-err">No FFScouter key set — every target will be excluded. Add one in Settings, or enable "Include unknown-FF targets".</span>`
                : "";
            const ffError = c && c.ffError
                ? `<span class="bh-err">FFScouter: ${escHtml(c.ffError)}</span>`
                : "";
            const thCls = (col) => {
                if (this._sortCol !== col) return "";
                return this._sortDir === "asc" ? "sort-asc" : "sort-desc";
            };
            // Rate-limit banner — prominent, actionable. Three sub-states:
            //   • partial — this cycle was aborted mid-scan but produced some
            //     matches; rows are an INCOMPLETE subset of "what's out there"
            //   • stale prior — this cycle aborted but we kept a prior full scan
            //   • empty — this cycle aborted with nothing to fall back on
            const isPartial = rateLimited && !!this.hunter.partialFromRateLimit;
            const scanned = c && typeof c.scanned === "number" ? c.scanned : null;
            const afterFF = c && typeof c.afterFF === "number" ? c.afterFF : null;
            const scanProgress = (scanned != null && afterFF != null)
                ? `scanned <b>${scanned}</b> of <b>${afterFF}</b> candidate target${afterFF === 1 ? "" : "s"} before the cap`
                : "before the scan could finish";
            const rateLimitTitle = isPartial
                ? "API rate limit hit — partial results shown"
                : (rows.length > 0
                    ? "API rate limit hit — showing previous results"
                    : "API rate limit hit — no results to show");
            const rateLimitLead = isPartial
                ? `Torn's API limited us (~100 requests / minute) and we ${scanProgress}. The table below is <b>incomplete</b> — more matches may exist among the targets we couldn't check this cycle.`
                : (rows.length > 0
                    ? `Torn's API limited us (~100 requests / minute) ${scanProgress}. The table below is from the <b>last successful refresh</b> and may be slightly stale.`
                    : `Torn's API limited us (~100 requests / minute) ${scanProgress}. No matches could be confirmed and no prior cycle has succeeded yet.`);
            const rateLimitBanner = rateLimited
                ? `
                    <div class="bh-rl-banner">
                        <div class="bh-rl-title">${rateLimitTitle}</div>
                        <div class="bh-rl-body">
                            ${rateLimitLead}
                            <br><br>
                            <b>Why this happens:</b> wide filters mean every bounty needs a per-target profile lookup, and Torn caps how fast we can do that. <b>Tighten your filters so fewer targets need scanning:</b>
                            <ul class="bh-rl-tips">
                                <li>Raise <b>Min reward</b> (e.g. $1M+) — skips low-value bounties.</li>
                                <li>Narrow <b>Fair-fight</b> range — excludes targets outside your combat bracket.</li>
                                <li>Lower <b>Hospital max</b> — skips long-hospital targets that aren't actionable.</li>
                                <li>Increase <b>Auto-refresh</b> interval (e.g. 2 min+) — spreads calls over time.</li>
                            </ul>
                            <span class="bh-rl-hint">Auto-retry will continue in the background.</span>
                        </div>
                    </div>
                `
                : "";
            // Paused banner — master toggle off, energy below threshold, or our
            // own status (hospital/jail/traveling) means we can't attack. Stays
            // above the table so the "why hasn't this refreshed?" question is
            // answered at a glance.
            const SELF_PAUSE_COPY = {
                hospital: "You're in hospital",
                jail: "You're in jail",
                traveling: "You're travelling",
            };
            const pr = this.hunter.pausedReason;
            const pausedBanner = pr === "low-energy" && this.hunter.myEnergy
                ? `<div class="bh-paused-banner">⏸ Paused — energy <b>${this.hunter.myEnergy.current}/${this.hunter.myEnergy.maximum}</b> (below ${this.hunter.settings.minEnergy}). Auto-refresh resumes when you recover enough to attack.</div>`
                : SELF_PAUSE_COPY[pr]
                    ? `<div class="bh-paused-banner">⏸ Paused — ${SELF_PAUSE_COPY[pr]}. Auto-refresh resumes once you're back and able to attack.</div>`
                    : pr === "disabled"
                        ? `<div class="bh-paused-banner">⏸ Search disabled — turn it back on in Settings to resume auto-refresh.</div>`
                        : "";
            content.innerHTML = `
                <div id="bh-donor-host"></div>
                <div id="bh-status-line">
                    <button id="bh-refresh-btn" class="bh-btn-muted">Refresh now</button>
                    <span>Next refresh in <span id="bh-countdown">${nextIn}</span>s</span>
                    <span>${rows.length} match${rows.length === 1 ? "" : "es"}${isPartial ? ' <span class="bh-rl-pill">partial</span>' : ""}</span>
                    ${this._apiCounterHtml()}
                    ${errLine}
                    ${ffKeyMissing}
                    ${ffError}
                </div>
                ${pausedBanner}
                ${this._renderWatchStrip()}
                ${rateLimitBanner}
                ${rows.length === 0 ? (rateLimited ? "" : `
                    <div class="bh-empty">
                        No bounties match your filters right now.<br>
                        <span style="color:#666">Adjust min price, FF range, or hospital window under Settings.</span>
                    </div>
                `) : `
                    <table class="bh-table">
                        <thead>
                            <tr>
                                <th data-sort="target" class="${thCls("target")}">Target</th>
                                <th data-sort="reward" class="num ${thCls("reward")}">Reward</th>
                                <th data-sort="ff" class="num ${thCls("ff")}">FF</th>
                                <th data-sort="bs" class="num bh-col-divider ${thCls("bs")}">BS</th>
                                <th data-sort="status" class="bh-col-divider ${thCls("status")}">Status</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map((row) => this._renderRow(row)).join("")}
                        </tbody>
                    </table>
                `}
            `;
            this._renderDonorBanner(content.querySelector("#bh-donor-host"));
            const btn = content.querySelector("#bh-refresh-btn");
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                try { await this.hunter.refresh(); } catch { /* shown in status line */ }
                btn.disabled = false;
            });
            content.querySelectorAll(".bh-attack").forEach((el) => {
                el.addEventListener("click", (e) => {
                    e.preventDefault();
                    const id = el.dataset.id;
                    openTornUrl(ATTACK_URL + id);
                });
            });
            content.querySelectorAll(".bh-row-blacklist").forEach((el) => {
                el.addEventListener("click", (e) => {
                    e.preventDefault();
                    this._blacklistWithUndo(el.dataset.id, el.dataset.name);
                });
            });
            content.querySelectorAll(".bh-row-watch").forEach((el) => {
                el.addEventListener("click", (e) => {
                    e.preventDefault();
                    const id = el.dataset.id;
                    if (this.hunter.isWatched(id)) {
                        this.hunter.removeFromWatchlist(id);
                    } else {
                        this.hunter.addToWatchlist({
                            target_id: id,
                            target_name: el.dataset.name,
                            reward: Number(el.dataset.reward),
                            statusState: el.dataset.state,
                        });
                    }
                    this._renderHunt();
                });
            });
            content.querySelectorAll(".bh-wl-remove").forEach((el) => {
                el.addEventListener("click", (e) => {
                    e.preventDefault();
                    this.hunter.removeFromWatchlist(el.dataset.id);
                    this._renderHunt();
                });
            });
            content.querySelectorAll("th[data-sort]").forEach((el) => {
                el.addEventListener("click", () => {
                    const col = el.dataset.sort;
                    if (this._sortCol === col) {
                        this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
                    } else {
                        this._sortCol = col;
                        // Numeric columns default to descending (biggest first),
                        // text columns default to ascending (A–Z).
                        this._sortDir = (col === "target") ? "asc" : "desc";
                    }
                    this._renderHunt();
                });
            });
        }

        _renderDonorBanner(host) {
            // Belt-and-braces — host is created in _renderHunt(); a missing
            // node just means we're being called outside the Hunt tab.
            if (!host) return;

            const paint = (status) => {
                if (!host.isConnected) return; // tab swapped before fetch resolved
                if (!DonorClient.shouldShow(status)) {
                    host.innerHTML = "";
                    return;
                }
                host.innerHTML = `
                    <div class="bh-donor-banner">
                        💚 <b>Thank you for your Xanax donation</b> — I really appreciate your support!
                        <button class="bh-donor-dismiss" title="Dismiss">&times;</button>
                    </div>
                `;
                host.querySelector(".bh-donor-dismiss").addEventListener("click", () => {
                    DonorClient.dismiss(status.lastDonationTs);
                    host.innerHTML = "";
                });
            };

            // Resolve user id independently of the Hunter (it might still be
            // mid-`validateKey` when the panel first renders). Cached after
            // the first successful resolve so subsequent renders are sync.
            DonorClient.getUserId().then((userId) => {
                if (!userId || !host.isConnected) return;
                const cached = DonorClient.cachedStatus(userId);
                if (cached) { paint(cached); return; }
                DonorClient.fetchStatus(userId).then(paint);
            });
        }

        _sortMatches(list) {
            const col = this._sortCol;
            const dir = this._sortDir === "asc" ? 1 : -1;
            const statusRank = (m) => m.statusState === "Okay" ? 0 : 1;
            const keyFor = (m) => {
                switch (col) {
                    case "target": return String(m.target_name || "").toLowerCase();
                    case "reward": return m.reward || 0;
                    case "ff":     return m.ff == null ? Number.POSITIVE_INFINITY : m.ff;
                    case "bs":     return parseBS(m.bs) == null ? Number.POSITIVE_INFINITY : parseBS(m.bs);
                    case "status": {
                        // Okay first (desc) or last (asc); within Hospital, sort by time-remaining.
                        const remain = m.statusState === "Hospital"
                            ? Math.max(0, (m.hospUntil || 0) - Math.floor(Date.now() / 1000))
                            : 0;
                        return statusRank(m) * 1e6 + remain;
                    }
                    default: return m.reward || 0;
                }
            };
            // "Infinity" keys (missing data) stay at the end regardless of dir,
            // so the user isn't bombarded with blank cells on asc.
            return [...list].sort((a, b) => {
                const ka = keyFor(a); const kb = keyFor(b);
                const aInf = ka === Number.POSITIVE_INFINITY;
                const bInf = kb === Number.POSITIVE_INFINITY;
                if (aInf && !bInf) return 1;
                if (bInf && !aInf) return -1;
                if (ka < kb) return -1 * dir;
                if (ka > kb) return  1 * dir;
                // Secondary: reward desc, keeps the big ones on top within ties.
                return (b.reward || 0) - (a.reward || 0);
            });
        }

        // Rolling API-call counter pill for the status line. Warns as it
        // nears Torn's ~100/min ceiling.
        _apiCounterHtml() {
            const n = apiCallsLastMinute();
            const cls = n >= RATE_WARN ? "bh-api-counter warn" : "bh-api-counter";
            const title = n >= RATE_WARN
                ? `${n} API calls in the last minute — near Torn's ~100/min limit. Raise the watchlist interval or watch fewer targets.`
                : `${n} API calls in the last minute (across all open BH tabs). Torn allows ~100/min.`;
            return `<span class="${cls}" id="bh-api-counter" title="${title}">API ${n}/min</span>`;
        }

        // Watchlist strip above the table: watched targets, their last-known
        // state, projected call cost, and remove buttons. Hidden when empty.
        _renderWatchStrip() {
            const wl = this.hunter.watchlist;
            const ids = Object.keys(wl);
            if (ids.length === 0) return "";
            const intervalSec = Math.max(1, Number(this.hunter.settings.watchlistIntervalSec) || 5);
            const proj = projectedWatchCallsPerMin(ids.length, intervalSec);
            const projCls = proj >= RATE_WARN ? "bh-wl-proj warn" : "bh-wl-proj";
            const items = ids.map((id) => {
                const e = wl[id];
                const stateCls = e.lastState === "Okay" ? "bh-badge-ok"
                    : e.lastState === "Hospital" ? "bh-badge-hosp" : "bh-badge-travel";
                const name = escHtml(e.name || id);
                return `<span class="bh-wl-item">
                    <a class="bh-name-link" href="${PROFILE_URL}${id}" target="_blank" rel="noopener">${name}</a>
                    <span class="bh-badge ${stateCls}">${escHtml(e.lastState || "?")}</span>
                    <button class="bh-wl-remove" data-id="${id}" title="Stop watching">&times;</button>
                </span>`;
            }).join("");
            return `
                <div class="bh-watchlist">
                    <div class="bh-wl-head">
                        <span>👁 Watching ${ids.length} for med-out</span>
                        ${this.hunter.settings.searchEnabled
                            ? `<span class="bh-wl-hint">Next poll in <span id="bh-wl-countdown">${this.hunter.secondsUntilWatchPoll()}</span>s</span>`
                            : `<span class="bh-wl-hint" id="bh-wl-countdown">⏸ paused — bounty search off</span>`}
                        <span class="${projCls}" title="Estimated requests/min this watchlist adds at the current interval (${intervalSec}s), accounting for the 750ms call gate.">~${proj}/min</span>
                        <span class="bh-wl-hint">every ${intervalSec}s · visible tab only</span>
                    </div>
                    <div class="bh-wl-items">${items}</div>
                </div>
            `;
        }

        // Presence dot from the profile's last_action.status. No dot when
        // unknown (e.g. a row seeded from older shared data without the field).
        _onlineDot(lastAction) {
            const cls = lastAction === "Online" ? "on"
                : lastAction === "Idle" ? "idle"
                : lastAction === "Offline" ? "off" : "";
            if (!cls) return "";
            return `<span class="bh-dot bh-dot-${cls}" title="${escHtml(lastAction)}"></span>`;
        }

        _renderRow(b) {
            const sm = fmt.statusMeta(b);
            const statusClass = sm.cls;
            const hospAttr = sm.attr;
            const statusText = sm.text;
            const locationBadge = (b.awayFromMe && b.location)
                ? ` <span class="bh-badge bh-badge-travel">📍 ${escHtml(b.location)}</span>`
                : "";
            const ffCell = b.ff == null ? "—" : b.ff.toFixed(2);
            const countBadge = b.bountyCount > 1
                ? ` <span class="bh-count">×${b.bountyCount}</span>`
                : "";
            return `
                <tr>
                    <td>
                        ${this._onlineDot(b.lastAction)}<a class="bh-name-link" href="${PROFILE_URL}${b.target_id}" target="_blank" rel="noopener">${escHtml(b.target_name)}</a>
                        <span style="color:#666;font-size:11px"> L${b.target_level}</span>${countBadge}
                    </td>
                    <td class="num">${escHtml(fmt.moneyFull(b.reward))}</td>
                    <td class="num">${ffCell}</td>
                    <td class="num bh-col-divider">${escHtml(b.bs || "—")}</td>
                    <td class="bh-col-divider"><span class="bh-badge ${statusClass}"${hospAttr}>${statusText}</span>${locationBadge}</td>
                    <td class="bh-row-actions-cell">
                        <button class="bh-attack" data-id="${b.target_id}">Attack →</button>
                        <button class="bh-row-watch${this.hunter.isWatched(b.target_id) ? " watching" : ""}" data-id="${b.target_id}" data-name="${escHtml(b.target_name)}" data-reward="${b.reward}" data-state="${b.statusState || ""}" title="${this.hunter.isWatched(b.target_id) ? "Stop watching for med-out" : "Watch for med-out (alert when out of hospital)"}">👁</button>
                        <button class="bh-row-blacklist" data-id="${b.target_id}" data-name="${escHtml(b.target_name)}" title="Blacklist ${escHtml(b.target_name)}">🚫</button>
                    </td>
                </tr>
            `;
        }

        // Lower floor than the all-fields-on minimum so a card with most
        // fields hidden can shrink down to roughly name + Attack button.
        // ~140 covers a 16-char ellipsised name and the attack pill.
        //
        // Reward sits on the head row next to the name, so enabling it costs
        // horizontal space. FF / Battle stats / Status render as chips on a
        // separate meta row that flex-wraps — one or two chips re-flow fine
        // at the narrow floor, so the only time we need extra width is when
        // all three chips are on at once (and even then the bump just keeps
        // them on a single row at the floor width).
        _notifWidthFloor(fields) {
            const f = fields || DEFAULT_SETTINGS.notifications.fields;
            let min = 140;
            if (f.reward !== false)                                              min += 40;
            if (f.ff !== false && f.bs !== false && f.status !== false)          min += 30;
            return min;
        }

        // Stand-alone so the HTML template above stays readable. Kept on the
        // class instead of as a free function to keep all settings rendering
        // colocated.
        _renderNotificationsSection(s) {
            const n = s.notifications || DEFAULT_SETTINGS.notifications;
            const f = n.fields || DEFAULT_SETTINGS.notifications.fields;
            const widthFloor = this._notifWidthFloor(f);
            const POSITIONS = [
                ["bottom-right", "Bottom right"],
                ["bottom-left",  "Bottom left"],
                ["top-right",    "Top right"],
                ["top-left",     "Top left"],
            ];
            const posOpts = POSITIONS.map(([v, label]) =>
                `<option value="${v}"${n.position === v ? " selected" : ""}>${label}</option>`).join("");
            const checked = (v) => v ? " checked" : "";
            return `
                <div class="bh-section">
                    <h3>Notifications</h3>
                    <label class="bh-check"><input type="checkbox" id="bh-set-toasts"${checked(s.toastsEnabled)}> Show toast for new matches</label>
                    <p class="bh-hint">Master switch — when off, the script still fills the Hunt tab but never pops a toast.</p>
                    <div class="bh-grid-2" style="margin-top:8px">
                        <div class="bh-field">
                            <label>Position</label>
                            <select id="bh-set-notif-pos" class="bh-select">${posOpts}</select>
                        </div>
                        <div class="bh-field">
                            <label>Card width (px)</label>
                            <input id="bh-set-notif-width" class="bh-input" type="number" min="${widthFloor}" max="640" step="10" value="${n.width}">
                            <span class="bh-hint" id="bh-notif-width-hint">Min ${widthFloor}, max 640. Lower min available when you hide fields.</span>
                        </div>
                        <div class="bh-field">
                            <label>Max visible at once</label>
                            <input id="bh-set-notif-max" class="bh-input" type="number" min="1" max="20" step="1" value="${n.maxVisible}">
                            <span class="bh-hint">Extra matches roll up into a single "+N more" card.</span>
                        </div>
                        <div class="bh-field">
                            <label>Auto-dismiss (seconds)</label>
                            <input id="bh-set-notif-timeout" class="bh-input" type="number" min="3" max="120" step="1" value="${n.timeoutSec}">
                            <span class="bh-hint">Hovering a card pauses its timer.</span>
                        </div>
                    </div>
                    <div class="bh-field" style="margin-top:4px">
                        <label>Show on each card</label>
                        <div class="bh-row-actions" style="gap:14px">
                            <label class="bh-check"><input type="checkbox" id="bh-set-notif-f-level"${checked(f.level !== false)}> Level</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-notif-f-reward"${checked(f.reward !== false)}> Reward</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-notif-f-ff"${checked(f.ff !== false)}> Fair fight</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-notif-f-bs"${checked(f.bs !== false)}> Battle stats</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-notif-f-status"${checked(f.status !== false)}> Status</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-notif-f-location"${checked(f.location !== false)}> Location</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-notif-f-blacklist"${checked(f.blacklist === true)}> Blacklist button</label>
                        </div>
                        <span class="bh-hint">The target name and the Attack button are always shown. Location shows a 📍 marker only when the target is in a different country than you. Blacklist button is off by default — enable it for one-click blacklisting from a toast.</span>
                    </div>
                    <div class="bh-row-actions" style="margin-top:8px">
                        <button id="bh-notif-preview" class="bh-btn bh-btn-muted">Preview toast</button>
                    </div>
                </div>
            `;
        }

        _clampInt(raw, lo, hi, fallback) {
            const n = parseInt(raw, 10);
            if (!Number.isFinite(n)) return fallback;
            return Math.max(lo, Math.min(hi, n));
        }

        // ── Blacklist section (rendered inside the Script tab) ─────────────
        //
        // Compact layout modeled on Bazaar Deal Hunter's Rules table: each
        // entry is one table row with an inline ✕ button. Copy / paste both
        // hit the system clipboard directly (no persistent textareas), so
        // the whole section stays roughly the height of the visible rows
        // plus a single action row.
        _renderBlacklistSection() {
            return `
                <div class="bh-section" id="bh-bl-section">
                    <h3>Blacklist</h3>
                    <div class="bh-bl-banner">
                        ⚠ Stored in this browser only — copy/paste to move between devices.
                    </div>
                    <table class="bh-bl-table">
                        <thead>
                            <tr>
                                <th style="width:88px">ID</th>
                                <th style="width:30%">Name</th>
                                <th>Note</th>
                                <th style="width:34px"></th>
                            </tr>
                        </thead>
                        <tbody id="bh-bl-tbody">${this._renderBlacklistRows()}</tbody>
                    </table>
                    <div class="bh-row-actions" style="margin-top:8px;flex-wrap:wrap">
                        <input id="bh-bl-id" class="bh-input" type="number" min="1" step="1" placeholder="Torn user ID" style="max-width:140px">
                        <button id="bh-bl-add" class="bh-btn bh-btn-primary">+ Add</button>
                        <button id="bh-bl-copy" class="bh-btn bh-btn-muted">Copy</button>
                        <button id="bh-bl-paste" class="bh-btn bh-btn-muted">Paste from clipboard</button>
                        <button id="bh-bl-clear" class="bh-btn bh-btn-danger">Clear all</button>
                        <span id="bh-bl-status" class="bh-save-status" style="margin-left:4px"></span>
                    </div>
                </div>
            `;
        }

        _renderBlacklistRows() {
            const entries = Object.entries(this.hunter.blacklist)
                .sort(([, a], [, b]) => (b.addedAt || 0) - (a.addedAt || 0));
            if (entries.length === 0) {
                return `<tr><td colspan="4" class="bh-bl-empty">Blacklist is empty. Add an ID below, or use the 🚫 button on a Hunt-list row.</td></tr>`;
            }
            return entries.map(([id, e]) => {
                const nameCell = e.name
                    ? `<a class="bh-name-link" href="${PROFILE_URL}${id}" target="_blank" rel="noopener">${escHtml(e.name)}</a>`
                    : `<a class="bh-name-link bh-bl-name-unknown" href="${PROFILE_URL}${id}" target="_blank" rel="noopener" title="Name fills in next time this bounty appears">(unknown)</a>`;
                return `
                    <tr data-id="${id}">
                        <td><a class="bh-name-link" href="${PROFILE_URL}${id}" target="_blank" rel="noopener">${id}</a></td>
                        <td class="bh-bl-name-cell">${nameCell}</td>
                        <td><input class="bh-input bh-bl-note" data-id="${id}" type="text" placeholder="Note (private, this device only)" value="${escHtml(e.note || "")}"></td>
                        <td><button class="bh-bl-x" data-id="${id}" title="Remove from blacklist">✕</button></td>
                    </tr>
                `;
            }).join("");
        }

        _wireBlacklistSection(content) {
            const $ = (id) => content.querySelector("#" + id);
            const tbody = $("bh-bl-tbody");
            const refresh = () => { tbody.innerHTML = this._renderBlacklistRows(); };

            const status = (kind, msg, sticky = false) => {
                const el = $("bh-bl-status");
                if (!el) return;
                el.className = "bh-save-status bh-save-" + kind;
                el.textContent = msg;
                if (!sticky && (kind === "ok" || kind === "info")) {
                    setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3000);
                }
            };

            const idInput = $("bh-bl-id");
            const addById = () => {
                const raw = idInput.value.trim();
                if (!/^\d+$/.test(raw) || raw === "0") {
                    status("err", "Enter a numeric Torn user ID.");
                    return;
                }
                if (Number(raw) === this.hunter.myUserId) {
                    status("err", "Can't blacklist yourself.");
                    return;
                }
                if (this.hunter.isBlacklisted(raw)) {
                    status("info", "Already blacklisted.");
                    return;
                }
                if (this.hunter.addToBlacklist(raw, null)) {
                    idInput.value = "";
                    refresh();
                    status("ok", "Added.");
                }
            };
            $("bh-bl-add").addEventListener("click", addById);
            idInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addById(); } });

            // Delegate row buttons + note edits to the tbody so we don't
            // re-bind dozens of listeners on every refresh.
            tbody.addEventListener("click", (e) => {
                const x = e.target.closest(".bh-bl-x");
                if (!x) return;
                this.hunter.removeFromBlacklist(x.dataset.id);
                refresh();
            });
            // Persist notes on blur — avoids saving on every keystroke, which
            // would churn localStorage and broadcast a storage event to every
            // other tab per character typed.
            tbody.addEventListener("focusout", (e) => {
                if (!e.target.classList.contains("bh-bl-note")) return;
                this.hunter.setBlacklistNote(e.target.dataset.id, e.target.value);
            });

            $("bh-bl-copy").addEventListener("click", async () => {
                const text = JSON.stringify(this.hunter.blacklist, null, 2);
                try {
                    await navigator.clipboard.writeText(text);
                    status("ok", `Copied ${Object.keys(this.hunter.blacklist).length} entries.`);
                } catch {
                    status("err", "Clipboard write blocked — check browser permissions.");
                }
            });
            $("bh-bl-paste").addEventListener("click", async () => {
                let text;
                try {
                    text = await navigator.clipboard.readText();
                } catch {
                    status("err", "Clipboard read blocked — paste into the ID field above instead.");
                    return;
                }
                if (!text || !text.trim()) {
                    status("err", "Clipboard is empty.");
                    return;
                }
                const added = this.hunter.importBlacklist(text);
                refresh();
                status("ok", added > 0
                    ? `Imported ${added} new entr${added === 1 ? "y" : "ies"}.`
                    : "No new entries (already present or unparseable).");
            });

            $("bh-bl-clear").addEventListener("click", () => {
                const count = Object.keys(this.hunter.blacklist).length;
                if (count === 0) { status("info", "Blacklist is already empty."); return; }
                if (!confirm(`Clear all ${count} blacklist entries? This can't be undone.`)) return;
                this.hunter.clearBlacklist();
                refresh();
                status("ok", "Cleared.");
            });
        }

        // Tiny utility used by Hunt-row / toast blacklist buttons. Adds the
        // player, then shows an undo toast for ~5s.
        _blacklistWithUndo(id, name) {
            if (this.hunter.isBlacklisted(id)) return;
            if (!this.hunter.addToBlacklist(id, name)) return;
            this.toaster.showAction({
                message: `Blacklisted ${name || `#${id}`}`,
                actionLabel: "Undo",
                onAction: () => this.hunter.removeFromBlacklist(id),
                timeoutMs: 5000,
            });
        }

        // After persisting changes that affect the refresh loop, restart it
        // from a clean state. Shared by Script and UI/UX persistence paths.
        _restartLoopFromSettings() {
            this.hunter.stop();
            if (this.hunter.settings.searchEnabled && this.hunter.settings.refreshSec > 0) {
                this.hunter.start();
            } else if (!this.hunter.settings.searchEnabled) {
                this.hunter.pausedReason = "disabled";
            } else {
                this.hunter.pausedReason = null;
            }
        }

        // ── Script tab ─────────────────────────────────────────────────────
        _renderScript() {
            const content = this._panel.querySelector("#bh-content");
            const s = this.hunter.settings;
            const energyScopeHint = (s.pauseOnLowEnergy && this.hunter.lastEnergyError === "scope")
                ? `<span class="bh-err">Your Torn API key can't read <code>/user/bars</code>. Regenerate it in <a class="bh-name-link" href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">Preferences → API Key</a> with <b>Minimal</b> access or higher.</span>`
                : "";
            const energyNowLine = (s.pauseOnLowEnergy && this.hunter.myEnergy)
                ? `<span class="bh-hint">Current energy: <b>${this.hunter.myEnergy.current}/${this.hunter.myEnergy.maximum}</b></span>`
                : "";
            content.innerHTML = `
                <div class="bh-section">
                    <h3>Search</h3>
                    <label class="bh-check"><input type="checkbox" id="bh-set-enabled"${s.searchEnabled ? " checked" : ""}> Bounty search enabled</label>
                    <p class="bh-hint">Master switch for the refresh loop. When off, no automatic Torn/FFScouter calls are made and no toasts fire.</p>
                    <label class="bh-check"><input type="checkbox" id="bh-set-pause-energy"${s.pauseOnLowEnergy ? " checked" : ""}> Pause when energy is below</label>
                    <div class="bh-field" style="max-width:160px;margin-top:4px">
                        <input id="bh-set-min-energy" class="bh-input" type="number" min="0" max="1000" step="1" value="${s.minEnergy}">
                    </div>
                    <p class="bh-hint">Skips the bounties fetch when you can't attack anyway (25 = standard attack cost). Requires a Torn key with <b>Minimal</b> access or higher.</p>
                    ${energyNowLine}
                    ${energyScopeHint}
                    <label class="bh-check" style="margin-top:8px"><input type="checkbox" id="bh-set-pause-hosp"${s.pauseInHospital ? " checked" : ""}> Pause while I'm in hospital</label>
                    <label class="bh-check"><input type="checkbox" id="bh-set-pause-jail"${s.pauseInJail ? " checked" : ""}> Pause while I'm in jail</label>
                    <label class="bh-check"><input type="checkbox" id="bh-set-pause-travel"${s.pauseWhileTraveling ? " checked" : ""}> Pause while I'm travelling</label>
                    <p class="bh-hint">Stops auto-refresh when your own status means you can't attack a bounty. Free — read from your profile, no extra API calls or key scope needed.</p>
                </div>

                <div class="bh-section">
                    <h3>Filters</h3>
                    <div class="bh-grid-2">
                        <div class="bh-field">
                            <label>Min reward ($)</label>
                            <input id="bh-set-price" class="bh-input" type="number" min="0" step="10000" value="${s.minPrice}">
                        </div>
                        <div class="bh-field">
                            <label>Hospital max (minutes remaining)</label>
                            <input id="bh-set-hosp" class="bh-input" type="number" min="0" max="10080" step="1" value="${s.hospitalMaxMin}"${s.hospNoLimit ? " disabled" : ""}>
                            <span class="bh-hint">0 = Okay only. ~5 lets you queue targets about to leave hospital. Up to 10080 (1 week).</span>
                            <label class="bh-check" style="margin-top:4px"><input type="checkbox" id="bh-set-hosp-nolimit"${s.hospNoLimit ? " checked" : ""}> No hospital time limit (include all hospitalised)</label>
                        </div>
                        <div class="bh-field">
                            <label>Fair-fight min</label>
                            <input id="bh-set-ffmin" class="bh-input" type="number" min="1" max="10" step="0.1" value="${s.minFF}">
                        </div>
                        <div class="bh-field">
                            <label>Fair-fight max</label>
                            <input id="bh-set-ffmax" class="bh-input" type="number" min="1" max="10" step="0.1" value="${s.maxFF}">
                        </div>
                    </div>
                    <label class="bh-check" style="margin-top:8px"><input type="checkbox" id="bh-set-samecountry"${s.sameCountryOnly ? " checked" : ""}> Only targets in my country</label>
                    <p class="bh-hint">On (default): hides targets in a different country — only ones you can attack right now. Off: includes different-country and in-transit (travelling/abroad) targets too, marked with a ✈ badge. Those aren't attackable until you're in the same country.</p>
                </div>

                <div class="bh-section">
                    <h3>Refresh</h3>
                    <div class="bh-grid-2">
                        <div class="bh-field">
                            <label>Auto-refresh</label>
                            <select id="bh-set-refresh" class="bh-select">
                                <option value="30"${s.refreshSec === 30 ? " selected" : ""}>Every 30 s</option>
                                <option value="60"${s.refreshSec === 60 ? " selected" : ""}>Every 60 s</option>
                                <option value="120"${s.refreshSec === 120 ? " selected" : ""}>Every 2 min</option>
                                <option value="300"${s.refreshSec === 300 ? " selected" : ""}>Every 5 min</option>
                                <option value="0"${s.refreshSec === 0 ? " selected" : ""}>Off (manual only)</option>
                            </select>
                            <span class="bh-hint">Honors Torn's global bounty-cache delay. 60 s is comfortably under the rate limit.</span>
                        </div>
                        <div class="bh-field">
                            <label>Matches</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-unkff"${s.includeUnknownFF ? " checked" : ""}> Include targets with unknown FF score</label>
                        </div>
                    </div>
                </div>

                <div class="bh-section">
                    <h3>Watchlist (med-out alerts)</h3>
                    <div class="bh-grid-2">
                        <div class="bh-field">
                            <label>Poll interval (seconds)</label>
                            <input id="bh-set-watch-int" class="bh-input" type="number" min="1" max="600" step="1" value="${Math.max(1, Number(s.watchlistIntervalSec) || 5)}">
                            <span class="bh-hint" id="bh-watch-proj-hint"></span>
                        </div>
                        <div class="bh-field">
                            <label>How it works</label>
                            <p class="bh-hint" style="margin-top:6px">Click 👁 on any Hunt row to watch that target. The <b>visible tab</b> polls each watched target's status and pops an alert the moment they leave hospital. A target is auto-removed only when its bounty is gone (claimed/expired). Minimum 1 s — but each target is one request, and Torn caps ~100/min, so watch few or widen the interval. The Hunt tab shows live calls/min.</p>
                        </div>
                    </div>
                </div>

                ${this._renderBlacklistSection()}

                <div class="bh-section">
                    <h3>Maintenance</h3>
                    <button id="bh-reset" class="bh-btn bh-btn-muted">Reset filters to defaults</button>
                </div>
            `;

            const $ = (id) => content.querySelector("#" + id);
            const persistScript = () => {
                const minFF = parseFloat($("bh-set-ffmin").value);
                const maxFF = parseFloat($("bh-set-ffmax").value);
                const cleanMin = Number.isFinite(minFF) ? Math.max(1, minFF) : 1.0;
                const cleanMax = Number.isFinite(maxFF) ? Math.max(cleanMin, maxFF) : cleanMin;
                this.hunter.updateSettings({
                    minPrice: Math.max(0, parseInt($("bh-set-price").value, 10) || 0),
                    hospitalMaxMin: Math.max(0, Math.min(10080, parseInt($("bh-set-hosp").value, 10) || 0)),
                    hospNoLimit: $("bh-set-hosp-nolimit").checked,
                    sameCountryOnly: $("bh-set-samecountry").checked,
                    minFF: cleanMin,
                    maxFF: cleanMax,
                    refreshSec: parseInt($("bh-set-refresh").value, 10),
                    watchlistIntervalSec: Math.max(1, Math.min(600, parseInt($("bh-set-watch-int").value, 10) || 5)),
                    includeUnknownFF: $("bh-set-unkff").checked,
                    searchEnabled: $("bh-set-enabled").checked,
                    pauseOnLowEnergy: $("bh-set-pause-energy").checked,
                    minEnergy: Math.max(0, Math.min(1000, parseInt($("bh-set-min-energy").value, 10) || 0)),
                    pauseInHospital: $("bh-set-pause-hosp").checked,
                    pauseInJail: $("bh-set-pause-jail").checked,
                    pauseWhileTraveling: $("bh-set-pause-travel").checked,
                });
                this._restartLoopFromSettings();
            };
            ["bh-set-price", "bh-set-hosp", "bh-set-hosp-nolimit", "bh-set-samecountry", "bh-set-ffmin", "bh-set-ffmax", "bh-set-refresh", "bh-set-watch-int", "bh-set-unkff",
             "bh-set-enabled", "bh-set-pause-energy", "bh-set-min-energy",
             "bh-set-pause-hosp", "bh-set-pause-jail", "bh-set-pause-travel"]
                .forEach((id) => $(id).addEventListener("change", persistScript));

            // Live projection hint under the watchlist interval input.
            const watchIntEl = $("bh-set-watch-int");
            const projHint = $("bh-watch-proj-hint");
            const updateProjHint = () => {
                const iv = Math.max(1, Math.min(600, parseInt(watchIntEl.value, 10) || 5));
                const k = this.hunter.watchlistCount();
                if (k === 0) { projHint.textContent = "No targets watched yet. Click 👁 on a Hunt row."; return; }
                const proj = projectedWatchCallsPerMin(k, iv);
                projHint.textContent = `${k} watched → ~${proj} calls/min at ${iv}s${proj >= RATE_WARN ? " ⚠ near the ~100/min limit" : ""}.`;
            };
            updateProjHint();
            watchIntEl.addEventListener("input", updateProjHint);

            // Grey out the numeric cap while "no hospital time limit" is on —
            // its value is ignored in that mode.
            $("bh-set-hosp-nolimit").addEventListener("change", (e) => {
                $("bh-set-hosp").disabled = e.target.checked;
            });

            $("bh-reset").addEventListener("click", () => {
                if (!confirm("Reset filters to defaults?")) return;
                // Preserve user-choice toggles AND the blacklist — "reset
                // filters" shouldn't flip the master search switch, silently
                // re-enable toasts, or wipe the user's blacklist.
                const cur = this.hunter.settings;
                this.hunter.updateSettings({
                    ...DEFAULT_SETTINGS,
                    toastsEnabled: cur.toastsEnabled,
                    searchEnabled: cur.searchEnabled,
                    pauseOnLowEnergy: cur.pauseOnLowEnergy,
                    minEnergy: cur.minEnergy,
                    pauseInHospital: cur.pauseInHospital,
                    pauseInJail: cur.pauseInJail,
                    pauseWhileTraveling: cur.pauseWhileTraveling,
                    notifications: cur.notifications,
                });
                this._renderActive();
            });

            this._wireBlacklistSection(content);
        }

        // ── UI/UX tab ──────────────────────────────────────────────────────
        _renderUIUX() {
            const content = this._panel.querySelector("#bh-content");
            const s = this.hunter.settings;
            content.innerHTML = this._renderNotificationsSection(s);

            const $ = (id) => content.querySelector("#" + id);
            const persistUIUX = () => {
                const allowedPositions = new Set(["bottom-right", "bottom-left", "top-right", "top-left"]);
                const posRaw = $("bh-set-notif-pos").value;
                const position = allowedPositions.has(posRaw) ? posRaw : "bottom-right";
                const fieldsObj = {
                    level:     $("bh-set-notif-f-level").checked,
                    reward:    $("bh-set-notif-f-reward").checked,
                    ff:        $("bh-set-notif-f-ff").checked,
                    bs:        $("bh-set-notif-f-bs").checked,
                    status:    $("bh-set-notif-f-status").checked,
                    location:  $("bh-set-notif-f-location").checked,
                    blacklist: $("bh-set-notif-f-blacklist").checked,
                };
                const widthFloor = this._notifWidthFloor(fieldsObj);
                const widthInput = $("bh-set-notif-width");
                widthInput.min = String(widthFloor);
                const widthHint = $("bh-notif-width-hint");
                if (widthHint) widthHint.textContent = `Min ${widthFloor}, max 640. Lower min available when you hide fields.`;
                this.hunter.updateSettings({
                    toastsEnabled: $("bh-set-toasts").checked,
                    notifications: {
                        position,
                        width:      this._clampInt(widthInput.value,                widthFloor, 640, 300),
                        maxVisible: this._clampInt($("bh-set-notif-max").value,              1,  20,   3),
                        timeoutSec: this._clampInt($("bh-set-notif-timeout").value,          3, 120,  15),
                        fields: fieldsObj,
                    },
                });
                this.toaster.applySettings();
            };
            ["bh-set-toasts",
             "bh-set-notif-pos", "bh-set-notif-width", "bh-set-notif-max", "bh-set-notif-timeout",
             "bh-set-notif-f-level", "bh-set-notif-f-reward", "bh-set-notif-f-ff",
             "bh-set-notif-f-bs", "bh-set-notif-f-status", "bh-set-notif-f-location", "bh-set-notif-f-blacklist"]
                .forEach((id) => { const el = $(id); if (el) el.addEventListener("change", persistUIUX); });

            $("bh-notif-preview").addEventListener("click", () => {
                persistUIUX();
                this.toaster.showMany([{
                    target_id: -1,
                    target_name: "Preview Target",
                    target_level: 50,
                    reward: 2_500_000,
                    ff: 2.75,
                    bs: "12.3k",
                    statusState: "Okay",
                    hospUntil: 0,
                    bountyCount: 1,
                    awayFromMe: true,
                    location: "Mexico",
                }]);
            });
        }

        // ── API tab ────────────────────────────────────────────────────────
        _renderAPI() {
            const content = this._panel.querySelector("#bh-content");
            const tornKey = KeyResolver.resolveTornKey() || "";
            const pdaNote = KeyResolver.isPDAKey()
                ? `<p class="bh-hint">Your Torn key is provided by Torn PDA. It is not editable here.</p>`
                : "";
            content.innerHTML = `
                <div class="bh-section">
                    <h3>Torn API key</h3>
                    ${pdaNote}
                    <div class="bh-field">
                        <input id="bh-set-tornkey" class="bh-input bh-input-masked" type="text" maxlength="16" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" value="${escHtml(tornKey)}" ${KeyResolver.isPDAKey() ? "disabled" : ""}>
                    </div>
                    ${!KeyResolver.isPDAKey() ? `
                        <div class="bh-row-actions">
                            <button id="bh-key-save" class="bh-btn bh-btn-primary">Save Torn key</button>
                            <button id="bh-key-clear" class="bh-btn bh-btn-danger">Clear Torn key &amp; log out</button>
                        </div>
                        <div id="bh-key-status" class="bh-save-status"></div>
                    ` : ""}
                </div>

                <div class="bh-section">
                    <h3>FFScouter key</h3>
                    <p class="bh-hint">Used to fetch fair-fight scores in bulk (one call per refresh).</p>
                    <div class="bh-field">
                        <input id="bh-set-ffkey" class="bh-input bh-input-masked" type="text" maxlength="16" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" value="${escHtml(KeyResolver.getFFKey())}">
                    </div>
                    <div class="bh-row-actions">
                        <button id="bh-ffkey-save" class="bh-btn bh-btn-primary">Save FFScouter key</button>
                        <button id="bh-ffkey-clear" class="bh-btn bh-btn-muted">Clear</button>
                    </div>
                    <div id="bh-ffkey-status" class="bh-save-status"></div>
                </div>

                <div class="bh-section">
                    <h3>Debug log</h3>
                    <label class="bh-check">
                        <input type="checkbox" id="bh-set-debug"${isDebugOn() ? " checked" : ""}> Record API requests &amp; rate-limit hits
                    </label>
                    <p class="bh-hint">When on, every Torn / FFScouter request is logged below with its status and latency. Rate-limit hits (Torn code 5, HTTP 429) are highlighted. Use this to confirm whether a slow refresh is rate-limited or just the network.</p>
                    <div id="bh-debug-log" class="bh-debug-log"></div>
                    <div class="bh-row-actions" style="margin-top:6px">
                        <button id="bh-debug-clear" class="bh-btn bh-btn-muted">Clear log</button>
                    </div>
                </div>

                <div class="bh-section">
                    <h3>Environment</h3>
                    <p class="bh-hint">Version ${VERSION} · Platform: ${IS_PDA ? "Torn PDA" : "Desktop"}</p>
                </div>
            `;

            const $ = (id) => content.querySelector("#" + id);
            const setStatus = (elId, kind, msg) => {
                const el = $(elId);
                if (!el) return;
                el.className = "bh-save-status bh-save-" + kind;
                el.textContent = msg;
            };

            if (!KeyResolver.isPDAKey()) {
                $("bh-key-save").addEventListener("click", async () => {
                    const k = $("bh-set-tornkey").value.trim();
                    if (!/^[A-Za-z0-9]{16}$/.test(k)) {
                        setStatus("bh-key-status", "err", "Torn key must be 16 alphanumeric characters.");
                        return;
                    }
                    setStatus("bh-key-status", "info", "Validating…");
                    this.hunter.api.setKey(k);
                    try {
                        await this.hunter.api.validateKey();
                    } catch (e) {
                        setStatus("bh-key-status", "err", "Key rejected: " + (e.message || "invalid"));
                        return;
                    }
                    KeyResolver.saveTornKey(k);
                    this.hunter.myUserId = null;
                    this.hunter.myUserLevel = null;
                    this.hunter.myUserAge = null;
                    setStatus("bh-key-status", "ok", "Saved. Refreshing matches…");
                    await this.hunter.refresh().catch(() => {});
                    setStatus("bh-key-status", "ok", "Saved ✓");
                });
                $("bh-key-clear").addEventListener("click", () => {
                    if (!confirm("Clear the Torn API key and return to the auth screen?")) return;
                    KeyResolver.clearTornKey();
                    this.hunter.stop();
                    this.toaster.clearAll();
                    this.setAuthed(false);
                });
            }
            $("bh-ffkey-save").addEventListener("click", async () => {
                const k = $("bh-set-ffkey").value.trim();
                if (!k) {
                    KeyResolver.clearFFKey();
                    setStatus("bh-ffkey-status", "info", "Cleared.");
                    if (this.hunter.lastCounts) this.hunter.lastCounts.ffError = null;
                    this.hunter.refresh().catch(() => {});
                    return;
                }
                setStatus("bh-ffkey-status", "info", "Validating with FFScouter…");
                const result = await validateFFScouterKey(k);
                if (!result.ok) {
                    setStatus("bh-ffkey-status", "err", result.message);
                    return;
                }
                KeyResolver.saveFFKey(k);
                if (this.hunter.lastCounts) this.hunter.lastCounts.ffError = null;
                setStatus("bh-ffkey-status", "ok", result.message + " Refreshing matches…");
                await this.hunter.refresh().catch(() => {});
                setStatus("bh-ffkey-status", "ok", result.message + " Saved ✓");
            });
            $("bh-ffkey-clear").addEventListener("click", () => {
                KeyResolver.clearFFKey();
                $("bh-set-ffkey").value = "";
                if (this.hunter.lastCounts) this.hunter.lastCounts.ffError = null;
                setStatus("bh-ffkey-status", "info", "Cleared.");
                this.hunter.refresh().catch(() => {});
            });

            // Debug log section — checkbox persists, log area updates live.
            const debugToggle = $("bh-set-debug");
            const debugEl = $("bh-debug-log");
            const renderLog = () => {
                if (!debugEl.isConnected) return;
                if (!isDebugOn()) {
                    debugEl.innerHTML = `<span class="bh-debug-hint">Debug is off. Enable it to start recording.</span>`;
                    return;
                }
                if (debugLog.length === 0) {
                    debugEl.innerHTML = `<span class="bh-debug-hint">No events yet — trigger a refresh from the Hunt tab.</span>`;
                    return;
                }
                const rows = [...debugLog].reverse().map((r) => {
                    const msPart = (r.ms != null) ? ` <span class="bh-debug-ms">${r.ms}ms</span>` : "";
                    return `<div class="bh-debug-row bh-debug-${r.level}"><span class="bh-debug-ts">${r.ts}</span> ${escHtml(r.label)}${msPart}</div>`;
                }).join("");
                debugEl.innerHTML = rows;
            };
            debugToggle.addEventListener("change", () => {
                try { localStorage.setItem(LS.debug, debugToggle.checked ? "1" : ""); } catch {}
                if (!debugToggle.checked) debugLog.length = 0;
                renderLog();
            });
            $("bh-debug-clear").addEventListener("click", () => {
                debugLog.length = 0;
                renderLog();
            });
            const onEntry = () => renderLog();
            debugBus.addEventListener("entry", onEntry);
            const detach = new MutationObserver(() => {
                if (!debugEl.isConnected) {
                    debugBus.removeEventListener("entry", onEntry);
                    detach.disconnect();
                }
            });
            detach.observe(this._panel, { childList: true, subtree: true });
            renderLog();
        }
    }

    // ════════════════════════════════════════════════════════════
    //  Shared footer menu (eugene-torn-scripts userscripts)
    //  — 1 script installed: its icon goes in the footer directly.
    //  — 2+ installed: a single 3-dots menu holds them all and
    //    expands a row above the footer on click.
    //  Idempotent and duplicated verbatim across scripts. The
    //  __eugFooterMenuLoaded guard ensures setup runs once per page.
    // ════════════════════════════════════════════════════════════

    (function setupEugFooterMenu() {
        // Use the page's real window so scripts in different @grant sandboxes
        // share the same registry. SPA (@grant none) and TAT (@grant GM_*)
        // otherwise see isolated `window` objects and can't find each other.
        const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
        if (W.__eugFooterMenuLoaded) return;
        W.__eugFooterMenuLoaded = true;
        W.__eugeneScripts = W.__eugeneScripts || [];

        const ROW_ID = "eug-footer-row";

        function injectCSS() {
            if (document.getElementById("eug-footer-style")) return;
            const style = document.createElement("style");
            style.id = "eug-footer-style";
            style.textContent = `
[data-eug="menu"]{background:linear-gradient(to bottom,#444,#2a2a2a)!important}
[data-eug="menu"]:hover{background:linear-gradient(to bottom,#555,#333)!important}
#${ROW_ID}{display:none;position:fixed;padding:4px;
  background:rgba(20,20,20,0.96);border:1px solid #444;border-radius:6px;
  gap:4px;z-index:2147483647;white-space:nowrap;pointer-events:auto}
#${ROW_ID}.eug-open{display:flex;flex-direction:row}
`;
            document.head.appendChild(style);
        }

        function injectEntryCSS(entry) {
            if (!entry.color) return;
            const id = `eug-color-${entry.id}`;
            const existing = document.getElementById(id);
            const dark = entry.colorDark || "#222";
            const hover = entry.hoverColor || entry.color;
            const css = `
[data-eug-id="${entry.id}"]{background:linear-gradient(to bottom, ${entry.color}, ${dark})!important}
[data-eug-id="${entry.id}"]:hover{background:linear-gradient(to bottom, ${hover}, ${entry.color})!important}
`;
            if (existing) { existing.textContent = css; return; }
            const el = document.createElement("style");
            el.id = id;
            el.textContent = css;
            document.head.appendChild(el);
        }

        function findRefBtn() {
            return document.getElementById("notes_panel_button")
                || document.getElementById("people_panel_button");
        }

        function getRow() { return document.getElementById(ROW_ID); }
        function closeRow() { const r = getRow(); if (r) r.classList.remove("eug-open"); }

        function openRow(menuBtn) {
            const row = getRow();
            if (!row) return;
            const rect = menuBtn.getBoundingClientRect();
            row.classList.add("eug-open");
            const rowRect = row.getBoundingClientRect();
            const gap = 6;
            const centerX = rect.left + rect.width / 2;
            let left = centerX - rowRect.width / 2;
            const maxLeft = window.innerWidth - rowRect.width - 4;
            left = Math.max(4, Math.min(left, maxLeft));
            row.style.left = left + "px";
            row.style.bottom = (window.innerHeight - rect.top + gap) + "px";
        }

        function makeScriptBtn(entry, refBtn, role) {
            const iconClasses = refBtn.querySelector("svg")?.className?.baseVal || "";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = refBtn.className;
            btn.title = entry.name;
            btn.setAttribute("data-eug", role);
            btn.setAttribute("data-eug-id", entry.id);
            const svg = (entry.iconSVG || "").replace(/<svg\b([^>]*)>/, (match, attrs) =>
                /\sclass\s*=/.test(attrs) ? match : `<svg${attrs} class="${iconClasses}">`);
            btn.innerHTML = svg;
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeRow();
                try { entry.onClick(); } catch { /* noop */ }
            });
            injectEntryCSS(entry);
            return btn;
        }

        function makeMenuBtn(refBtn) {
            const iconClasses = refBtn.querySelector("svg")?.className?.baseVal || "";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = refBtn.className;
            btn.title = "My userscripts";
            btn.setAttribute("data-eug", "menu");
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" class="${iconClasses}">
                <defs><linearGradient id="eug_menu_grad" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox">
                    <stop offset="0" stop-color="#ddd"/><stop offset="1" stop-color="#999"/>
                </linearGradient></defs>
                <g fill="url(#eug_menu_grad)">
                    <circle cx="5" cy="12" r="2"/>
                    <circle cx="12" cy="12" r="2"/>
                    <circle cx="19" cy="12" r="2"/>
                </g>
            </svg>`;
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const row = getRow();
                if (row && row.classList.contains("eug-open")) closeRow();
                else openRow(btn);
            });
            return btn;
        }

        // Legacy standalone-button IDs from pre-shared-menu versions.
        // If a user has a mixed install (one script new, one old), the old
        // script creates its own button under one of these IDs. Nuke them
        // so the shared menu stays authoritative. Safe to add new IDs here.
        const LEGACY_BUTTON_IDS = ["tat-footer-btn", "spa-footer-btn"];

        function render() {
            const refBtn = findRefBtn();
            if (!refBtn) return false;
            injectCSS();

            const parent = refBtn.parentNode;
            parent.querySelectorAll('[data-eug]').forEach((el) => el.remove());
            LEGACY_BUTTON_IDS.forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.remove();
            });
            const oldRow = getRow();
            if (oldRow) oldRow.remove();

            const scripts = W.__eugeneScripts || [];
            if (scripts.length === 0) return true;

            if (scripts.length === 1) {
                parent.insertBefore(makeScriptBtn(scripts[0], refBtn, "solo"), refBtn);
            } else {
                const menuBtn = makeMenuBtn(refBtn);
                parent.insertBefore(menuBtn, refBtn);
                const row = document.createElement("div");
                row.id = ROW_ID;
                row.setAttribute("data-eug-row", "");
                for (const s of scripts) row.appendChild(makeScriptBtn(s, refBtn, "item"));
                document.body.appendChild(row);
            }
            return true;
        }

        function mount() {
            render();
            // Torn's SPA swaps the footer DOM on navigation, taking our buttons
            // with it. Keep observing indefinitely and re-render whenever the
            // ref button is back but our buttons are gone. Throttled via rAF.
            let pending = false;
            const obs = new MutationObserver(() => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    const refBtn = findRefBtn();
                    if (refBtn && !refBtn.parentNode.querySelector('[data-eug]')) render();
                });
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }

        W.addEventListener("eugene-scripts-updated", render);
        document.addEventListener("click", (e) => {
            const row = getRow();
            if (!row || !row.classList.contains("eug-open")) return;
            const menuBtn = document.querySelector('[data-eug="menu"]');
            if (menuBtn && menuBtn.contains(e.target)) return;
            if (row.contains(e.target)) return;
            closeRow();
        });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRow(); });
        W.addEventListener("scroll", closeRow, { passive: true });
        W.addEventListener("resize", closeRow);

        W.registerEugeneScript = function (entry) {
            const list = W.__eugeneScripts;
            const i = list.findIndex((s) => s.id === entry.id);
            if (i >= 0) list[i] = entry;
            else list.push(entry);
            W.dispatchEvent(new CustomEvent("eugene-scripts-updated"));
        };
        W.mountEugeneFooterMenu = mount;
    })();

    // ════════════════════════════════════════════════════════════
    //  MAIN
    // ════════════════════════════════════════════════════════════

    const BH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
        <defs><linearGradient id="bh_icon_grad" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox">
            <stop offset="0" stop-color="#ddd"/><stop offset="1" stop-color="#999"/>
        </linearGradient></defs>
        <g fill="url(#bh_icon_grad)">
            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"/>
            <path d="M12 6a6 6 0 1 0 6 6 6 6 0 0 0-6-6Zm0 10a4 4 0 1 1 4-4 4 4 0 0 1-4 4Z"/>
            <circle cx="12" cy="12" r="1.5"/>
            <path d="M11 0h2v5h-2zM11 19h2v5h-2zM0 11h5v2H0zM19 11h5v2h-5z"/>
        </g>
    </svg>`;

    function main() {
        const initialKey = KeyResolver.resolveTornKey();
        const api = new TornAPI(initialKey || "");
        const hunter = new Hunter(api);
        const toaster = new Toaster(() => hunter.settings);
        const ui = new UI(hunter, toaster);

        // Toaster needs a way to reach the UI for its "+N more" card.
        window.__bhUI = ui;

        ui.inject();
        ui.setAuthed(!!initialKey);

        // Cross-tab sync: when another tab writes fresh match data, adopt it
        // here and re-render. The Hunter's own _tick path separately reads
        // the same store on its next cycle to decide whether to skip its
        // own fetch. Settings (searchEnabled, refreshSec, filters, …) are
        // synced via the same storage event but a different key, so
        // toggling search off in one tab actually stops the loop in others.
        window.addEventListener("storage", (e) => {
            if (!e.newValue) return;
            if (e.key === LS.shared) {
                try {
                    const payload = JSON.parse(e.newValue);
                    hunter.adoptSharedPayload(payload);
                } catch { /* ignore malformed writes */ }
            } else if (e.key === LS.settings) {
                try {
                    const next = JSON.parse(e.newValue);
                    if (next && typeof next === "object") {
                        hunter.applyExternalSettings(next);
                        // Cross-tab notification re-positioning: only useful if
                        // the container already exists (i.e. a toast was shown
                        // at least once in this tab); otherwise applySettings
                        // is a no-op and the next showMany picks up the new
                        // values from ensureContainer().
                        toaster.applySettings();
                    }
                } catch { /* ignore malformed writes */ }
            } else if (e.key === LS.blacklist) {
                hunter.applyExternalBlacklist();
            } else if (e.key === LS.watchlist) {
                hunter.applyExternalWatchlist();
            }
        });

        // The visible tab owns watchlist polling. On focus, take over the
        // duty (and adopt anything a sibling added while we were hidden); on
        // blur the running tick self-suspends its requests. Kicking a tick on
        // focus makes the handoff feel instant.
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") hunter.kickWatchIfVisible();
        });

        const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
        W.registerEugeneScript({
            id: "bh",
            name: "Bounty Hunter",
            color: "#b33a3a",
            colorDark: "#6b1f1f",
            hoverColor: "#d64a4a",
            iconSVG: BH_ICON_SVG,
            onClick: () => ui.toggle(true),
        });
        W.mountEugeneFooterMenu();

        if (initialKey) {
            hunter.start();
            // Resume watching any targets carried over from a previous session.
            hunter.ensureWatchLoop();
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", main);
    } else {
        main();
    }
})();
