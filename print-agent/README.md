# PULSAR print agent — chek printeri uchun (drayversiz)

Printer ulangan kompyuterda ishlaydigan kichik dastur. Yangi buyurtma oshxonaga
tushishi bilan chekni printerdan o'zi chiqaradi — drayver, chop etish oynasi va
kassirning aralashuvisiz.

- **USB printer** — Windows'da drayver o'rnatmasdan to'g'ridan-to'g'ri yozadi.
- **WiFi / LAN printer** — printerning IP manziliga (port 9100) yozadi.
- Tashqi kutubxona kerak emas — faqat **Node.js 18+**.

## O'rnatish (bir marta)

1. Kompyuterga **Node.js** o'rnating: https://nodejs.org (LTS versiyasi).
2. Shu `print-agent` papkasini kompyuterga ko'chiring (masalan `C:\print-agent`).
3. Botda: **Profil → Printer va chek → Chop etish usuli: Kompyuter agenti** →
   **Token yaratish** → **Nusxa olish**.
4. `start-agent.bat` ni ikki marta bosing. Birinchi marta oyna matn so'raydi —
   nusxalangan matnni joylang (sichqonchaning o'ng tugmasi) va **Enter** bosing.
   Agent uni `config.json` ga o'zi saqlaydi, keyingi safar so'ramaydi.
5. Oynada **"Ulandi: <do'kon nomi>"** chiqsa — tayyor. Botdagi sozlamalarda ham
   **● Agent ulangan** yozuvi paydo bo'ladi. Endi "🖨 Chek" bosilganda chek printerdan
   o'zi chiqadi — chop etish oynasi ochilmaydi.

> Chek hech qachon drayver yoki chop etish oynasi orqali chiqmaydi. Agent o'chiq bo'lsa,
> cheklar 10 daqiqagacha navbatda kutadi va agent yoqilishi bilan chiqadi.

## Kompyuter yoqilganda o'zi ishga tushsin

`Win + R` → `shell:startup` → ochilgan papkaga `start-agent.bat` ning **yorlig'ini** (shortcut) qo'ying.

## Tekshirish buyruqlari

```bat
node agent.js --list    :: ulangan USB printerlar ro'yxati
node agent.js --test    :: printerga sinov cheki
```

## `printer` sozlamasi

| Qiymat | Ma'nosi |
|---|---|
| `"auto"` | Ulangan USB chek printerini o'zi topadi (tavsiya etiladi) |
| `"usb:\\\\?\\USB#VID_0483&PID_070B#…"` | Aniq USB qurilma (`--list` chiqargan qatorni qo'ying) |
| `"tcp://192.168.1.50:9100"` | WiFi/LAN printer — IP manzili printerning sozlama chekida yoziladi |

## Muammolar

| Belgi | Sabab va yechim |
|---|---|
| `Ulangan USB chek printeri topilmadi` | Kabelni, printer yoqilganini tekshiring; `node agent.js --list` |
| `printerni boshqa dastur band qilgan` | Printer uchun ochiq boshqa kassa dasturini yoping |
| `Agent tokeni noto'g'ri yoki yangilangan` | Botdan yangi config.json oling — token yangilangan bo'lishi mumkin |
| `Server bilan aloqa yo'q` | Internetni tekshiring; agent o'zi qayta ulanadi |

## Qanday ishlaydi

Agent har 2 soniyada serverdan "yangi chek bormi?" deb so'raydi (ulanishni agent
boshlaydi, shuning uchun routerda port ochish kerak emas). Server chekni tayyor
ESC/POS baytlari ko'rinishida beradi, agent ularni printerga yozadi va serverga
"chiqdi" deb javob qaytaradi. 10 daqiqadan eski cheklar chop etilmaydi.

Windows'da USB qurilmaga yozish uchun agent bitta doimiy PowerShell yordamchisini
ishga tushiradi (Node.js'ning o'zi Windows USB printer qurilmasini ocha olmaydi).
Agent yopilganda yordamchi ham o'zi yopiladi.
