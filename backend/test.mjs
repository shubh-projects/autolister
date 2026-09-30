import assert from 'node:assert/strict';
import { validateProduct, validateJobForPublish, toFlipkartPayload, chunk } from './validation.mjs';
import { randomToken, hashToken, encryptSecret, decryptSecret } from './security.mjs';

process.env.TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const good = {
  product_id: 'AB123456789012',
  sku: 'TSHIRT-BLK-M',
  title: 'Black Cotton T-Shirt',
  description: '100% cotton.',
  brand: 'Demo',
  category: 'T-Shirts',
  size: 'M',
  color: 'Black',
  mrp: 999,
  selling_price: 799,
  hsn: '6109',
  tax_code: 'GST_APPAREL',
  listing_status: 'INACTIVE',
  fulfillment_profile: 'NON_FBF',
  shipping: { dispatch_sla: 2, shipping_provider: 'SELLER', procurement_type: 'REGULAR' },
  shipping_fees: { local: 0, zonal: 0, national: 0 },
  packages: [],
  locations: [{ id: 'LOC001', status: 'ENABLED', inventory: 10 }],
  address_label: { manufacturer_details: ['Demo Manufacturer, India'], importer_details: [], packer_details: ['Demo Packer, India'], countries_of_origin: ['IN'] },
  dating_label: null,
  ai_source_confidence: 0.99,
};

assert.equal(validateProduct(good).valid, true);
assert.equal(validateProduct({ ...good, selling_price: 1200 }).valid, false);
assert.equal(validateProduct({ ...good, product_id: 'too-short' }).valid, false);

const payload = toFlipkartPayload([good]);
assert.equal(payload['TSHIRT-BLK-M'].product_id, good.product_id);
assert.equal(payload['TSHIRT-BLK-M'].price.selling_price, 799);
assert.equal(payload['TSHIRT-BLK-M'].locations[0].inventory, 10);

assert.deepEqual(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
assert.equal(validateJobForPublish([{ ...good, approval_status: 'APPROVED' }]).valid, true);
assert.equal(validateJobForPublish([{ ...good, approval_status: 'PENDING' }]).valid, false);

const token = randomToken();
assert.equal(typeof token, 'string');
assert.equal(hashToken(token).length, 64);
const encrypted = encryptSecret('hello');
assert.equal(decryptSecret(encrypted), 'hello');

console.log('All tests passed.');
import { splitSource, mergeProducts } from './ai.mjs';

const longText = Array.from({ length: 20 }, (_, i) => `Product ${i + 1}: SKU-${i + 1}\nDetails for product ${i + 1}.`).join('\n\n');
const aiChunks = splitSource(longText, 120);
assert.ok(aiChunks.length > 1);
const merged = mergeProducts([
  { product_id: 'ABC12345678901', sku: 'SKU1', title: 'Test', size: 'M', color: 'Black', mrp: null, source_excerpt: 'A' },
  { product_id: 'ABC12345678901', sku: 'SKU1', title: 'Test', size: 'M', color: 'Black', mrp: 999, source_excerpt: 'A longer source' },
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].mrp, 999);

console.log('AI chunk/merge tests passed.');
