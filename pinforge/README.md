# PinForge — AI Pinterest Pin Writer (Chrome Extension, Manifest V3)

Drop images → Google Gemini writes a Pinterest-ready **SEO title, description,
keywords, alt text and board** for each → PinForge **publishes the pins to your
Pinterest account** through Pinterest's normal Create Pin page, using your own login.
(CSV / Excel / JSON export is still there as a backup.)

## Install (2 minutes)

1. Unzip `pinforge.zip`.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `pinforge` folder (the one with `manifest.json`).
4. Settings opens automatically. Paste a Gemini API key from
   <https://aistudio.google.com/apikey>, click **Test**, then **Save settings**.
5. Click the PinForge toolbar icon → **Open workspace**.

## Using it

**One-time setup**
1. Log in to pinterest.com in the same Chrome.
2. Workspace → **Test Pinterest connection**. It opens Pinterest's Create Pin page and
   shows what it can see. Click **Use these boards in PinForge** so the AI picks only
   from your real boards.
3. Do one test pin with *When a pin is ready* = **Fill the form, I click Publish**.
   Check the form, click Publish yourself. If it all looks right, switch back to
   **PinForge clicks Publish**.

**Daily use**
- **Full auto ON** → just drop images. PinForge writes the text and publishes each pin
  as soon as it is written — it doesn't wait for the whole batch (20–40 s pause between
  pins, max 25 a day by default).
- **Full auto OFF** → one click on **Generate + Publish all** does the same for everything
  in the list. Or use **Generate all** first, review/edit, then **Publish all ready**.
- **Reliable mode (on by default):** PinForge uses Chrome's debugger to upload the image
  and type/click for real — exactly like you doing it, and instant. While it works Chrome
  shows a bar *"PinForge started debugging this browser"* — that's normal, don't press
  Cancel. The image is saved for a moment in Downloads/PinForge-temp and deleted right after.
  If reliable mode is off or cancelled, PinForge falls back to simulated input.
- **Tags:** PinForge first adds the topics Pinterest itself suggests for the image, then
  fills up with the AI keywords.
- **Board:** the pin's board → your fallback board → otherwise the board Pinterest already
  shows (it remembers your last one).
- Each card shows *Not on Pinterest yet / Publishing… / Published (View pin ↗) / Publish failed*.
- Keep the PinForge tab open while publishing. Pinterest opens in a normal tab next to it and stays open — you can watch every field fill in. Works on any laptop or screen size.

**Links** — *One link for all* or *Individual links* (paste one URL per line to fill cards in order).
Every field is editable and auto-saved; "↻ New" rewrites one field.

### How publishing works (and its limits)
Pinterest's official API only publishes *public* pins for apps that Pinterest has reviewed
(new apps get "Trial" access where pins are visible only to you). So PinForge fills in
Pinterest's own Create Pin page in your browser — exactly what you'd do by hand.

- **Account safety:** Pinterest can flag accounts that post too fast or too much. Keep the
  default pacing and daily limit, and post content you own.
- **If Pinterest changes its page**, a step may fail with a clear message (e.g. "Could not
  find the title box"). Run *Test Pinterest connection* → *Copy report*. Fixes can usually
  be made in Settings → Pinterest → *Selector overrides* without updating the extension.
- Tagged topics are best-effort (Pinterest doesn't show that field to every account).

## Folder structure

```
pinforge/
├── manifest.json              Manifest V3: permissions, pages, icons, CSP
├── background/
│   └── service-worker.js      Opens Settings on install, focuses/opens the workspace tab
├── content/
│   └── pinterest.js           Runs on Pinterest's Create Pin page: upload, fill, board, tags, publish
├── app/                       Main workspace (full browser tab)
│   ├── app.html
│   ├── app.css
│   └── app.js                 Upload, queue, cards, editing, preview, export
├── options/                   Settings page
│   ├── options.html
│   ├── options.css
│   └── options.js             API key, model, style, links, limits, proxy, data wipe
├── popup/                     Toolbar popup (stats + buttons)
│   ├── popup.html
│   └── popup.js
├── lib/                       Logic modules (no UI) — easy to test
│   ├── gemini.js              Prompt, request, structured JSON output, retries, errors
│   ├── storage.js             Settings (chrome.storage) + images/results (IndexedDB)
│   ├── image.js               Validate, resize, thumbnail, base64
│   ├── validate.js            Clean/limit text, keywords, URL validation
│   ├── pinterest.js           Opens the Pinterest window, sends pins, pacing, daily limit
│   ├── export.js              CSV, JSON, and a built-in .xlsx writer (backup)
│   └── queue.js               Concurrency + requests-per-minute limiter
├── shared/
│   ├── base.css               Design tokens (light/dark), buttons, forms, toasts
│   └── dom.js                 Safe element builder h(), toast, copy, download, confirm
├── icons/                     16/32/48/128 px
├── backend/                   OPTIONAL PHP proxy so the API key stays on your server
│   ├── proxy.php
│   ├── config.sample.php
│   ├── schema.sql             MySQL tables (usage log + future Pinterest API)
│   └── .htaccess
├── tests/                     Unit tests (Node) + Excel check (Python/openpyxl)
├── docs/
│   ├── TESTING.md             Manual test checklist
│   └── FUTURE_PINTEREST_API.md
└── package.json               Only for `npm test` — Chrome ignores it
```

## How it works

```
Images ──► image.js (resize to 1280px JPEG + 480px thumb) ──► IndexedDB
                                                               │
"Generate" ──► queue.js (N parallel, max X/min) ──► gemini.js ─┤
                     prompt + image ──► Gemini generateContent │  (JSON schema output)
                     ◄── JSON ── validate.sanitizeResult() ◄───┘
Cards (edit, ↻ regenerate field, preview) ──► auto-save ──► export.js ──► CSV/XLSX/JSON
```

- **Why a full tab instead of the popup?** Popups close when you click away — bad for
  bulk jobs. The workspace tab keeps running.
- **Why Gemini calls from the page, not the service worker?** MV3 service workers are
  stopped when idle; long queues are more reliable on a page.
- **Why IndexedDB?** `chrome.storage` is for small data; IndexedDB holds image blobs.
- **Structured output:** Gemini is given a JSON schema (`responseSchema`), so answers
  are clean JSON. `sanitizeResult()` still enforces lengths and types.

## Security

- API key stored only in `chrome.storage.local` (or `session` — "forget when Chrome
  closes"), sent only in the `x-goog-api-key` header to Google, never in URLs, never shown
  in full after saving. Option to remove it any time.
- Strict CSP: `script-src 'self'` — no remote code, no `eval`.
- All AI/user text is inserted with `textContent` (never `innerHTML`) → no XSS.
- Links: only `http(s)`, no `javascript:`, no credentials in URLs.
- CSV export blocks spreadsheet formula injection (`=`, `+`, `@`).
- Permissions: `storage`, `unlimitedStorage`, `scripting`, and the Gemini + pinterest.com hosts.
  PinForge never sees your Pinterest password — it uses the session you're already logged in with.
  A proxy host is requested at runtime only if you configure one.
- For teams/public release, use the PHP proxy so the key never ships to browsers.

## Optional backend (PHP + MySQL)

1. Upload `backend/` to an **HTTPS** host. Copy `config.sample.php` → `config.php`, fill it in.
2. (Optional) run `schema.sql` in MySQL and set the `db` DSN for usage logging.
3. In PinForge Settings → Advanced, set the proxy URL and access token. Chrome will ask
   permission for that domain once.

## Development

```
npm test          # 30 unit tests (validate, gemini, export, queue) + Excel validation
npm install       # one time, for the UI tests
npm run test:ui   # workspace, settings and Pinterest-page smoke tests in jsdom
```

After editing files, click the ↻ reload icon on the extension in `chrome://extensions`
and reload the workspace tab.

Suggested build order if you extend it: `lib/validate.js` → `lib/gemini.js` →
`lib/storage.js` → `lib/image.js` → `lib/queue.js` → `lib/export.js` → `shared/` →
`options/` → `app/` → `popup/` → `background/` → `backend/`.

## Troubleshooting

| Message | Fix |
|---|---|
| "API key is not valid" | Re-copy the key from AI Studio, Test, Save. |
| "Rate limit or quota reached" | Lower *Parallel requests* to 1 and *Requests per minute* to ~8. It retries automatically. |
| "Model not found" | Settings → Load models → pick one. |
| "Not available for this account or region" | Gemini API availability varies by country/account; use a proxy server in a supported region. |
| HEIC images rejected | Export as JPG/PNG first. |
| "Not logged in to Pinterest" | Log in at pinterest.com in this Chrome, then Publish again. |
| "Board … was not found" | Run Test Pinterest connection → Use these boards, or fix the board name on the card. |
| "Could not find the … box" | Pinterest changed its page. Copy the test report and add a selector override. |
| Published but "not confirmed" | Check your Pinterest profile; the pin is usually there. |
