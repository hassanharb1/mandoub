/* The app in a real browser at phone size: the rep's main flows, step by step.
   Run: npm test   (or: node --test tests/app.test.mjs) */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { staticServer, browser, phone, realData, wait } from "./helpers.mjs";

let srv, b;
before(async () => { srv = await staticServer(); b = await browser(); });
after(async () => { await b?.close(); await srv?.close(); });

const click = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) throw new Error("missing " + s); e.click(); }, sel);

test("opens with no errors, every tab draws, no sideways scroll (light and dark, 360 and 390)", async () => {
  for (const [width, dark] of [[390, false], [360, true]]) {
    const page = await phone(b, srv.url, { width, dark });
    for (const tab of ["home", "customers", "orders", "products", "money"]) {
      await click(page, `#nav [data-go="${tab}"]`); await wait(80);
      assert.ok(await page.evaluate(() => document.querySelector("#view").innerText.trim().length > 0), `${tab} is empty`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${tab} scrolls sideways at ${width}px`);
    }
    await click(page, "#settingsBtn"); await wait(150);
    const heads = await page.evaluate(() => [...document.querySelectorAll(".sheet h2")].map(h => h.textContent).join("|"));
    for (const h of ["حسابك", "الإشعارات", "البيانات", "تحديث البرنامج"]) assert.ok(heads.includes(h), `settings missing ${h}`);
    assert.equal(await page.evaluate(() => !!document.querySelector("#bootErr")), false, "red error banner");
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test("النوتة reads names, amounts, Arabic digits, «ألف» and «قديمة»", async () => {
  const page = await phone(b, srv.url);
  const r = await page.evaluate(() => ["محمد 500", "سيد 2 ألف قديمة", "1- النور: 1,200 ج تحويل", "احمد ٣٠٠", "بدون مبلغ"].map(l => { const x = __T.parseNoteLine(l); return [x.name, x.amount, x.note, x.old, x.err]; }));
  assert.deepEqual(r[0], ["محمد", 500, "", false, ""]);
  assert.deepEqual(r[1].slice(0, 2), ["سيد", 2000]); assert.equal(r[1][3], true);
  assert.deepEqual(r[2].slice(0, 3), ["النور", 1200, "تحويل"]);
  assert.deepEqual(r[3].slice(0, 2), ["احمد", 300]);
  assert.equal(r[4][4], "اكتب المبلغ");
  await page.context().close();
});

test("look-alike names are caught, different ones aren't", async () => {
  const page = await phone(b, srv.url);
  const r = await page.evaluate(() => [["الحاج سيد", "سيد"], ["معرض النور للكهرباء", "النور للكهرباء"], ["الأمانة", "الامانه"], ["محمد", "احمد"], ["الصفا", "المروة"]].map(([a, c]) => __T.sameName(a, c)));
  assert.deepEqual(r, [true, true, true, false, false]);
  await page.context().close();
});

test("order sums: cartons × pieces, discount % and amount", async () => {
  const page = await phone(b, srv.url);
  const r = await page.evaluate(() => {
    const items = [{ qty: 2, unit: "ك", per: 10, price: 5 }, { qty: 3, unit: "ق", price: 20 }];
    return [__T.orderMoney({ items, disc: 10 }), __T.orderMoney({ items, discAmt: 16 }), __T.orderMoney({ items, subManual: 500 })].map(m => [m.sub, m.disc, m.net]);
  });
  assert.deepEqual(r, [[160, 16, 144], [160, 16, 144], [500, 0, 500]]);
  await page.context().close();
});

test("new order → discount question → send → it counts on the customer's account", async () => {
  const page = await phone(b, srv.url); await realData(page);
  const cid = await page.evaluate(() => __T.S.customers[0].id), b0 = await page.evaluate(id => __T.balance(id), cid);
  await page.evaluate(id => __T.orderEditor({ customerId: id }), cid); await wait(300);
  await click(page, "#plist [data-p]"); await wait(100);
  await click(page, "#oSend"); await wait(150);
  assert.ok(await page.$("#scrim2 [data-dq]"), "the discount question didn't show");
  await click(page, '#scrim2 [data-dq="0"]'); await wait(300);
  assert.match(await page.evaluate(() => document.querySelector(".sheet h3").textContent), /ابعت الطلب/);
  await click(page, "#stx"); await wait(600);
  const o = await page.evaluate(() => __T.S.orders.slice().sort((a, b) => b.created - a.created)[0]);
  assert.equal(o.status, "sent");
  const net = await page.evaluate(o => __T.total(o), o);
  assert.ok(net > 0);
  assert.equal(await page.evaluate(id => __T.balance(id), cid), b0 + net, "balance didn't grow by the order");
  assert.ok(await page.evaluate(([id, no]) => __T.custLedger(id).some(l => l.s === `طلب رقم ${no}`), [cid, o.no]), "no ledger line for the order");
  // an old demo order (sent before ordFrom) stays out
  assert.equal(await page.evaluate(() => __T.S.orders.filter(x => x.created < __T.S.ordFrom && __T.ordOn(x)).length), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("النوتة saves collections; «لسه ما اتبعتش» sends them, turns green, and undo works", async () => {
  const page = await phone(b, srv.url); await realData(page);
  const name = await page.evaluate(() => __T.S.customers[0].name), u0 = await page.evaluate(() => __T.unsentPays().length);
  await page.evaluate(() => __T.noteSheet()); await wait(150);
  await page.fill("#nt", `${name} 500\n${name} 250 قديمة`); await wait(200);
  assert.match(await page.evaluate(() => document.querySelector("#nsave").textContent), /احفظ 2/);
  await click(page, "#nsave"); await wait(300);
  assert.equal(await page.evaluate(() => __T.unsentPays().length), u0 + 2);
  await page.evaluate(() => __T.closeSheet());
  await click(page, '#nav [data-go="money"]'); await wait(200);
  assert.match(await page.evaluate(() => document.querySelector("#usSec").innerText), /لسه ما اتبعتش/);
  assert.ok(await page.evaluate(() => __T.unsentPays().reduce((a, p) => a + p.amount, 0)) >= 750);
  await click(page, "#usTxt"); await wait(500);
  assert.equal(await page.evaluate(() => __T.unsentPays().length), 0);
  assert.match(await page.evaluate(() => document.querySelector("#usSec").innerText), /كل التحصيلات اتبعتت/);
  await click(page, "#usUndo"); await wait(200);
  assert.equal(await page.evaluate(() => __T.unsentPays().length), u0 + 2);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("the phone's back button: closes the sheet, then goes Home, then asks before leaving", async () => {
  const page = await phone(b, srv.url);
  await click(page, '#nav [data-go="customers"]'); await wait(100);
  await click(page, "#settingsBtn"); await wait(150);
  await page.goBack(); await wait(200);
  assert.equal(await page.$("#scrim"), null, "back didn't close the sheet");
  await page.goBack(); await wait(200);
  assert.equal(await page.evaluate(() => document.querySelector('#nav [aria-current="page"]').dataset.go), "home");
  await page.goBack(); await wait(200);
  assert.match(await page.evaluate(() => document.querySelector(".toast")?.textContent || ""), /دوس رجوع تاني علشان تخرج/);
  await page.context().close();
});

test("send several orders at once marks the drafts sent", async () => {
  const page = await phone(b, srv.url); await realData(page);
  assert.ok(await page.evaluate(() => __T.S.orders.some(o => o.status === "draft")), "demo has no draft to send");
  await page.evaluate(() => __T.multiSendSheet()); await wait(200);
  await click(page, "#msTxt"); await wait(500);
  assert.equal(await page.evaluate(() => __T.S.orders.filter(o => o.status === "draft").length), 0);
  await page.context().close();
});

test("look-alike customers: warned on the list, merged with everything moved", async () => {
  const page = await phone(b, srv.url); await realData(page);
  const a = await page.evaluate(() => { const c = __T.S.customers[1]; __T.S.customers.push({ id: "dupx", name: "الحاج " + c.name, owner: "", area: "", phone: "", opening: 100 });
    __T.S.payments.push({ id: "pdup", customerId: "dupx", amount: 70, date: Date.now(), at: Date.now() }); __T.save(); return c; });
  const n0 = await page.evaluate(() => __T.S.customers.length), bal0 = await page.evaluate(id => __T.balance(id), a.id);
  await click(page, '#nav [data-go="customers"]'); await wait(150);
  assert.ok(await page.$("#dupBtn"), "no look-alike warning");
  await page.evaluate(id => __T.mergeSheet(id, "dupx"), a.id); await wait(200);
  await click(page, "#mgGo"); await wait(200);
  assert.equal(await page.evaluate(() => __T.S.customers.length), n0 - 1);
  assert.equal(await page.evaluate(() => __T.S.payments.find(p => p.id === "pdup").customerId), a.id);
  assert.equal(await page.evaluate(id => __T.balance(id), a.id), bal0 + 100 - 70, "opening balances didn't add up");
  await page.context().close();
});

test("products: the list draws in parts and search finds by name and code", async () => {
  const page = await phone(b, srv.url);
  await click(page, '#nav [data-go="products"]'); await wait(200);
  const first = await page.evaluate(() => document.querySelectorAll(".pcard").length);
  assert.ok(first > 0 && first <= 24, `drew ${first} cards at once`);
  await page.fill("#vq", "EV-400"); await wait(400);
  assert.match(await page.evaluate(() => document.querySelector("#vlist").innerText), /دلاية ماسورة/);
  await page.fill("#vq", "مجناتيك"); await wait(400);
  assert.ok(await page.evaluate(() => document.querySelectorAll(".pcard").length) > 3);
  await page.context().close();
});

test("the colleague's page opens and explains a missing link", async () => {
  const page = await (await b.newContext()).newPage();
  const errs = []; page.on("pageerror", e => errs.push(e.message));
  await page.goto(srv.url + "/colleague.html"); await wait(300);
  assert.match(await page.evaluate(() => document.querySelector("#list").innerText), /الرابط/);
  assert.deepEqual(errs, []);
  await page.context().close();
});

test("a crash is reported: queued with its details (sent to /api/err when the server answers), the same one only once", async () => {
  const page = await phone(b, srv.url);
  await page.evaluate(() => { localStorage.removeItem("mandoub.errq"); setTimeout(() => { null.boom(); }, 0); setTimeout(() => { null.boom(); }, 0); });
  await wait(400);
  const q = await page.evaluate(() => JSON.parse(localStorage.getItem("mandoub.errq") || "[]"));
  assert.equal(q.length, 1, "the same error was queued twice");
  assert.match(q[0].msg, /null/); assert.equal(q[0].ver > 0, true); assert.equal(q[0].view, "home");
  assert.equal(await page.evaluate(() => !!document.querySelector("#bootErr")), true, "the red banner didn't show");
  await page.context().close();
});

test("customer statement: running balance ends at what he owes, for each period; picture and text are ready", async () => {
  const page = await phone(b, srv.url); await realData(page);
  const cid = await page.evaluate(() => __T.S.customers.find(c => __T.S.payments.some(p => p.customerId === c.id)).id);
  await click(page, '#nav [data-go="customers"]'); await wait(100);
  await page.evaluate(id => __T.go("customer", id), cid); await wait(200);
  await click(page, "#cStmt");
  await page.waitForSelector("#stimg img", { timeout: 10000 });
  for (const d of ["30", "90", "0"]) {
    await click(page, `[data-sd="${d}"]`); await page.waitForSelector("#stimg img", { timeout: 10000 });
    const txt = await page.evaluate(() => document.querySelector("#sttx").textContent), bal = await page.evaluate(id => Math.round(__T.balance(id)), cid);
    assert.match(txt, new RegExp(`(عليه دلوقتي|ليه عندنا): ${Math.abs(bal).toLocaleString("en-US")} ج`), `period ${d}: the total doesn't match the balance`);
  }
  assert.match(await page.evaluate(() => document.querySelector("#sttx").textContent), /رصيد أول المدة/);
  assert.equal(await page.evaluate(() => document.querySelector("#stimgb").disabled), false);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("an order written as text: counts, cartons, sizes, colours and codes find the right products; unsure lines ask", async () => {
  const page = await phone(b, srv.url);
  const r = await page.evaluate(() => ["20 سبوت عيون 12 وات ابيض", "5 كرتونة كشاف ايفورا 100 وات", "3 تراك عيون متحرك 12w اسود", "4 EV-400", "8 سلندر فارغ 15 سم", "7 لمبة كاسة", "2 مروحة سقف"]
    .map(l => { const x = __T.parseOrderLine(l), m = __T.matchProducts(x, 3); return { q: x.qty, u: x.unit, c: x.color, top: m[0] && m[0].p.name, sure: m.sure, n: m.length }; }));
  assert.deepEqual(r[0], { q: 20, u: "ق", c: "ابيض", top: "سبوت عيون 12 وات", sure: true, n: r[0].n });
  assert.deepEqual([r[1].q, r[1].u, r[1].top, r[1].sure], [5, "ك", "كشاف إيفورا 100 وات", true]);
  assert.deepEqual([r[2].c, r[2].top, r[2].sure], ["اسود", "تراك عيون متحرك 12 وات", true]);
  assert.deepEqual([r[3].q, r[3].top, r[3].sure], [4, "دلاية ماسورة فارغ", true]);
  assert.deepEqual([r[4].top, r[4].sure], ["سلندر فارغ 15 سم", true]);
  assert.equal(r[5].sure, false, "an unclear line didn't ask"); assert.ok(r[5].n > 1);
  assert.equal(r[6].n, 0, "a product that isn't in the list matched something");
  assert.deepEqual(await page.evaluate(() => __T.splitOrderText("20 لمبة 12 وات و 5 سبوت عيون، 3 دلاية")), ["20 لمبة 12 وات", "5 سبوت عيون", "3 دلاية"]);
  // in the order screen: write, pick the unclear one, add
  await page.evaluate(() => __T.orderEditor({ customerId: __T.S.customers[0].id })); await wait(300);
  await click(page, "#otxt"); await wait(150);
  await page.fill("#otx", "20 سبوت عيون 12 وات ابيض\n7 لمبة كاسة\n2 مروحة سقف"); await wait(150);
  assert.equal(await page.evaluate(() => document.querySelector("#oadd").disabled), true);
  await click(page, ".nask [data-op]"); await wait(100);
  await click(page, "#oadd"); await wait(300);
  assert.match(await page.evaluate(() => document.querySelector("#ocount").textContent), /3 أصناف/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("today's route: why each customer is on it, «زرته» moves him to the bottom, the day summary, and maps links", async () => {
  const page = await phone(b, srv.url); await realData(page);
  const L = await page.evaluate(() => __T.routeList().map(x => ({ id: x.c.id, why: x.why.join(" · "), done: x.done })));
  assert.ok(L.length >= 3, "the demo should give a few customers to visit");
  assert.ok(L.every(x => x.why), "a customer is on the route with no reason");
  assert.ok(L.some(x => /مستني/.test(x.why)) && L.some(x => /عليه/.test(x.why)) && L.some(x => /طلبه/.test(x.why)));
  await click(page, "#hRoute"); await wait(200);
  await click(page, "[data-rv]"); await wait(150);
  const after = await page.evaluate(() => __T.routeList());
  assert.equal(after[after.length - 1].done, true, "a visited customer didn't go to the bottom");
  assert.match(await page.evaluate(() => __T.daySummary()), /زرت 1 عميل/);
  const urls = await page.evaluate(() => [__T.mapsUrl({ name: "النور", area: "العصافرة" }), __T.mapsUrl({ name: "x", loc: { lat: 31.2, lng: 29.9 } })]);
  assert.match(urls[0], /maps\/search\/\?api=1&query=/); assert.match(urls[1], /destination=31\.2,29\.9/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("monthly report: orders, collections, best customers and products add up; the picture renders", async () => {
  const page = await phone(b, srv.url); await realData(page);
  const R = await page.evaluate(() => { const d = new Date(); return __T.monthData(d.getFullYear(), d.getMonth()); });
  const check = await page.evaluate(() => { const d = new Date(), a = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const os = __T.S.orders.filter(o => o.status !== "draft" && ((o.hist && o.hist.sent) || o.created) >= a);
    return { n: os.length, net: Math.round(os.reduce((x, o) => x + __T.total(o), 0)), pays: __T.S.payments.filter(p => p.date >= a).reduce((x, p) => x + p.amount, 0) }; });
  assert.equal(R.orders, check.n); assert.equal(Math.round(R.net), check.net); assert.equal(R.pays, check.pays);
  assert.ok(R.topC.length > 0 && R.topC.every((x, i, l) => !i || l[i - 1].sum >= x.sum), "best customers aren't sorted");
  assert.match(await page.evaluate(R => __T.reportText(R), R), /تقرير شهر/);
  await click(page, '#nav [data-go="money"]'); await wait(100);
  await click(page, "#mRep"); await page.waitForSelector("#rpimg img", { timeout: 10000 });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("the one main button opens the four everyday actions; the first-run guide shows once and comes back from settings; rare settings are folded", async () => {
  const page = await phone(b, srv.url, { guide: true });
  await page.waitForSelector(".guide", { timeout: 3000 });
  assert.match(await page.evaluate(() => document.querySelector(".guide h2").textContent), /اكتب الطلب/);
  await click(page, "#gnext"); await click(page, "#gnext"); await click(page, "#gnext"); await wait(100);
  assert.equal(await page.$(".guide"), null, "the guide didn't close");
  await page.reload(); await page.waitForFunction(() => window.__T); await wait(1000);
  assert.equal(await page.$(".guide"), null, "the guide showed twice");
  await click(page, "#fab"); await wait(150);
  assert.equal(await page.evaluate(() => document.querySelectorAll("[data-nm]").length), 4);
  await click(page, '[data-nm="order"]'); await wait(300);
  assert.match(await page.evaluate(() => document.querySelector(".sheet h3").textContent), /طلب جديد/);
  await page.evaluate(() => __T.closeSheet());
  await click(page, "#settingsBtn"); await wait(150);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".sec.fold .btns, .sec.fold .card, .sec.fold .list")).display), "none", "a rare section isn't folded");
  await click(page, "#sguide"); await wait(150);
  assert.ok(await page.$(".guide"), "«شرح البرنامج» didn't bring the guide back");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("companies: each has its colour and name tag; collections carry the company (النوتة word, «الشركة» for all, the sheet) and totals split by company", async () => {
  const page = await phone(b, srv.url); await realData(page);
  assert.notEqual(await page.evaluate(() => __T.coColor("ev")), await page.evaluate(() => __T.coColor("wl")));
  assert.deepEqual(await page.evaluate(() => [__T.parseNoteLine("محمد 500 وايت").co, __T.parseNoteLine("سيد 2 ألف ايفورا قديمة").co, __T.parseNoteLine("علي 300 تحويل").co, __T.parseNoteLine("محمد 500 وايت لايت تحويل").note]), ["wl", "ev", "", "تحويل"]);
  await click(page, '#nav [data-go="products"]'); await wait(200);
  assert.ok(await page.evaluate(() => document.querySelectorAll(".pcard .cotag").length > 0), "no company tag on the products");
  const name = await page.evaluate(() => __T.S.customers[0].name);
  await page.evaluate(() => __T.noteSheet()); await wait(150);
  await click(page, '[data-nco="ev"]');
  await page.fill("#nt", `${name} 500\n${name} 300 وايت`); await wait(200);
  await click(page, "#nsave"); await wait(300);
  const cos = await page.evaluate(() => __T.S.payments.slice(-2).map(p => p.co));
  assert.deepEqual(cos, ["ev", "wl"]);
  assert.match(await page.evaluate(() => __T.coSplit(__T.S.payments.slice(-2))), /إيفورا: 500 ج · وايت لايت: 300 ج/);
  await page.evaluate(() => __T.closeSheet());
  // the single collection sheet remembers the customer's last company
  await page.evaluate(id => __T.collectSheet(id), await page.evaluate(() => __T.S.customers[0].id)); await wait(150);
  assert.equal(await page.evaluate(() => document.querySelector('[data-pco][aria-pressed="true"]').dataset.pco), "wl");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("one payment for two companies: split in the collection sheet, or one line in النوتة, becomes a collection per company", async () => {
  const page = await phone(b, srv.url); await realData(page);
  assert.deepEqual(await page.evaluate(() => [__T.expandNoteLine("محمد 10000 ايفورا 10000 وايت"), __T.expandNoteLine("سيد ٢ ألف وايت ٣ ألف ايفورا"), __T.expandNoteLine("علي 500 فاتورة 12"), __T.expandNoteLine("النور 1,200 تحويل")]),
    [["محمد 10000 ايفورا", "محمد 10000 وايت"], ["سيد 2 ألف وايت", "سيد 3 ألف ايفورا"], ["علي 500 فاتورة 12"], ["النور 1,200 تحويل"]]);
  const c = await page.evaluate(() => __T.S.customers[0]), n0 = await page.evaluate(() => __T.S.payments.length);
  await page.evaluate(() => __T.noteSheet()); await wait(150);
  await page.fill("#nt", `${c.name} 10000 ايفورا 10000 وايت`); await wait(200);
  assert.match(await page.evaluate(() => document.querySelector("#nsave").textContent), /احفظ 2/);
  await click(page, "#nsave"); await wait(300);
  assert.deepEqual(await page.evaluate(() => __T.S.payments.slice(-2).map(p => [p.amount, p.co])), [[10000, "ev"], [10000, "wl"]]);
  await page.evaluate(() => __T.closeSheet());
  await page.evaluate(id => __T.collectSheet(id), c.id); await wait(150);
  await click(page, "#psplit"); await wait(100);
  await page.fill('[data-psa="ev"]', "4000"); await page.fill('[data-psa="wl"]', "6000"); await wait(100);
  assert.equal(await page.evaluate(() => document.querySelector("#pa").value), "10000");
  await click(page, "#ps"); await wait(300);
  assert.deepEqual(await page.evaluate(() => __T.S.payments.slice(-2).map(p => [p.amount, p.co])), [[4000, "ev"], [6000, "wl"]]);
  assert.equal(await page.evaluate(() => __T.S.payments.length), n0 + 4);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
