import { API_BASE_URL } from './config.js';

let deviceToken = null;
let dashboardData = null;
const extensionContext = Boolean(globalThis.chrome?.runtime?.id);

const $ = (id) => document.getElementById(id);

async function ensureSession() {
  if (extensionContext) {
    const stored = await chrome.storage.local.get(['deviceToken']);
    if (stored.deviceToken) return (deviceToken = stored.deviceToken);
    const result = await chrome.runtime.sendMessage({ type: 'ensure-session' });
    if (!result.ok) throw new Error(result.error);
    deviceToken = result.deviceToken;
    return deviceToken;
  }

  const storageKey = 'autolisterDeviceToken';
  const storedToken = localStorage.getItem(storageKey);
  if (storedToken) return (deviceToken = storedToken);
  const response = await fetch(`${API_BASE_URL}/api/session`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Session creation failed (${response.status})`);
  localStorage.setItem(storageKey, data.deviceToken);
  deviceToken = data.deviceToken;
  return deviceToken;
}

async function api(path) {
  if (!deviceToken) deviceToken = await ensureSession();
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${deviceToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function load() {
  $('refreshBtn').textContent = 'Refreshing…';
  try {
    dashboardData = await api('/api/dashboard');
    render(dashboardData);
  } catch (e) {
    $('accountLine').textContent = e.message;
    $('connectionBadge').textContent = 'ERROR';
    $('connectionBadge').className = 'badge bad';
  } finally {
    $('refreshBtn').textContent = 'Refresh';
  }
}

function render(data) {
  const s = data.stats;
  $('stats').innerHTML = [
    stat('Products', s.products),
    stat('Published', s.published, 'good'),
    stat('Needs review', s.pending_review, 'review'),
    stat('Approved', s.approved, 'review'),
    stat('Blocked', s.blocked, 'bad'),
    stat('Failed', s.failed, 'bad'),
    stat('Warnings', s.warning, 'warn'),
  ].join('');

  const c = data.connection;
  $('accountLine').textContent = c ? `Flipkart seller connection active · connected ${formatDate(c.connected_at)}` : 'No Flipkart seller account connected';
  $('connectionBadge').textContent = c ? 'CONNECTED' : 'NOT CONNECTED';
  $('connectionBadge').className = `badge ${c ? 'good' : 'bad'}`;
  $('connectionDetails').innerHTML = c
    ? `Provider: <strong>Flipkart</strong><br>Access token expiry: <strong>${formatDate(c.access_token_expires_at)}</strong>`
    : 'Connect a Flipkart seller account from the uploader before publishing.';

  if (data.latest_job) {
    $('latestJobStatus').textContent = data.latest_job.status;
    $('latestJobStatus').className = `badge ${statusClass(data.latest_job.status)}`;
    $('latestJob').innerHTML = `<strong>${escapeHtml(data.latest_job.filename)}</strong><br>${data.latest_job.product_count} product records · ${formatDate(data.latest_job.created_at)}<br>Published ${data.latest_job.counts.published} · Failed ${data.latest_job.counts.failed} · Review ${data.latest_job.counts.review}`;
  }

  renderProducts();
  renderJobs(data.jobs);
  renderProblems(data.problems);
}

function renderProducts() {
  const q = $('search').value.trim().toLowerCase();
  const status = $('statusFilter').value;
  const rows = (dashboardData.products || []).filter((p) => {
    const text = `${p.title || ''} ${p.sku || ''} ${p.product_id || ''} ${p.category || ''}`.toLowerCase();
    return (!q || text.includes(q)) && (status === 'ALL' || p.status === status);
  });
  $('productsBody').innerHTML = rows.map((p) => `<tr>
    <td><div class="product-main">${escapeHtml(p.title || 'Untitled')}</div><span class="sub">${escapeHtml(p.category || 'Uncategorized')} · ${escapeHtml(p.size || 'No size')}</span></td>
    <td>${escapeHtml(p.sku || '—')}</td>
    <td>${escapeHtml(p.product_id || '—')}</td>
    <td><span class="sub">${escapeHtml(p.job_filename || '—')}</span></td>
    <td><span class="badge ${statusClass(p.status)}">${escapeHtml(p.status)}</span></td>
    <td class="issue-count">${p.issue_count || 0}</td>
    <td><button class="open-btn" data-open-job="${escapeHtml(p.job_id)}">Open review</button></td>
  </tr>`).join('');
  $('productEmpty').classList.toggle('hidden', rows.length !== 0);
  document.querySelectorAll('[data-open-job]').forEach((b) => b.addEventListener('click', () => openReview(b.dataset.openJob)));
}

function renderJobs(jobs) {
  $('jobsBody').innerHTML = jobs.map((j) => `<tr>
    <td><div class="product-main">${escapeHtml(j.filename)}</div><span class="sub">${formatDate(j.created_at)}</span></td>
    <td>${j.product_count}</td><td>${j.counts.published}</td><td>${j.counts.review}</td><td>${j.counts.failed}</td>
    <td><button class="open-btn" data-open-job="${escapeHtml(j.id)}">Review</button></td>
  </tr>`).join('');
  $('jobsEmpty').classList.toggle('hidden', jobs.length !== 0);
  document.querySelectorAll('[data-open-job]').forEach((b) => b.addEventListener('click', () => openReview(b.dataset.openJob)));
}

function renderProblems(problems) {
  $('problemCount').textContent = String(problems.length);
  $('problems').innerHTML = problems.slice(0, 30).map((p) => {
    const issue = p.issues?.[0]?.message || p.api_result?.errors?.[0]?.description || `Status: ${p.status}`;
    return `<div class="problem"><div class="problem-title">${escapeHtml(p.title || p.sku || 'Untitled')}</div><div class="problem-meta">${escapeHtml(p.status)} · ${escapeHtml(p.sku || 'No SKU')} · ${escapeHtml(p.job_filename || '')}</div><div class="problem-msg">${escapeHtml(issue)}</div><div style="margin-top:6px"><button class="open-btn" data-open-job="${escapeHtml(p.job_id)}">Fix in review</button></div></div>`;
  }).join('');
  $('problemsEmpty').classList.toggle('hidden', problems.length !== 0);
  document.querySelectorAll('[data-open-job]').forEach((b) => b.addEventListener('click', () => openReview(b.dataset.openJob)));
}

function openReview(jobId) {
  if (extensionContext) chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?job=${encodeURIComponent(jobId)}`) });
  else window.open(`/app?job=${encodeURIComponent(jobId)}`, '_blank', 'noopener');
}

function stat(name, value, kind = '') { return `<div class="stat"><div class="num">${value}</div><div class="name">${escapeHtml(name)}</div></div>`; }
function statusClass(status) { if (status === 'PUBLISHED') return 'good'; if (['FAILED','BLOCKED'].includes(status)) return 'bad'; if (status === 'WARNING') return 'warn'; if (['APPROVED','REVIEW_REQUIRED'].includes(status)) return 'review'; return ''; }
function formatDate(value) { return value ? new Date(Number(value)).toLocaleString() : '—'; }
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }

$('refreshBtn').addEventListener('click', load);
$('openUploader').addEventListener('click', () => {
  if (extensionContext) chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  else window.location.href = '/app';
});
$('search').addEventListener('input', renderProducts);
$('statusFilter').addEventListener('change', renderProducts);

ensureSession().then(load).catch((e) => { $('accountLine').textContent = e.message; });
