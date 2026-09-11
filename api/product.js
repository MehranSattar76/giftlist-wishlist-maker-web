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

// Container boot time for serverless lifecycle diagnostics
const CONTAINER_BOOT_TIME = Date.now();
const CONTAINER_ID = `cnt_${Math.random().toString(36).substring(2, 8)}`;

// Rolling in-memory log buffer (stores last 50 requests across warm serverless invocations)
const MAX_LOGS = 50;
const requestLogs = [];

function recordRequestLog(entry) {
  const logObj = {
    id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    containerId: CONTAINER_ID,
    ...entry
  };
  requestLogs.unshift(logObj);
  if (requestLogs.length > MAX_LOGS) {
    requestLogs.pop();
  }
  // Permanent structured metric log to Vercel Runtime Logs dashboard
  console.log('[API_METRIC]', JSON.stringify(logObj));
}

function renderLogsHtml(logs) {
  const rows = logs.map(l => {
    const statusBadge = l.success
      ? '<span style="color:#0f5132;background:#d1e7dd;padding:2px 8px;border-radius:4px;font-weight:600;">200 OK</span>'
      : `<span style="color:#842029;background:#f8d7da;padding:2px 8px;border-radius:4px;font-weight:600;">ERR: ${l.error || 'Failed'}</span>`;
    
    const imgPreview = l.imageUrl
      ? `<a href="${l.imageUrl}" target="_blank"><img src="${l.imageUrl}" style="max-height:40px;max-width:40px;border-radius:4px;object-fit:cover;" /></a>`
      : '<span style="color:#888;">None</span>';
    
    const priceDisplay = (l.price !== null && l.price !== undefined)
      ? `<strong>$${Number(l.price).toFixed(2)}</strong>`
      : '<span style="color:#888;">—</span>';

    const cbInfo = l.crawlbaseTriggered
      ? `<span style="color:#055160;background:#cff4fc;padding:2px 6px;border-radius:3px;font-size:11px;">${l.crawlbaseMode || 'yes'} (${l.crawlbaseStatus || '—'})</span>`
      : '<span style="color:#888;font-size:11px;">Skipped</span>';

    const cleanTitle = (l.title || 'Untitled').length > 40
      ? (l.title || 'Untitled').slice(0, 40) + '…'
      : (l.title || 'Untitled');

    const shortUrl = (l.url || '').length > 45
      ? (l.url || '').slice(0, 45) + '…'
      : (l.url || '');

    return `<tr>
      <td style="font-size:12px;white-space:nowrap;">${l.timestamp ? l.timestamp.split('T')[1].split('.')[0] : '—'}</td>
      <td><strong>${l.method}</strong></td>
      <td><span style="background:#f0f2f5;padding:2px 6px;border-radius:3px;font-weight:500;">${l.store || 'Store'}</span></td>
      <td><a href="${l.url}" target="_blank" title="${l.url}" style="color:#0d6efd;text-decoration:none;">${shortUrl}</a></td>
      <td title="${l.title || ''}">${cleanTitle}</td>
      <td>${priceDisplay}</td>
      <td style="text-align:center;">${imgPreview}</td>
      <td><span style="font-size:11px;color:#555;">${l.source || '—'}</span></td>
      <td>${cbInfo}</td>
      <td style="font-size:12px;text-align:right;">${l.durationMs || 0}ms</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Vercel Request Logs - Wishlist & Giftlist Metadata Engine</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fa; color: #212529; margin: 0; padding: 20px; }
    .container { max-width: 1300px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); padding: 24px; }
    h1 { font-size: 22px; margin-top: 0; display: flex; align-items: center; justify-content: space-between; }
    .meta { color: #6c757d; font-size: 13px; margin-bottom: 20px; }
    .actions { display: flex; gap: 10px; }
    .btn { background: #0d6efd; color: #fff; padding: 6px 14px; border-radius: 4px; text-decoration: none; font-size: 13px; font-weight: 500; }
    .btn-secondary { background: #6c757d; }
    .btn-danger { background: #dc3545; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }
    th { text-align: left; padding: 10px; background: #f1f3f5; border-bottom: 2px solid #dee2e6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 10px; border-bottom: 1px solid #e9ecef; vertical-align: middle; }
    tr:hover { background-color: #f8f9fa; }
    .empty { padding: 40px; text-align: center; color: #888; font-size: 15px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      <span>Vercel In-Memory Request Logs (${logs.length} / ${MAX_LOGS})</span>
      <div class="actions">
        <a href="?logs=1&format=html" class="btn">Refresh</a>
        <a href="?logs=1" class="btn btn-secondary" target="_blank">View JSON</a>
        <a href="?clearLogs=1" class="btn btn-danger" onclick="return confirm('Clear logs?')">Clear Logs</a>
      </div>
    </h1>
    <div class="meta">
      Captures real-time metadata resolution requests across warm serverless invocations. Shows client Edge fetches, server fetches, Crawlbase triggers, and final parsed fields.
    </div>
    ${logs.length === 0 ? '<div class="empty">No requests recorded yet. Make a request via the mobile app or API to see live traces.</div>' : `
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Method</th>
            <th>Store</th>
            <th>Target URL</th>
            <th>Resolved Title</th>
            <th>Price</th>
            <th>Image</th>
            <th>Source</th>
            <th>Crawlbase</th>
            <th>Latency</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    `}
  </div>
</body>
</html>`;
}

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
  if (lower.startsWith('undefined')) return false;
  if (lower.includes('undefined : target')) return false;
  if (lower.includes('robot') || lower.includes('captcha') || lower.includes('human')) return false;
  if (lower.includes('access denied') || lower.includes('page not found') || lower.includes('error page')) return false;
  if (lower.includes('item not available')) return false;
  if (lower.includes('expect more. pay less.')) return false;
  if (lower === 'target' || lower === 'walmart' || lower === 'amazon' || lower === 'best buy' || lower === 'etsy') return false;
  return true;
}

function extractAmazonPrice(html) {
  if (!html || typeof html !== 'string') return null;

  // 1. Scoped Buybox containers (Core price displays - desktop and mobile Chrome viewports)
  // Mobile Amazon uses corePriceDisplay_mobile_feature_div, corePrice_mobile_feature_div, apex_mobile, newAccordionRow
  const buyboxContainerRegex = /id=["'](?:corePriceDisplay_desktop_feature_div|corePriceDisplay_mobile_feature_div|corePrice_feature_div|corePrice_mobile_feature_div|apex_desktop|apex_mobile|price_inside_buybox|priceblock_ourprice|priceblock_dealprice|mobilePrice_feature_div|apex_dp_inside_header|booksHeaderSection|tmmSwatches|buyBoxAccordion|newAccordionRow)["'][\s\S]{0,1400}?(?:class=["'](?:a-price\s*[^"']*|a-size-base\s*a-color-price[^"']*)["'][\s\S]{0,400}?(?:<span class=["']a-offscreen["']>\s*\$([0-9,.]+)|>\s*\$([0-9,.]+)\s*<\/span>)|(?:<span class=["']a-offscreen["']>\s*\$([0-9,.]+)))/i;
  const buyboxMatch = html.match(buyboxContainerRegex);
  if (buyboxMatch) {
    const pStr = (buyboxMatch[1] || buyboxMatch[2] || buyboxMatch[3] || '').replace(/,/g, '');
    const val = parseFloat(pStr);
    if (!isNaN(val) && val > 0) return val;
  }

  // 2. Primary buybox price offscreen (aok-align-center, priceToPay, reinventPricePriceToPayMargin)
  const offscreenMatch = html.match(/class=["'][^"']*(?:priceToPay|reinventPricePriceToPayMargin|aok-align-center)[^"']*["'][^>]*>[\s\S]{0,300}?<span class=["']a-offscreen["']>\s*\$([0-9,.]+)/i)
    || html.match(/<span class=["']a-price\s+aok-align-center[^"']*["'][^>]*>[\s\S]*?<span class=["']a-offscreen["']>\s*\$([0-9,.]+)/i);
  if (offscreenMatch) {
    const val = parseFloat(offscreenMatch[1].replace(/,/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }

  // 3. Whole + Fraction inside buybox or core price display (desktop & mobile)
  const wholeFractionRegex = /id=["'](?:corePriceDisplay_desktop_feature_div|corePriceDisplay_mobile_feature_div|corePrice_feature_div|corePrice_mobile_feature_div|apex_desktop|apex_mobile|price_inside_buybox|mobilePrice_feature_div)["'][\s\S]{0,1400}?class=["']a-price-whole["']>(\d+)<[\s\S]*?class=["']a-price-fraction["']>(\d+)</i;
  const wfMatch = html.match(wholeFractionRegex);
  if (wfMatch) {
    const val = parseFloat(`${wfMatch[1]}.${wfMatch[2]}`);
    if (!isNaN(val) && val > 0) return val;
  }

  // 4. Check embedded twister / buybox JSON ONLY inside verified buybox or twister blocks
  // (NEVER do un-scoped global priceAmount search which matches $2,500 Amazon Visa card promo)
  const twisterMatch = html.match(/"desktop_buybox_group[^"]*":\s*\[\s*\{[^}]*?"priceAmount":\s*(\d+(?:\.\d+)?)/i)
    || html.match(/"mobile_buybox_group[^"]*":\s*\[\s*\{[^}]*?"priceAmount":\s*(\d+(?:\.\d+)?)/i)
    || html.match(/twister-plus-buying-options-price-data["'][^>]*>[\s\S]*?"priceAmount":\s*(\d+(?:\.\d+)?)/i);
  if (twisterMatch) {
    const val = parseFloat(twisterMatch[1]);
    if (!isNaN(val) && val > 0) return val;
  }

  // 5. Books slot-price
  const slotMatch = html.match(/class=["']slot-price["'][^>]*>[\s\S]*?class=["'][^"']*a-color-price[^"']*["']>\s*\$([0-9,.]+)/i);
  if (slotMatch) {
    const val = parseFloat(slotMatch[1].replace(/,/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }

  // 6. Generic core price whole + fraction across top portion of page (capped to reasonable bounds)
  const genericWf = html.match(/class=["']a-price-whole["']>(\d+)<[\s\S]{0,80}?class=["']a-price-fraction["']>(\d+)</i);
  if (genericWf) {
    const val = parseFloat(`${genericWf[1]}.${genericWf[2]}`);
    if (!isNaN(val) && val > 0 && val < 50000) return val;
  }

  return null;
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

    let amzImage = null;
    const imgMatch = html.match(/id=["']landingImage["'][^>]*data-old-hires=["']([^"']+)["']/i)
      || html.match(/id=["']landingImage["'][^>]*src=["']([^"']+)["']/i)
      || html.match(/data-a-dynamic-image=["']\{&quot;(https:\/\/[^&"]+)&quot;/i);
    if (imgMatch) amzImage = imgMatch[1];

    const amzPrice = extractAmazonPrice(html);

    return {
      storeName: 'Amazon',
      asin,
      slugTitle,
      cdnImage,
      storeImage: amzImage,
      storePrice: amzPrice
    };
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
    const tcinMatch = cleanUrl.match(/\/A-(\d{7,10})/i) || cleanUrl.match(/\/p\/[^\/]+\/(\d{7,10})/i);
    const tcin = tcinMatch ? (tcinMatch[1] || tcinMatch[2]) : null;
    const slugMatch = cleanUrl.match(/target\.[a-z.]+\/p\/([^/?#]+)\/-\/A-\d+/i)
      || cleanUrl.match(/target\.[a-z.]+\/p\/([^/?#]+)/i);
    const slugTitle = slugMatch ? cleanSlug(slugMatch[1]) : null;

    let targetPrice = null;

    // 1. Rendered HTML price selectors (data-test="current-price" / "product-price")
    const dtPriceMatch = html.match(/data-test=["'](?:current-price|product-price)["'][^>]*>[\s\S]*?\$([0-9,.]+)/i)
      || html.match(/class=["'][^"']*(?:CurrentPrice|styles__StyledPrice)[^"']*["'][^>]*>[\s\S]*?\$([0-9,.]+)/i)
      || html.match(/class=["'][^"']*Price[^"']*["'][^>]*>[\s\S]*?\$([0-9,.]+)/i);
    if (dtPriceMatch) {
      const p = parseFloat(dtPriceMatch[1].replace(/,/g, ''));
      if (!isNaN(p) && p > 0) targetPrice = p;
    }

    // 2. Embedded JSON / Next.js serialized values in HTML
    if (!targetPrice) {
      const priceJsonMatch = html.match(/"formatted_current_price"\s*:\s*"\$([0-9,.]+)"/i)
        || html.match(/"current_retail"\s*:\s*(\d+(?:\.\d+)?)/i)
        || html.match(/"current_retail_min"\s*:\s*(\d+(?:\.\d+)?)/i)
        || html.match(/"regular_price"\s*:\s*(\d+(?:\.\d+)?)/i)
        || html.match(/"price"\s*:\s*(\d+(?:\.\d+)?)/i);
      if (priceJsonMatch) {
        const p = parseFloat((priceJsonMatch[1] || '').replace(/,/g, ''));
        if (!isNaN(p) && p > 0) targetPrice = p;
      }
    }

    let targetImage = null;
    const scene7Match = html.match(/https:\/\/target\.scene7\.com\/is\/image\/Target\/[a-zA-Z0-9_-]+/i);
    if (scene7Match) targetImage = scene7Match[0];

    return { storeName: 'Target', tcin, slugTitle, storePrice: targetPrice, storeImage: targetImage };
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

    let etsyPrice = null;
    const priceMatch = html.match(/meta[^>]*property=["']product:price:amount["'][^>]*content=["'](\d+(?:\.\d+)?)["']/i)
      || html.match(/class=["']currency-value["']>(\d+(?:\.\d+)?)<\/span>/i)
      || html.match(/class=["'][^"']*wt-text-title-larger[^"']*["'][^>]*>[\s\S]*?\$(\d+(?:\.\d+)?)/i);
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
    const candidate = priceVal.currentPrice
      || priceVal.price
      || priceVal.value
      || priceVal.amount
      || priceVal.regularPrice
      || priceVal.salePrice;
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
    const isTarget = targetUrl.toLowerCase().includes('target.com');
    const autoParseParam = isTarget ? '&autoparse=true' : '';
    apiUrl = `https://api.crawlbase.com/?token=${CRAWLBASE_TOKEN}&url=${encodeURIComponent(targetUrl)}${autoParseParam}${countryParam}`;
    debugInfo.crawlbaseMode = isTarget ? 'crawling-api-autoparse' : 'crawling-api-html';
  }

  try {
    const isDedicatedScraper = Boolean(scraperName);
    const cbTimeout = isDedicatedScraper ? 28000 : 15000;
    const cbResp = await fetch(apiUrl, {
      signal: AbortSignal.timeout(cbTimeout)
    });

    debugInfo.crawlbaseStatus = cbResp.status;
    const pcStatus = cbResp.headers.get('pc_status');
    if (pcStatus) debugInfo.crawlbasePcStatus = pcStatus;

    if (!cbResp.ok) {
      const errText = await cbResp.text();
      debugInfo.crawlbaseError = `HTTP ${cbResp.status}: ${errText.slice(0, 200)}`;
      return null;
    }

    const contentType = cbResp.headers.get('content-type') || '';
    const rawText = await cbResp.text();
    let jsonData = null;
    if (contentType.includes('application/json') || (rawText.trim().startsWith('{') && rawText.trim().endsWith('}'))) {
      try {
        jsonData = JSON.parse(rawText);
      } catch (_) {}
    }

    if (scraperName || jsonData) {
      debugInfo.crawlbaseJsonReceived = true;
      debugInfo.crawlbaseRawData = jsonData;

      const item = jsonData?.body || jsonData?.data || jsonData || {};
      const title = (item.name || item.title || item.productTitle || item.product_name || '').trim();
      const rawPrice = item.price || item.rawPrice || item.currentPrice || item.salePrice;
      const parsedPrice = parsePriceValue(rawPrice);
      const image = item.thumbnail
        || item.mainImage
        || item.main_image
        || (Array.isArray(item.highResolutionImages) && item.highResolutionImages.length > 0 ? item.highResolutionImages[0] : null)
        || (Array.isArray(item.images) && item.images.length > 0 ? item.images[0] : null)
        || item.image
        || null;

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
        source: scraperName ? `crawlbase-${scraperName}` : 'crawlbase-autoparse'
      };
    } else {
      const unblockedHtml = rawText;
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

  // 1. In-Memory Request Logs Inspection Endpoints
  if (req.query.logs === '1' || req.query.viewLogs === '1') {
    const wantsHtml = req.query.format === 'html' || (!req.query.format && req.headers.accept?.includes('text/html'));
    if (wantsHtml) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(renderLogsHtml(requestLogs));
    }
    return res.status(200).json({
      success: true,
      totalRecorded: requestLogs.length,
      maxBuffer: MAX_LOGS,
      containerId: CONTAINER_ID,
      containerBootTime: new Date(CONTAINER_BOOT_TIME).toISOString(),
      containerUptimeSec: Math.floor((Date.now() - CONTAINER_BOOT_TIME) / 1000),
      persistenceNotice: "In-memory logs reflect recent requests handled by this specific warm serverless container instance. For permanent unified log history across all container instances and regions, view the Vercel Project Dashboard -> Logs tab.",
      logs: requestLogs
    });
  }

  if (req.query.clearLogs === '1') {
    requestLogs.length = 0;
    return res.status(200).json({ success: true, message: 'In-memory request logs cleared' });
  }

  const startTime = Date.now();
  const rawClientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
  const clientIp = rawClientIp.split(',')[0].trim() || 'unknown';

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
        const durationMs = Date.now() - startTime;
        recordRequestLog({
          method: req.method,
          url: targetUrl,
          store: 'eBay',
          clientIp,
          clientHtmlLength: clientHtml ? clientHtml.length : 0,
          source: 'ebay-browse-api',
          crawlbaseTriggered: false,
          crawlbaseMode: null,
          crawlbaseStatus: null,
          title: ebayData.title,
          price: ebayData.price,
          hasImage: Boolean(ebayData.imageUrl),
          imageUrl: ebayData.imageUrl,
          durationMs,
          success: true,
          error: null
        });
        console.log(`[REQ] ${req.method} eBay - ${ebayData.title?.slice(0, 30)} - $${ebayData.price} (${durationMs}ms)`);
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
    const suspiciousAmazonPrice = (result.storeName === 'Amazon' && result.price !== null && result.price > 500);
    const shouldTryCrawlbase = Boolean(CRAWLBASE_TOKEN && (forceCrawlbase || priceMissing || suspiciousAmazonPrice));

    if (shouldTryCrawlbase) {
      debugInfo.crawlbaseTriggered = true;
      debugInfo.crawlbaseTriggerReason = forceCrawlbase ? 'explicit-request' : (suspiciousAmazonPrice ? 'suspicious-high-price' : 'missing-price');
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

    // 4. Target Dedicated RedSky Aggregation Fallback (via Crawlbase proxy)
    // If Target price is still missing after HTML extraction and autoparse, query Target's official RedSky API
    const isTargetStillMissingPrice = (result.storeName === 'Target' && (result.price === null || result.price <= 0));
    const targetTcinMatch = targetUrl.match(/\/A-(\d{7,10})/i) || targetUrl.match(/\/p\/[^\/]+\/(\d{7,10})/i);
    const targetTcin = targetTcinMatch ? (targetTcinMatch[1] || targetTcinMatch[2]) : null;

    if (isTargetStillMissingPrice && targetTcin && CRAWLBASE_TOKEN) {
      debugInfo.targetRedskyTriggered = true;
      try {
        const redskyTargetUrl = `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&tcin=${targetTcin}&pricing_store_id=3991&has_pricing_store_id=true&is_override_store=false`;
        const cbRedskyApi = `https://api.crawlbase.com/?token=${CRAWLBASE_TOKEN}&url=${encodeURIComponent(redskyTargetUrl)}`;
        const redskyResp = await fetch(cbRedskyApi, { signal: AbortSignal.timeout(14000) });
        if (redskyResp.ok) {
          const rJson = await redskyResp.json();
          const prodData = rJson?.data?.product || rJson?.product;
          const prodPrice = prodData?.price;
          const currentRetail = prodPrice?.current_retail || prodPrice?.current_retail_min || prodPrice?.reg_retail;
          if (currentRetail && typeof currentRetail === 'number' && currentRetail > 0) {
            result.price = currentRetail;
            result.minPrice = prodPrice?.current_retail_min || currentRetail;
            result.maxPrice = prodPrice?.current_retail_max || null;
            if (result.minPrice && result.maxPrice && result.maxPrice > result.minPrice) {
              result.priceRangeText = `$${result.minPrice.toFixed(2)} - $${result.maxPrice.toFixed(2)}`;
            }
            if (!result.imageUrl && prodData?.item?.enrichment?.images?.primary_image_url) {
              result.imageUrl = prodData.item.enrichment.images.primary_image_url;
            }
            debugInfo.targetRedskySuccess = true;
            debugInfo.targetRedskyPrice = currentRetail;
          }
        }
      } catch (rErr) {
        debugInfo.targetRedskyError = rErr.message;
        console.warn('Target Redsky aggregation fallback failed:', rErr.message);
      }
    }

    const durationMs = Date.now() - startTime;
    recordRequestLog({
      method: req.method,
      url: targetUrl,
      store: result.storeName,
      clientIp,
      clientHtmlLength: clientHtml ? clientHtml.length : 0,
      source: result.source || debugInfo.source || 'native',
      crawlbaseTriggered: Boolean(debugInfo.crawlbaseTriggered),
      crawlbaseMode: debugInfo.crawlbaseMode || null,
      crawlbaseStatus: debugInfo.crawlbaseStatus || null,
      title: result.title,
      price: result.price,
      hasImage: Boolean(result.imageUrl),
      imageUrl: result.imageUrl,
      durationMs,
      success: true,
      error: null
    });
    console.log(`[REQ] ${req.method} ${result.storeName || 'Store'} - ${result.title?.slice(0, 30)} - $${result.price} (${durationMs}ms)`);

    if (isDebug) result.debug = debugInfo;
    return res.status(200).json(result);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    recordRequestLog({
      method: req.method,
      url: targetUrl,
      store: 'Unknown',
      clientIp,
      clientHtmlLength: clientHtml ? clientHtml.length : 0,
      source: 'error',
      crawlbaseTriggered: Boolean(debugInfo.crawlbaseTriggered),
      crawlbaseMode: debugInfo.crawlbaseMode || null,
      crawlbaseStatus: debugInfo.crawlbaseStatus || null,
      title: null,
      price: null,
      hasImage: false,
      imageUrl: null,
      durationMs,
      success: false,
      error: error.message || 'Failed to extract metadata'
    });
    console.error('[REQ_ERR] Error resolving product metadata:', error);
    return res.status(500).json({
      success: false,
      url: targetUrl,
      error: error.message || 'Failed to extract metadata',
      debug: isDebug ? debugInfo : undefined
    });
  }
};
