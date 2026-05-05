// ==UserScript==
// @name         Bounty Hunter
// @namespace    https://github.com/eugene-torn-scripts/bounty-hunter
// @version      1.6.0
// @description  Live Torn bounty board filter — min reward, FFScouter fair-fight range, Okay/Hospital status — with clickable attack toasts. Desktop + Torn PDA.
// @author       lannav
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// @connect      ffscouter.com
// @connect      *.workers.dev
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

    const VERSION = "1.6.0";
    const LS = {
        apiKey:    "bh_apiKey",
        ffKey:     "bh_ffscouterKey",
        settings:  "bh_settings",
        shared:    "bh_shared",      // cross-tab: last refresh result (matches + metadata)
        debug:     "bh_debug",       // "1" when the debug log is on; undefined/"" otherwise
        donorCache:"bh_donorCache",  // { userId, donor, lastDonationTs, fetchedAt } — 6h client cache
        donorAck:  "bh_donorAck",    // unix-ts of last donation the user dismissed the banner for
    };
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
        refreshSec: 60,
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

    const TOAST_TIMEOUT_MS = 15_000;
    const TOAST_MAX_VISIBLE_DESKTOP = 3;
    const TOAST_MAX_VISIBLE_MOBILE = 1;
    const MOBILE_MEDIA = "(max-width: 768px)";
    function toastMaxVisible() {
        try { return window.matchMedia(MOBILE_MEDIA).matches ? TOAST_MAX_VISIBLE_MOBILE : TOAST_MAX_VISIBLE_DESKTOP; }
        catch { return TOAST_MAX_VISIBLE_DESKTOP; }
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
            return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
        } catch { return { ...DEFAULT_SETTINGS }; }
    }

    function saveSettings(s) {
        localStorage.setItem(LS.settings, JSON.stringify(s));
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
            // /profile includes status + age + level + faction_id in one call,
            // which we need to filter out Torn's new-account protection window.
            const data = await this._get(`/user/${id}/profile`);
            return data.profile || null;
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

        async fetchStatus(userId) {
            if (!userId) return null;
            if (this._inflight) return this._inflight;
            const url = `${DONOR_API_BASE}/donor?id=${encodeURIComponent(userId)}&script=bounty`;
            this._inflight = (async () => {
                try {
                    const r = await fetch(url, { method: "GET", credentials: "omit", cache: "default" });
                    if (!r.ok) return null;
                    const d = await r.json();
                    const status = {
                        userId,
                        donor: !!d.donor,
                        lastDonationTs: Number(d.lastDonationTs) || 0,
                        fetchedAt: Date.now(),
                    };
                    this._writeCache(status);
                    return status;
                } catch { return null; }
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
            this.myUserId = null;
            this.myUserLevel = null;
            this.myUserAge = null;      // days since our own signup — drives NPP rule
            this.myCountry = null;      // "Torn" | "<country>" | null — drives country filter
            this.lastMatches = [];      // last render's rows
            this.lastMatchIds = new Set();
            this.lastCounts = null;     // { total, afterBasic, afterFF, withFF, ffNull, ffError, statusBreakdown }
            this._statusCache = new Map(); // id → { data, fetchedAt }
            this._timer = null;
            this._running = false;
            this._nextAt = 0;
            this.lastError = null;
            this.myEnergy = null;       // { current, maximum } when pauseOnLowEnergy is on + call succeeded
            this.lastEnergyError = null; // "scope" | "error" | null — drives the settings-panel hint
            this.pausedReason = null;   // "disabled" | "low-energy" | null — drives the Hunt-tab banner
            this.onUpdate = null;       // ui sets this
            this.onToast = null;        // toaster sets this
        }

        updateSettings(next) {
            this.settings = { ...this.settings, ...next };
            saveSettings(this.settings);
            // Reset diff memory so tightening/loosening filters doesn't spam toasts
            // with everything, nor suppress legitimate new matches.
            this.lastMatchIds = new Set();
            // Invalidate the cross-tab cache — its matches were computed with the
            // previous filters, so neither this tab nor its siblings should reuse it.
            try { localStorage.removeItem(LS.shared); } catch { /* noop */ }
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
        // lastMatches/lastMatchIds. Shared by the real-refresh path and the
        // cross-tab free-ride path.
        _applyMatches(matches) {
            const matchKey = (m) => `${m.target_id}|${m.reward}`;
            const currentIds = new Set(matches.map(matchKey));
            const newOnes = matches.filter((m) => !this.lastMatchIds.has(matchKey(m)));
            if (this.settings.toastsEnabled && this.onToast && newOnes.length > 0) {
                this.onToast(newOnes);
            }
            this.lastMatches = matches;
            this.lastMatchIds = currentIds;
        }

        // Called by the `storage` event listener when another tab writes new
        // shared data. Updates our in-memory state + re-renders via onUpdate.
        adoptSharedPayload(s) {
            if (!s) return;
            this._adoptSharedIdentity(s);
            if (Array.isArray(s.matches)) {
                this.lastCounts = s.lastCounts || null;
                this._applyMatches(s.matches);
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
                // Cross-tab free-ride: if another tab refreshed recently under
                // the same settings, reuse its result instead of burning our
                // own API budget. Keeps N-tab users at ~1× call cost.
                const shared = this._readShared();
                const fresh = shared
                    && (Date.now() - shared.writtenAt) < (this.settings.refreshSec * 1000 * SHARED_FRESH_RATIO);
                if (fresh) {
                    logDebug(`free-ride: reusing fresh result from another tab (${shared.matches ? shared.matches.length : 0} matches)`, "info");
                    this._adoptSharedIdentity(shared);
                    this.lastCounts = shared.lastCounts || null;
                    this.lastError = null;
                    this._applyMatches(shared.matches || []);
                    if (this.onUpdate) this.onUpdate();
                } else {
                    const delaySec = await this.refresh();
                    waitSec = Math.max(this.settings.refreshSec, delaySec || 0);
                }
            } catch (err) {
                this.lastError = err;
                if (isRateLimitError(err)) {
                    logDebug(`refresh aborted — rate limit; keeping ${this.lastMatches.length} prior matches on screen`, "err");
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
                }
            } catch { /* non-fatal — keep previous identity/country */ }

            // Energy gate — skip the (expensive) bounties fetch when the
            // player can't attack anyway. Opt-in; needs a Minimal+ key.
            // Failures here never block bounty hunting — we just drop the
            // gate for this cycle and surface a hint in the settings panel.
            if (this.settings.pauseOnLowEnergy && this.settings.minEnergy > 0) {
                try {
                    const bars = await this.api.fetchBars();
                    const energy = bars && bars.energy;
                    if (energy && typeof energy.current === "number") {
                        this.myEnergy = { current: energy.current, maximum: energy.maximum };
                        this.lastEnergyError = null;
                        if (energy.current < this.settings.minEnergy) {
                            this.pausedReason = "low-energy";
                            logDebug(`paused — energy ${energy.current}/${energy.maximum} < ${this.settings.minEnergy}; skipping bounty fetch`, "info");
                            if (this.onUpdate) this.onUpdate({ loading: false });
                            return 0;
                        }
                    }
                } catch (e) {
                    // Torn code 16 = scope too low; treat anything else as
                    // a transient error. Either way, don't block hunting.
                    this.lastEnergyError = (e && e.tornCode === 16) ? "scope" : "error";
                    logDebug(`bars fetch failed (${e && e.tornCode ? "code " + e.tornCode : "network"}): ${e && e.message || "error"}`, "err");
                }
            } else {
                this.myEnergy = null;
                this.lastEnergyError = null;
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

            // 1) Price + self filter. Age-based "new-account" filter happens
            // later (in step 3) since target age requires a per-user profile
            // fetch anyway.
            const byBasic = dedupedBounties.filter((b) =>
                b.reward >= this.settings.minPrice
                && (this.myUserId == null || b.target_id !== this.myUserId)
            );
            counts.afterBasic = byBasic.length;

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
            const profiles = await this._fetchProfiles(byFF.map((b) => Number(b.target_id)));
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
                if (this.myCountry && targetCountry && targetCountry !== this.myCountry) {
                    counts.differentCountry++;
                    continue;
                }
                if (state === "Okay") {
                    matches.push({ ...b, statusState: "Okay", hospUntil: 0 });
                } else if (state === "Hospital" && remaining <= hospWindowSec) {
                    matches.push({ ...b, statusState: "Hospital", hospUntil: until });
                }
            }
            matches.sort((a, b) => b.reward - a.reward);
            counts.matches = matches.length;

            // 4) Diff for toasts + render + cross-tab broadcast.
            this.lastCounts = counts;
            this._applyMatches(matches);
            this._writeShared();
            logDebug(`refresh: done — ${matches.length} matches (of ${counts.total} bounties)`, "ok", performance.now() - refreshStart);
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
                        const profile = await this.api.fetchUserProfile(id);
                        if (profile) {
                            const data = {
                                status: profile.status || null,
                                age: typeof profile.age === "number" ? profile.age : null,
                                faction_id: profile.faction_id || null,
                            };
                            out.set(id, data);
                            this._statusCache.set(id, { data, fetchedAt: Date.now() });
                        }
                    } catch (err) {
                        // Rate-limit: stop all workers and bubble up so the
                        // cycle aborts and prior matches stay on screen.
                        if (isRateLimitError(err)) { rateLimitErr = err; return; }
                        // Other per-target errors: row just won't match this cycle.
                    }
                }
            });
            await Promise.all(workers);
            if (rateLimitErr) throw rateLimitErr;
            return out;
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
        constructor() {
            this.container = null;
            this._cards = []; // { id, el, timer, remaining, enteredAt }
            this._clearAllEl = null;
        }

        ensureContainer() {
            if (this.container && document.body.contains(this.container)) return;
            const c = document.createElement("div");
            c.id = "bh-toasts";
            document.body.appendChild(c);
            this.container = c;
        }

        showMany(bounties) {
            this.ensureContainer();
            // Responsive cap — fewer alerts on phones where screen real estate
            // is scarce; more on desktop. Clear-all / overflow cards don't
            // count toward the bounty slot budget.
            const maxVisible = toastMaxVisible();
            const existingBountyCards = this._cards.filter((c) => !c.isMore && !c.isClearAll).length;
            const slots = Math.max(0, maxVisible - existingBountyCards);
            const toShow = bounties.slice(0, slots);
            const overflow = bounties.length - toShow.length;
            for (const b of toShow) this._showOne(b);
            if (overflow > 0) this._showMoreCard(overflow);
            this._updateClearAllButton();
        }

        _showOne(b) {
            const el = document.createElement("div");
            el.className = "bh-toast";
            const isHosp = b.statusState === "Hospital";
            const statusLabel = isHosp ? fmt.hospLabel(b.hospUntil) : "Okay";
            const statusClass = isHosp ? "bh-badge-hosp" : "bh-badge-ok";
            const hospAttr = isHosp ? ` data-hosp-until="${b.hospUntil}"` : "";
            const countBadge = b.bountyCount > 1
                ? ` <span class="bh-count">×${b.bountyCount}</span>`
                : "";
            el.innerHTML = `
                <button class="bh-toast-close" title="Dismiss">&times;</button>
                <div class="bh-toast-head">
                    <div class="bh-toast-name">${escHtml(b.target_name)} <span class="bh-toast-lvl">L${b.target_level}</span>${countBadge}</div>
                    <div class="bh-toast-reward">${escHtml(fmt.money(b.reward))}</div>
                </div>
                <div class="bh-toast-meta">
                    <span class="bh-chip">FF ${b.ff == null ? "?" : b.ff.toFixed(2)}</span>
                    ${b.bs ? `<span class="bh-chip">BS ${escHtml(b.bs)}</span>` : ""}
                    <span class="bh-chip ${statusClass}"${hospAttr}>${statusLabel}</span>
                </div>
                <button class="bh-toast-attack">Attack →</button>
            `;
            const card = { id: Number(b.target_id), el, timer: null, remaining: TOAST_TIMEOUT_MS, enteredAt: 0, isMore: false };

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
            const card = { id: null, el, timer: null, remaining: TOAST_TIMEOUT_MS, enteredAt: 0, isMore: true, count };
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
.bh-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.bh-badge-ok{background:#1e3a2a;color:#4caf50}
.bh-badge-hosp{background:#3a2a1e;color:#ffb74d}
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

/* Toasts */
#bh-toasts{position:fixed;bottom:16px;right:16px;display:flex;flex-direction:column-reverse;gap:8px;
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
.bh-toast-attack{width:100%;padding:6px 10px;background:#ef5350;color:#fff;border:none;border-radius:4px;
  cursor:pointer;font-weight:600;font-size:12px}
.bh-toast-attack:hover{background:#f44336}
.bh-toast-more{border-left-color:#888;text-align:center}
.bh-toast-more-label{color:#fff;font-weight:700;font-size:16px}
.bh-toast-more-hint{color:#888;font-size:11px;margin-top:2px}
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
  #bh-toasts{left:8px;right:8px;bottom:8px;align-items:stretch}
  .bh-toast{width:auto;padding:14px 12px 12px}
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
                    <div class="bh-tab" data-tab="settings">Settings</div>
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

            // Countdown ticker — updates both the "next refresh in Xs" header
            // and any live hospital-countdown badges (rows + toasts). Ticks
            // every second; toasts live outside the panel so they tick too.
            this._countdownTimer = setInterval(() => {
                if (this._isOpen() && this.activeTab === "hunt") {
                    const el = document.getElementById("bh-countdown");
                    if (el) el.textContent = this.hunter.secondsUntilRefresh() + "s";
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
            if (this.activeTab === "hunt") this._renderHunt();
            else this._renderSettings();
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
            // Rate-limit banner — prominent, actionable. When prior matches
            // exist we keep them on screen; when they don't, the banner fully
            // replaces the misleading "no matches" empty state.
            const rateLimitTitle = rows.length > 0
                ? "Rate limit hit — showing previous results"
                : "Rate limit hit — no results to show";
            const rateLimitLead = rows.length > 0
                ? `Torn / FFScouter returned a rate-limit response while processing ${c && c.total != null ? c.total + " " : ""}bounties. The table below is from the last successful refresh and may be slightly stale.`
                : `Torn / FFScouter returned a rate-limit response before any matches could be confirmed this cycle. No table is shown because no successful refresh has completed yet.`;
            const rateLimitBanner = rateLimited
                ? `
                    <div class="bh-rl-banner">
                        <div class="bh-rl-title">${rateLimitTitle}</div>
                        <div class="bh-rl-body">
                            ${rateLimitLead}
                            <br><br>
                            <b>To reduce API load, tighten your filters so fewer targets need a per-profile lookup:</b>
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
            // Paused banner — either the master toggle is off, or energy is
            // below the configured threshold. Stays above the table so the
            // "why hasn't this refreshed?" question is answered at a glance.
            const pausedBanner = this.hunter.pausedReason === "low-energy" && this.hunter.myEnergy
                ? `<div class="bh-paused-banner">⏸ Paused — energy <b>${this.hunter.myEnergy.current}/${this.hunter.myEnergy.maximum}</b> (below ${this.hunter.settings.minEnergy}). Auto-refresh resumes when you recover enough to attack.</div>`
                : this.hunter.pausedReason === "disabled"
                    ? `<div class="bh-paused-banner">⏸ Search disabled — turn it back on in Settings to resume auto-refresh.</div>`
                    : "";
            content.innerHTML = `
                <div id="bh-donor-host"></div>
                <div id="bh-status-line">
                    <button id="bh-refresh-btn" class="bh-btn-muted">Refresh now</button>
                    <span>Next refresh in <span id="bh-countdown">${nextIn}</span>s</span>
                    <span>${rows.length} match${rows.length === 1 ? "" : "es"}</span>
                    ${errLine}
                    ${ffKeyMissing}
                    ${ffError}
                </div>
                ${pausedBanner}
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
            const userId = this.hunter.myUserId;
            // Without our own user id we can't ask the worker about ourselves,
            // and the banner has nothing to say about a stranger.
            if (!userId) { host.innerHTML = ""; return; }

            const paint = (status) => {
                if (!host.isConnected) return; // tab swapped before fetch resolved
                if (!DonorClient.shouldShow(status)) {
                    host.innerHTML = "";
                    return;
                }
                host.innerHTML = `
                    <div class="bh-donor-banner">
                        💚 <b>Thank you for your Xanax donation</b> — I really appreciate your support! It keeps the script alive.
                        <button class="bh-donor-dismiss" title="Dismiss">&times;</button>
                    </div>
                `;
                host.querySelector(".bh-donor-dismiss").addEventListener("click", () => {
                    DonorClient.dismiss(status.lastDonationTs);
                    host.innerHTML = "";
                });
            };

            const cached = DonorClient.cachedStatus(userId);
            if (cached) {
                paint(cached);
                return;
            }
            // Cache miss → fire-and-forget. Keep the host empty until the
            // fetch resolves so we never flash an empty banner shell.
            DonorClient.fetchStatus(userId).then(paint);
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

        _renderRow(b) {
            const statusClass = b.statusState === "Hospital" ? "bh-badge-hosp" : "bh-badge-ok";
            const hospAttr = b.statusState === "Hospital" ? ` data-hosp-until="${b.hospUntil}"` : "";
            const statusText = b.statusState === "Hospital" ? fmt.hospLabel(b.hospUntil) : "Okay";
            const ffCell = b.ff == null ? "—" : b.ff.toFixed(2);
            const countBadge = b.bountyCount > 1
                ? ` <span class="bh-count">×${b.bountyCount}</span>`
                : "";
            return `
                <tr>
                    <td>
                        <a class="bh-name-link" href="${PROFILE_URL}${b.target_id}" target="_blank" rel="noopener">${escHtml(b.target_name)}</a>
                        <span style="color:#666;font-size:11px"> L${b.target_level}</span>${countBadge}
                    </td>
                    <td class="num">${escHtml(fmt.moneyFull(b.reward))}</td>
                    <td class="num">${ffCell}</td>
                    <td class="num bh-col-divider">${escHtml(b.bs || "—")}</td>
                    <td class="bh-col-divider"><span class="bh-badge ${statusClass}"${hospAttr}>${statusText}</span></td>
                    <td><button class="bh-attack" data-id="${b.target_id}">Attack →</button></td>
                </tr>
            `;
        }

        _renderSettings() {
            const content = this._panel.querySelector("#bh-content");
            const s = this.hunter.settings;
            const tornKey = KeyResolver.resolveTornKey() || "";
            const pdaNote = KeyResolver.isPDAKey()
                ? `<p class="bh-hint">Your Torn key is provided by Torn PDA. It is not editable here.</p>`
                : "";
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
                            <input id="bh-set-hosp" class="bh-input" type="number" min="0" max="60" step="1" value="${s.hospitalMaxMin}">
                            <span class="bh-hint">0 = Okay only. ~5 lets you queue targets about to leave hospital.</span>
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
                            <label>Notifications</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-toasts"${s.toastsEnabled ? " checked" : ""}> Show toast for new matches</label>
                            <label class="bh-check"><input type="checkbox" id="bh-set-unkff"${s.includeUnknownFF ? " checked" : ""}> Include targets with unknown FF score</label>
                        </div>
                    </div>
                </div>

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
                    <button id="bh-reset" class="bh-btn bh-btn-muted">Reset filters to defaults</button>
                </div>
            `;

            const $ = (id) => content.querySelector("#" + id);
            const persistFilters = () => {
                const minFF = parseFloat($("bh-set-ffmin").value);
                const maxFF = parseFloat($("bh-set-ffmax").value);
                const cleanMin = Number.isFinite(minFF) ? Math.max(1, minFF) : 1.0;
                const cleanMax = Number.isFinite(maxFF) ? Math.max(cleanMin, maxFF) : cleanMin;
                this.hunter.updateSettings({
                    minPrice: Math.max(0, parseInt($("bh-set-price").value, 10) || 0),
                    hospitalMaxMin: Math.max(0, Math.min(60, parseInt($("bh-set-hosp").value, 10) || 0)),
                    minFF: cleanMin,
                    maxFF: cleanMax,
                    refreshSec: parseInt($("bh-set-refresh").value, 10),
                    toastsEnabled: $("bh-set-toasts").checked,
                    includeUnknownFF: $("bh-set-unkff").checked,
                    searchEnabled: $("bh-set-enabled").checked,
                    pauseOnLowEnergy: $("bh-set-pause-energy").checked,
                    minEnergy: Math.max(0, Math.min(1000, parseInt($("bh-set-min-energy").value, 10) || 0)),
                });
                // Stop unconditionally, then let start() self-gate on
                // searchEnabled + refreshSec. Handles all four transitions
                // (on→on, on→off, off→on, off→off) with one code path.
                this.hunter.stop();
                if (this.hunter.settings.searchEnabled && this.hunter.settings.refreshSec > 0) {
                    this.hunter.start();
                } else if (!this.hunter.settings.searchEnabled) {
                    this.hunter.pausedReason = "disabled";
                } else {
                    this.hunter.pausedReason = null;
                }
            };
            ["bh-set-price", "bh-set-hosp", "bh-set-ffmin", "bh-set-ffmax", "bh-set-refresh", "bh-set-toasts", "bh-set-unkff",
             "bh-set-enabled", "bh-set-pause-energy", "bh-set-min-energy"]
                .forEach((id) => $(id).addEventListener("change", persistFilters));

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
                    // Drop stale error so Hunt tab doesn't display a ghost message.
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
                // Clear any "no_key" / "Invalid API key" error left over from the
                // previous refresh, so tab-switching to Hunt before the new
                // refresh lands doesn't show a ghost FFScouter error.
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
            $("bh-reset").addEventListener("click", () => {
                if (!confirm("Reset filters to defaults?")) return;
                // Preserve user-choice toggles — "reset filters" shouldn't
                // flip the master search switch or silently re-enable toasts.
                const s = this.hunter.settings;
                this.hunter.updateSettings({
                    ...DEFAULT_SETTINGS,
                    toastsEnabled: s.toastsEnabled,
                    searchEnabled: s.searchEnabled,
                    pauseOnLowEnergy: s.pauseOnLowEnergy,
                    minEnergy: s.minEnergy,
                });
                this._renderActive();
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
            // Live updates: subscribe once per render, and clean up when the
            // node goes away (next settings re-render replaces the container).
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
        const toaster = new Toaster();
        const ui = new UI(hunter, toaster);

        // Toaster needs a way to reach the UI for its "+N more" card.
        window.__bhUI = ui;

        ui.inject();
        ui.setAuthed(!!initialKey);

        // Cross-tab sync: when another tab writes fresh match data, adopt it
        // here and re-render. The Hunter's own _tick path separately reads
        // the same store on its next cycle to decide whether to skip its
        // own fetch.
        window.addEventListener("storage", (e) => {
            if (e.key !== LS.shared || !e.newValue) return;
            try {
                const payload = JSON.parse(e.newValue);
                hunter.adoptSharedPayload(payload);
            } catch { /* ignore malformed writes */ }
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

        if (initialKey) hunter.start();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", main);
    } else {
        main();
    }
})();
