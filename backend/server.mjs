import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 1. Core Services
import { randomToken, hashToken, encryptSecret } from './security.mjs';
import { readDb, updateDb, getEntity, setEntity } from './store.mjs';
import { extractDocument } from './document.mjs';
import { extractProductsWithAI } from './ai.mjs';
import { validateProduct, validateJobForPublish, toFlipkartPayload, chunk } from './validation.mjs';
import { buildAuthorizationUrl, exchangeCodeForToken, createListings, findExistingListings } from './flipkart.mjs';

// 2. Windows PDF Parse Fix (Lazy Loaded)
try {
  const { DOMMatrix } = await import('@napi-rs/canvas');
  global.DOMMatrix = DOMMatrix;
} catch (err) {
  console.warn('[Server] @napi-rs/canvas optional dependency not installed. Skipping Windows PDF DOMMatrix polyfill.');
}

// 3. Marketplace Adapters
import { FlipkartAdapter } from './adapters/flipkart.mjs';
import { MeeshoAdapter } from './adapters/meesho.mjs';

const adapters = {
  flipkart: new FlipkartAdapter(),
  meesho: new MeeshoAdapter()
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8787);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const EXTENSION_ID = process.env.EXTENSION_ID || '';

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = [
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    ...(EXTENSION_ID ? [`chrome-extension://${EXTENSION_ID}`] : [])
  ];
  const devExtensionOrigin = !EXTENSION_ID && origin.startsWith('chrome-extension://') && process.env.NODE_ENV !== 'production';
  if (!origin || allowed.includes(origin) || devExtensionOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// UI HTML route
app.get('/', (_req, res) => {
  const extensionPath = path.resolve(__dirname, '..', 'extension');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Flipkart AI AutoLister</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #eef2ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(ellipse at 80% 0%, #243c64 0, transparent 42%), #0b1020; }
    .wrap { max-width: 920px; margin: 0 auto; padding: 56px 24px; }
    .eyebrow { color: #83e0c2; font-size: 12px; font-weight: 800; letter-spacing: .18em; }
    .hero { padding: 36px 0 24px; }
    h1 { font-size: clamp(38px, 7vw, 66px); letter-spacing: -.055em; line-height: 1.02; margin: 16px 0; }
    p { color: #b7c3d8; line-height: 1.7; max-width: 650px; }
    .badge { display: inline-flex; align-items: center; gap: 9px; margin-top: 12px; padding: 10px 14px; border: 1px solid #285a4e; background: #12352f; border-radius: 999px; color: #9bf0d5; font-weight: 700; }
    .dot { width: 8px; height: 8px; background: #41d6a0; border-radius: 50%; box-shadow: 0 0 16px #41d6a0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: 22px; }
    .card { padding: 23px; border: 1px solid #26344c; background: #111a2b; border-radius: 18px; }
    .card h2 { font-size: 17px; margin: 0 0 10px; }
    .card p { font-size: 14px; margin: 0 0 17px; }
    .button { display: inline-block; border: 0; cursor: pointer; color: #0b1920; background: #91f0d4; text-decoration: none; font: inherit; font-size: 14px; font-weight: 800; padding: 11px 15px; border-radius: 10px; }
    .button.alt { background: #263852; color: #e7efff; }
    .small { font-size: 12px; color: #9caecc; margin-top: 26px; }
    .path { display: block; overflow-wrap: anywhere; font-size: 12px; color: #d5e0f3; background: #0b1020; padding: 10px; border-radius: 8px; margin: 0 0 12px; }
    .recommended { border-color: #41d6a0; box-shadow: 0 0 0 1px #41d6a0; }
    .status { font-size: 13px; color: #9bf0d5; min-height: 20px; margin: 12px 0 0; }
    .launch { display: inline-block; margin-top: 14px; padding: 15px 22px; border-radius: 12px; background: #91f0d4; color: #0b1920; font-weight: 900; text-decoration: none; }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="eyebrow">LOCAL DEVELOPMENT SERVER</div>
    <section class="hero">
      <h1>Flipkart AI<br>AutoLister</h1>
      <p>Start using the uploader in this browser tab, or open your browser’s extension manager to install/use the toolbar extension.</p>
      <span class="badge"><span class="dot"></span> Backend online · mock Flipkart mode</span>
      <p id="browserNote">Choose Chrome or Edge below.</p>
      <a class="launch" href="/app">Open AutoLister uploader →</a>
    </section>
    <section class="grid">
      <article class="card" data-browser="chrome">
        <h2>Install in Chrome</h2>
        <p>Copy the Chrome extensions address, paste it into the address bar, then enable Developer mode and choose “Load unpacked”.</p>
        <code class="path">${escapeHtml(extensionPath)}</code>
        <button class="button" type="button" data-copy="chrome://extensions">Copy Chrome extensions address</button>
        <button class="button alt" type="button" data-copy="${escapeHtml(extensionPath)}">Copy extension folder path</button>
        <p class="status" data-copy-status role="status" aria-live="polite"></p>
      </article>
      <article class="card" data-browser="edge">
        <h2>Install in Microsoft Edge</h2>
        <p>Copy the Edge extensions address, paste it into the address bar, then enable Developer mode and choose “Load unpacked”.</p>
        <code class="path">${escapeHtml(extensionPath)}</code>
        <button class="button" type="button" data-copy="edge://extensions">Copy Edge extensions address</button>
        <button class="button alt" type="button" data-copy="${escapeHtml(extensionPath)}">Copy extension folder path</button>
        <p class="status" data-copy-status role="status" aria-live="polite"></p>
      </article>
      <article class="card">
        <h2>Check backend health</h2>
        <p>The extension uses the local API at <strong>http://localhost:${PORT}</strong>. Test that the API is reachable:</p>
        <button class="button alt" id="healthBtn" type="button">Check backend</button>
        <p class="status" id="healthStatus" role="status" aria-live="polite"></p>
      </article>
    </section>
    <p class="small">For Chrome, Edge, Brave, or Opera, load the extension once from the folder above. Firefox needs a separate build. Real Flipkart publishing requires approved seller API credentials.</p>
  </main>
  <script>
    const userAgent = navigator.userAgent;
    const browser = /Edg\\//.test(userAgent) ? 'edge' : /Chrome\\//.test(userAgent) ? 'chrome' : '';
    const browserNote = document.getElementById('browserNote');
    if (browser) {
      document.querySelector('[data-browser="' + browser + '"]')?.classList.add('recommended');
      browserNote.textContent = 'Detected ' + (browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome') + ' — use the highlighted card, then paste its copied address into the address bar.';
    } else {
      browserNote.textContent = 'Choose the button for the Chromium browser where you want to install the extension.';
    }
    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('.card');
        const status = card.querySelector('[data-copy-status]');
        const value = button.dataset.copy;
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const field = document.createElement('textarea');
          field.value = value;
          field.style.position = 'fixed';
          field.style.opacity = '0';
          document.body.appendChild(field);
          field.select();
          const copied = document.execCommand('copy');
          field.remove();
          if (!copied) {
            status.textContent = 'Copy was blocked by the browser. Select and copy the path shown above.';
            return;
          }
        }
        status.textContent = value.startsWith('chrome://') || value.startsWith('edge://')
          ? 'Address copied. Press Ctrl+L, paste it, and press Enter. Then click Load unpacked.'
          : 'Folder path copied. In the Load unpacked folder picker, paste this path into the address bar and confirm.';
      });
    });
    document.getElementById('healthBtn').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = document.getElementById('healthStatus');
      button.disabled = true;
      button.textContent = 'Checking…';
      try {
        const response = await fetch('/health', { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        status.textContent = result.ok ? 'Backend reachable · mock Flipkart ' + (result.mockFlipkart ? 'enabled.' : 'disabled.') : 'Health check did not pass.';
      } catch (error) {
        status.textContent = 'Backend check failed: ' + error.message;
      } finally {
        button.disabled = false;
        button.textContent = 'Check backend';
      }
    });
  </script>
</body>
</html>`);
});

const extensionDirectory = path.resolve(__dirname, '..', 'extension');
app.get('/app', (req, res) => res.redirect(`/extension/popup.html${req.originalUrl.slice(4)}`));
app.get('/dashboard', (_req, res) => res.redirect('/extension/dashboard.html'));
app.use('/extension', express.static(extensionDirectory, { index: false }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

function authMiddleware(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Missing device authorization token.' });
  req.deviceToken = token;
  req.deviceHash = hashToken(token);
  return next();
}

async function sessionForHash(deviceHash) {
  const db = await readDb();
  return db.sessions[deviceHash] || null;
}

function publicConnection(connection) {
  if (!connection) return null;
  return {
    id: connection.id,
    provider: 'flipkart',
    connected_at: connection.connected_at,
    scope: connection.scope,
    access_token_expires_at: connection.access_token_expires_at,
  };
}

app.get('/health', async (_req, res) => res.json({ ok: true, service: 'flipkart-ai-autolister', mockFlipkart: process.env.MOCK_FLIPKART === 'true' }));

// --- NEW: MOCK MEESHO INTERNAL API ENDPOINT ---
app.post('/api/mock/meesho/catalog', async (req, res) => {
  // Simulate 800ms network delay
  await new Promise(resolve => setTimeout(resolve, 800));
  res.json({
    success: true,
    catalog_id: `MSHO_MOCK_${Math.floor(Math.random() * 100000)}`,
    message: "Catalog uploaded successfully to mock Meesho server."
  });
});

app.post('/api/session', async (_req, res) => {
  const token = randomToken(32);
  const deviceHash = hashToken(token);
  const sessionId = crypto.randomUUID();
  await setEntity('sessions', deviceHash, { id: sessionId, created_at: Date.now() });
  res.json({ deviceToken: token, sessionId });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const session = await sessionForHash(req.deviceHash);
  const connectionId = session?.connection_id;
  const connection = connectionId ? await getEntity('connections', connectionId) : null;
  res.json({ sessionId: session?.id || null, connection: publicConnection(connection) });
});

app.get('/api/auth/flipkart/start', authMiddleware, async (req, res) => {
  const session = await sessionForHash(req.deviceHash);
  if (!session) return res.status(401).json({ error: 'Unknown extension session.' });
  if (process.env.MOCK_FLIPKART === 'true') {
    const connectionId = crypto.randomUUID();
    const fakeAccess = encryptSecret('mock-access-token');
    const fakeRefresh = encryptSecret('mock-refresh-token');
    await setEntity('connections', connectionId, {
      id: connectionId,
      device_hash: req.deviceHash,
      connected_at: Date.now(),
      scope: 'Seller_Api',
      access_token_enc: fakeAccess,
      refresh_token_enc: fakeRefresh,
      access_token_expires_at: Date.now() + 60 * 24 * 3600 * 1000,
      refresh_token_expires_at: Date.now() + 180 * 24 * 3600 * 1000,
      mock: true,
    });
    await updateDb((db) => { db.sessions[req.deviceHash].connection_id = connectionId; });
    return res.json({ mock: true, connected: true });
  }
  if (!process.env.PUBLIC_BASE_URL || !process.env.FLIPKART_CLIENT_ID || !process.env.FLIPKART_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Real Flipkart mode requires PUBLIC_BASE_URL, FLIPKART_CLIENT_ID and FLIPKART_CLIENT_SECRET.' });
  }
  const state = randomToken(32);
  await setEntity('oauthStates', state, { device_hash: req.deviceHash, created_at: Date.now(), expires_at: Date.now() + 10 * 60 * 1000 });
  res.json({ url: buildAuthorizationUrl(state), mock: false });
});

app.get('/auth/flipkart/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  const oauth = state ? await getEntity('oauthStates', state) : null;
  if (!oauth || oauth.expires_at < Date.now()) return res.status(400).send(page('Connection failed', 'The OAuth state is missing or expired. Start the connection again.', true));
  await setEntity('oauthStates', state, null).catch(() => {});
  if (error) return res.status(400).send(page('Connection denied', `${error}: ${errorDescription || ''}`, true));
  if (!code) return res.status(400).send(page('Connection failed', 'Flipkart did not return an authorization code.', true));
  try {
    const token = await exchangeCodeForToken(code, state);
    const connectionId = crypto.randomUUID();
    await setEntity('connections', connectionId, { id: connectionId, device_hash: oauth.device_hash, connected_at: Date.now(), ...token });
    await updateDb((db) => { db.sessions[oauth.device_hash].connection_id = connectionId; });
    res.send(page('Flipkart connected', 'You can close this tab and return to the extension.', false));
  } catch (e) {
    res.status(502).send(page('Flipkart connection failed', e.message, true));
  }
});

// --- UPDATED MULTI-PLATFORM UPLOAD PIPELINE ---
app.post('/api/jobs/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const session = await sessionForHash(req.deviceHash);
  if (!session) return res.status(401).json({ error: 'Unknown extension session.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    // 1. Read platforms checked by the user in the extension popup
    let targetPlatforms = ['flipkart'];
    if (req.body.platforms) {
      try {
        targetPlatforms = JSON.parse(req.body.platforms);
      } catch (e) {
        if (typeof req.body.platforms === 'string') targetPlatforms = req.body.platforms.split(',');
      }
    }

    const extracted = await extractDocument(req.file.buffer, req.file.originalname, req.file.mimetype);
    const universalProducts = await extractProductsWithAI(extracted.text);
    
    // 2. Route the universal data through the selected marketplace adapters
    const allMarketplaceProducts = [];
    for (const platform of targetPlatforms) {
      if (adapters[platform]) {
        const platformProducts = universalProducts.map((p) => adapters[platform].transform(p));
        allMarketplaceProducts.push(...platformProducts);
      }
    }
    
    // 3. Normalize for UI and run validation
    const normalized = allMarketplaceProducts.map((p, idx) => normalizeProduct(p, idx));
    const withValidation = normalized.map((p) => ({
      ...p,
      approval_status: 'PENDING',
      validation: validateProduct(p),
      status: 'REVIEW_REQUIRED',
    }));

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      device_hash: req.deviceHash,
      filename: req.file.originalname,
      created_at: Date.now(),
      source_method: extracted.method,
      product_count: withValidation.length,
      status: 'REVIEW',
      source_text_preview: extracted.text.slice(0, 4000),
      products: withValidation,
    };
    await setEntity('jobs', jobId, job);
    res.json({ jobId, ...summarizeJob(job) });
  } catch (e) {
    console.error(e);
    res.status(422).json({ error: e.message });
  }
});

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  const db = await readDb();
  const jobs = Object.values(db.jobs || {})
    .filter((job) => job.device_hash === req.deviceHash)
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));

  const allProducts = [];
  for (const job of jobs) {
    for (let index = 0; index < (job.products || []).length; index += 1) {
      const product = job.products[index];
      const issues = product.validation?.issues || [];
      allProducts.push({
        id: product.id,
        job_id: job.id,
        job_filename: job.filename,
        created_at: job.created_at,
        product_index: index,
        marketplace: product.marketplace,
        title: product.title,
        sku: product.sku,
        product_id: product.product_id,
        category: product.category,
        size: product.size,
        color: product.color,
        status: product.status || 'REVIEW_REQUIRED',
        approval_status: product.approval_status || 'PENDING',
        validation_valid: Boolean(product.validation?.valid),
        issue_count: issues.length,
        issues: issues.slice(0, 8),
        api_result: product.api_result || null,
        last_attempt_at: product.last_attempt_at || null,
      });
    }
  }

  const count = (status) => allProducts.filter((p) => p.status === status).length;
  const problems = allProducts
    .filter((p) => ['FAILED', 'WARNING', 'BLOCKED', 'REVIEW_REQUIRED'].includes(p.status) || !p.validation_valid)
    .sort((a, b) => Number(b.last_attempt_at || b.created_at || 0) - Number(a.last_attempt_at || a.created_at || 0));

  const latestJob = jobs[0] || null;
  const connectionId = db.sessions?.[req.deviceHash]?.connection_id;
  const connection = connectionId ? db.connections?.[connectionId] : null;

  res.json({
    connection: publicConnection(connection),
    generated_at: Date.now(),
    stats: {
      jobs: jobs.length,
      products: allProducts.length,
      published: count('PUBLISHED'),
      pending_review: count('REVIEW_REQUIRED'),
      approved: count('APPROVED'),
      blocked: count('BLOCKED'),
      failed: count('FAILED'),
      warning: count('WARNING'),
    },
    latest_job: latestJob ? summarizeJob(latestJob) : null,
    jobs: jobs.slice(0, 50).map(summarizeJob),
    products: allProducts.slice(0, 1000),
    problems: problems.slice(0, 250),
  });
});

app.get('/api/jobs/:jobId', authMiddleware, async (req, res) => {
  const job = await getEntity('jobs', req.params.jobId);
  if (!job || job.device_hash !== req.deviceHash) return res.status(404).json({ error: 'Job not found.' });
  res.json(sanitizeJob(job));
});

app.patch('/api/jobs/:jobId/products/:index', authMiddleware, async (req, res) => {
  const job = await getEntity('jobs', req.params.jobId);
  const index = Number(req.params.index);
  if (!job || job.device_hash !== req.deviceHash) return res.status(404).json({ error: 'Job not found.' });
  if (!Number.isInteger(index) || index < 0 || index >= job.products.length) return res.status(400).json({ error: 'Invalid product index.' });
  const allowedFields = new Set([
    'product_id','sku','title','description','brand','category','size','color','mrp','selling_price','hsn','tax_code',
    'listing_status','fulfillment_profile','shipping','shipping_fees','packages','locations','address_label','dating_label'
  ]);
  const updated = { ...job.products[index] };
  for (const [key, value] of Object.entries(req.body || {})) if (allowedFields.has(key)) updated[key] = value;
  updated.validation = validateProduct(updated);
  updated.approval_status = 'PENDING';
  updated.status = 'REVIEW_REQUIRED';
  await updateDb((db) => { db.jobs[job.id].products[index] = updated; db.jobs[job.id].status = 'REVIEW'; });
  res.json({ product: updated });
});

app.post('/api/jobs/:jobId/approve', authMiddleware, async (req, res) => {
  const job = await getEntity('jobs', req.params.jobId);
  if (!job || job.device_hash !== req.deviceHash) return res.status(404).json({ error: 'Job not found.' });
  const indexes = Array.isArray(req.body?.indexes) ? req.body.indexes : [];
  if (!indexes.length) return res.status(400).json({ error: 'No products selected for approval.' });
  await updateDb((db) => {
    for (const i of indexes) {
      if (!Number.isInteger(i) || i < 0 || i >= db.jobs[job.id].products.length) continue;
      const product = db.jobs[job.id].products[i];
      product.approval_status = product.validation.valid ? 'APPROVED' : 'BLOCKED';
      product.status = product.validation.valid ? 'APPROVED' : 'BLOCKED';
    }
    db.jobs[job.id].status = 'READY_TO_PUBLISH';
  });
  res.json(sanitizeJob(await getEntity('jobs', job.id)));
});

// --- UPDATED MULTI-PLATFORM PUBLISHER ---
app.post('/api/jobs/:jobId/publish', authMiddleware, async (req, res) => {
  const job = await getEntity('jobs', req.params.jobId);
  if (!job || job.device_hash !== req.deviceHash) return res.status(404).json({ error: 'Job not found.' });
  
  const approved = job.products.filter((p) => p.approval_status === 'APPROVED' && !['PUBLISHED'].includes(p.status));
  if (!approved.length) return res.status(409).json({ error: 'No approved products to publish.' });
  
  await updateDb((db) => { db.jobs[job.id].status = 'PUBLISHING'; });
  const batchResults = [];

  const flipkartProducts = approved.filter(p => p.marketplace === 'flipkart');
  const meeshoProducts = approved.filter(p => p.marketplace === 'meesho');

  // 1. Publish Flipkart Products
  if (flipkartProducts.length > 0) {
    const session = await sessionForHash(req.deviceHash);
    const connectionId = session?.connection_id;
    if (!connectionId) return res.status(409).json({ error: 'Connect a Flipkart account first to publish Flipkart listings.' });
    
    const validation = validateJobForPublish(flipkartProducts);
    if (!validation.valid) return res.status(409).json({ error: 'Flipkart publish blocked by validation.', errors: validation.errors });

    const batches = chunk(flipkartProducts, 10);
    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      const payload = toFlipkartPayload(batch);
      try {
        const response = await createListings(connectionId, payload);
        const parsed = response.body || {};
        for (const product of batch) {
          const result = parsed[product.sku] || { status: 'failure', errors: [{ severity: 'ERROR', description: 'No per-SKU response.' }] };
          const status = String(result.status || '').toLowerCase();
          await markProductResult(job.id, product.sku, status === 'success' ? 'PUBLISHED' : status === 'warning' ? 'WARNING' : 'FAILED', result);
        }
        batchResults.push({ marketplace: 'flipkart', batch: i + 1, count: batch.length, httpStatus: response.httpStatus, response: parsed });
      } catch (e) {
        for (const product of batch) await markProductResult(job.id, product.sku, 'FAILED', { errors: [{ severity: 'ERROR', description: e.message }] });
        batchResults.push({ marketplace: 'flipkart', batch: i + 1, count: batch.length, error: e.message });
      }
    }
  }

  // 2. Publish Meesho Products (Via Local Mock Endpoint)
  if (meeshoProducts.length > 0) {
    const batches = chunk(meeshoProducts, 10);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        const response = await fetch(`http://localhost:${PORT}/api/mock/meesho/catalog`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ products: batch })
        });
        const result = await response.json();
        
        for (const product of batch) {
          await markProductResult(job.id, product.sku, 'PUBLISHED', { meesho_catalog_id: result.catalog_id, message: result.message });
        }
        batchResults.push({ marketplace: 'meesho', batch: i + 1, count: batch.length, response: result });
      } catch (e) {
        for (const product of batch) await markProductResult(job.id, product.sku, 'FAILED', { errors: [{ severity: 'ERROR', description: e.message }] });
        batchResults.push({ marketplace: 'meesho', batch: i + 1, count: batch.length, error: e.message });
      }
    }
  }

  await updateDb((db) => { db.jobs[job.id].status = 'COMPLETED'; db.jobs[job.id].completed_at = Date.now(); });
  res.json({ ...sanitizeJob(await getEntity('jobs', job.id)), batches: batchResults });
});

app.get('/api/flipkart/listings/search', authMiddleware, async (req, res) => {
  const session = await sessionForHash(req.deviceHash);
  if (!session?.connection_id) return res.status(409).json({ error: 'Connect Flipkart first.' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required.' });
  try {
    const results = await findExistingListings(session.connection_id, q);
    res.json({ results: results.slice(0, 50) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

function normalizeProduct(p, index) {
  const numeric = (v) => (v == null || v === '' ? null : Number(v));
  return {
    id: crypto.randomUUID(),
    marketplace: p.marketplace || 'flipkart',
    product_id: clean(p.product_id),
    sku: clean(p.sku),
    title: clean(p.title),
    description: clean(p.description),
    brand: clean(p.brand),
    category: clean(p.category),
    size: clean(p.size),
    color: clean(p.color),
    mrp: Number.isInteger(numeric(p.mrp)) ? numeric(p.mrp) : null,
    selling_price: Number.isInteger(numeric(p.selling_price)) ? numeric(p.selling_price) : null,
    hsn: clean(p.hsn),
    tax_code: clean(p.tax_code),
    listing_status: p.listing_status || 'INACTIVE',
    fulfillment_profile: clean(p.fulfillment_profile),
    shipping: p.shipping || {
      dispatch_sla: null,
      shipping_provider: null,
      procurement_type: null,
    },
    shipping_fees: p.shipping_fees || null,
    packages: Array.isArray(p.packages) ? p.packages : [],
    locations: Array.isArray(p.locations) ? p.locations : [],
    address_label: p.address_label || { manufacturer_details: [], importer_details: [], packer_details: [], countries_of_origin: [] },
    dating_label: p.dating_label || null,
    source_excerpt: clean(p.source_excerpt),
    ai_source_confidence: Number(p.ai_source_confidence) || 1,

    // NEW: Pass through the Meesho-specific physical attributes and origin
    package_weight_kg: numeric(p.package_weight_kg),
    package_length_cm: numeric(p.package_length_cm),
    package_breadth_cm: numeric(p.package_breadth_cm),
    package_height_cm: numeric(p.package_height_cm),
    country_of_origin: clean(p.country_of_origin)
  };
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function summarizeJob(job) {
  const summary = {
    id: job.id,
    filename: job.filename,
    created_at: job.created_at,
    source_method: job.source_method,
    product_count: job.product_count,
    status: job.status,
    counts: {
      review: job.products.filter((p) => p.status === 'REVIEW_REQUIRED').length,
      approved: job.products.filter((p) => p.status === 'APPROVED').length,
      blocked: job.products.filter((p) => p.status === 'BLOCKED').length,
      published: job.products.filter((p) => p.status === 'PUBLISHED').length,
      failed: job.products.filter((p) => p.status === 'FAILED').length,
    }
  };
  return summary;
}

function sanitizeJob(job) {
  return { ...summarizeJob(job), products: job.products, source_text_preview: job.source_text_preview, completed_at: job.completed_at || null };
}

async function markProductResult(jobId, sku, status, result) {
  await updateDb((db) => {
    const job = db.jobs[jobId];
    const product = job.products.find((p) => p.sku === sku);
    if (!product) return;
    product.status = status;
    product.api_result = result;
    product.last_attempt_at = Date.now();
  });
}

function page(title, message, error) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui;padding:48px;background:#f6f7f9;color:#16181d}main{max-width:650px;margin:auto;background:white;padding:32px;border-radius:18px;box-shadow:0 15px 60px rgba(0,0,0,.08)}h1{margin-top:0}p{color:#555;line-height:1.5}.status{font-weight:700}</style></head><body><main><h1>${escapeHtml(title)}</h1><p class="status">${error ? 'Connection was not completed.' : 'Success.'}</p><p>${escapeHtml(message)}</p></main></body></html>`;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c])); }

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(err?.status || 500).json({ error: err?.message || 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Flipkart AI AutoLister backend listening on http://localhost:${PORT}`);
  console.log(`MOCK_FLIPKART=${process.env.MOCK_FLIPKART === 'true'}`);
});