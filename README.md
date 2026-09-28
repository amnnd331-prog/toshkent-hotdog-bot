# Faqat admin uchun Telegram Mini App — sozlash yo'riqnomasi

## Chek printeri — drayversiz, to'g'ridan-to'g'ri

Kassir **"Oshxonaga yuborish"** ni bosishi bilan (yoki mijoz buyurtmasi oshxonaga tushishi
bilan) chek printerdan o'zi chiqadi. Drayver ham, chop etish oynasi ham ishlatilmaydi —
chek printer tushunadigan ESC/POS baytlari ko'rinishida to'g'ridan-to'g'ri yuboriladi.

**Printer kompyuterga ulangan bo'lsa (USB yoki WiFi):** `print-agent/` dasturi ishlatiladi.
U printer ulangan kompyuterda ishlab turadi va yangi cheklarni serverdan olib, printerga yozadi.
Sozlash — 2 daqiqa: [print-agent/README.md](print-agent/README.md).

**Printer Android telefonga ulangan bo'lsa (Bluetooth / USB-OTG):** bepul **RawBT** ilovasi:
1. Play Market'dan **RawBT** (`ru.a402d.rawbtprinter`) ni o'rnating va printerni unga qo'shing.
2. Ilovada: Profil → Printer va chek → **Android telefon — RawBT ilovasi orqali**.

**Sozlamalar** (Profil → Printer va chek): qog'oz eni (58/80 mm), nusxalar soni, chek ostidagi
matn va "Yangi buyurtma oshxonaga tushganda chek o'zi chiqsin" (sukut bo'yicha yoqilgan).
Har bir buyurtma ostidagi **🖨 Chek** tugmasi bilan chekni qayta chiqarish ham mumkin.

Ikki xil chek bor: `oshxona` (narxsiz, yirik shrift — tayyorlash uchun) va `mijoz`
(narxlar va jami bilan).

## Xavfsizlik: login va parollar

- Kodda **hech qanday standart parol yo'q**. Bosh ega uchun `ADMIN_PASSWORD` (kamida 8 belgi)
  berilmagan bo'lsa, tasodifiy parol yaratiladi va egasining o'ziga **Telegram bot orqali** yuboriladi.
- Ilgari ishlatilgan eski standart parol server ishga tushganda avtomatik almashtiriladi,
  yangisi egasiga botda yuboriladi.
- Xodimlar uchun umumiy boshlang'ich parol faqat `STAFF_DEFAULT_PASSWORD` (kamida 8 belgi)
  berilganda ishlaydi. Aks holda xodim saytdagi **"Parolni unutdim"** orqali botdan shaxsiy parol oladi.
- Bitta loginga 5 marta noto'g'ri urinishdan keyin u 15 daqiqaga bloklanadi.
- `BOT_TOKEN`, `.env` va `print-agent/config.json` ni hech qachon GitHub'ga yuklamang —
  ular `.gitignore` da.

## Dasturchilar uchun: kod tuzilishi (v8)
- **API endpointlar** `server.js` da `route(url, fn)` / `authed(url, fn)` orqali ro'yxatga olinadi.
  `authed` Telegram `initData` imzosini markazda tekshiradi va handlerga `{ user, userId }` beradi —
  har bir endpointda qayta tekshirish shart emas.
- Javob yordamchilari: `sendOk(res, data)`, `sendFail(res, sabab)`, `denyAccess(...)`, `sendFeatureBlocked(res, id)`.
- Handler ichidagi har qanday xato ushlanadi va 500 javob qaytadi — server qulamaydi.
- Frontend'da `apiPost(url, body)` `initData` ni o'zi qo'shadi; forma xabarlari uchun `setMsg(el, matn, 'ok'|'err')`,
  modal uchun `openOverlay(html)` ishlatiladi.
- Dizayn tokenlari `public/style.css` boshida: `--brand-*` (egasi tanlagan rang), `--royal-*` (shampan-oltin aksent),
  `--shadow-*` / `--bevel-hi` (3D chuqurlik). Brend rangi o'zgarsa gradientlar ham avtomatik moslashadi.
- `app.js`/`style.css` uzoq muddat keshlanadi: ularni o'zgartirsangiz `public/index.html` dagi `?v=` raqamini oshiring.

## 1. BotFather orqali bot yaratish
1. Telegramda **@BotFather** ni oching.
2. `/newbot` yuboring, keyin bot nomi va username kiriting (username `bot` bilan tugashi kerak, masalan `MeningAdminBotim_bot`).
3. BotFather sizga **BOT_TOKEN** beradi (masalan `123456:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxx`) — uni saqlab qo'ying, hech kimga bermang.

## 2. O'zingizning Telegram ID (ADMIN_ID) ni bilib olish
1. Telegramda **@userinfobot** ga o'ting va `/start` bosing.
2. U sizga `Id: 123456789` deb ko'rsatadi — shu raqam sizning `ADMIN_ID`.

## 3. Bot username'ini bilib olish
BotFather bot yaratganda sizga bergan username (masalan `MeningAdminBotim_bot`) — bu `BOT_USERNAME` bo'ladi, taklif havolalari shu asosida yasaladi.

## 4. Serverni ishga tushirish
Bu papkada asosiy fayllar: `server.js` va `public/index.html`. Tashqi kutubxona kerak emas — faqat Node.js o'rnatilgan bo'lsa yetarli.

```bash
export BOT_TOKEN="BotFather'dan olingan token"
export ADMIN_ID="123456789"
export BOT_USERNAME="MeningAdminBotim_bot"
export PUBLIC_URL="https://sizning-domeningiz.com"   # ixtiyoriy, lekin bo'lsa webhook avtomatik o'rnatiladi
node server.js
```

Server `http://localhost:3000` da ishga tushadi.

## 5. Internetga chiqarish (HTTPS shart!)
Telegram Mini App va webhook faqat **HTTPS** manzilda ishlaydi. Eng oson yo'llar:
- **Railway.app**, **Render.com** yoki **Vercel** kabi bepul xostingga joylash (loyihani shunchaki yuklaysiz, ular avtomatik HTTPS beradi).
- Yoki test uchun `ngrok http 3000` orqali vaqtinchalik HTTPS link olish.

Muhit o'zgaruvchilarini (`BOT_TOKEN`, `ADMIN_ID`, `BOT_USERNAME`, `PUBLIC_URL`) shu xostingning "Environment Variables" bo'limiga qo'shishni unutmang. `PUBLIC_URL` sizning serveringizning tashqi HTTPS manzili bo'lishi kerak (masalan `https://myapp.up.railway.app`) — server ishga tushganda shu manzil + `/webhook` ga Telegram webhook'ini avtomatik o'rnatadi.

Agar `PUBLIC_URL` ni sozlamasangiz, webhook'ni qo'lda o'rnatishingiz kerak bo'ladi:
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://sizning-domeningiz.com/webhook"
```

## 6. BotFather'da Mini App (Web App) ulash
1. @BotFather ga qayting.
2. `/mybots` → botingizni tanlang → **Bot Settings** → **Menu Button** → **Configure Menu Button**.
3. Web App URL sifatida serveringiz manzilini kiriting, masalan: `https://sizning-domeningiz.com`
4. Tugma nomini kiriting, masalan: `Ochish`

Shundan so'ng bot chatida pastda menyu tugmasi chiqadi — bosilganda Mini App ochiladi.

## 7. Bir martalik taklif havolasi qanday ishlaydi
1. Admin Mini App'ni ochadi → **"Havola yaratish"** tugmasini bosadi → `https://t.me/BOT_USERNAME?start=inv_...` ko'rinishidagi bir martalik havola oladi.
2. Admin bu havolani do'kon egasiga yuboradi (masalan, Telegram orqali).
3. Do'kon egasi havolani bosib botni ochganda, bot uning so'rovini adminning shaxsiy chatiga yuboradi — ism, username va Telegram ID bilan.
4. Admin o'sha xabar ostidagi tugmalardan birini bosadi: **1 kun**, **7 kun**, **30 kun**, **Doimiy** yoki **Rad etish**.
5. Tasdiqlansa, do'kon egasiga tanlangan muddatga Mini App'ga kirish huquqi beriladi va u haqida xabar boradi. Muddat tugagach, kirish avtomatik yopiladi (ro'yxatdan ham avtomatik tozalanadi).
6. Havola faqat **bir marta** ishlaydi — ishlatilgandan keyin qayta ochilsa, "yaroqsiz" degan xabar chiqadi.

Admin Mini App orqali istalgan vaqtda do'kon egasini ro'yxatdan **"O'chirish"** tugmasi bilan olib tashlashi mumkin (bu allaqachon mavjud edi, endi ro'yxatda har bir egasining qolgan muddati ham ko'rsatiladi).

## Qanday ishlaydi (xavfsizlik)
- Telegram Mini App ochilganda `initData` degan imzolangan ma'lumot beriladi — unda foydalanuvchi ID'si va Telegram'ning raqamli imzosi bor.
- Backend (`server.js`) shu imzoni **BOT_TOKEN** yordamida qayta hisoblab, Telegram'ning o'zi yuborganini tasdiqlaydi (soxtalashtirib bo'lmaydi).
- Imzo to'g'ri chiqsa va foydalanuvchi ID'si `ADMIN_ID` ga teng yoki tasdiqlangan, muddati tugamagan do'kon egasi bo'lsagina — kirish beriladi.
- Boshqa har qanday holatda (begona odam, soxta so'rov, brauzerdan to'g'ridan-to'g'ri ochish, muddati tugagan) — xato ekrani chiqadi.
- Webhook so'rovlarini qo'shimcha himoyalash uchun ixtiyoriy `WEBHOOK_SECRET` muhit o'zgaruvchisini sozlashingiz mumkin.

## Muhim eslatma
`BOT_TOKEN` faqat serverda (`server.js` ichida, muhit o'zgaruvchisi sifatida) turishi kerak — uni frontendga yoki GitHub'ga hech qachon ochiq qo'ymang.

> ⚠️ **Xavfsizlik ogohlantirishi:** yuklangan loyihada `.env` fayli ichida haqiqiy `BOT_TOKEN` topildi. Bu token allaqachon boshqa joyga (masalan, shu suhbatga) oshkor bo'lgan hisoblanadi. @BotFather'da `/mybots` → botingiz → **Bot Settings** → **Revoke current token** orqali uni bekor qilib, yangisini olishni **tavsiya qilamiz**. `.env` faylini hech qachon repo yoki arxivga qo'shmang — `.gitignore`'ga qo'shing.
