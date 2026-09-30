const PRODUCT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sku: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          brand: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          category: { type: ['string', 'null'] },
          hsn: { type: ['string', 'null'] },
          size: { type: ['string', 'null'] },
          color: { type: ['string', 'null'] },
          mrp: { type: ['number', 'null'] },
          selling_price: { type: ['number', 'null'] },
          weight: { type: ['number', 'null'] },
          dimensions: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              length: { type: ['number', 'null'] },
              breadth: { type: ['number', 'null'] },
              height: { type: ['number', 'null'] }
            },
            required: ['length', 'breadth', 'height']
          },
          manufacturer_address: { type: ['string', 'null'] },
          source_excerpt: { type: ['string', 'null'] }
        },
        required: [
          'sku', 'title', 'brand', 'description', 'category', 'hsn', 'size', 'color',
          'mrp', 'selling_price', 'weight', 'dimensions', 'manufacturer_address', 'source_excerpt'
        ]
      }
    }
  },
  required: ['products']
};

const SYSTEM_PROMPT = `You are a strict data extraction parser for e-commerce catalogs. Convert seller-provided product documents into a universal structured format.

ABSOLUTE RULES:
1. Extract product details into the universal JSON schema provided.
2. Do NOT hallucinate or invent SKUs, prices, dimensions, weights, or addresses.
3. If a value is absent or ambiguous, return null according to the schema.
4. ONLY extract the physical location for "manufacturer_address". Do NOT put warranty information, return policies, or random text in the address field. If no physical address exists, return null.
5. Split size/color variants into separate records only when the source clearly identifies distinct SKUs or rows.
6. Populate "source_excerpt" with the exact snippet or sentence from the text where you found the main specifications to serve as an audit trail.
7. Do not produce anything outside the JSON schema.
8. Do not use information from outside the supplied document.`;

const DEFAULT_CHUNK_CHARS = 10000;
const OVERLAP_CHARS = 1000;

function splitSource(text, maxChars = DEFAULT_CHUNK_CHARS) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const piece = paragraph.trim();
    if (!piece) continue;
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (piece.length <= maxChars) {
      current = piece;
    } else {
      for (let i = 0; i < piece.length; i += maxChars - OVERLAP_CHARS) {
        chunks.push(piece.slice(Math.max(0, i - (i ? OVERLAP_CHARS : 0)), i + maxChars));
      }
      current = '';
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function identityKey(product) {
  const primary = normalizeKey(product.sku);
  if (primary) return `${primary}|${normalizeKey(product.size)}|${normalizeKey(product.color)}`;
  return `${normalizeKey(product.title)}|${normalizeKey(product.brand)}|${normalizeKey(product.size)}|${normalizeKey(product.color)}`;
}

function richness(product) {
  const json = JSON.stringify(product);
  return (json.match(/"[^"]+":(?!null)/g) || []).length;
}

function mergeProducts(records) {
  const byKey = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const key = identityKey(record);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, record);
      continue;
    }
    const preferred = richness(record) > richness(existing) ? record : existing;
    const other = preferred === record ? existing : record;
    byKey.set(key, deepMergeMissing(preferred, other));
  }
  return [...byKey.values()];
}

function deepMergeMissing(primary, fallback) {
  if (Array.isArray(primary) || Array.isArray(fallback)) {
    return primary?.length ? primary : fallback;
  }
  if (primary && typeof primary === 'object' && fallback && typeof fallback === 'object') {
    const out = { ...primary };
    for (const [key, value] of Object.entries(fallback)) {
      if (out[key] == null || (typeof out[key] === 'string' && !out[key].trim()) || (Array.isArray(out[key]) && !out[key].length)) {
        out[key] = value;
      } else {
        out[key] = deepMergeMissing(out[key], value);
      }
    }
    return out;
  }
  return primary ?? fallback;
}

async function askOllama(sourceText) {
  const baseUrl = String(process.env.AI_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'llama3.1:latest';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 180000));

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { 
          temperature: 0,
          num_ctx: 8192 
        },
        format: PRODUCT_SCHEMA,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Extract ALL product records from this document section. Do not invent missing values. Include every product/variant that is directly present in this section.\n\nDOCUMENT SECTION:\n${sourceText}`
          }
        ]
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama returned HTTP ${response.status}: ${body.slice(0, 1000)}`);
    }

    const data = await response.json();
    const content = data?.message?.content;
    if (!content) throw new Error('Ollama returned no structured message content.');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.products)) throw new Error('AI response did not contain a products array.');
    return parsed.products;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('AI extraction timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractProductsWithAI(sourceText) {
  const provider = process.env.AI_PROVIDER || 'ollama';
  if (provider !== 'ollama') throw new Error(`Unsupported AI_PROVIDER: ${provider}. This build defaults to local Ollama for zero API cost.`);

  const chunks = splitSource(sourceText);
  if (!chunks.length) return [];

  const records = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const extracted = await askOllama(chunks[i]);
    records.push(...extracted);
  }
  return mergeProducts(records);
}

export { PRODUCT_SCHEMA, splitSource, mergeProducts };