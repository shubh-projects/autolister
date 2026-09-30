# Flipkart AI AutoLister — Browser Extension + Backend

This project is a deliberately strict implementation of the workflow:

1. User opens the extension.
2. User connects a Flipkart seller account using Flipkart's third-party OAuth flow.
3. User uploads a PDF/DOCX/TXT/CSV containing product information.
4. Backend extracts the source text.
5. AI converts the document into a strict structured product schema.
6. Deterministic validation checks every product.
7. Optional existing-listing matching uses the seller's current Flipkart listings when the document does not provide an FSN/product_id.
8. Extension shows an editable human-review screen.
9. Only explicitly approved products are publishable.
10. Backend calls Flipkart's official Listing API in batches of 10 SKUs.
11. Every per-SKU success/warning/error is persisted and shown to the user.
12. Tokens are encrypted at rest and refreshed through Flipkart's refresh-token flow.

## What this code does NOT pretend to solve

Flipkart's current Listing API requires a valid Flipkart `product_id` (FSN) when creating a listing. This project therefore refuses to guess a new FSN from a document. If a product cannot be mapped to an existing seller listing, it goes to `NEEDS_PRODUCT_MAPPING` instead of being published.

Also, Flipkart requires a registered third-party application for managing other sellers' accounts. The browser extension is intentionally NOT the place where the client secret or seller refresh token lives. Those stay on the backend.

## Prerequisites

- Node.js 22.x (the project intentionally pins to Node 22 because `pdf-parse` has a reported Node 24/Windows worker issue at the current 2.4.5 release).
- Google Chrome 88+ for Manifest V3.
- Optional but recommended: Ollama for local zero-cost AI.
- A Flipkart seller/partner application when moving from mock mode to real publishing.

## 1. Install

```bash
npm install
```

## 2. Copy environment

```bash
copy .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

Generate the encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in `TOKEN_ENCRYPTION_KEY`.

## 3. Run local AI (zero API cost)

Install Ollama from https://ollama.com/ and then:

```bash
ollama pull qwen3:8b
```

The code uses Ollama structured JSON output support so extraction is schema-constrained rather than free-form text.

## 4. Start backend

```bash
npm start
```

Backend: `http://localhost:8787`

## 5. Load extension (Chrome, Edge, Brave, Opera)

The extension is compatible with Chromium-based browsers, including Microsoft Edge. From the project folder, either load the project root (which has a root `manifest.json`) or load the smaller `extension` folder:

- Chrome: open `chrome://extensions`
- Microsoft Edge: open `edge://extensions`
- Brave: open `brave://extensions`

Enable Developer mode → Load unpacked → select `flipkart-ai-autolister` (the project root) or `flipkart-ai-autolister/extension`.

Open the extension and use the built-in mock connection while developing.

The backend homepage is available at `http://localhost:8787/`; `/health` returns the machine-readable health status. Opening the API root previously returned Express's default “Cannot GET /” because it is an API server rather than a web dashboard.

Firefox does not use this Chromium Manifest V3 package as-is and would need a separate Firefox manifest/build.

## 6. Real Flipkart connection

For third-party access, Flipkart's current documentation requires:

- a verified third-party application;
- a valid HTTPS redirect URL;
- Authorization Code flow with `Seller_Api` scope;
- server-side exchange of the authorization code using the app ID + secret.

For local testing, use a free HTTPS tunnel such as Cloudflare Tunnel and put the HTTPS public URL in `.env` as `PUBLIC_BASE_URL`. Register the callback URL as:

`https://YOUR_PUBLIC_HOST/auth/flipkart/callback`

Then set:

```env
MOCK_FLIPKART=false
FLIPKART_CLIENT_ID=...
FLIPKART_CLIENT_SECRET=...
PUBLIC_BASE_URL=https://YOUR_PUBLIC_HOST
EXTENSION_ID=your-installed-extension-id
```

Restart the backend.

## 7. Production architecture

Browser extension → HTTPS backend → AI/document engine → encrypted token store → Flipkart API.

Do NOT move the Flipkart client secret into the extension.

## Extension configuration

The default extension points at `http://localhost:8787`.

When you deploy the backend, edit `extension/config.js` and set `API_BASE_URL` to your HTTPS backend, then reload the extension.

## Testing

```bash
npm test
npm run check
```

The test suite exercises payload creation, validation, approval gating, chunking, mock API behavior and token encryption.

## Important accuracy boundary

No software can truthfully promise "never requires debugging or changes" when an external marketplace controls credentials, catalog rules, API availability, validation rules, or API versions. This project is intentionally designed to fail closed instead: missing/ambiguous marketplace identifiers become review blockers instead of guessed values.

The currently documented Flipkart listing API requires a `product_id` for the listing request. This project can search the connected seller account's existing listings for a human-selected match, but it does not pretend to create a new marketplace catalog FSN when the current Seller API does not expose that generic catalog-creation operation.

## Real seller flow

The production flow should be:

Browser extension → your HTTPS backend → Flipkart OAuth → encrypted refresh token → document extraction → local/remote structured AI → deterministic validator → human approval → `/listings/v3` in batches of 10 → per-SKU result persistence.

The client secret must remain on the backend. The extension only receives a short-lived device/session token to talk to your backend.

## Current implementation choices

- AI: Ollama locally, default model `qwen3:8b`, JSON-schema constrained output.
- PDF: `pdf-parse`; scanned/low-text PDF fallback uses page screenshots + Tesseract OCR.
- DOCX: Mammoth raw-text extraction.
- Storage: local JSON file for zero-dependency development. Replace with Postgres/Supabase before multi-user production.
- Flipkart: official Seller APIs; mock mode is enabled by default so the complete approval/publish flow can be tested without publishing real listings.


## Account Dashboard (v1.1)

The extension now includes a dedicated `dashboard.html` control center. It is separate from the upload/review popup and reads the authenticated user's stored jobs.

It shows:
- Connected Flipkart account state and token expiry metadata.
- Total product records and counts for published, approved, review-required, blocked, failed, and warning products.
- Search/filter across processed products by title, SKU, FSN/product_id and status.
- Listing-run history with per-run counts.
- A consolidated Problems / Attention Center for review-required, blocked, failed and warning records.
- Deep links from dashboard rows back into the existing review editor for the source job.

The dashboard currently represents listings that this AutoLister has processed and stored. It does not claim to be a complete mirror of every unrelated listing already present in the seller account; that would require a broader marketplace reconciliation/sync design against the applicable Flipkart seller-listing APIs.
