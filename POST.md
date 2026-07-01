# Bounty Hunter — Torn forum post

This is the live forum post content (Tools & Userscripts subforum). Screenshots
are already uploaded to Torn's editor and linked below. All body text is set to
14px minimum; section headers are 16px.

Uploaded screenshots in use:

| Marker | What it shows |
|---|---|
| `https://editor.torn.com/7ab284e6-0699-4017-805a-74d60dc076ef-4192025.png` | Hunt tab with matches |
| `https://editor.torn.com/6c774166-ebf4-4797-8c1e-d1493e5a4d34-4192025.png` | Corner toast on a new match |
| `https://editor.torn.com/cdbeb15b-7280-4a13-83f9-332633cf2b91-4192025.png` | Torn footer with the 🎯 button |

(Settings-tab screenshot intentionally omitted — the tab is being reworked; add one once it's cleaned up.)

---

```html
<p style="text-align: center;">
  <span style="font-size: 22px;"><strong>🎯 Bounty Hunter</strong></span> <br /><span style="font-size: 14px;"
    ><em>Stop scrolling. Start hitting.</em></span
  >
</p>
<p>&nbsp;</p>
<p style="font-size: 14px;">
  The bounty board is a mess &mdash; a thousand targets, most too strong, plenty you <em>can't even attack</em>, and the
  good ones vanish in seconds. This script filters the whole board in real time so you only see bounties
  <em>actually worth taking</em>, and pops a clickable alert the instant a new one appears.
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>📝 Latest updates</strong></span>
</p>
<ul style="font-size: 14px;">
  <li>
    <strong>2026-07-01</strong> &mdash; <strong>Settings rework</strong>: the on/off switch now sits right on the
    <strong>Hunt</strong> tab (▶ Running / ⏸ Paused), and the rest is regrouped into clearer tabs &mdash;
    <strong>Filters</strong>, <strong>Alerts</strong>, <strong>Blacklist</strong>, and <strong>Key</strong>. Less
    clutter, easier to find things.
  </li>
  <li>
    <strong>2026-07-01</strong> &mdash; <strong>Med-out watchlist</strong> (alert when a hospitalised target gets out),
    <strong>presence dots</strong> (🟢/🟠/⚪), and a live <strong>API-call counter</strong>. Fixed toasts not firing on
    the first refresh.
    <em
      >Watchlist inspired by
      <a href="/profiles.php?XID=2396833" target="_blank" rel="noopener">B_Wheezy [2396833]</a>.</em
    >
  </li>
  <li>
    <strong>2026-06-01</strong> &mdash; <strong>Auto-pause</strong> the refresh loop while <em>you're</em> in hospital /
    jail / travelling.
    <em>Idea from <a href="/profiles.php?XID=3972720" target="_blank" rel="noopener">Experiment420 [3972720]</a>.</em>
  </li>
  <li>
    <strong>2026-05-23</strong> &mdash; <strong>Blacklist</strong>, full <strong>notification settings</strong>, and
    Script / UI/UX / API <strong>settings tabs</strong>.
    <em>Ideas from <a href="/profiles.php?XID=1949201" target="_blank" rel="noopener">realmister [1949201]</a>.</em>
  </li>
</ul>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🎯 What it does</strong></span>
</p>
<ul style="font-size: 14px;">
  <li>Pulls the <strong>entire</strong> bounty board, not just the first page</li>
  <li>Filters by <strong>minimum reward</strong> and <strong>fair-fight score</strong> (via FFScouter)</li>
  <li>
    Skips players under <strong>New Player Protection</strong> and targets in a <strong>different country</strong>
  </li>
  <li>
    Keeps near-release <strong>Hospital</strong> targets with a live countdown; one-click <strong>Attack</strong> per
    row
  </li>
  <li>Clickable <strong>toast</strong> the instant a new match appears &mdash; click it, go straight to the fight</li>
  <li><strong>Med-out watchlist</strong>: get alerted the moment a watched hospital target gets out</li>
  <li>
    <strong>Presence dot</strong> per row (🟢 online / 🟠 idle / ⚪ offline) + live <strong>API-call counter</strong>
  </li>
  <li>Sortable columns, &times;N duplicate grouping, desktop <em>and</em> Torn PDA</li>
</ul>
<p>&nbsp;</p>
<blockquote style="font-size: 14px;"><strong>Claim the ones worth claiming.</strong></blockquote>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>📋 Hunt tab</strong></span>
</p>
<p style="font-size: 14px;">
  Live-filtered list: name, level, reward, FF, BS estimate, status, attack button. Click a header to sort. Hit
  <strong>Refresh now</strong> or let it auto-poll.
</p>
<p>
  <a class="full" href="https://editor.torn.com/7ab284e6-0699-4017-805a-74d60dc076ef-4192025.png" rel="page_thread"
    ><img
      src="https://editor.torn.com/7ab284e6-0699-4017-805a-74d60dc076ef-4192025.png"
      alt="7ab284e6-0699-4017-805a-74d60dc076ef-4192025.png"
      width="507"
      height="284"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🔔 Toasts</strong></span>
</p>
<p style="font-size: 14px;">
  New matches pop a card in the page corner &mdash; name, reward, FF, status. Click it to jump to the attack page. Up to
  3 at once on desktop; extras roll into a <strong>+N more</strong> card. Configurable position, size, and count.
</p>
<p>
  <a class="full" href="https://editor.torn.com/6c774166-ebf4-4797-8c1e-d1493e5a4d34-4192025.png" rel="page_thread"
    ><img
      src="https://editor.torn.com/6c774166-ebf4-4797-8c1e-d1493e5a4d34-4192025.png"
      alt="6c774166-ebf4-4797-8c1e-d1493e5a4d34-4192025.png"
      width="224"
      height="414"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>👁 Med-out watchlist</strong></span>
</p>
<p style="font-size: 14px;">
  Target sitting in hospital? Click <strong>👁</strong> on their row. The script polls them on a fast interval (down to
  1s) and alerts you the instant they med out &mdash; the moment the board wouldn't re-notify you. They drop off once
  the bounty is gone or shrinks. Only the tab you're looking at polls, so watch a few, not fifty &mdash; the live API
  counter turns red near Torn's ~100/min limit.
  <em>Inspired by <a href="/profiles.php?XID=2396833" target="_blank" rel="noopener">B_Wheezy [2396833]</a>.</em>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚙️ Settings</strong></span>
</p>
<ul style="font-size: 14px;">
  <li><strong>Hunt</strong> — the ▶ Running / ⏸ Paused switch (pauses the whole script), refresh, and API counter</li>
  <li><strong>Filters</strong> — min reward, FF range, hospital window, reachability (same-country / unknown-FF)</li>
  <li><strong>Alerts</strong> — refresh + watchlist intervals, toast appearance, and an Advanced block for the energy / hospital / jail / travel pauses</li>
  <li><strong>Blacklist</strong> — exclude players (browser-local, copy/paste between devices)</li>
  <li><strong>Key</strong> — Torn + FFScouter keys, debug log</li>
</ul>
<p style="font-size: 14px;">
  Settings were just reworked into these tabs — proper screenshots coming soon.
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚠️ Watch your API budget</strong></span>
</p>
<p style="font-size: 14px;">
  Torn allows <strong>100 calls/min per key</strong>. Each refresh costs ~10 for the board, 1 for FFScouter, and
  <strong>1 per surviving target</strong> &mdash; loose filters + a 30s interval <strong>will</strong> rate-limit you
  (and every other script sharing your key). Keep min reward at <strong>$500k+</strong>, FF around
  <strong>1.0&ndash;3.0</strong>, and stick to the default <strong>60s</strong> refresh unless your match count is tiny.
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚡ Setup &mdash; 60 seconds</strong></span>
</p>
<ol style="font-size: 14px;">
  <li>Install the script (link below)</li>
  <li>Click the 🎯 button in your footer bar</li>
  <li>Paste your <strong>Public</strong> Torn API key (offers to reuse Supply Pack Analyzer's key if installed)</li>
  <li>
    Paste your <strong>FFScouter</strong> key in the <strong>Key</strong> tab &mdash; free at
    <a href="https://ffscouter.com" target="_blank" rel="noopener">ffscouter.com</a>
  </li>
</ol>
<p style="font-size: 14px;">
  <strong>Note:</strong> the footer button only shows on the <strong>new chat (3.0)</strong>. If you're still on the
  <strong>old chat (2.0)</strong>, switch to 3.0 or the button won't appear.
</p>
<p>
  <a href="https://editor.torn.com/cdbeb15b-7280-4a13-83f9-332633cf2b91-4192025.png" target="_blank" rel="noopener"
    ><img
      src="https://editor.torn.com/cdbeb15b-7280-4a13-83f9-332633cf2b91-4192025.png"
      alt="Footer button screenshot"
      width="435"
  /></a>
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>💚 Like it?</strong></span>
</p>
<p style="font-size: 14px;">
  Send a Xanax to <a href="/profiles.php?XID=4192025" target="_blank" rel="noopener">eugene_s [4192025]</a> with
  <strong>"bounty"</strong> or <strong>"hunt"</strong> in the message &mdash; donors get a small dismissable thank-you
  note on the Hunt tab.
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🔒 Privacy</strong></span>
</p>
<p style="font-size: 14px;">
  Your API keys <strong>never leave your browser</strong> &mdash; the script talks straight to
  <code>api.torn.com</code> and <code>ffscouter.com</code>. The only other call sends just your Torn id (no key, no PII)
  to light up the donor thank-you note.
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
  <span style="font-size: 14px;"
    ><em>Works with Tampermonkey, Violentmonkey, or compatible managers. Torn PDA supported.</em> <br /><em
      >Feedback and suggestions welcome &mdash; reply here or message me in-game.</em
    ></span
  >
</p>
```
