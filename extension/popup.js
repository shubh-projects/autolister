import { API_BASE_URL } from './config.js';

let deviceToken = null;
let currentJobId = null;
let currentJob = null;
const extensionContext = Boolean(globalThis.chrome?.runtime?.id);

const $ = (id) => document.getElementById(id);

async function init() {
  deviceToken = await ensureDeviceToken();
  if (!extensionContext) document.body.classList.add('web-app');
  await refreshConnection();
  const jobFromUrl = new URLSearchParams(location.search).get('job');
  if (jobFromUrl) { currentJobId = jobFromUrl; await loadJob(jobFromUrl); }
}

async function ensureDeviceToken() {
  if (deviceToken) return deviceToken;
  if (extensionContext) {
    const stored = await chrome.storage.local.get(['deviceToken']);
    if (stored.deviceToken) return (deviceToken = stored.deviceToken);
    const result = await chrome.runtime.sendMessage({ type: 'ensure-session' });
    if (!result.ok) throw new Error(result.error);
    return (deviceToken = result.deviceToken);
  }

  const storageKey = 'autolisterDeviceToken';
  const storedToken = localStorage.getItem(storageKey);
  if (storedToken) return (deviceToken = storedToken);
  const response = await fetch(`${API_BASE_URL}/api/session`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Session creation failed (${response.status})`);
  localStorage.setItem(storageKey, data.deviceToken);
  return (deviceToken = data.deviceToken);
}

async function api(path, options = {}) {
  await ensureDeviceToken();
  const headers = { Authorization: `Bearer ${deviceToken}`, ...(options.headers || {}) };
  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function refreshConnection() {
  const data = await api('/api/me');
  if (data.connection) {
    $('connectionText').textContent = 'Connected ✓';
    $('connectionText').style.color = '#087443';
    $('connectBtn').textContent = 'Reconnect';
  } else {
    $('connectionText').textContent = 'Not connected';
    $('connectionText').style.color = '#b42318';
  }
}

$('dashboardBtn').addEventListener('click', () => {
  if (extensionContext) {
    const dashboardPath = location.pathname.includes('/extension/') ? 'extension/dashboard.html' : 'dashboard.html';
    chrome.tabs.create({ url: chrome.runtime.getURL(dashboardPath) });
  } else {
    window.open('/dashboard', '_blank', 'noopener');
  }
});

$('connectBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/auth/flipkart/start');
    if (data.url) {
      if (extensionContext) chrome.tabs.create({ url: data.url });
      else window.open(data.url, '_blank', 'noopener');
      $('connectionText').textContent = 'Authorization opened — return here after approval.';
    } else {
      await refreshConnection();
      $('connectionText').textContent = 'Mock Flipkart connected ✓';
      $('connectionText').style.color = '#087443';
    }
  } catch (e) { setStatus('uploadStatus', e.message, true); }
});

$('analyzeBtn').addEventListener('click', async () => {
  const file = $('file').files?.[0];
  if (!file) return setStatus('uploadStatus', 'Choose a PDF, DOCX, TXT, MD or CSV first.', true);
  
  // Capture the selected marketplaces
  const selectedPlatforms = Array.from(document.querySelectorAll('input[name="platforms"]:checked')).map(cb => cb.value);
  if (selectedPlatforms.length === 0) return setStatus('uploadStatus', 'Select at least one marketplace destination.', true);

  const form = new FormData();
  form.append('file', file);
  form.append('platforms', JSON.stringify(selectedPlatforms)); // Send platform array to Node backend

  try {
    setStatus('uploadStatus', `Extracting document + running AI analysis for ${selectedPlatforms.join(', ')}…`);
    const data = await api('/api/jobs/upload', { method: 'POST', body: form });
    currentJobId = data.jobId;
    await loadJob(currentJobId);
    setStatus('uploadStatus', `Analyzed ${data.product_count} product records. Review every record before approving.`, false, true);
  } catch (e) { setStatus('uploadStatus', e.message, true); }
});

$('selectValidBtn').addEventListener('click', () => {
  if (!currentJob) return;
  document.querySelectorAll('input[data-approve]').forEach((el) => {
    const index = Number(el.dataset.approve);
    el.checked = Boolean(currentJob.products[index]?.validation?.valid && currentJob.products[index]?.status !== 'PUBLISHED');
  });
});

$('approveSelectedBtn').addEventListener('click', async () => {
  if (!currentJob) return;
  const indexes = [...document.querySelectorAll('input[data-approve]:checked')].map((el) => Number(el.dataset.approve));
  if (!indexes.length) return setStatus('publishStatus', 'Select at least one product to approve.', true);
  try {
    currentJob = await api(`/api/jobs/${currentJobId}/approve`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ indexes }) });
    renderJob(currentJob);
    setStatus('publishStatus', 'Selected products were evaluated. Only valid products are approved.', false, true);
  } catch (e) { setStatus('publishStatus', e.message, true); }
});

$('publishBtn').addEventListener('click', async () => {
  if (!currentJobId) return;
  const approved = currentJob?.products?.filter((p) => p.approval_status === 'APPROVED' && p.status !== 'PUBLISHED') || [];
  if (!approved.length) return setStatus('publishStatus', 'Nothing is approved and waiting for publication.', true);
  const ok = confirm(`Publish ${approved.length} approved product(s) to the selected marketplaces?`);
  if (!ok) return;
  try {
    setStatus('publishStatus', 'Publishing only explicitly approved + valid products…');
    currentJob = await api(`/api/jobs/${currentJobId}/publish`, { method: 'POST' });
    renderJob(currentJob);
    setStatus('publishStatus', 'Publish run finished. Review every per-SKU result below.', false, true);
  } catch (e) { setStatus('publishStatus', e.message, true); }
});

async function loadJob(jobId) {
  currentJob = await api(`/api/jobs/${jobId}`);
  $('reviewSection').classList.remove('hidden');
  renderJob(currentJob);
}

function renderJob(job) {
  $('jobMeta').textContent = `${job.filename} · ${job.product_count} records · ${job.source_method}`;
  $('products').innerHTML = job.products.map((p, index) => productHtml(p, index)).join('');
  document.querySelectorAll('[data-save]').forEach((btn) => btn.addEventListener('click', () => saveProduct(Number(btn.dataset.save))));
  document.querySelectorAll('[data-search-map]').forEach((btn) => btn.addEventListener('click', () => searchMapping(Number(btn.dataset.searchMap))));
  document.querySelectorAll('[data-use-fsn]').forEach((btn) => btn.addEventListener('click', () => useFsn(Number(btn.dataset.index), btn.dataset.fsn)));
}

function productHtml(p, index) {
  const issues = p.validation?.issues || [];
  const badgeClass = ['PUBLISHED','APPROVED'].includes(p.status) ? 'good' : (p.validation?.valid ? 'good' : 'bad');
  const badgeText = p.status || (p.validation?.valid ? 'VALID' : 'BLOCKED');
  const loc = p.locations?.[0] || {};
  const pkg = p.packages?.[0] || {};
  const dims = pkg.dimensions || {};
  const addr = p.address_label || {};
  const shipping = p.shipping || {};
  const fees = p.shipping_fees || {};

  return `<article class="product">
    <div class="product-top">
      <div>
        <div class="product-title">${escapeHtml(p.title || 'Untitled product')}</div>
        <div class="small">Record ${index + 1}</div>
      </div>
      <label class="check-wrap"><input type="checkbox" data-approve="${index}" ${p.validation?.valid && p.status !== 'PUBLISHED' ? '' : 'disabled'} ${p.approval_status === 'APPROVED' ? 'checked' : ''}> Approve</label>
      <div class="badge ${badgeClass}">${escapeHtml(badgeText)}</div>
    </div>
    <div class="source">Source: ${escapeHtml(p.source_excerpt || 'No source excerpt')}</div>
    <div class="editor">
      ${inputField('product_id','Flipkart FSN / product_id',p.product_id)}
      <div class="field wide"><label>Marketplace mapping</label><button type="button" class="secondary" data-search-map="${index}">Find matching seller listing</button><div id="map-results-${index}" class="mapping-results"></div></div>
      ${inputField('sku','Seller SKU',p.sku)}
      ${inputField('title','Title',p.title,'wide')}
      ${inputField('brand','Brand',p.brand)}
      ${inputField('category','Category',p.category)}
      ${inputField('size','Size',p.size)}
      ${inputField('color','Color',p.color)}
      ${inputField('mrp','MRP',p.mrp,'', 'number')}
      ${inputField('selling_price','Selling price',p.selling_price,'', 'number')}
      ${inputField('hsn','HSN',p.hsn)}
      ${inputField('tax_code','Flipkart tax code',p.tax_code)}
      ${selectField('listing_status','Listing status',p.listing_status,['ACTIVE','INACTIVE'])}
      ${selectField('fulfillment_profile','Fulfillment profile',p.fulfillment_profile,['NON_FBF','FBF_LITE','FBF','FBF_AND_FBF_LITE','FBF_AND_NON_FBF'])}
      ${selectField('shipping_provider','Shipping provider',shipping.shipping_provider,['FLIPKART','SELLER','FLIPKART_SELLER'])}
      ${selectField('procurement_type','Procurement type',shipping.procurement_type,['REGULAR','EXPRESS','INTERNATIONAL','MADE_TO_ORDER','DOMESTIC'])}
      ${inputField('dispatch_sla','Dispatch SLA (days)',shipping.dispatch_sla,'','number')}
      ${inputField('location_id','Seller location ID',loc.id)}
      ${selectField('location_status','Location status',loc.status,['ENABLED','DISABLED'])}
      ${inputField('inventory','Inventory',loc.inventory,'','number')}
      ${inputField('manufacturer','Manufacturer name/address',addr.manufacturer_details?.[0],'wide')}
      ${inputField('packer','Packer name/address',addr.packer_details?.[0],'wide')}
      ${inputField('importer','Importer name/address',addr.importer_details?.[0],'wide')}
      ${inputField('origin','Country of origin (ISO-2)',addr.countries_of_origin?.[0])}
      ${inputField('package_name','Package name',pkg.name)}
      ${inputField('package_length','Length (cm)',dims.length,'','number')}
      ${inputField('package_breadth','Breadth (cm)',dims.breadth,'','number')}
      ${inputField('package_height','Height (cm)',dims.height,'','number')}
      ${inputField('package_weight','Weight (kg)',pkg.weight,'','number')}
      ${inputField('fee_local','Local shipping fee',fees.local,'','number')}
      ${inputField('fee_zonal','Zonal shipping fee',fees.zonal,'','number')}
      ${inputField('fee_national','National shipping fee',fees.national,'','number')}
      ${inputField('description','Description',p.description,'wide','textarea')}
    </div>
    ${issues.length ? `<ul class="error-list">${issues.map((i) => `<li>${escapeHtml(i.field)} — ${escapeHtml(i.message)}</li>`).join('')}</ul>` : '<div class="small" style="margin-top:8px">Validation passed. Review source excerpt and marketplace identifiers before approval.</div>'}
    <div class="save-row"><button class="save-btn" data-save="${index}">Save & revalidate</button></div>
  </article>`;
}

function inputField(name, label, value, cls = '', type = 'text') {
  const safe = value == null ? '' : value;
  if (type === 'textarea') return `<div class="field ${cls}"><label>${escapeHtml(label)}</label><textarea data-field="${name}" data-index-field="1">${escapeHtml(safe)}</textarea></div>`;
  return `<div class="field ${cls}"><label>${escapeHtml(label)}</label><input data-field="${name}" data-index-field="1" type="${type}" value="${escapeHtml(safe)}"></div>`;
}

function selectField(name, label, value, options) {
  return `<div class="field"><label>${escapeHtml(label)}</label><select data-field="${name}" data-index-field="1"><option value="">— Missing —</option>${options.map((o) => `<option value="${escapeHtml(o)}" ${o === value ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></div>`;
}

async function searchMapping(index) {
  const product = currentJob?.products?.[index];
  if (!product) return;
  const q = product.title || product.sku || product.source_excerpt || '';
  const host = $(`map-results-${index}`);
  host.textContent = 'Searching the connected seller account…';
  try {
    const data = await api(`/api/flipkart/listings/search?q=${encodeURIComponent(q.slice(0, 120))}`);
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      host.textContent = 'No matching existing seller listing was returned. A new FSN cannot be invented by this system.';
      return;
    }
    host.innerHTML = results.slice(0, 10).map((r) => `
      <div class="mapping-item">
        <div><strong>${escapeHtml(r.product_name || 'Unnamed')}</strong><span>${escapeHtml(r.productId || '')} · ${escapeHtml(r.sku || '')} · ${escapeHtml(r.status || '')}</span></div>
        <button type="button" class="secondary" data-use-fsn="1" data-index="${index}" data-fsn="${escapeHtml(r.productId || '')}" ${r.productId ? '' : 'disabled'}>Use FSN</button>
      </div>`).join('');
    host.querySelectorAll('[data-use-fsn]').forEach((btn) => btn.addEventListener('click', () => useFsn(Number(btn.dataset.index), btn.dataset.fsn)));
  } catch (e) {
    host.textContent = e.message;
  }
}

function useFsn(index, fsn) {
  if (!fsn) return;
  const input = document.querySelectorAll('.product')[index]?.querySelector('[data-field="product_id"]');
  if (input) {
    input.value = fsn;
    setStatus('publishStatus', `FSN ${fsn} inserted into record ${index + 1}. Save & revalidate before approval.`, false, true);
  }
}

async function saveProduct(index) {
  const card = document.querySelectorAll('.product')[index];
  if (!card) return;
  const product = structuredClone(currentJob.products[index]);
  const get = (name) => card.querySelector(`[data-field="${name}"]`)?.value ?? '';
  const str = (name) => get(name).trim() || null;
  const num = (name) => { const v = get(name).trim(); return v === '' ? null : Number(v); };

  product.product_id = str('product_id');
  product.sku = str('sku');
  product.title = str('title');
  product.brand = str('brand');
  product.category = str('category');
  product.size = str('size');
  product.color = str('color');
  product.mrp = num('mrp');
  product.selling_price = num('selling_price');
  product.hsn = str('hsn');
  product.tax_code = str('tax_code');
  product.listing_status = str('listing_status');
  product.fulfillment_profile = str('fulfillment_profile');
  product.shipping = {
    ...product.shipping,
    shipping_provider: str('shipping_provider'),
    procurement_type: str('procurement_type'),
    dispatch_sla: num('dispatch_sla'),
  };

  const loc = { ...(product.locations?.[0] || {}), id: str('location_id'), status: str('location_status'), inventory: num('inventory') };
  product.locations = [loc];

  const manufacturer = str('manufacturer');
  const packer = str('packer');
  const importer = str('importer');
  const origin = str('origin');
  product.address_label = {
    ...(product.address_label || {}),
    manufacturer_details: manufacturer ? [manufacturer] : [],
    packer_details: packer ? [packer] : [],
    importer_details: importer ? [importer] : [],
    countries_of_origin: origin ? [origin] : [],
  };

  const packageName = str('package_name');
  const length = num('package_length');
  const breadth = num('package_breadth');
  const height = num('package_height');
  const weight = num('package_weight');
  product.packages = packageName || length != null || breadth != null || height != null || weight != null
    ? [{ ...(product.packages?.[0] || {}), name: packageName, dimensions: length != null || breadth != null || height != null ? { length, breadth, height } : null, weight }]
    : [];

  const fl = num('fee_local');
  const fz = num('fee_zonal');
  const fn = num('fee_national');
  product.shipping_fees = fl != null || fz != null || fn != null ? { local: fl, zonal: fz, national: fn } : null;
  product.description = str('description');

  try {
    const result = await api(`/api/jobs/${currentJobId}/products/${index}`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(product)
    });
    currentJob.products[index] = result.product;
    renderJob(currentJob);
    setStatus('publishStatus', `Record ${index + 1} saved and revalidated.`, false, result.product.validation.valid);
  } catch (e) { setStatus('publishStatus', e.message, true); }
}

function setStatus(id, text, error = false, success = false) {
  const el = $(id); el.textContent = text; el.className = `status${error ? ' error' : success ? ' success' : ''}`;
}
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }

init().catch((e) => setStatus('uploadStatus', e.message, true));
