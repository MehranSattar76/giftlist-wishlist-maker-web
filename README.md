# GiftList & WishList Maker - Official Companion Website

This is the standalone companion website for **GiftList & WishList Maker** for Android, developed by **MZ Developers** (`mzdevelopers001@gmail.com`).

The site is built with pure HTML5, CSS3, and JavaScript. It is strictly compliant with the operating policies of **Amazon Associates** and the **eBay Partner Network (EPN)**.

The gift-planning articles live on the dedicated `/gift-guide` page. The Google Play and Apple App Store icon placeholders are intentionally inactive until the official download URLs are available.
The home page previews the guides as linked cards. Visitors can search and filter the full guide collection and save favourites; saved guides are kept in browser storage on that device.

---

## Compliance Highlights

- **Amazon Associates Disclaimer**: Prominently displayed in the site footer and `/disclosure`:
  > *"As an Amazon Associate I earn from qualifying purchases."*
- **eBay Partner Network Disclosure**: Full EPN partnership disclosures on `/disclosure` and footer.
- **Product Pricing & Availability Notice**: Explicit disclaimers warning users that prices fluctuate and the retailer's checkout page is definitive.
- **Privacy Policy (`/privacy`)**: Discloses local Room database storage, third-party cookies, affiliate tracking, and GDPR/CCPA rights.
- **Terms of Service (`/terms`)**: Clarifies third-party merchant responsibilities (Amazon/eBay handling checkout/shipping/returns).
- **Contact (`/contact`)**: Publisher contact details with `mzdevelopers001@gmail.com`.

---

## Deployment

The HTML, CSS, and browser JavaScript can be served by a standard web server. The `api/product.js` metadata endpoint is a Node.js serverless handler and needs a compatible runtime or adapter; serving the static files alone will not provide that API.

---

## Submitting to Amazon Associates & eBay EPN

Once your website is live:
1. **Amazon Associates Central**:
   - In the **Websites and Mobile Apps List** step, paste your public website URL under **Website List**.
   - Describe your website: *"A mobile app companion site and gift registry planner that helps users organize event budgets, track gift ideas, and compare products across Amazon and other retailers."*
   - Under topics, select: *Home/Family/Pets*, *Shopping*, or *Tech*.
2. **eBay Partner Network (EPN)**:
   - Paste your public website URL as your primary Promotional Property.
   - Business Model: *Shopping Comparison / Loyalty & Registry Tool*.
