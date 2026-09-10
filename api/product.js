// api/product.js - Serverless Metadata Resolution Service for Vercel
// Supports eBay Developer Browse API & Universal E-Commerce Fallbacks

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
  
  // Format standard item ID or try REST-style ID
  const itemRestId = `v1|${itemId}|0`;
  let apiUrl = `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemRestId)}`;
  
  let response = await fetch(apiUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    // Fallback directly to legacy format
    apiUrl = `https://api.ebay.com/buy/browse/v1/item/${itemId}`;
    response = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Accept': 'application/json'
      }
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

  // Reverse attribute order: content="..." property="..."
  const altRegex = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, 'i');
  const altMatch = html.match(altRegex);
  return altMatch && altMatch[1] ? altMatch[1].trim() : null;
}

function extractSlugTitle(url) {
  // Amazon
  const amzMatch = url.match(/amazon\.[a-z.]+\/([^/?#]+)\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i);
  if (amzMatch && amzMatch[1] && !['dp', 'gp'].includes(amzMatch[1].toLowerCase())) {
    return amzMatch[1].replace(/[-_]/g, ' ').trim();
  }
  // Target
  const tgtMatch = url.match(/target\.[a-z.]+\/p\/([^/?#]+)\/-\/A-\d+/i);
  if (tgtMatch && tgtMatch[1]) return tgtMatch[1].replace(/[-_]/g, ' ').trim();
  // Walmart
  const wmtMatch = url.match(/walmart\.[a-z.]+\/ip\/([^/?#]+)\/\d+/i);
  if (wmtMatch && wmtMatch[1]) return wmtMatch[1].replace(/[-_]/g, ' ').trim();
  // Etsy
  const etsyMatch = url.match(/etsy\.[a-z.]+\/listing\/\d+\/([^/?#]+)/i);
  if (etsyMatch && etsyMatch[1]) return etsyMatch[1].replace(/[-_]/g, ' ').trim();
  // Best Buy
  const bbMatch = url.match(/bestbuy\.[a-z.]+\/site\/([^/?#]+)\/\d+\.p/i);
  if (bbMatch && bbMatch[1]) return bbMatch[1].replace(/[-_]/g, ' ').trim();

  return null;
}

async function resolveUniversalProduct(url) {
  let cleanUrl = url;
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }

  let host = '';
  try {
    host = new URL(cleanUrl).hostname.replace('www.', '');
  } catch (_) {}

  const storeName = extractStoreName(host);
  const slugTitle = extractSlugTitle(cleanUrl);

  const response = await fetch(cleanUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000)
  });

  const html = await response.text();

  // 1. Try structured JSON-LD
  const jsonLd = parseJsonLd(html);

  // 2. OpenGraph / Twitter meta tags
  const ogTitle = extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title');
  const ogImage = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image');
  const ogPrice = extractMetaTag(html, 'og:price:amount') || extractMetaTag(html, 'product:price:amount');

  // 3. Smart Title Validation & Selection
  function isValidTitle(t) {
    if (!t || typeof t !== 'string') return false;
    const lower = t.toLowerCase().trim();
    if (lower.length < 3) return false;
    if (lower.includes('undefined')) return false;
    if (lower.includes('robot') || lower.includes('captcha')) return false;
    if (lower.includes('access denied') || lower.includes('page not found') || lower.includes('error page')) return false;
    if (lower.includes('item not available')) return false;
    return true;
  }

  let finalTitle = null;
  if (isValidTitle(jsonLd?.title)) finalTitle = jsonLd.title.trim();
  else if (isValidTitle(ogTitle)) finalTitle = ogTitle.trim();
  else if (slugTitle) finalTitle = slugTitle;
  else if (isValidTitle(rawTitleTag)) finalTitle = rawTitleTag.trim();
  else finalTitle = storeName !== 'Online Store' ? `Item from ${storeName}` : 'Shared Product';

  // 4. Fallback Image
  const finalImage = jsonLd?.image || ogImage || null;

  // 5. Price & Range Parsing
  let finalPrice = jsonLd?.price || (ogPrice ? parseFloat(ogPrice) : null);
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

  // Disallow invalid prices (e.g. 0.00)
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

async function resolveWithCrawlbase(url) {
  const token = process.env.CRAWLBASE_TOKEN || '';
  if (!token) return null;

  try {
    const endpoint = `https://api.crawlbase.com/?token=${token}&autoparse=true&url=${encodeURIComponent(url)}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    const body = data.body;
    if (!body) return null;

    const title = body.name || body.title;
    if (!title || typeof title !== 'string' || !title.trim()) return null;

    const priceVal = typeof body.price === 'number' ? body.price : parseFloat(body.price);
    const image = body.mainImage || body.main_image || (Array.isArray(body.images) ? body.images[0] : null) || (Array.isArray(body.highResolutionImages) ? body.highResolutionImages[0] : null);

    let storeName = 'Online Store';
    if (url.includes('amazon') || url.includes('a.co') || url.includes('amzn.to')) storeName = 'Amazon';
    else if (url.includes('walmart')) storeName = 'Walmart';
    else if (url.includes('target')) storeName = 'Target';
    else if (url.includes('bestbuy')) storeName = 'Best Buy';
    else if (url.includes('etsy')) storeName = 'Etsy';

    return {
      success: true,
      url: url,
      title: title.trim(),
      storeName: storeName,
      price: !isNaN(priceVal) && priceVal > 0 ? priceVal : null,
      minPrice: !isNaN(priceVal) && priceVal > 0 ? priceVal : null,
      maxPrice: null,
      priceRangeText: null,
      imageUrl: image || null
    };
  } catch (err) {
    console.warn('Crawlbase extraction failed:', err.message);
    return null;
  }
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

  const { url } = req.query;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Missing required "url" query parameter'
    });
  }

  const trimmedUrl = url.trim();

  try {
    // 1. eBay Track (Uses official eBay Browse API - saves Crawlbase credits)
    const ebayItemId = extractEbayItemId(trimmedUrl);
    if (ebayItemId) {
      try {
        const ebayData = await resolveEbayProduct(ebayItemId, trimmedUrl);
        return res.status(200).json(ebayData);
      } catch (ebayErr) {
        console.warn('eBay API resolution failed, falling back to universal extractor:', ebayErr.message);
      }
    }

    // 2. Amazon Track (Heavily anti-bot gated - prioritize Crawlbase parser if token is set)
    if (trimmedUrl.includes('amazon.') || trimmedUrl.includes('a.co') || trimmedUrl.includes('amzn.to')) {
      const cbResult = await resolveWithCrawlbase(trimmedUrl);
      if (cbResult && cbResult.title) {
        return res.status(200).json(cbResult);
      }
    }

    // 3. Fast Universal resolution for other stores
    const result = await resolveUniversalProduct(trimmedUrl);
    const hasMeaningfulTitle = result && result.title && !result.title.startsWith('Item from') && !result.title.startsWith('Shared Product');
    if (hasMeaningfulTitle && (result.price != null || result.imageUrl != null)) {
      return res.status(200).json(result);
    }

    // 4. Fallback to Crawlbase if direct extraction had missing details or was gated
    const cbFallback = await resolveWithCrawlbase(trimmedUrl);
    if (cbFallback && cbFallback.title) {
      return res.status(200).json(cbFallback);
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error resolving product metadata:', error);
    return res.status(500).json({
      success: false,
      url: trimmedUrl,
      error: error.message || 'Failed to extract metadata'
    });
  }
};
