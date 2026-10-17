# دفتر المندوب (Mandoub) — project notes for Claude Code

A mobile PWA for a sales rep at an electrical-supplies company in Alexandria, Egypt. Built by **MESTK** (Hassan's company — always spelled MESTK, never MSETK). The rep is Hassan's friend; this is a live trial, with a SaaS version for many reps/companies as a possible next step.

Talk to Hassan in Egyptian Arabic. All UI copy is natural Egyptian Arabic: short, plain, no tashkeel.

## The user and his problem
- The rep visits traders and shops (عملاء) and takes orders. He carries **no stock**.
- He sends each order to a colleague at the company over WhatsApp. The colleague enters it into the company system, and the company ships to the customer.
- He **collects payments himself** and hands the cash to the company.
- Before the app he used phone notes plus WhatsApp. His pain points: forgetting to send orders (for example, an order taken on Tuesday that both he and the customer forgot), tracking collections, and remembering customer requests for items not in stock.
- His phone is **Android** with Chrome. Hassan tests on an iPhone.
- What the rep said matters most: **"the important thing is that it's easy to use on the phone."**

## What the app does (v1, in production)
- **النهارده (Home):** cash in hand, money still owed by customers, collected today, orders today, plus a «محتاج تفتكر» list. That list shows unsent draft orders, sent orders nobody confirmed, customers waiting for something, customers who broke their usual ordering rhythm, and overdue balances.
- **العملاء (Customers):** list sorted by balance. A visit screen shows the balance, open orders, pending requests, what the customer usually buys, a "repeat last order" button and a ledger.
- **Customer picker** (order, collection, quick capture): a search-as-you-type panel, empty query lists the 8 most recently touched customers (orders/payments/requests); the chosen id sits in a hidden input that fires `change`.
- **طلب جديد (New order):** pick a customer (خصم العميل % and الدفع sit right under it), then a «★ بياخد عادةً» chip with that customer's usual products (opened by default when he has history), then products by company tab (إيفورا / وايت لايت / «اخترت»), search (name or code, across both companies) and category chips. Each product row has its photo (tap to enlarge), price per piece, +/− with a **ق (قطعة) / ك (كرتونة)** toggle next to the count, colour quick-picks taken from the product name (ابيض/اسود/ورم/دهبي…, `item.color`) and a free note per line (`item.note`). **No money total on the order screen** (carton prices are unknown, so a sum would be wrong). «+ عميل جديد» under the customer picker adds a customer (name, area) without leaving the order. A free-text item is still possible. Each order also has **خصم العميل %** (empty by default, typed per order; `o.disc`, shown as a %) and **الدفع** كاش / آجل / بعدين (`o.pay`: `cash` / `credit` / `""`; changeable from the order sheet; a sent order still on «بعدين» shows in «محتاج تفتكر»). Both appear in the message and, in the picture, as a highlighted strip under the header. Colour quick-picks only show when the name offers a choice (2+ colours). Save as a draft, or send.
- **Sending:** the send sheet draws the order as a **picture with the product photos** (canvas → JPEG) and the rep picks **«ابعت الصورة»** (picture only) **or «ابعت الرسالة»** (text only) — not both; each opens the share menu so it can go to the colleague or a WhatsApp group (text falls back to `wa.me`). Order status steps: draft → sent → registered → shipped → delivered.
- **المنتجات (Catalog tab):** browse both price lists as a photo grid, search, tap a product to enlarge it or start an order with it.
- **سجّل بسرعة (Quick capture):** customer plus free text (or voice), saved as a pending request until it is converted to an order or closed.
- **الفلوس (Money):** record collections, record «سلّمت للشركة» handovers to the company, cash in hand = collections − handovers, money owed, and recent movements. Collections and handovers have a **date (day picker, weekday shown)** and can be **edited or deleted** by tapping them (in الفلوس or the customer's ledger). «سجّل وابعته للجروب» saves a collection and opens the share menu with a short text (customer, amount, day, remaining balance) so it can go to a WhatsApp group or a person.
- **Home collections counter:** «حصّلت النهارده» counts from `S.colFrom` (start of today if never set). Tapping it lists those collections (editable) and «صفّر العداد» sets `S.colFrom` to now — nothing is deleted and cash in hand doesn't change.
- **رصيد أول المدة (opening balance):** flexible — عليه (owes) or ليه (credit, stored negative), with a «لحد يوم» date (`openingDate`); editable from the customer form or by tapping it in the ledger.
- **Notifications (no server):** on every save the page writes `notify.json` to the `mandoub-notify` cache: reminders for the 6 «محتاج تفتكر» kinds (draft not sent, sent not confirmed, customer waiting, late customer, overdue balance, no backup), each with the time it becomes due and switchable in Settings (`S.settings.notif`). `sw.js` shows the due ones on `periodicsync` (Chrome Android, installed app only, timing chosen by Chrome, roughly once or twice a day) and won't repeat the same list within 20 h. Not on iOS. Reliable, specific pushes need the sync server or the APK.
- **Settings:** rep name, colleague name and WhatsApp number, a reminder delay for unsent orders, backup and restore as JSON, clearing the demo data, restoring the demo data.
- **Commission was removed on purpose.** Hassan asked for that. Do not add it back.

## Tech
- One self-contained file, `public/index.html`, written in vanilla JS with no framework and no build step, plus `catalog.js` (the product list, ~30 KB, loaded before the app), `catalog-img.js` (all product photos as WebP data URIs, ~850 KB, loaded **after** the app opens so a slow line never blocks it; no image folder, so a dashboard upload can't miss it), `sw.js` (offline cache), `manifest.json` and the icons.
- Data lives in **localStorage** under the key `mandoub.v1`, as one JSON state object `S`: `settings, products, carton (unused now), customers, orders, requests, payments, handovers, adjusts, seq, demo, since, lastBackup`. Products are **not** in `S`: they come from `catalog.js` (`self.CATALOG`); `S.products` only keeps products from older versions so old orders still resolve. Order items: `{pid, qty, unit:"ق"|"ك", color, note, price, name}` (name and price are a snapshot).
- A customer's balance = `opening` + `S.adjusts` − payments. Orders are **not** added (no reliable amounts, and the rep never sees the invoice: the colleague deals with the company). The rep controls the account with **«ظبط الحساب»** on the customer page: «عليه كام» (set to the company's figure; the difference is stored), «زوّد عليه» or «نزّل من عليه». Each is a dated, editable line `{id, customerId, amount (signed), date, note}` in the ledger.
- **Products:** 228 real products from two company price lists Hassan sent (Aug 2026): **إيفورا** (Evora, 12-page scanned PDF, hand-transcribed; prices exclude VAT) and **وايت لايت** (White Light, 9-page table). Prices are per piece. Photos were cropped from the PDFs, ~320px WebP in `catalog-img.js`. To update prices, edit `catalog.js` directly; for a new list, re-extract.
- The app ships with **demo data** (fictional customers and orders, marked by a banner) that uses real catalog products. On boot, an old demo state (placeholder products `p1…p16`) is replaced by the new demo, keeping settings; non-demo data is never touched.
- **Never block the first paint** (the rep's Android sat on the splash screen once): the Google Font loads non-blocking, photos load after render, and `sw.js` falls back to the cached copy after 4 s on a slow line. A red banner shows any JS error on screen so the rep can screenshot it.
- On boot the app calls `navigator.storage.persist()`. A backup-reminder card appears on Home after 3 days without a backup, but only when demo mode is off.
- **Voice:** the Web Speech API (`ar-EG`) is used on Android only, with an 8 s no-speech watchdog and a 25 s hard stop. On **iOS the mic button is hidden** and a hint points to the keyboard's own mic, because Web Speech hangs in iOS home-screen web apps.
- Design: MESTK brand colors (Charcoal `#282825`, Burnt Orange `#BD572F`, Warm Cream `#F5F0E7`), the Cairo font, RTL, light and dark themes through CSS tokens. Body text is about 15px, tap targets are at least 36px, and the side gutter is 16px.

## Hosting and deploy
- **Live URL:** https://mandoub-mestk.hassan-mestkawy.workers.dev, served as a Cloudflare Worker with static assets. Hassan's Cloudflare account also hosts easy-drive-system and mestk-platform.
- **Netlify is not an option:** `*.netlify.app` is blocked in Egypt (ERR_CONNECTION_TIMED_OUT without a VPN).
- Deploy from this folder with `npx wrangler deploy` (it reads `wrangler.jsonc`, the worker name `mandoub-mestk` and the `./public` folder). The first run asks Hassan to log in with `npx wrangler login`. A manual alternative: Cloudflare dashboard → mandoub-mestk → New deployment → upload the `public` folder.
- **On every release, bump `CACHE` in `public/sw.js`** (currently `mandoub-v15`) so phones pick up the update. `sw.js` is network-first for the page, so the update arrives on the next app open. The user's data is never touched by a deploy.

## How to test
- `npx serve public` or `python -m http.server -d public`, then open it at a phone width (about 360–400px) in DevTools device mode.
- Check both themes, the Arabic text and numbers, no horizontal scroll, and the flow "new order → WhatsApp message → mark sent".
- To test the backup reminder: set `S.demo=false` and move `S.since` back more than 3 days in localStorage.

## Agreed next steps (in order)
1. **Wait for the trial feedback.** The rep uses the app for 1–2 weeks while keeping his old WhatsApp routine in parallel. Fix whatever he gets stuck on first.
2. **Ease-of-use pass** (proposed, not yet approved or built):
   - one main action button instead of two (new order and quick capture)
   - ~~customer picker becomes search, with recent customers first~~ — done
   - bigger tap targets and text
   - ~~each customer's frequent products shown first~~ — done
   - a 3-screen first-run guide
   - rarely used things (full ledger, settings) moved out of the way
3. ~~Replace the demo products with the real product list~~ — done (إيفورا + وايت لايت). Carton contents/prices are not tracked (the rep asked to drop the amounts).
4. **Cloud backup and sync with Supabase** (chosen over Cloudflare D1 because it has built-in auth and row-level security). Use email login rather than SMS OTP, which costs per message. Keep the app offline-first and sync when online. Hosting stays on Cloudflare.
5. Later: an Android APK (for reliable daily notifications), then a multi-rep, multi-company **SaaS** with a colleague/manager screen that receives orders directly instead of over WhatsApp.

## Related assets
- A 57 s explainer video (`mandoub-explainer`, MESTK brand, 12 scenes) lives in the MESTK Motion Studio at `Downloads\MESTK\mestk-motion-studio`. Its spec is `src/videos/mandoub-explainer.ts` and its screenshots are in `public/media/mandoub/`. If the UI changes a lot, re-capture the screens and re-render.

## Rules
- Never invent the company's products, prices, customers or contact details. Demo data stays clearly labelled as demo.
- Keep the app a single static site with no build step unless Hassan agrees to change that.
- Ask Hassan before anything that could wipe or migrate the rep's stored data.
