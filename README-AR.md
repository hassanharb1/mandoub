# دفتر المندوب

تطبيق موبايل للمندوب: طلبات العملاء على الواتساب، التحصيل والفلوس اللي معاه، وتذكير بالطلبات المنسية
من شغل MESTK

- اللينك: https://mandoub-mestk.hassan-mestkawy.workers.dev
- كل ملفات التطبيق في فولدر `public`
- كل التفاصيل والقرارات والخطوات الجاية في `CLAUDE.md`

## تكمل الشغل على Claude Code
افتح Claude Code على الفولدر ده واكتب مثلًا:
«اقرا CLAUDE.md وقولي فاهم إيه، وبعدين نبدأ في تعديلات سهولة الاستخدام»

## تنزل تحديث
`npx wrangler deploy` من جوه الفولدر ده
أو من موقع Cloudflare: مشروع mandoub-mestk ← New deployment ← ارفع فولدر `public`
وقبل أي تحديث غيّر رقم النسخة في `public/sw.js` (مثلًا mandoub-v5 ← mandoub-v6)
