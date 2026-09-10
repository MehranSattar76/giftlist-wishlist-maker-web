// api/product.js - Serverless Metadata Resolution Service for Vercel
// Phase 1: Pure Native Multi-Store Extraction Engine (Zero Crawlbase)
// Supports eBay Developer Browse API & Store-Specific Parsers for Walmart, Target, Best Buy, Etsy, Amazon

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';

// In-memory token cache across serverless warm invocations
let ebayTokenCache = {
  token: null,
  expiresAt: 0
};

async function getEbayAccessToken() {
  if (ebayTokenCache.token && Date.now() < ebayTokenCache.expiresAt - 60000) {
    return ebayTokenCache.token;
  }

  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error('eBay credentials not configured');
  }

  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`eBay OAuth failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  ebayTokenCache.token = data.access_token;
  ebayTokenCache.expiresAt = Date.now() + (data.expires_in * 1000);
  return data.access_token;
}

function extractEbayItemId(url) {
  const match = url.match(/ebay\.[a-z.]+\/itm\/(?:[^/?#]+\/)?(\d{9,14})/i);
  return match ? match[1] : null;
}

async function resolveEbayProduct(itemId, rawUrl) {
  const token = await getEbayAccessToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    'Accept': 'application/json'
  };

  // Try 1: Official get_item_by_legacy_id for standard eBay listing numbers
  let response = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemId}`, {
    headers
  });

  // Try 2: RESTful item ID format (v1|itemId|0)
  if (!response.ok) {
    const itemRestId = `v1|${itemId}|0`;
    response = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemRestId)}`, {
      headers
    });
  }

  // Try 3: Direct item ID
  if (!response.ok) {
    response = await fetch(`https://api.ebay.com/buy/browse/v1/item/${itemId}`, {
      headers
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`eBay item lookup failed (${response.status}): ${errText}`);
  }

  const item = await response.json();
  const priceVal = parseFloat(item.price?.value);

  return {
    success: true,
    url: rawUrl,
    title: item.title || 'eBay Item',
    storeName: 'eBay',
    price: !isNaN(priceVal) && priceVal > 0 ? priceVal : null,
    minPrice: !isNaN(priceVal) && priceVal > 0 ? priceVal : null,
    maxPrice: null,
    priceRangeText: null,
    imageUrl: item.image?.imageUrl || item.additionalImages?.[0]?.imageUrl || null,
    affiliateUrl: item.itemAffiliateWebUrl || item.itemWebUrl || rawUrl
  };
}

function cleanSlug(slug) {
  if (!slug) return null;
  const decoded = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (decoded.length < 3) return null;
  return decoded.split(' ').map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '').join(' ');
}

function extractStoreName(host) {
  const h = host.toLowerCase();
  if (h.includes('amazon') || h.includes('a.co') || h.includes('amzn.to')) return 'Amazon';
  if (h.includes('ebay')) return 'eBay';
  if (h.includes('walmart')) return 'Walmart';
  if (h.includes('target')) return 'Target';
  if (h.includes('etsy')) return 'Etsy';
  if (h.includes('bestbuy')) return 'Best Buy';
  return 'Online Store';
}

function extractPriceRange(text) {
  if (!text) return null;
  const match = text.match(/(?:US\s*)?\$\s*(\d{1,4}(?:\.\d{2})?)\s*(?:-|to)\s*(?:US\s*)?\$?\s*(\d{1,4}(?:\.\d{2})?)/i);
  if (!match) return null;
  const low = parseFloat(match[1]);
  const high = parseFloat(match[2]);
  if (low > 0 && high > low && high < 5000) {
    return { low, high, text: `$${low.toFixed(2)} - $${high.toFixed(2)}` };
  }
  return null;
}

function parseJsonLd(html) {
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (!item) continue;
        const type = String(item['@type'] || '');
        if (type.includes('Product') || item.offers) {
          const title = item.name || null;
          let image = null;
          if (typeof item.image === 'string') image = item.image;
          else if (Array.isArray(item.image) && item.image[0]) {
            image = typeof item.image[0] === 'string' ? item.image[0] : item.image[0].url;
          } else if (item.image?.url) image = item.image.url;

          let price = null;
          let minPrice = null;
          let maxPrice = null;

          const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offers) {
            if (offers.lowPrice) minPrice = parseFloat(offers.lowPrice);
            if (offers.highPrice) maxPrice = parseFloat(offers.highPrice);
            if (offers.price) price = parseFloat(offers.price);
          }

          if ((price && price > 0) || (minPrice && minPrice > 0) || title) {
            return { title, image, price: price || minPrice, minPrice, maxPrice };
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

function extractMetaTag(html, property) {
  const regex = new RegExp(`<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const match = html.match(regex);
  if (match && match[1]) return match[1].trim();

  const altRegex = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, 'i');
  const altMatch = html.match(altRegex);
  return altMatch && altMatch[1] ? altMatch[1].trim() : null;
}

function isValidTitle(t) {
  if (!t || typeof t !== 'string') return false;
  const lower = t.toLowerCase().trim();
  if (lower.length < 3) return false;
  if (lower.includes('undefined')) return false;
  if (lower.includes('robot') || lower.includes('captcha') || lower.includes('human')) return false;
  if (lower.includes('access denied') || lower.includes('page not found') || lower.includes('error page')) return false;
  if (lower.includes('item not available')) return false;
  if (lower === 'target' || lower === 'walmart' || lower === 'amazon' || lower === 'best buy' || lower === 'etsy') return false;
  return true;
}

function extractStoreDetails(cleanUrl, html) {
  const h = cleanUrl.toLowerCase();

  // 1. AMAZON
  if (h.includes('amazon.') || h.includes('a.co') || h.includes('amzn.to')) {
    const asinMatch = cleanUrl.match(/(?:\/dp\/|\/gp\/product\/|\/d\/|\/asin\/)([A-Z0-9]{10})/i);
    const asin = asinMatch ? asinMatch[1] : null;
    const slugMatch = cleanUrl.match(/amazon\.[a-z.]+\/([^/?#]+)\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i);
    const slugTitle = slugMatch && !['dp', 'gp'].includes(slugMatch[1].toLowerCase()) ? cleanSlug(slugMatch[1]) : null;
    const cdnImage = asin ? `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_SX500_.jpg` : null;

    let amzPrice = null;
    const priceMatch = html.match(/class=["']a-price-whole["']>(\d+)<\/span><span class=["']a-price-fraction["']>(\d+)<\/span>/i);
    if (priceMatch) {
      amzPrice = parseFloat(`${priceMatch[1]}.${priceMatch[2]}`);
    }

    return { storeName: 'Amazon', asin, slugTitle, cdnImage, storePrice: amzPrice };
  }

  // 2. WALMART
  if (h.includes('walmart.')) {
    const itemIdMatch = cleanUrl.match(/walmart\.[a-z.]+\/ip\/(?:[^/?#]+\/)?(\d{7,12})/i);
    const itemId = itemIdMatch ? itemIdMatch[1] : null;
    const slugMatch = cleanUrl.match(/walmart\.[a-z.]+\/ip\/([^/?#]+)\/\d+/i);
    const slugTitle = slugMatch ? cleanSlug(slugMatch[1]) : null;

    let nextDataPrice = null;
    let nextDataTitle = null;
    let nextDataImage = null;

    const nextDataMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch && nextDataMatch[1]) {
      try {
        const nextJson = JSON.parse(nextDataMatch[1]);
        const prod = nextJson?.props?.pageProps?.initialData?.data?.product;
        if (prod) {
          nextDataTitle = prod.name || null;
          nextDataPrice = prod.priceInfo?.currentPrice?.price || prod.priceInfo?.minPrice || null;
          nextDataImage = prod.imageInfo?.thumbnailUrl || prod.imageInfo?.allImages?.[0]?.url || null;
        }
      } catch (_) {}
    }

    if (!nextDataPrice) {
      const priceMatch = html.match(/"currentPrice"\s*:\s*\{"price"\s*:\s*(\d+(?:\.\d+)?)/i);
      if (priceMatch) nextDataPrice = parseFloat(priceMatch[1]);
    }

    return {
      storeName: 'Walmart',
      itemId,
      slugTitle,
      storeTitle: nextDataTitle,
      storePrice: nextDataPrice,
      storeImage: nextDataImage
    };
  }

  // 3. TARGET
  if (h.includes('target.')) {
    const tcinMatch = cleanUrl.match(/\/A-(\d{7,10})/i);
    const tcin = tcinMatch ? tcinMatch[1] : null;
    const slugMatch = cleanUrl.match(/target\.[a-z.]+\/p\/([^/?#]+)\/-\/A-\d+/i);
    const slugTitle = slugMatch ? cleanSlug(slugMatch[1]) : null;

    let targetPrice = null;
    const priceMatch = html.match(/"current_retail"\s*:\s*(\d+(?:\.\d+)?)/i)
      || html.match(/"price"\s*:\s*(\d+(?:\.\d+)?)/i);
    if (priceMatch) targetPrice = parseFloat(priceMatch[1]);

    return { storeName: 'Target', tcin, slugTitle, storePrice: targetPrice };
  }

  // 4. BEST BUY
  if (h.includes('bestbuy.')) {
    const skuMatch = cleanUrl.match(/bestbuy\.[a-z.]+\/site\/[^/?#]+\/(\d{7,8})\.p/i)
      || cleanUrl.match(/[?&]skuId=(\d{7,8})/i);
    const sku = skuMatch ? skuMatch[1] : null;
    const slugMatch = cleanUrl.match(/bestbuy\.[a-z.]+\/site\/([^/?#]+)\/\d+\.p/i);
    const slugTitle = slugMatch ? cleanSlug(slugMatch[1]) : null;

    const cdnImage = sku
      ? `https://pisces.bbystatic.com/image2/BestBuy_US/images/products/${sku.substring(0, 4)}/${sku}_sd.jpg`
      : null;

    let bbyPrice = null;
    const priceMatch = html.match(/itemprop=["']price["'][^>]*content=["'](\d+(?:\.\d+)?)["']/i)
      || html.match(/"customerPrice"\s*:\s*(\d+(?:\.\d+)?)/i);
    if (priceMatch) bbyPrice = parseFloat(priceMatch[1]);

    return { storeName: 'Best Buy', sku, slugTitle, cdnImage, storePrice: bbyPrice };
  }

  // 5. ETSY
  if (h.includes('etsy.')) {
    const listingMatch = cleanUrl.match(/etsy\.[a-z.]+\/listing\/(\d{7,12})(?:\/([^/?#]+))?/i);
    const listingId = listingMatch ? listingMatch[1] : null;
    const slugTitle = listingMatch && listingMatch[2] ? cleanSlug(listingMatch[2]) : null;

    // 5. ETSY
    let etsyPrice = null;
    const priceMatch = html.match(/meta[^>]*property=["']product:price:amount["'][^>]*content=["'](\d+(?:\.\d+)?)["']/i)
      || html.match(/class=["']currency-value["']>(\d+(?:\.\d+)?)<\/span>/i);
    if (priceMatch) etsyPrice = parseFloat(priceMatch[1]);

    return { storeName: 'Etsy', listingId, slugTitle, storePrice: etsyPrice };
  }

  // 6. EBAY
  if (h.includes('ebay.')) {
    const itemIdMatch = cleanUrl.match(/ebay\.[a-z.]+\/itm\/(?:[^/?#]+\/)?(\d{9,14})/i);
    const itemId = itemIdMatch ? itemIdMatch[1] : null;
    const slugMatch = cleanUrl.match(/ebay\.[a-z.]+\/itm\/([^/?#]+)\/\d+/i);
    const slugTitle = slugMatch ? cleanSlug(slugMatch[1]) : null;

    let ebayPrice = null;
    const priceMatch = html.match(/itemprop=["']price["'][^>]*content=["'](\d+(?:\.\d+)?)["']/i)
      || html.match(/class=["']x-price-primary["'][^>]*>[\s\S]*?\$(\d+(?:\.\d+)?)/i);
    if (priceMatch) ebayPrice = parseFloat(priceMatch[1]);

    return { storeName: 'eBay', itemId, slugTitle, storePrice: ebayPrice };
  }

  return { storeName: null };
}

async function resolveUniversalProduct(url, debugInfo = {}) {
  let cleanUrl = url;
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }

  let host = '';
  try {
    host = new URL(cleanUrl).hostname.replace('www.', '');
  } catch (_) {}

  const baseStoreName = extractStoreName(host);

  const referer = `https://${host}/`;
  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer,
    'Sec-Ch-Ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };

  let html = '';
  try {
    const response = await fetch(cleanUrl, {
      headers: fetchHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });
    debugInfo.fetchStatus = response.status;
    html = await response.text();
    debugInfo.htmlLength = html.length;
    if (html.includes('<title>')) {
      const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      debugInfo.pageTitle = tm ? tm[1].trim() : null;
    }
  } catch (err) {
    debugInfo.fetchError = err.message;
    console.warn('Direct fetch failed, continuing with URL slug fallbacks:', err.message);
  }

  // 1. Run store-specific native extractor
  const storeData = extractStoreDetails(cleanUrl, html);
  const storeName = storeData.storeName || baseStoreName;

  // 2. Structured JSON-LD
  const jsonLd = parseJsonLd(html);

  // 3. OpenGraph / Twitter meta tags
  const ogTitle = extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title');
  const ogImage = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image');
  const ogPrice = extractMetaTag(html, 'og:price:amount') || extractMetaTag(html, 'product:price:amount');

  // 4. Resolve Title (Priority: Structured Store Title -> JSON-LD -> OpenGraph -> Slug -> Raw Title)
  let finalTitle = null;
  if (isValidTitle(storeData.storeTitle)) finalTitle = storeData.storeTitle.trim();
  else if (isValidTitle(jsonLd?.title)) finalTitle = jsonLd.title.trim();
  else if (isValidTitle(ogTitle)) finalTitle = ogTitle.trim();
  else if (storeData.slugTitle) finalTitle = storeData.slugTitle;
  else {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const rawTitleTag = titleMatch ? titleMatch[1].replace(/[\r\n\t]+/g, ' ').trim() : null;
    if (isValidTitle(rawTitleTag)) finalTitle = rawTitleTag;
    else finalTitle = storeName !== 'Online Store' ? `Item from ${storeName}` : 'Shared Product';
  }

  // 5. Resolve Image (Priority: Store Image -> JSON-LD -> OpenGraph -> CDN Fallback)
  const finalImage = storeData.storeImage
    || jsonLd?.image
    || (ogImage && !ogImage.includes('favicon') ? ogImage : null)
    || storeData.cdnImage
    || null;

  // 6. Resolve Price & Range
  let finalPrice = storeData.storePrice || jsonLd?.price || (ogPrice ? parseFloat(ogPrice) : null);
  let minPrice = jsonLd?.minPrice || finalPrice;
  let maxPrice = jsonLd?.maxPrice || null;
  let priceRangeText = null;

  if (minPrice && maxPrice && maxPrice > minPrice) {
    priceRangeText = `$${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`;
  } else {
    const rangeInHtml = extractPriceRange(html);
    if (rangeInHtml) {
      minPrice = rangeInHtml.low;
      maxPrice = rangeInHtml.high;
      priceRangeText = rangeInHtml.text;
      finalPrice = minPrice;
    }
  }

  // Disallow invalid prices (<= 0.0)
  if (finalPrice !== null && finalPrice <= 0) finalPrice = null;
  if (minPrice !== null && minPrice <= 0) minPrice = null;

  return {
    success: true,
    url: cleanUrl,
    title: finalTitle,
    storeName: storeName,
    price: finalPrice,
    minPrice: minPrice,
    maxPrice: maxPrice,
    priceRangeText: priceRangeText,
    imageUrl: finalImage
  };
}

module.exports = async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, debug } = req.query;
  const isDebug = debug === '1';
  const debugInfo = {};

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Missing required "url" query parameter'
    });
  }

  const trimmedUrl = url.trim();

  try {
    // 1. eBay Track (Uses official eBay Developer Browse API - 100% reliable)
    const ebayItemId = extractEbayItemId(trimmedUrl);
    if (ebayItemId) {
      debugInfo.ebayItemId = ebayItemId;
      debugInfo.hasEbayClientId = Boolean(EBAY_CLIENT_ID);
      debugInfo.hasEbaySecret = Boolean(EBAY_CLIENT_SECRET);
      try {
        const ebayData = await resolveEbayProduct(ebayItemId, trimmedUrl);
        if (isDebug) ebayData.debug = debugInfo;
        return res.status(200).json(ebayData);
      } catch (ebayErr) {
        debugInfo.ebayError = ebayErr.message;
        console.warn('eBay API resolution failed, falling back to native extractor:', ebayErr.message);
      }
    }

    // 2. Native Multi-Store Engine for all stores (Zero Crawlbase in Phase 1)
    const result = await resolveUniversalProduct(trimmedUrl, debugInfo);
    if (isDebug) result.debug = debugInfo;
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error resolving product metadata:', error);
    return res.status(500).json({
      success: false,
      url: trimmedUrl,
      error: error.message || 'Failed to extract metadata',
      debug: isDebug ? debugInfo : undefined
    });
  }
};
