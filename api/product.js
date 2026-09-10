// api/product.js - Serverless Metadata Resolution Service for Vercel
// Phase 1: Pure Native Multi-Store Extraction Engine
// Phase 2: Targeted Store-Specific Crawlbase Fallback Engine (Amazon, Walmart, Best Buy, Target, Etsy)
// Supports eBay Developer Browse API & Store-Specific Parsers

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const CRAWLBASE_TOKEN = process.env.CRAWLBASE_TOKEN || '';

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

  // Try 4: Item Group (for listings with variations/options)
  if (!response.ok) {
    const groupResp = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=${itemId}`, {
      headers
    });
    if (groupResp.ok) {
      const groupData = await groupResp.json();
      const firstItem = groupData.items?.[0];
      if (firstItem) {
        const pVal = parseFloat(firstItem.price?.value);
        return {
          success: true,
          url: rawUrl,
          title: firstItem.title || 'eBay Item',
          storeName: 'eBay',
          price: !isNaN(pVal) && pVal > 0 ? pVal : null,
          minPrice: !isNaN(pVal) && pVal > 0 ? pVal : null,
          maxPrice: null,
          priceRangeText: null,
          imageUrl: firstItem.image?.imageUrl || firstItem.additionalImages?.[0]?.imageUrl || null,
          affiliateUrl: firstItem.itemAffiliateWebUrl || firstItem.itemWebUrl || rawUrl
        };
      }
    }
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

async function resolveUniversalProduct(url, debugInfo = {}, providedHtml = null) {
  let cleanUrl = url;
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }

  let host = '';
  try {
    host = new URL(cleanUrl).hostname.replace('www.', '');
  } catch (_) {}

  const baseStoreName = extractStoreName(host);

  let html = '';
  if (providedHtml && typeof providedHtml === 'string' && providedHtml.length > 50) {
    html = providedHtml;
    debugInfo.source = debugInfo.crawlbaseTriggered ? 'crawlbase-unblocked-html' : 'client-assisted-edge-fetch';
    debugInfo.htmlLength = html.length;
    if (html.includes('<title>')) {
      const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      debugInfo.pageTitle = tm ? tm[1].trim() : null;
    }
  } else {
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

    try {
      const response = await fetch(cleanUrl, {
        headers: fetchHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(8000)
      });
      debugInfo.fetchStatus = response.status;
      html = await response.text();
      debugInfo.htmlLength = html.length;
      debugInfo.source = 'server-direct-fetch';
      if (html.includes('<title>')) {
        const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        debugInfo.pageTitle = tm ? tm[1].trim() : null;
      }
    } catch (err) {
      debugInfo.fetchError = err.message;
      console.warn('Direct fetch failed, continuing with URL slug fallbacks:', err.message);
    }
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

function parsePriceValue(priceVal) {
  if (typeof priceVal === 'number' && !isNaN(priceVal) && priceVal > 0) {
    return priceVal;
  }
  if (priceVal && typeof priceVal === 'object') {
    const candidate = priceVal.value || priceVal.amount || priceVal.price;
    return parsePriceValue(candidate);
  }
  if (typeof priceVal !== 'string') return null;
  const cleaned = priceVal.replace(/,/g, '').trim();
  const match = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
  if (match) {
    const val = parseFloat(match[1]);
    return !isNaN(val) && val > 0 ? val : null;
  }
  return null;
}

function getCrawlbaseScraperName(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('amazon.') || host.includes('amzn.')) {
      return 'amazon-product-details';
    }
    if (host.includes('walmart.')) {
      return 'walmart-product-details';
    }
    if (host.includes('bestbuy.')) {
      return 'bestbuy-product-details';
    }
    if (host.includes('ebay.')) {
      return 'ebay-product';
    }
  } catch (_) {}
  return null;
}

async function fetchViaCrawlbase(targetUrl, debugInfo = {}) {
  if (!CRAWLBASE_TOKEN) {
    debugInfo.crawlbaseSkipped = 'Missing CRAWLBASE_TOKEN';
    return null;
  }

  const scraperName = getCrawlbaseScraperName(targetUrl);
  let countryParam = '&country=US';
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    if (host.endsWith('.co.uk')) countryParam = '&country=UK';
    else if (host.endsWith('.de')) countryParam = '&country=DE';
    else if (host.endsWith('.fr')) countryParam = '&country=FR';
    else if (host.endsWith('.ca')) countryParam = '&country=CA';
  } catch (_) {}

  let apiUrl = '';
  if (scraperName) {
    apiUrl = `https://api.crawlbase.com/?token=${CRAWLBASE_TOKEN}&url=${encodeURIComponent(targetUrl)}&scraper=${encodeURIComponent(scraperName)}${countryParam}`;
    debugInfo.crawlbaseMode = `scraper:${scraperName}`;
  } else {
    apiUrl = `https://api.crawlbase.com/?token=${CRAWLBASE_TOKEN}&url=${encodeURIComponent(targetUrl)}${countryParam}`;
    debugInfo.crawlbaseMode = 'crawling-api-html';
  }

  try {
    const cbResp = await fetch(apiUrl, {
      signal: AbortSignal.timeout(28000)
    });

    debugInfo.crawlbaseStatus = cbResp.status;
    const pcStatus = cbResp.headers.get('pc_status');
    if (pcStatus) debugInfo.crawlbasePcStatus = pcStatus;

    if (!cbResp.ok) {
      const errText = await cbResp.text();
      debugInfo.crawlbaseError = `HTTP ${cbResp.status}: ${errText.slice(0, 200)}`;
      return null;
    }

    if (scraperName) {
      const data = await cbResp.json();
      debugInfo.crawlbaseJsonReceived = true;
      debugInfo.crawlbaseRawData = data;

      const title = (data.title || data.name || '').trim();
      const rawPrice = data.price;
      const parsedPrice = parsePriceValue(rawPrice);
      const image = data.main_image || (Array.isArray(data.images) && data.images.length > 0 ? data.images[0] : null) || data.image || null;

      let minPrice = parsedPrice;
      let maxPrice = null;
      let priceRangeText = null;

      if (typeof rawPrice === 'string' && rawPrice.includes('-')) {
        const parts = rawPrice.split('-');
        const low = parsePriceValue(parts[0]);
        const high = parsePriceValue(parts[1]);
        if (low && high && high > low) {
          minPrice = low;
          maxPrice = high;
          priceRangeText = `$${low.toFixed(2)} - $${high.toFixed(2)}`;
        }
      }

      let storeName = 'Online Store';
      try {
        const host = new URL(targetUrl).hostname.replace('www.', '');
        storeName = extractStoreName(host);
      } catch (_) {}

      return {
        success: true,
        url: targetUrl,
        title: title || (storeName !== 'Online Store' ? `Item from ${storeName}` : 'Shared Product'),
        storeName: storeName,
        price: parsedPrice,
        minPrice: minPrice,
        maxPrice: maxPrice,
        priceRangeText: priceRangeText,
        imageUrl: image,
        source: `crawlbase-${scraperName}`
      };
    } else {
      const unblockedHtml = await cbResp.text();
      debugInfo.crawlbaseHtmlLength = unblockedHtml ? unblockedHtml.length : 0;
      if (!unblockedHtml || unblockedHtml.length < 50) {
        debugInfo.crawlbaseError = 'Crawlbase returned empty HTML';
        return null;
      }

      debugInfo.crawlbaseBypassed = true;
      const parsed = await resolveUniversalProduct(targetUrl, debugInfo, unblockedHtml);
      if (parsed) {
        parsed.source = 'crawlbase-crawling-api';
      }
      return parsed;
    }
  } catch (err) {
    debugInfo.crawlbaseError = err.message;
    console.warn('Crawlbase request failed:', err.message);
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

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {}
  }

  const targetUrl = (body?.url || req.query.url || '').trim();
  const clientHtml = (body?.html && typeof body.html === 'string') ? body.html : null;
  const isDebug = (body?.debug === '1' || req.query.debug === '1');
  const ebaySearch = body?.ebaySearch || req.query.ebaySearch;
  const debugInfo = {};

  if (ebaySearch) {
    try {
      const token = await getEbayAccessToken();
      const sRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(ebaySearch)}&limit=2`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Accept': 'application/json'
        }
      });
      const sJson = await sRes.json();
      return res.status(200).json({ status: sRes.status, data: sJson });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Missing required "url" query or body parameter'
    });
  }

  try {
    // 1. eBay Track (Uses official eBay Developer Browse API - 100% reliable)
    const ebayItemId = extractEbayItemId(targetUrl);
    if (ebayItemId) {
      debugInfo.ebayItemId = ebayItemId;
      debugInfo.hasEbayClientId = Boolean(EBAY_CLIENT_ID);
      debugInfo.hasEbaySecret = Boolean(EBAY_CLIENT_SECRET);
      try {
        const ebayData = await resolveEbayProduct(ebayItemId, targetUrl);
        if (isDebug) ebayData.debug = debugInfo;
        return res.status(200).json(ebayData);
      } catch (ebayErr) {
        debugInfo.ebayError = ebayErr.message;
        console.warn('eBay API resolution failed, falling back to native extractor:', ebayErr.message);
      }
    }

    // 2. Native Multi-Store Engine (Client-Assisted edge fetch or Server direct fetch)
    let result = await resolveUniversalProduct(targetUrl, debugInfo, clientHtml);

    // 3. Phase 2: Smart Targeted Crawlbase Fallback Engine
    // Triggers ONLY when:
    // - Explicitly requested via crawlbase=1 or body.crawlbase=true, OR
    // - Native resolution could not obtain a valid price AND CRAWLBASE_TOKEN is configured
    const forceCrawlbase = (req.query.crawlbase === '1' || body?.crawlbase === true);
    const priceMissing = (result.price === null || result.price === undefined || result.price <= 0);
    const shouldTryCrawlbase = Boolean(CRAWLBASE_TOKEN && (forceCrawlbase || priceMissing));

    if (shouldTryCrawlbase) {
      debugInfo.crawlbaseTriggered = true;
      debugInfo.crawlbaseTriggerReason = forceCrawlbase ? 'explicit-request' : 'missing-price';
      try {
        const cbResult = await fetchViaCrawlbase(targetUrl, debugInfo);
        if (cbResult && cbResult.success) {
          const hasCbPrice = (cbResult.price !== null && cbResult.price > 0);
          const hasCbImage = Boolean(cbResult.imageUrl);
          const hasBetterTitle = isValidTitle(cbResult.title) && (
            !result.title ||
            result.title.startsWith('Item from') ||
            result.title === 'Shared Product' ||
            hasCbPrice
          );

          result = {
            success: true,
            url: targetUrl,
            title: hasBetterTitle ? cbResult.title : result.title,
            storeName: cbResult.storeName || result.storeName,
            price: hasCbPrice ? cbResult.price : result.price,
            minPrice: (cbResult.minPrice !== null && cbResult.minPrice > 0) ? cbResult.minPrice : result.minPrice,
            maxPrice: (cbResult.maxPrice !== null && cbResult.maxPrice > 0) ? cbResult.maxPrice : result.maxPrice,
            priceRangeText: cbResult.priceRangeText || result.priceRangeText,
            imageUrl: hasCbImage ? cbResult.imageUrl : result.imageUrl,
            affiliateUrl: cbResult.affiliateUrl || result.affiliateUrl
          };
          debugInfo.crawlbaseMerged = true;
        }
      } catch (cbErr) {
        debugInfo.crawlbaseFallbackError = cbErr.message;
        console.warn('Crawlbase fallback failed:', cbErr.message);
      }
    }

    if (isDebug) result.debug = debugInfo;
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error resolving product metadata:', error);
    return res.status(500).json({
      success: false,
      url: targetUrl,
      error: error.message || 'Failed to extract metadata',
      debug: isDebug ? debugInfo : undefined
    });
  }
};
