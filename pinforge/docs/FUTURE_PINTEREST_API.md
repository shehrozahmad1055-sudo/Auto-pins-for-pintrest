# Future: publish directly with the Pinterest API (v5)

PinForge v1 exports files. Publishing straight to Pinterest needs the official API.

## What's needed
1. A Pinterest developer app (developers.pinterest.com) — approval is required for
   standard access; new apps start with trial access.
2. **OAuth 2.0** — the client secret must stay on a server, so this uses `backend/`:
   - extension opens the authorize URL with `chrome.identity.launchWebAuthFlow`
   - the redirect returns a `code` → backend exchanges it for access + refresh tokens
   - tokens stored encrypted in `pinterest_accounts` (see `schema.sql`)
3. Scopes: `boards:read`, `pins:write` (and `boards:write` to create boards).

## Endpoints to use (verify against current docs before building)
- `GET /v5/boards` — fill the board dropdown with real boards (replace the text list).
- `POST /v5/pins` — create a pin with `board_id`, `title`, `description`, `link`,
  `alt_text`, and `media_source` (`image_base64` or `image_url`).

## Planned changes in this codebase
- `lib/pinterest.js` — calls the backend (`/backend/pinterest.php`), never Pinterest directly.
- `app.js` — "Publish" button per card + "Publish all ready" using the same `runQueue`
  (Pinterest has its own rate limits; keep requests per minute low).
- Item gets `pinterestPinId`, `publishStatus` → shown on the card; record in `published_pins`.
- `manifest.json` — add `"identity"` permission.
