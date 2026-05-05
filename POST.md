# Bounty Hunter — Torn forum post

Paste the HTML below into a Torn forum post (Tools & Userscripts subforum).

**Before posting, replace every `TODO-SCREENSHOT-*` URL** with a real
`editor.torn.com/...` URL by:

1. Upload the screenshot to Torn's forum-post editor (Add image → Upload).
2. Copy the URL it generates.
3. Replace both the `href` and `src` in the matching `<a>/<img>` block.

Suggested screenshots to capture:

| Marker | What to screenshot |
|---|---|
| `TODO-SCREENSHOT-HUNT` | Hunt tab with a handful of matches (rows + sort arrows visible) |
| `TODO-SCREENSHOT-TOAST` | A corner toast fired on a new match, ideally with the ×N count badge |
| `TODO-SCREENSHOT-FOOTER` | Torn footer showing the 🎯 bounty-hunter button (or the shared 3-dots menu open) |
| `TODO-SCREENSHOT-SETTINGS` | Settings tab with filter fields visible |

---

```html
<p style="text-align: center;">
  <span style="font-size: 22px;"><strong>🎯 Bounty Hunter</strong></span> <br /><span style="font-size: 14px;"
    ><em>Stop scrolling. Start hitting.</em></span
  >
</p>
<p>&nbsp;</p>
<p>
  The bounty board is a dumpster fire. A thousand targets, most of them too strong to touch, plenty of fresh accounts
  you <em>can't even attack</em>, and the good ones get claimed in seconds. I built a script that filters the whole
  board in real time so you only see bounties that are <em>actually yours to take</em> &mdash; and pops a clickable
  alert the instant a new one appears.
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🎯 What it does</strong></span>
</p>
<p>&nbsp;</p>
<ul>
  <li>Pulls the <strong>entire</strong> bounty board, not just the first page</li>
  <li>Filters by <strong>minimum reward</strong> &mdash; skip the pocket change</li>
  <li>Filters by <strong>fair-fight score</strong> (via FFScouter) &mdash; only targets in your league</li>
  <li>
    Auto-skips players under <strong>Torn's New Player Protection</strong> (age &lt; 14d) &mdash; no wasted clicks on
    unattackable newbies
  </li>
  <li>
    Skips targets in a <strong>different country</strong> than you (abroad / foreign hospital) &mdash; they aren't
    reachable from your attack page anyway
  </li>
  <li>Keeps <strong>Hospital</strong> targets about to release, with a <strong>live countdown</strong> on the badge</li>
  <li>One-click <strong>Attack</strong> button on every row</li>
  <li>
    Clickable <strong>toast notifications</strong> in the corner of any Torn page when a new match appears &mdash; click
    the toast, go straight to the fight
  </li>
  <li>
    Sortable columns, duplicate-bounty grouping (<strong>×N</strong> badge), desktop <em>and</em> Torn PDA support
  </li>
</ul>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚔️ Who is this for?</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Bounty hunters who'd rather spend their hospital time planning the next hit than refreshing the board hoping for
  something in range.
</p>
<p>&nbsp;</p>
<blockquote><strong>Claim the ones worth claiming.</strong></blockquote>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>📋 Hunt tab</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Live-filtered bounty list. Target name + level, reward, FF, BS estimate, status, attack button. Click any column
  header to sort. Hit <strong>Refresh now</strong> or let it auto-poll on your chosen interval.
</p>
<p>&nbsp;</p>
<p>
  <a href="TODO-SCREENSHOT-HUNT" target="_blank" rel="noopener"
    ><img src="TODO-SCREENSHOT-HUNT" alt="Hunt tab screenshot" width="600"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🔔 Toast notifications</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Every new match pops a card in the bottom-right of the Torn page. Shows name, level, reward, FF, status. Click
  anywhere on the card &mdash; straight to the attack page. Hover pauses the auto-dismiss. Up to 3 on screen at once
  on desktop (1 on mobile); extras collapse into a <strong>+N more</strong> card that opens the full list.
</p>
<p>&nbsp;</p>
<p>
  <a href="TODO-SCREENSHOT-TOAST" target="_blank" rel="noopener"
    ><img src="TODO-SCREENSHOT-TOAST" alt="Toast notification screenshot" width="400"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚙️ Settings</strong></span>
</p>
<p>&nbsp;</p>
<ul>
  <li>Minimum reward (default $500k)</li>
  <li>Fair-fight min / max (default 1.0&ndash;3.0)</li>
  <li>Hospital window &mdash; show Hospital targets with &le; N minutes left (default 5; 0 = Okay only)</li>
  <li>Auto-refresh interval (30s / 60s / 2m / 5m / off)</li>
  <li>Toast notifications on/off</li>
  <li>Include targets with <strong>unknown FF</strong> score &mdash; handy if you don't have an FFScouter key</li>
  <li>
    <strong>Bounty search</strong> master switch &mdash; freeze the refresh loop without uninstalling
  </li>
  <li>
    <strong>Pause when energy is below N</strong> &mdash; skips fetches when you can't attack anyway. Needs a Torn key
    with <em>Minimal</em> access or higher (Public-only keys see a hint in Settings prompting a regenerate)
  </li>
</ul>
<p>&nbsp;</p>
<p>
  <a href="TODO-SCREENSHOT-SETTINGS" target="_blank" rel="noopener"
    ><img src="TODO-SCREENSHOT-SETTINGS" alt="Settings tab screenshot" width="500"
  /></a>
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚠️ Don't blow your API budget</strong></span>
</p>
<p>&nbsp;</p>
<p>Torn allows <strong>100 API calls per minute per key</strong>. Each refresh costs roughly:</p>
<ul>
  <li>~10 calls to fetch the full bounty board</li>
  <li>1 bulk call to FFScouter</li>
  <li><strong>1 call per FF-surviving target</strong> to check status + age</li>
</ul>
<p>
  That last bit is the one that can bite. Loose filters (very low min reward + wide FF range) can produce
  <em>hundreds</em> of survivors per refresh. Combine that with a 30-second refresh interval and you
  <strong>will</strong> get rate-limited &mdash; which temporarily breaks any other scripts that share your key too.
</p>
<p>&nbsp;</p>
<p><strong>Rule of thumb:</strong></p>
<ul>
  <li>Keep minimum reward at <strong>$500k+</strong> for normal days, <strong>$200k+</strong> if the board is thin</li>
  <li>Keep FF range narrow &mdash; <strong>1.0&ndash;3.0</strong> is the sweet spot for respect</li>
  <li>
    Default <strong>60-second</strong> refresh is plenty. Only drop to 30s if your post-filter match count is in the
    single digits.
  </li>
</ul>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚡ Setup &mdash; 60 seconds</strong></span>
</p>
<p>&nbsp;</p>
<ol>
  <li>Install the script (link below)</li>
  <li>Click the 🎯 button in your footer bar</li>
  <li>
    Paste your <strong>Public</strong> Torn API key (the script offers to reuse Supply Pack Analyzer's key if you have
    it installed)
  </li>
  <li>
    Paste your <strong>FFScouter</strong> key in Settings &mdash; grab one free at
    <a href="https://ffscouter.com" target="_blank" rel="noopener">ffscouter.com</a>
  </li>
</ol>
<p>&nbsp;</p>
<p>
  <a href="TODO-SCREENSHOT-FOOTER" target="_blank" rel="noopener"
    ><img src="TODO-SCREENSHOT-FOOTER" alt="Footer button screenshot" width="435"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>💚 If you like the script</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Building and maintaining this is a labour of love &mdash; and a Xanax now and then keeps it going. If you've enjoyed
  Bounty Hunter and want to say thanks, send a Xanax to
  <a href="https://www.torn.com/profiles.php?XID=4192025" target="_blank" rel="noopener">eugene_s [4192025]</a>
  with the word <strong>"bounty"</strong> or <strong>"hunt"</strong> in the message. Donors will see a small green
  thank-you note on their Hunt tab. Dismissable, no nags.
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🔒 Privacy</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Your API keys <strong>never leave your browser</strong>. The script talks directly to <code>api.torn.com</code> and
  <code>ffscouter.com</code>. On Torn PDA the key is injected by PDA itself and nothing is stored locally.
</p>
<p>&nbsp;</p>
<p>
  The only call to anything else is the donor-status check above &mdash; it sends just your Torn user id (no key, no
  PII) to a small Cloudflare Worker so the thank-you banner can light up. Cached for 6 hours, so a single tab hits the
  worker at most ~4 times a day.
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p style="text-align: center;">
  <span style="font-size: 18px;">
    <strong
      ><a
        href="https://greasyfork.org/scripts/574289-bounty-hunter/code/Bounty%20Hunter.user.js"
        target="_blank"
        rel="noopener"
        >⬇️ Install from Greasyfork</a
      ></strong
    >
  </span>
</p>
<p>&nbsp;</p>
<p style="text-align: center;">
  <em>Works with Tampermonkey, Violentmonkey, or compatible userscript managers. Torn PDA supported.</em> <br /><em
    >Feedback and suggestions welcome &mdash; reply here or message me in-game.</em
  >
</p>
```
