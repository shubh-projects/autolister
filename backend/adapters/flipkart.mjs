import fs from 'node:fs';
import path from 'node:path';

// Safely load seller profile if available
let sellerProfile = {};
const profilePath = path.resolve(process.cwd(), 'seller-profile.json');
if (fs.existsSync(profilePath)) {
  try {
    sellerProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (err) {
    console.warn('[Flipkart Adapter] Failed to parse seller-profile.json:', err.message);
  }
}

export class FlipkartAdapter {
  transform(universalRecord) {
    const extracted = universalRecord || {};

    return {
      marketplace: 'flipkart',
      sku: extracted.sku || null,
      title: extracted.title || null,
      brand: extracted.brand || null,
      description: extracted.description || null,
      mrp: extracted.mrp ? Number(extracted.mrp) : null,
      selling_price: extracted.price || extracted.selling_price ? Number(extracted.price || extracted.selling_price) : null,
      hsn: extracted.hsn || null,

      // Legal / Compliance declarations sourced from profile, never hardcoded
      country_of_origin: extracted.country_of_origin || sellerProfile.country_of_origin || null,
      manufacturer_details: extracted.manufacturer || sellerProfile.manufacturer_details || null,
      packer_details: sellerProfile.packer_details || null,
      importer_details: sellerProfile.importer_details || null,

      // Dimensions and weight default to null to enforce validation checks
      package_weight_kg: extracted.weight_kg ?? null,
      package_length_cm: extracted.length_cm ?? null,
      package_breadth_cm: extracted.breadth_cm ?? null,
      package_height_cm: extracted.height_cm ?? null,

      inventory: extracted.inventory_count ?? null,
      location_id: sellerProfile.default_location_id || null,

      // Audit trail
      source_excerpt: extracted.source_excerpt || '',
      ai_confidence: extracted.confidence ?? null
    };
  }
}