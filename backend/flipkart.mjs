import { decryptSecret, encryptSecret } from './security.mjs';
import { getEntity, setEntity } from './store.mjs';

const OAUTH_BASE = () => String(process.env.FLIPKART_OAUTH_BASE || 'https://api.flipkart.net/oauth-service').replace(/\/$/, '');
const API_BASE = () => String(process.env.FLIPKART_API_BASE || 'https://api.flipkart.net/sellers').replace(/\/$/, '');
const SCOPE = () => process.env.FLIPKART_SCOPE || 'Seller_Api';

function requireClientCredentials() {
  const id = process.env.FLIPKART_CLIENT_ID;
  const secret = process.env.FLIPKART_CLIENT_SECRET;
  if (!id || !secret) throw new Error('FLIPKART_CLIENT_ID and FLIPKART_CLIENT_SECRET are required for real mode.');
  return { id, secret };
}

function basicAuth(id, secret) {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

export function buildAuthorizationUrl(state) {
  const { id } = requireClientCredentials();
  const redirectUri = `${String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '')}/auth/flipkart/callback`;
  const url = new URL(`${OAUTH_BASE()}/oauth/authorize`);
  url.searchParams.set('client_id', id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE());
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCodeForToken(code, state) {
  const { id, secret } = requireClientCredentials();
  const url = new URL(`${OAUTH_BASE()}/oauth/token`);
  url.searchParams.set('grant_type', 'authorization_code');
  url.searchParams.set('code', code);
  url.searchParams.set('redirect_uri', `${String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '')}/auth/flipkart/callback`);
  url.searchParams.set('state', state);

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: basicAuth(id, secret), Accept: 'application/json' },
  });
  const body = await safeJson(response);
  if (!response.ok) throw new Error(`Flipkart OAuth token exchange failed (${response.status}): ${JSON.stringify(body).slice(0, 1200)}`);
  return normalizeTokenResponse(body);
}

async function refreshConnection(connection) {
  const { id, secret } = requireClientCredentials();
  const refreshToken = decryptSecret(connection.refresh_token_enc);
  const url = new URL(`${OAUTH_BASE()}/oauth/token`);
  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('refresh_token', refreshToken);
  url.searchParams.set('scope', SCOPE());

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: basicAuth(id, secret), Accept: 'application/json' },
  });
  const body = await safeJson(response);
  if (!response.ok) throw new Error(`Flipkart OAuth refresh failed (${response.status}): ${JSON.stringify(body).slice(0, 1200)}`);

  const token = normalizeTokenResponse(body);
  const merged = {
    ...token,
    id: connection.id,
    device_hash: connection.device_hash,
    connected_at: connection.connected_at,
  };
  await setEntity('connections', connection.id, merged);
  return merged;
}

function normalizeTokenResponse(body) {
  if (!body?.access_token) throw new Error('Flipkart token response did not contain access_token.');
  return {
    scope: body.scope || SCOPE(),
    access_token_enc: encryptSecret(body.access_token),
    refresh_token_enc: body.refresh_token ? encryptSecret(body.refresh_token) : null,
    access_token_expires_at: Date.now() + Number(body.expires_in || 60 * 24 * 3600) * 1000,
    refresh_token_expires_at: Date.now() + Number(body.refresh_expires_in || 180 * 24 * 3600) * 1000,
  };
}

async function getConnection(connectionId) {
  const connection = await getEntity('connections', connectionId);
  if (!connection) throw new Error('Flipkart connection not found.');
  return connection;
}

async function ensureAccessToken(connectionId, forceRefresh = false) {
  let connection = await getConnection(connectionId);
  const fiveMinutes = 5 * 60 * 1000;
  if (forceRefresh || connection.access_token_expires_at < Date.now() + fiveMinutes) {
    if (!connection.refresh_token_enc) throw new Error('Flipkart access token is expired and no refresh token is stored. Reconnect the seller account.');
    connection = await refreshConnection(connection);
  }
  return { connection, token: decryptSecret(connection.access_token_enc) };
}

export async function flipkartRequest(connectionId, path, options = {}, retry401 = true) {
  if (process.env.MOCK_FLIPKART === 'true') return mockFlipkartRequest(path, options);

  const maxAttempts = Number(process.env.FLIPKART_MAX_RETRIES || 3);
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const { token } = await ensureAccessToken(connectionId, false);
    const response = await fetch(`${API_BASE()}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    const body = await safeJson(response);

    if (response.status === 401 && retry401) {
      await ensureAccessToken(connectionId, true);
      return flipkartRequest(connectionId, path, options, false);
    }

    const retryable = [429, 500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt === maxAttempts) {
      return { httpStatus: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(retryAfter * 1000, 30000)
      : Math.min(1000 * 2 ** attempt, 15000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error('Flipkart request failed after retries.');
}

export async function createListings(connectionId, payload) {
  return flipkartRequest(connectionId, '/listings/v3', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function findExistingListings(connectionId, searchText) {
  const states = ['ACTIVE', 'INACTIVE', 'READY_FOR_ACTIVATION'];
  const results = [];
  for (const internalState of states) {
    let batchNo = 0;
    while (batchNo < 50) {
      const response = await flipkartRequest(connectionId, '/listings/v3/product/search', {
        method: 'POST',
        body: JSON.stringify({ batchNo, internalState, searchText }),
      });
      if (response.httpStatus !== 200) break;
      const page = response.body?.listingData || [];
      results.push(...page);
      if (page.length < 20) break;
      batchNo += 1;
    }
  }
  return results;
}

async function safeJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function mockFlipkartRequest(path, options) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (path === '/listings/v3' && options.method === 'POST') {
    const payload = JSON.parse(options.body || '{}');
    const response = {};
    for (const [sku] of Object.entries(payload)) {
      if (sku.toUpperCase().includes('FAIL')) {
        response[sku] = { status: 'failure', errors: [{ severity: 'ERROR', code: 90001, description: 'Mock failure for testing.' }] };
      } else {
        response[sku] = { status: 'success', errors: [] };
      }
    }
    return { httpStatus: 200, body: response, headers: {} };
  }
  if (path.includes('/product/search')) {
    return { httpStatus: 200, body: { totalListingsCount: 0, listingData: [] }, headers: {} };
  }
  return { httpStatus: 200, body: {}, headers: {} };
}
