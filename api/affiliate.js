// api/affiliate.js - Server-Side Affiliate Architecture for All Six Stores
// Supports: Amazon, eBay, Walmart, Target, Best Buy, Etsy
// Features:
// 1. Dynamic affiliate URL injection vs. clean URL serving per store
// 2. Manual Affiliate Override Table (paste manual links for any product/ASIN)
// 3. Independent enable/disable flags for all 6 stores via environment variables
// 4. Strict stripping of competitor/stale tracking parameters for clean baseline URLs

// ============================================================================
// 1. STORE AFFILIATE CONFIGURATION TABLE
// ============================================================================

// Global master killswitch: if true, all links are served clean without affiliate tagging
const DISABLE_ALL_AFFILIATES = process.env.DISABLE_ALL_AFFILIATES === 'true';

// Per-store settings (enabled flags & partner tags)
const STORE_AFFILIATE_CONFIG = {
  amazon: {
    id: 'amazon',
    name: 'Amazon',
    // Set to true if AMAZON_ASSOCIATE_TAG is provided, or explicitly via AFFILIATE_ENABLED_AMAZON
    enabled: process.env.AFFILIATE_ENABLED_AMAZON !== 'false',
    tag: process.env.AMAZON_ASSOCIATE_TAG || process.env.AMAZON_AFFILIATE_TAG || '',
    defaultDomain: 'amazon.com'
  },
  ebay: {
    id: 'ebay',
    name: 'eBay',
    enabled: process.env.AFFILIATE_ENABLED_EBAY === 'true',
    campaignId: process.env.EBAY_CAMPAIGN_ID || process.env.EBAY_AFFILIATE_TAG || '',
    toolId: process.env.EBAY_TOOL_ID || '10001',
    customId: process.env.EBAY_CUSTOM_ID || 'giftlist'
  },
  walmart: {
    id: 'walmart',
    name: 'Walmart',
    enabled: process.env.AFFILIATE_ENABLED_WALMART === 'true',
    tag: process.env.WALMART_AFFILIATE_TAG || process.env.WALMART_PARTNER_ID || '',
    defaultDomain: 'walmart.com'
  },
  target: {
    id: 'target',
    name: 'Target',
    enabled: process.env.AFFILIATE_ENABLED_TARGET === 'true',
    tag: process.env.TARGET_AFFILIATE_TAG || process.env.TARGET_AFID || '',
    defaultDomain: 'target.com'
  },
  bestbuy: {
    id: 'bestbuy',
    name: 'Best Buy',
    enabled: process.env.AFFILIATE_ENABLED_BESTBUY === 'true',
    tag: process.env.BESTBUY_AFFILIATE_TAG || process.env.BESTBUY_REF || '',
    defaultDomain: 'bestbuy.com'
  },
  etsy: {
    id: 'etsy',
    name: 'Etsy',
    enabled: process.env.AFFILIATE_ENABLED_ETSY === 'true',
    tag: process.env.ETSY_AWIN_TAG || process.env.ETSY_AFFILIATE_TAG || '',
    defaultDomain: 'etsy.com'
  }
};

// ============================================================================
// 2. MANUAL AFFILIATE OVERRIDE TABLE
// ============================================================================
// You can paste manual affiliate URLs directly into this dictionary (keyed by ASIN,
// item ID, or product URL), OR pass them via process.env.MANUAL_AFFILIATE_OVERRIDES
// (JSON string formatted like '{"B08N5WRWNW": "https://amzn.to/3xyz"}').
// If an item matches this table, the manual affiliate link is served immediately.

let manualAffiliateMap = {
  // Example entries (add your manual URLs here whenever needed):
  // 'B08N5WRWNW': 'https://amzn.to/example-link-1',
  // 'https://www.amazon.com/dp/B08N5WRWNW': 'https://amzn.to/example-link-1',
};

// Load optional runtime overrides from environment variable
if (process.env.MANUAL_AFFILIATE_OVERRIDES) {
  try {
    const parsed = JSON.parse(process.env.MANUAL_AFFILIATE_OVERRIDES);
    if (typeof parsed === 'object' && parsed !== null) {
      manualAffiliateMap = { ...manualAffiliateMap, ...parsed };
    }
  } catch (err) {
    console.warn('[AFFILIATE] Failed to parse MANUAL_AFFILIATE_OVERRIDES JSON:', err.message);
  }
}

/**
 * Add or update a manual affiliate override at runtime
 * @param {string} key - ASIN, Item ID, or raw product URL
 * @param {string} affiliateUrl - The manual affiliate link (e.g. amzn.to shortlink)
 */
function setManualAffiliateOverride(key, affiliateUrl) {
  if (key && affiliateUrl) {
    manualAffiliateMap[key.trim()] = affiliateUrl.trim();
  }
}

/**
 * Retrieve the current manual overrides table
 */
function getManualAffiliateOverrides() {
  return { ...manualAffiliateMap };
}

// ============================================================================
// 3. STORE IDENTIFIERS & CLEAN URL EXTRACTORS
// ============================================================================

/**
 * Detect which store a URL belongs to
 */
function detectStore(url) {
  if (!url || typeof url !== 'string') return 'other';
  const lower = url.toLowerCase();
  if (lower.includes('amazon.') || lower.includes('a.co') || lower.includes('amzn.to')) return 'amazon';
  if (lower.includes('ebay.') || lower.includes('ebay.to') || lower.includes('ebay.io')) return 'ebay';
  if (lower.includes('walmart.')) return 'walmart';
  if (lower.includes('target.')) return 'target';
  if (lower.includes('bestbuy.')) return 'bestbuy';
  if (lower.includes('etsy.')) return 'etsy';
  return 'other';
}

/**
 * Extract Amazon ASIN from any Amazon URL or short link
 */
function extractAmazonAsin(url) {
  if (!url) return null;
  const match = url.match(/(?:\/dp\/|\/gp\/product\/|\/d\/|\/ASIN\/)([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Extract Amazon domain (e.g. amazon.com, amazon.co.uk, amazon.ca)
 */
function extractAmazonDomain(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '').toLowerCase();
    if (host.includes('amazon.')) return host;
  } catch (_) {}
  return 'amazon.com';
}

/**
 * Extract eBay Item ID
 */
function extractEbayItemId(url) {
  if (!url) return null;
  const match = url.match(/(?:itm\/(?:[^\/]+\/)?|itm\/)(\d{9,14})/i);
  return match ? match[1] : null;
}

/**
 * Extract Walmart Item ID
 */
function extractWalmartItemId(url) {
  if (!url) return null;
  const match = url.match(/(?:ip\/(?:[^\/]+\/)?|ip\/)(\d{8,12})/i);
  return match ? match[1] : null;
}

/**
 * Extract Target TCIN
 */
function extractTargetTcin(url) {
  if (!url) return null;
  const match = url.match(/(?:A-(\d{8,10})|\/p\/[^\/]+\/-\/A-(\d{8,10}))/i);
  return match ? (match[1] || match[2]) : null;
}

/**
 * Extract Best Buy SKU
 */
function extractBestBuySku(url) {
  if (!url) return null;
  const matchParam = url.match(/skuId=(\d{7,10})/i);
  if (matchParam) return matchParam[1];
  const matchPath = url.match(/\/(\d{7,10})\.p/i);
  return matchPath ? matchPath[1] : null;
}

/**
 * Extract Etsy Listing ID
 */
function extractEtsyListingId(url) {
  if (!url) return null;
  const match = url.match(/listing\/(\d{8,14})/i);
  return match ? match[1] : null;
}

// ============================================================================
// 4. CLEAN CANONICAL URL GENERATOR (WITHOUT AFFILIATE PROGRAM)
// ============================================================================

/**
 * Generates a clean canonical product URL stripped of all tracking/affiliate params.
 * Used when a store's affiliate program is disabled or not configured.
 */
function buildCleanProductUrl(rawUrl, storeKey = null) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const store = storeKey || detectStore(rawUrl);

  try {
    switch (store) {
      case 'amazon': {
        const asin = extractAmazonAsin(rawUrl);
        const domain = extractAmazonDomain(rawUrl);
        if (asin) return `https://www.${domain}/dp/${asin}`;
        break;
      }
      case 'ebay': {
        const itemId = extractEbayItemId(rawUrl);
        if (itemId) return `https://www.ebay.com/itm/${itemId}`;
        break;
      }
      case 'walmart': {
        const itemId = extractWalmartItemId(rawUrl);
        if (itemId) return `https://www.walmart.com/ip/${itemId}`;
        break;
      }
      case 'target': {
        const tcin = extractTargetTcin(rawUrl);
        if (tcin) return `https://www.target.com/p/-/A-${tcin}`;
        break;
      }
      case 'bestbuy': {
        const sku = extractBestBuySku(rawUrl);
        if (sku) return `https://www.bestbuy.com/site/${sku}.p?skuId=${sku}`;
        break;
      }
      case 'etsy': {
        const listingId = extractEtsyListingId(rawUrl);
        if (listingId) return `https://www.etsy.com/listing/${listingId}`;
        break;
      }
    }
  } catch (_) {}

  // Fallback: Strip common tracking query params
  try {
    const parsed = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    const trackingParams = [
      'tag', 'ascsubtag', 'linkCode', 'ref', 'ref_', 'pf_rd_r', 'pf_rd_p',
      'campid', 'toolid', 'customid', 'mkevt', 'mkcid', 'mkrid',
      'wmlspartner', 'sourceid', 'veh', 'affillinktype',
      'afid', 'cpng', 'adgroup', 'lnm',
      'loc', 'irclickid', 'irgwc',
      'awc', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid'
    ];
    trackingParams.forEach(p => parsed.searchParams.delete(p));
    return parsed.toString();
  } catch (_) {
    return rawUrl;
  }
}

// ============================================================================
// 5. AFFILIATE DECORATOR (WITH AFFILIATE PROGRAM)
// ============================================================================

/**
 * Builds the decorated affiliate URL for a given store
 */
function buildAffiliateProductUrl(cleanUrl, storeKey) {
  const config = STORE_AFFILIATE_CONFIG[storeKey];
  if (!config || !config.enabled) {
    return null;
  }

  switch (storeKey) {
    case 'amazon': {
      const asin = extractAmazonAsin(cleanUrl);
      const domain = extractAmazonDomain(cleanUrl);
      const tag = config.tag;
      if (!asin || !tag) return null;
      return `https://www.${domain}/dp/${asin}?tag=${encodeURIComponent(tag)}`;
    }

    case 'ebay': {
      const itemId = extractEbayItemId(cleanUrl);
      const campId = config.campaignId;
      if (!itemId || !campId) return null;
      const toolId = config.toolId || '10001';
      const customId = config.customId || 'giftlist';
      return `https://www.ebay.com/itm/${itemId}?mkevt=1&mkcid=1&mkrid=711-53200-19255-0&campid=${encodeURIComponent(campId)}&toolid=${encodeURIComponent(toolId)}&customid=${encodeURIComponent(customId)}`;
    }

    case 'walmart': {
      const itemId = extractWalmartItemId(cleanUrl);
      const tag = config.tag;
      if (!itemId || !tag) return null;
      return `https://www.walmart.com/ip/${itemId}?wmlspartner=${encodeURIComponent(tag)}&sourceid=imp_${encodeURIComponent(tag)}`;
    }

    case 'target': {
      const tcin = extractTargetTcin(cleanUrl);
      const tag = config.tag;
      if (!tcin || !tag) return null;
      return `https://www.target.com/p/-/A-${tcin}?afid=${encodeURIComponent(tag)}&ref=tgt_adv_xasd0002`;
    }

    case 'bestbuy': {
      const sku = extractBestBuySku(cleanUrl);
      const tag = config.tag;
      if (!sku || !tag) return null;
      return `https://www.bestbuy.com/site/${sku}.p?skuId=${sku}&ref=${encodeURIComponent(tag)}&loc=${encodeURIComponent(tag)}`;
    }

    case 'etsy': {
      const listingId = extractEtsyListingId(cleanUrl);
      const tag = config.tag;
      if (!listingId || !tag) return null;
      // Standard Awin tracking or direct tag parameter
      return `https://www.etsy.com/listing/${listingId}?awc=${encodeURIComponent(tag)}`;
    }

    default:
      return null;
  }
}

// ============================================================================
// 6. MASTER RESOLUTION ENGINE
// ============================================================================

/**
 * Resolves product URL with or without affiliate program for all six stores.
 *
 * @param {string} rawUrl - The input product URL
 * @param {string} [storeHint] - Optional store name hint
 * @param {boolean} [forceNoAffiliate=false] - If true, guarantees clean URL with no affiliate
 * @returns {object} { cleanUrl, affiliateUrl, hasAffiliate, storeKey, source, storeName }
 */
function resolveAffiliateUrl(rawUrl, storeHint = null, forceNoAffiliate = false) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return {
      cleanUrl: '',
      affiliateUrl: '',
      hasAffiliate: false,
      storeKey: 'other',
      source: 'empty',
      storeName: storeHint || 'Online Store'
    };
  }

  const storeKey = detectStore(rawUrl);
  const cleanUrl = buildCleanProductUrl(rawUrl, storeKey);
  const storeConfig = STORE_AFFILIATE_CONFIG[storeKey];
  const canonicalStoreName = storeConfig ? storeConfig.name : (storeHint || 'Online Store');

  // If forceNoAffiliate or global disable is active, return clean URL immediately
  if (forceNoAffiliate || DISABLE_ALL_AFFILIATES) {
    return {
      cleanUrl,
      affiliateUrl: cleanUrl,
      hasAffiliate: false,
      storeKey,
      source: 'clean_url_no_affiliate',
      storeName: canonicalStoreName
    };
  }

  // 1. Check Manual Overrides Table first (highest priority)
  const asinOrId = (storeKey === 'amazon' ? extractAmazonAsin(rawUrl) : null)
    || (storeKey === 'ebay' ? extractEbayItemId(rawUrl) : null)
    || (storeKey === 'walmart' ? extractWalmartItemId(rawUrl) : null)
    || (storeKey === 'target' ? extractTargetTcin(rawUrl) : null)
    || (storeKey === 'bestbuy' ? extractBestBuySku(rawUrl) : null)
    || (storeKey === 'etsy' ? extractEtsyListingId(rawUrl) : null);

  if (manualAffiliateMap[rawUrl]) {
    return {
      cleanUrl,
      affiliateUrl: manualAffiliateMap[rawUrl],
      hasAffiliate: true,
      storeKey,
      source: 'manual_override_exact_url',
      storeName: canonicalStoreName
    };
  }
  if (cleanUrl && manualAffiliateMap[cleanUrl]) {
    return {
      cleanUrl,
      affiliateUrl: manualAffiliateMap[cleanUrl],
      hasAffiliate: true,
      storeKey,
      source: 'manual_override_clean_url',
      storeName: canonicalStoreName
    };
  }
  if (asinOrId && manualAffiliateMap[asinOrId]) {
    return {
      cleanUrl,
      affiliateUrl: manualAffiliateMap[asinOrId],
      hasAffiliate: true,
      storeKey,
      source: 'manual_override_item_id',
      storeName: canonicalStoreName
    };
  }

  // 2. Check Store-Specific Affiliate Program
  if (storeConfig && storeConfig.enabled) {
    const decorated = buildAffiliateProductUrl(cleanUrl, storeKey);
    if (decorated) {
      return {
        cleanUrl,
        affiliateUrl: decorated,
        hasAffiliate: true,
        storeKey,
        source: 'store_affiliate_program',
        storeName: canonicalStoreName
      };
    }
  }

  // 3. Fallback: Store has no affiliate program active -> Serve clean URL without affiliate
  return {
    cleanUrl,
    affiliateUrl: cleanUrl,
    hasAffiliate: false,
    storeKey,
    source: 'clean_url_no_affiliate',
    storeName: canonicalStoreName
  };
}

/**
 * Returns diagnostic overview of all 6 store affiliate programs
 */
function getAffiliateStatusReport() {
  const stores = Object.keys(STORE_AFFILIATE_CONFIG).map(k => {
    const conf = STORE_AFFILIATE_CONFIG[k];
    const hasTag = Boolean(conf.tag || conf.campaignId);
    return {
      storeId: conf.id,
      storeName: conf.name,
      enabled: conf.enabled && !DISABLE_ALL_AFFILIATES,
      hasTagConfigured: hasTag,
      tagPreview: hasTag ? (conf.tag || conf.campaignId).slice(0, 4) + '***' : 'None',
      status: (!DISABLE_ALL_AFFILIATES && conf.enabled && hasTag)
        ? 'ACTIVE_AFFILIATE'
        : 'SERVING_CLEAN_URL_WITHOUT_AFFILIATE'
    };
  });

  return {
    globalDisabled: DISABLE_ALL_AFFILIATES,
    manualOverridesCount: Object.keys(manualAffiliateMap).length,
    stores
  };
}

module.exports = {
  STORE_AFFILIATE_CONFIG,
  detectStore,
  extractAmazonAsin,
  extractEbayItemId,
  extractWalmartItemId,
  extractTargetTcin,
  extractBestBuySku,
  extractEtsyListingId,
  buildCleanProductUrl,
  buildAffiliateProductUrl,
  resolveAffiliateUrl,
  setManualAffiliateOverride,
  getManualAffiliateOverrides,
  getAffiliateStatusReport
};
