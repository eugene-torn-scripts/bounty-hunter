# Bounty Hunter

A [Torn City](https://www.torn.com) userscript that surfaces **currently-attackable bounties** — filtered by reward, by fair-fight score (via FFScouter), and by target status — and fires a clickable toast for each new match so you can go straight to attack.

Works on desktop browsers (Tampermonkey / Violentmonkey / Greasemonkey) and inside **Torn PDA**.

---

## What it does

The global bounty board is noisy. Most of the money is on targets you can't beat, or who are already in hospital, jail, or traveling. Bounty Hunter pulls the full board, filters it against your rules, and only keeps bounties that are actually worth your time *right now*.

Every refresh:

1. Fetches the full `/torn/bounties` list (paginated — all active bounties, not just the top 100).
2. Drops anything below your minimum reward.
3. Asks **FFScouter** for fair-fight scores in a single bulk call. Targets with no FF estimate are excluded (you can't assess them, so there's no point hunting them). Targets outside your FF range are excluded.
4. Checks each survivor's current status. Keeps `Okay`, plus `Hospital` with less than *N* minutes remaining (configurable — `0` = strict Okay only).
5. Sorts by reward.
6. Pops a **toast notification** for each newly-matched bounty — click anywhere on the card to jump straight to the claim page.

A panel lists all current matches and auto-refreshes on an interval you pick (honoring Torn's global bounty cache delay, so you never waste a call).

---

## Filters

All configurable in the Settings tab:

| Filter | Default | Notes |
|---|---|---|
| Minimum reward | $500,000 | Ignores petty bounties. |
| Fair-fight min | 1.00 | Don't bother with anything below `1.0` (you'd overkill for no respect). |
| Fair-fight max | 3.00 | Above `~3.0` you're liable to lose the fight. |
| Hospital max minutes | 5 | How close to release to still consider a Hospital target. `0` = Okay only. |
| Auto-refresh interval | 60 s | Respects `bounties_delay` from Torn — no wasted calls. |
| Toast notifications | on | Turn off for silent mode. |

---

## Toasts

When new matches appear, a small card slides in from the bottom-right corner of the Torn page. Each card shows target name + level, reward, FF, BS estimate, and status; clicking anywhere on the card opens the **attack URL** (`page.php?sid=attack&user2ID=<target_id>`) in a new tab. Torn auto-credits the bounty when the target is hospitalised.

- Auto-dismiss after 15 s; **hover pauses the timer**; the `×` button dismisses instantly.
- Up to 5 cards on screen at once. If more than 5 fresh matches appear in one refresh, the 6th and beyond collapse into a single `+N more` card that opens the main panel when clicked.
- Zero permission prompts — toasts are just DOM elements. No native OS notifications.

---

## API keys

You need two:

- **Torn public API key** — read the bounty board, each target's status, your own user ID. Get it at [torn.com → Preferences → API Key](https://www.torn.com/preferences.php#tab=api). "Public" access is enough.
- **FFScouter key** — read fair-fight scores in bulk (one call per refresh, up to 205 IDs). Sign up at [ffscouter.com](https://ffscouter.com). **Without this key, every target is excluded** (no FF → can't filter).

### On Torn PDA

Bounty Hunter reads the shared API key directly from PDA via the `###PDA-APIKEY###` placeholder — you **don't** need to re-paste anything. The FFScouter key still has to be set manually (there's no shared-key hook for third-party services).

### On desktop (with Supply Pack Analyzer already installed)

If you already use [Supply Pack Analyzer](https://github.com/eugene-torn-scripts/supply-pack-analyzer), the auth screen offers a **"Use Supply Pack Analyzer's saved key"** button so you don't have to paste it twice.

---

## Panel

Opened via the footer button (the crimson crosshair icon next to Torn's Notes/People panel). If you have multiple `eugene-torn-scripts` scripts installed, they share a single 3-dots menu in the footer — Bounty Hunter slots in there automatically.

Two tabs:

| Tab | Content |
|---|---|
| **Hunt** | Live table of matching bounties — target, reward, FF, BS estimate, status, big red `Attack →` button per row. Countdown to next refresh. Manual refresh button. |
| **Settings** | All filters, API key management, platform info, reset. |

---

## Privacy

- Your Torn API key and your FFScouter key live in `localStorage` (`bh_apiKey`, `bh_ffscouterKey`) under `torn.com`. They are used only against `api.torn.com` and `ffscouter.com`.
- Inside Torn PDA, the Torn key is provided by PDA and is **not persisted** in `localStorage` — PDA owns it.
- No backend. No server. Nothing is uploaded anywhere.
- Uninstalling the script does not automatically clear `localStorage`. Use **Clear Torn key & log out** in Settings first if you want a clean removal.

---

## Install

### Desktop (Tampermonkey / Violentmonkey / Greasemonkey)

Install from source on GitHub, or from Greasy Fork once published. Point your userscript manager at the raw `bounty-hunter.user.js` and enable it for `torn.com`.

### Torn PDA

Add the script URL under PDA → Settings → Userscripts. The `@match https://www.torn.com/*` directive means it loads on every Torn page.

---

## How it handles rate limits

Torn allows 100 API calls per minute per key. Per refresh, Bounty Hunter makes:

- **1 call** to `/torn/bounties` (plus an extra page if the active board exceeds 100 entries).
- **1 call** to `ffscouter.com/get-stats` — bulk, up to 205 IDs.
- **N calls** to `/user/{id}/basic`, where N = survivors after the FF filter. Status lookups are cached for 20 s across refreshes.

For typical filters (min price $500k, FF 1–3), that's ~10–15 Torn calls per refresh. At a 60-second interval, that's comfortably under 20 % of your per-minute budget.

---

## Development

Single file: [`bounty-hunter.user.js`](bounty-hunter.user.js). Organized top-to-bottom with `═══` section banners: constants → utils → HTTP → `TornAPI` → FFScouter client → `KeyResolver` → `Hunter` (orchestrator) → `Toaster` → CSS → `UI` → shared footer-menu IIFE → main.

To iterate locally: point your userscript manager at a `file://` URL of your checkout and save-reload on `torn.com`.

---

## License

GNU General Public License v3.0 or later — see [`LICENSE`](LICENSE).

In short: free to use, modify, and redistribute, but derivative work must also be GPL-3.0 with source published. Attribution to `lannav` must be retained.
