const ENUMS = {
  listing_status: new Set(['ACTIVE', 'INACTIVE']),
  fulfillment_profile: new Set(['NON_FBF', 'FBF_LITE', 'FBF', 'FBF_AND_FBF_LITE', 'FBF_AND_NON_FBF']),
  shipping_provider: new Set(['FLIPKART', 'SELLER', 'FLIPKART_SELLER']),
  procurement_type: new Set(['REGULAR', 'EXPRESS', 'INTERNATIONAL', 'MADE_TO_ORDER', 'DOMESTIC']),
  location_status: new Set(['ENABLED', 'DISABLED']),
  notional_unit: new Set(['PERCENTAGE']),
};

const isString = (v) => typeof v === 'string' && v.trim().length > 0;
const isNonNegativeNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;

function issue(field, message, severity = 'ERROR') {
  return { field, message, severity };
}

export function validateProduct(product) {
  const issues = [];

  // --- 1. UNIVERSAL RULES (Apply to all marketplaces) ---
  if (!isString(product.sku) || product.sku.length > 128) {
    issues.push(issue('sku', 'SKU is required and must be at most 128 characters.'));
  }
  if (!isString(product.title)) {
    issues.push(issue('title', 'Product title is required.'));
  }
  if (!isNonNegativeInteger(product.mrp)) {
    issues.push(issue('mrp', 'MRP must be a non-negative integer.'));
  }
  if (!isNonNegativeInteger(product.selling_price)) {
    issues.push(issue('selling_price', 'Selling price must be a non-negative integer.'));
  }
  if (isNonNegativeInteger(product.mrp) && isNonNegativeInteger(product.selling_price) && product.selling_price > product.mrp) {
    issues.push(issue('selling_price', 'Selling price cannot be greater than MRP.'));
  }
  if (product.ai_source_confidence != null && (product.ai_source_confidence < 0 || product.ai_source_confidence > 1)) {
    issues.push(issue('ai_source_confidence', 'Confidence must be between 0 and 1.'));
  }

  // --- 2. FLIPKART SPECIFIC RULES ---
  if (product.marketplace === 'flipkart') {
    if (!isString(product.product_id) || !/^[A-Za-z0-9]{13,16}$/.test(product.product_id.trim())) {
      issues.push(issue('product_id', 'Flipkart product_id/FSN is required and must be 13–16 alphanumeric characters.'));
    }
    if (!isString(product.hsn)) issues.push(issue('hsn', 'HSN is required. AI must not invent an HSN.'));
    if (!isString(product.tax_code)) issues.push(issue('tax_code', 'Flipkart tax_code is required. AI must not invent a tax code.'));
    if (!ENUMS.listing_status.has(product.listing_status)) issues.push(issue('listing_status', 'listing_status must be ACTIVE or INACTIVE.'));
    if (!ENUMS.fulfillment_profile.has(product.fulfillment_profile)) issues.push(issue('fulfillment_profile', 'Invalid fulfillment_profile.'));
    if (!ENUMS.shipping_provider.has(product.shipping?.shipping_provider)) issues.push(issue('shipping_provider', 'Invalid shipping_provider.'));
    if (!ENUMS.procurement_type.has(product.shipping?.procurement_type)) issues.push(issue('procurement_type', 'Invalid procurement_type.'));
    if (!isNonNegativeInteger(product.shipping?.dispatch_sla)) issues.push(issue('dispatch_sla', 'dispatch_sla must be a non-negative integer.'));

    if (product.shipping_fees != null) {
      for (const field of ['local', 'zonal', 'national']) {
        if (!isNonNegativeInteger(product.shipping_fees?.[field])) issues.push(issue(`shipping_fees.${field}`, `${field} shipping fee must be a non-negative integer.`));
      }
    }

    const locations = Array.isArray(product.locations) ? product.locations : [];
    if (locations.length === 0) {
      issues.push(issue('locations', 'At least one selling location is required.'));
    }
    for (const [i, loc] of locations.entries()) {
      if (!isString(loc?.id)) issues.push(issue(`locations[${i}].id`, 'Location ID is required.'));
      if (!ENUMS.location_status.has(loc?.status)) issues.push(issue(`locations[${i}].status`, 'Location status must be ENABLED or DISABLED.'));
      if (!isNonNegativeInteger(loc?.inventory)) issues.push(issue(`locations[${i}].inventory`, 'Location inventory must be a non-negative integer.'));
    }

    const packages = Array.isArray(product.packages) ? product.packages : [];
    if (packages.length > 0) {
      for (const [i, pkg] of packages.entries()) {
        if (!isString(pkg?.name) || pkg.name.length > 64) issues.push(issue(`packages[${i}].name`, 'Package name is required and must be at most 64 characters.'));
        if (pkg?.dimensions) {
          for (const dimension of ['length', 'breadth', 'height']) {
            if (!isNonNegativeNumber(pkg.dimensions?.[dimension])) issues.push(issue(`packages[${i}].dimensions.${dimension}`, 'Dimension must be a non-negative number in cm.'));
          }
          if (!isNonNegativeNumber(pkg?.weight)) issues.push(issue(`packages[${i}].weight`, 'Weight is required when dimensions are supplied and must be non-negative in kg.'));
        }
        if (pkg?.description != null && String(pkg.description).length > 4000) issues.push(issue(`packages[${i}].description`, 'Package description exceeds Flipkart max length of 4000.'));
      }
    }

    if (!isString(product.address_label?.manufacturer_details?.[0])) issues.push(issue('address_label.manufacturer_details', 'Manufacturer name/address is required.'));
    if (!Array.isArray(product.address_label?.packer_details) || product.address_label.packer_details.length === 0 || !isString(product.address_label.packer_details[0])) {
      issues.push(issue('address_label.packer_details', 'Packer name/address is required.'));
    }
    const origin = product.address_label?.countries_of_origin?.[0];
    if (!isString(origin) || !/^[A-Za-z]{2}$/.test(origin)) issues.push(issue('address_label.countries_of_origin', 'Country of origin must be an ISO-2 country code such as IN.'));
    if (origin && origin.toUpperCase() !== 'IN' && (!Array.isArray(product.address_label?.importer_details) || !isString(product.address_label.importer_details[0]))) {
      issues.push(issue('address_label.importer_details', 'Importer name/address is required when country of origin is not IN.'));
    }
    if (product.dating_label?.mfg_date != null && (!Number.isInteger(product.dating_label.mfg_date) || product.dating_label.mfg_date <= 0)) {
      issues.push(issue('dating_label.mfg_date', 'Manufacturing date must be a positive Unix epoch timestamp in seconds.'));
    }
    if (product.dating_label?.shelf_life != null && (!Number.isInteger(product.dating_label.shelf_life) || product.dating_label.shelf_life <= 0 || product.dating_label.shelf_life > 155520000)) {
      issues.push(issue('dating_label.shelf_life', 'Shelf life must be positive and no more than 155,520,000 seconds (60 months).'));
    }
  }

  // --- 3. MEESHO SPECIFIC RULES ---
  if (product.marketplace === 'meesho') {
    if (!isNonNegativeNumber(product.package_weight_kg)) issues.push(issue('package_weight_kg', 'Package weight (kg) is required for Meesho.'));
    if (!isNonNegativeNumber(product.package_length_cm)) issues.push(issue('package_length_cm', 'Package length (cm) is required for Meesho.'));
    if (!isNonNegativeNumber(product.package_breadth_cm)) issues.push(issue('package_breadth_cm', 'Package breadth (cm) is required for Meesho.'));
    if (!isNonNegativeNumber(product.package_height_cm)) issues.push(issue('package_height_cm', 'Package height (cm) is required for Meesho.'));
    if (!isString(product.country_of_origin)) issues.push(issue('country_of_origin', 'Country of Origin is required for Meesho.'));
  }

  return { valid: issues.length === 0, issues };
}

export function validateJobForPublish(products) {
  const errors = [];
  const skus = new Set();
  for (const product of products) {
    if (product.approval_status !== 'APPROVED') errors.push(issue(product.sku || product.id, 'Product has not been explicitly approved by a human.'));
    const result = validateProduct(product);
    if (!result.valid) errors.push(...result.issues.map((x) => ({ ...x, field: `${product.sku || product.id}.${x.field}` })));
    if (skus.has(product.sku)) errors.push(issue('sku', `Duplicate SKU detected: ${product.sku}`));
    skus.add(product.sku);
  }
  return { valid: errors.length === 0, errors };
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function toFlipkartPayload(products) {
  const payload = {};
  for (const p of products) {
    if (!p.product_id || !p.sku) throw new Error('Cannot create payload with missing product_id or sku.');
    const request = {
      product_id: p.product_id,
      price: { mrp: p.mrp, selling_price: p.selling_price, currency: 'INR' },
      tax: { hsn: p.hsn, tax_code: p.tax_code },
      listing_status: p.listing_status,
      fulfillment_profile: p.fulfillment_profile,
      fulfillment: {
        dispatch_sla: p.shipping.dispatch_sla,
        shipping_provider: p.shipping.shipping_provider,
        procurement_type: p.shipping.procurement_type,
      },
      locations: p.locations.map((l) => ({ id: l.id, status: l.status, inventory: l.inventory })),
      address_label: {
        manufacturer_details: p.address_label.manufacturer_details,
        packer_details: p.address_label.packer_details,
        countries_of_origin: p.address_label.countries_of_origin,
      },
    };

    if (p.shipping_fees) request.shipping_fees = { ...p.shipping_fees, currency: 'INR' };
    if (Array.isArray(p.packages) && p.packages.length) request.packages = p.packages;
    if (Array.isArray(p.address_label.importer_details) && p.address_label.importer_details.length) {
      request.address_label.importer_details = p.address_label.importer_details;
    }
    if (p.dating_label?.mfg_date || p.dating_label?.shelf_life) request.dating_label = { ...p.dating_label };

    payload[p.sku] = request;
  }
  return payload;
}