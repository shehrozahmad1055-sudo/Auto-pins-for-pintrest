# PinForge — Testing

## Automated
`npm test` — unit tests for text limits, keyword cleaning, URL validation, prompt building,
Gemini request/response parsing, error mapping, retry/backoff, CSV/JSON/XLSX export
(including formula-injection guard and Unicode), and the rate-limited queue.

## Manual checklist (load unpacked, then go through these)

**Install & settings**
- [ ] Fresh install opens Settings automatically.
- [ ] Wrong key → Test shows "not valid". Right key → "Key works — N models".
- [ ] Load models fills the dropdown. Save → toast "Settings saved".
- [ ] "Forget when Chrome closes": restart Chrome → key is gone, banner shows in workspace.
- [ ] Invalid default link (e.g. `javascript:x`) is rejected with a red message.

**Upload**
- [ ] Drag 20+ images at once → all appear as "Not generated".
- [ ] Click-to-choose and Ctrl+V paste both work.
- [ ] A .heic / .psd / empty file is skipped with a clear message.
- [ ] Transparent PNG thumbnail has a white background.
- [ ] Reload the tab → images and results are still there.

**Generation**
- [ ] "Generate N pins" shows a progress bar; cards switch to "Generating…" then "Ready".
- [ ] Stop halts the queue; unfinished cards return to "Not generated".
- [ ] Set requests/minute to 2 → starts are spaced ~30 s apart.
- [ ] Remove the key mid-way (or use a bad key) → batch stops once with a clear message.
- [ ] Turn Wi-Fi off → card shows a network error; "Retry failed" works after reconnecting.
- [ ] Titles ≤ max length, descriptions ≤ max, keyword count matches settings.
- [ ] Boards from your Settings list are used when provided.

**Editing**
- [ ] Typing in a field updates the counter; over-limit turns red; reload keeps edits.
- [ ] "↻ New" on title changes only the title.
- [ ] Editing keywords re-renders chips; primary keyword chip is highlighted.
- [ ] Individual links: paste 3 URLs → first 3 cards filled; a bad line is reported.
- [ ] "Apply board to all" overrides; empty board field resets to AI suggestions.

**Pinterest publishing**
- [ ] Logged out of Pinterest → Publish shows "not logged in" and the queue stops.
- [ ] Test Pinterest connection: all ✓, real boards listed; "Use these boards" fills Settings.
- [ ] Fill-only mode: Pinterest window shows image, title, description, link, alt text, board filled; nothing posts until you click Publish; card turns "Published".
- [ ] Auto mode, 3 pins: waits 45–90 s between pins, each card gets "View pin ↗" that opens the real pin.
- [ ] Board name that doesn't exist → card says which boards exist.
- [ ] Daily limit 2 → third pin is not published, toast explains why.
- [ ] Full auto ON + drop 2 images → generated and published with no clicks.
- [ ] Close the Pinterest tab mid-run → clear error, nothing stuck in "Publishing…".

**Preview & export**
- [ ] Preview shows image, title, description, domain, board, keywords, alt text.
- [ ] CSV opens correctly in Excel/Google Sheets (Urdu/emoji text intact, commas/quotes OK).
- [ ] Excel (.xlsx) opens in Excel and Google Sheets; header row bold and frozen.
- [ ] JSON contains `count` and every pin.
- [ ] Pinterest preset has: Title, Media URL, Pinterest board, Thumbnail, Description, Link, Publish date, Keywords.

**Security**
- [ ] A notes field containing `<img src=x onerror=alert(1)>` shows as plain text.
- [ ] DevTools → Network: the key appears only in the `x-goog-api-key` header, never in a URL.
- [ ] Dark mode (OS setting) looks right on all pages.
