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
- **طلب جديد (New order):** pick a customer and products (search, categories, +/− buttons, plus a free-text item). Save as a draft, or send as a numbered, formatted **WhatsApp message to the colleague** through a `wa.me` link. Order status steps: draft → sent → registered → shipped → delivered.
- **سجّل بسرعة (Quick capture):** customer plus free text (or voice), saved as a pending request until it is converted to an order or closed.
- **الفلوس (Money):** record collections, record «سلّمت للشركة» handovers to the company, cash in hand = collections − handovers, money owed, and recent movements.
- **Settings:** rep name, colleague name and WhatsApp number, a reminder delay for unsent orders, backup and restore as JSON, clearing the demo data, restoring the demo data.
- **Commission was removed on purpose.** Hassan asked for that. Do not add it back.

## Tech
- One self-contained file, `public/index.html`, written in vanilla JS with no framework and no build step, plus `sw.js` (offline cache), `manifest.json` and the icons.
- Data lives in **localStorage** under the key `mandoub.v1`, as one JSON state object `S`: `settings, products, customers, orders, requests, payments, handovers, seq, demo, since, lastBackup`.
- A customer's balance = `opening` + totals of orders with status **delivered** − payments.
- The app ships with **demo data** (fictional customers and products, marked by a banner). Products and prices are placeholders until Hassan sends the company's real product list.
- On boot the app calls `navigator.storage.persist()`. A backup-reminder card appears on Home after 3 days without a backup, but only when demo mode is off.
- **Voice:** the Web Speech API (`ar-EG`) is used on Android only, with an 8 s no-speech watchdog and a 25 s hard stop. On **iOS the mic button is hidden** and a hint points to the keyboard's own mic, because Web Speech hangs in iOS home-screen web apps.
- Design: MESTK brand colors (Charcoal `#282825`, Burnt Orange `#BD572F`, Warm Cream `#F5F0E7`), the Cairo font, RTL, light and dark themes through CSS tokens. Body text is about 15px, tap targets are at least 36px, and the side gutter is 16px.

## Hosting and deploy
- **Live URL:** https://mandoub-mestk.hassan-mestkawy.workers.dev, served as a Cloudflare Worker with static assets. Hassan's Cloudflare account also hosts easy-drive-system and mestk-platform.
- **Netlify is not an option:** `*.netlify.app` is blocked in Egypt (ERR_CONNECTION_TIMED_OUT without a VPN).
- Deploy from this folder with `npx wrangler deploy` (it reads `wrangler.jsonc`, the worker name `mandoub-mestk` and the `./public` folder). The first run asks Hassan to log in with `npx wrangler login`. A manual alternative: Cloudflare dashboard → mandoub-mestk → New deployment → upload the `public` folder.
- **On every release, bump `CACHE` in `public/sw.js`** (currently `mandoub-v4`) so phones pick up the update. `sw.js` is network-first for the page, so the update arrives on the next app open. The user's data is never touched by a deploy.

## How to test
- `npx serve public` or `python -m http.server -d public`, then open it at a phone width (about 360–400px) in DevTools device mode.
- Check both themes, the Arabic text and numbers, no horizontal scroll, and the flow "new order → WhatsApp message → mark sent".
- To test the backup reminder: set `S.demo=false` and move `S.since` back more than 3 days in localStorage.

## Agreed next steps (in order)
1. **Wait for the trial feedback.** The rep uses the app for 1–2 weeks while keeping his old WhatsApp routine in parallel. Fix whatever he gets stuck on first.
2. **Ease-of-use pass** (proposed, not yet approved or built):
   - one main action button instead of two (new order and quick capture)
   - customer picker becomes search, with recent customers first, instead of a `<select>`
   - bigger tap targets and text
   - each customer's frequent products shown first
   - a 3-screen first-run guide
   - rarely used things (full ledger, settings) moved out of the way
3. **Replace the demo products with the company's real product list** once Hassan sends it.
4. **Cloud backup and sync with Supabase** (chosen over Cloudflare D1 because it has built-in auth and row-level security). Use email login rather than SMS OTP, which costs per message. Keep the app offline-first and sync when online. Hosting stays on Cloudflare.
5. Later: an Android APK (for reliable daily notifications), then a multi-rep, multi-company **SaaS** with a colleague/manager screen that receives orders directly instead of over WhatsApp.

## Related assets
- A 57 s explainer video (`mandoub-explainer`, MESTK brand, 12 scenes) lives in the MESTK Motion Studio at `Downloads\MESTK\mestk-motion-studio`. Its spec is `src/videos/mandoub-explainer.ts` and its screenshots are in `public/media/mandoub/`. If the UI changes a lot, re-capture the screens and re-render.

## Rules
- Never invent the company's products, prices, customers or contact details. Demo data stays clearly labelled as demo.
- Keep the app a single static site with no build step unless Hassan agrees to change that.
- Ask Hassan before anything that could wipe or migrate the rep's stored data.
