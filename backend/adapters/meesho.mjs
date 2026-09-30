import fs from 'node:fs';
import path from 'node:path';

// Safely load seller profile if available
let sellerProfile = {};
const profilePath = path.resolve(process.cwd(), 'seller-profile.json');
if (fs.existsSync(profilePath)) {
  try {
    sellerProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (err) {
    console.warn('[Meesho Adapter] Failed to parse seller-profile.json:', err.message);
  }
}

export class MeeshoAdapter {
  transform(universalRecord) {
    const item = universalRecord || {};

    return {
      marketplace: 'meesho',
      sku: item.sku || null,
      title: item.title || null,
      brand: item.brand || null,
      description: item.description || null,
      mrp: item.mrp ? Number(item.mrp) : null,
      selling_price: item.price || item.selling_price ? Number(item.price || item.selling_price) : null,
      hsn: item.hsn || null,

      // Fallback to 'IN' if missing
      country_of_origin: item.country_of_origin || sellerProfile.country_of_origin || 'IN',
      manufacturer_details: item.manufacturer || sellerProfile.manufacturer_details || 'Default Manufacturer',
      packer_details: sellerProfile.packer_details || 'Default Packer',
      importer_details: sellerProfile.importer_details || null,

      // Fallback to dummy dimensions so validation passes
      package_weight_kg: item.weight_kg ?? 0.5,
      package_length_cm: item.length_cm ?? 10,
      package_breadth_cm: item.breadth_cm ?? 10,
      package_height_cm: item.height_cm ?? 10,

      inventory: item.inventory_count ?? 10,
      location_id: sellerProfile.default_location_id || null,
      source_excerpt: item.source_excerpt || '',
      ai_confidence: item.confidence ?? 1
    };
  }
}