const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BOT_TOKEN = process.env.BOT_TOKEN || 'BOT_TOKEN_BU_YERGA';
const ADMIN_ID = process.env.ADMIN_ID || 'ADMIN_TELEGRAM_ID_BU_YERGA';
const PORT = process.env.PORT || 3000;

const BOT_USERNAME = (process.env.BOT_USERNAME || 'BOT_USERNAME_BU_YERGA')
  .trim()
  .replace(/^(https?:\/\/)?(www\.)?t\.me\//i, '')
  .replace(/^@/, '')
  .replace(/\/+$/, '');

const PUBLIC_URL = process.env.PUBLIC_URL || '';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const DATA_DIR = process.env.DATA_DIR || __dirname;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-3-5-haiku-20241022';

const SUBSCRIPTION_TRIAL_DAYS = parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS, 10) || 14;
const SUBSCRIPTION_GRACE_DAYS = parseInt(process.env.SUBSCRIPTION_GRACE_DAYS, 10) || 3;
const OWNERS_FILE = path.join(DATA_DIR, 'owners.json');

const ADMINS_FILE = path.join(DATA_DIR, 'admins.json');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');

const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

const TARIFFS_FILE = path.join(DATA_DIR, 'tariffs.json');

const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

const ARCHIVED_ORDERS_FILE = path.join(DATA_DIR, 'archived_orders.json');

const SUBSCRIPTION_PLANS_FILE = path.join(DATA_DIR, 'subscription_plans.json');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const BROADCASTS_FILE = path.join(DATA_DIR, 'broadcasts.json');
const ADMIN_SUPPORT_FILE = path.join(DATA_DIR, 'admin_support.json');

const SUBSCRIPTION_STATUS = {
  PENDING_TRIAL: 'pending_trial',
  ACTIVE: 'active',
  BLOCKED: 'blocked'
};

function ensureSubscriptionFields(owner) {
  if (!owner) return owner;
  if (owner.subscriptionStatus === undefined) {
    const stillValid = !owner.expiresAt || new Date(owner.expiresAt).getTime() > Date.now();
    owner.subscriptionStatus = stillValid ? SUBSCRIPTION_STATUS.ACTIVE : SUBSCRIPTION_STATUS.BLOCKED;
  }
  if (owner.subscriptionUntil === undefined) {
    owner.subscriptionUntil = owner.expiresAt || null;
  }
  if (owner.graceUntil === undefined) {
    owner.graceUntil = null;
  }
  if (owner.trialGivenAt === undefined) {
    owner.trialGivenAt = null;
  }

  if (owner.blockedNotifiedAt === undefined) {
    owner.blockedNotifiedAt = null;
  }

  if (owner.customerPaymentCard === undefined) {
    owner.customerPaymentCard = { cardNumber: '', cardHolder: '' };
  }

  if (owner.activePlanDailyPrice === undefined) {
    owner.activePlanDailyPrice = null;
  }
  if (owner.activePlanTariffId === undefined) {
    owner.activePlanTariffId = owner.tariffId || null;
  }
  return owner;
}

// MUHIM: bu yerda ilgari standart namunaviy (demo) rejalar (1 oy/50 000 va
// h.k.) avtomatik yaratilardi — bu owner tomonida admin hali sozlamagan
// "notanish" raqamlar ko'rinishiga olib kelgan (chalkashlikka sabab bo'lgan
// muammo shu edi). Endi bunday avtomatik demo-seed YO'Q: agar admin hali
// birorta reja kiritmagan bo'lsa, ro'yxat shunchaki BO'SH bo'ladi va owner
// "Obuna" bo'limida "hali rejalar sozlanmagan" ko'radi — hech qachon
// tasodifiy/o'ylab topilgan narx ko'rsatilmaydi.
function loadSubscriptionPlans() {
  try {
    if (!fs.existsSync(SUBSCRIPTION_PLANS_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(SUBSCRIPTION_PLANS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (e) {
    console.error('subscription_plans.json o\'qishda xatolik:', e.message);
    return {};
  }
}

function saveSubscriptionPlans(plans) {
  try {
    fs.writeFileSync(SUBSCRIPTION_PLANS_FILE, JSON.stringify(plans, null, 2));
  } catch (e) {
    console.error('subscription_plans.json yozishda xatolik:', e.message);
  }
}

const DEFAULT_PAYMENT_REQUISITES = {
  cardNumber: '**** **** **** ****',
  cardHolder: 'ADMIN ISM FAMILIYA',
  clickNumber: '+998 90 000 00 00',
  paymeNumber: '+998 90 000 00 00'
};

function loadPaymentRequisites() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      const initial = { paymentRequisites: DEFAULT_PAYMENT_REQUISITES };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(initial, null, 2));
      return Object.assign({}, DEFAULT_PAYMENT_REQUISITES);
    }
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign({}, DEFAULT_PAYMENT_REQUISITES, (parsed && parsed.paymentRequisites) || {});
  } catch (e) {
    console.error('settings.json (paymentRequisites) o\'qishda xatolik:', e.message);
    return Object.assign({}, DEFAULT_PAYMENT_REQUISITES);
  }
}

function savePaymentRequisites(requisites) {
  let current = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      current = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
    }
  } catch (e) {
    console.error('settings.json o\'qishda xatolik (saqlashdan oldin):', e.message);
  }
  current.paymentRequisites = Object.assign({}, DEFAULT_PAYMENT_REQUISITES, current.paymentRequisites || {}, requisites || {});
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2));
  } catch (e) {
    console.error('settings.json yozishda xatolik:', e.message);
  }
  return current.paymentRequisites;
}

function calcTariffUpgradeSurcharge(owner, plan) {
  const result = { surcharge: 0, remainingDays: 0, isUpgrade: false, oldDailyPrice: 0, newDailyPrice: 0 };
  if (!plan || !plan.tariffId || !plan.days) return result;

  if (!owner.activePlanTariffId) return result;

  if (owner.activePlanTariffId === plan.tariffId) return result;
  const untilMs = owner.subscriptionUntil ? new Date(owner.subscriptionUntil).getTime() : NaN;
  const remainingMs = (Number.isFinite(untilMs) && untilMs > Date.now()) ? (untilMs - Date.now()) : 0;
  if (remainingMs <= 0) return result;
  const remainingDays = Math.ceil(remainingMs / 86400000);
  const oldDailyPrice = owner.activePlanDailyPrice || 0;
  const newDailyPrice = plan.price / plan.days;
  result.remainingDays = remainingDays;
  result.oldDailyPrice = oldDailyPrice;
  result.newDailyPrice = newDailyPrice;
  const diffPerDay = newDailyPrice - oldDailyPrice;
  if (diffPerDay > 0) {
    result.isUpgrade = true;
    result.surcharge = Math.round(diffPerDay * remainingDays);
  }
  return result;
}

function createSubscriptionPaymentRequest(owner, planId) {
  const plans = loadSubscriptionPlans();
  const plan = plans[planId];
  if (!plan) return null;

  let tariffLabel = null;
  if (plan.tariffId) {
    const tariff = loadTariffs().find(t => t.id === plan.tariffId);
    tariffLabel = tariff ? tariff.name : null;
  }
  const upgrade = calcTariffUpgradeSurcharge(owner, plan);
  owner.subscriptionPaymentRequest = {
    id: crypto.randomBytes(6).toString('hex'),
    planId: plan.id,
    planLabel: plan.label,
    baseAmount: plan.price,
    upgradeSurcharge: upgrade.surcharge,
    upgradeRemainingDays: upgrade.isUpgrade ? upgrade.remainingDays : 0,
    amount: plan.price + upgrade.surcharge,
    days: plan.days,
    tariffId: plan.tariffId || null,
    tariffLabel,
    status: 'kutilmoqda_skrinshot',
    screenshotFileId: null,
    requestedAt: new Date().toISOString(),
    screenshotSentAt: null,
    decidedAt: null,
    decidedBy: null
  };
  return owner.subscriptionPaymentRequest;
}

async function sendObunaPlansMenu(owner, chatId) {
  const requisites = loadPaymentRequisites();
  const plans = loadSubscriptionPlans();
  const tariffs = loadTariffs();
  const list = Object.values(plans).sort((a, b) => (a.order || 0) - (b.order || 0));
  const planLines = list.map(p => {
    const tariff = p.tariffId ? tariffs.find(t => t.id === p.tariffId) : null;
    const tariffNote = tariff ? ` — tarif: ${escapeHtmlServer(tariff.name)}` : '';
    const upgrade = calcTariffUpgradeSurcharge(owner, p);
    const upgradeNote = upgrade.isUpgrade
      ? ` <i>(+${fmtNum(upgrade.surcharge)} so'm ustama — qolgan ${upgrade.remainingDays} kun uchun tarif farqi, jami ${fmtNum(p.price + upgrade.surcharge)} so'm)</i>`
      : '';
    return `• <b>${escapeHtmlServer(p.label)}</b> — ${fmtNum(p.price)} so'm${p.discountNote ? ' (' + escapeHtmlServer(p.discountNote) + ')' : ''}${tariffNote}${upgradeNote}`;
  }).join('\n');
  const text = `💳 <b>Obuna tarifini tanlang</b>\n\n${planLines}\n\n` +
    `To'lov rekvizitlari:\n💳 Karta: <code>${escapeHtmlServer(requisites.cardNumber)}</code>\n👤 Egasi: ${escapeHtmlServer(requisites.cardHolder)}\n\n` +
    `Tarifni tanlang, so'ng shu summani ko'rsatilgan kartaga o'tkazib, TO'LOV CHEKI (skrinshot) ni shu botga rasm qilib yuboring.`;
  const kb = { inline_keyboard: list.map(p => [{ text: `${p.label} — ${fmtNum(p.price)} so'm`, callback_data: `subplan:${p.id}` }]) };
  await sendMessage(chatId, text, kb);
}

function decideSubscriptionPayment(owner, action, decidedByUserId, reasonText) {
  const reqData = owner && owner.subscriptionPaymentRequest;
  if (!reqData || reqData.status !== 'kutilmoqda_tasdiq') {
    return { ok: false, reason: 'So\'rov topilmadi yoki allaqachon ko\'rib chiqilgan.' };
  }

  if (action === 'approve') {
    const plans = loadSubscriptionPlans();
    const plan = plans[reqData.planId];
    const days = (plan && plan.days) || reqData.days || 30;

    const baseMs = (owner.subscriptionUntil && new Date(owner.subscriptionUntil).getTime() > Date.now())
      ? new Date(owner.subscriptionUntil).getTime()
      : Date.now();
    const newUntil = new Date(baseMs + days * 86400000);
    owner.subscriptionUntil = newUntil.toISOString();
    owner.expiresAt = owner.subscriptionUntil;
    owner.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
    owner.graceUntil = null;
    owner.blockedNotifiedAt = null;
    owner.reminderSentAt = null;
    owner.paid = true;
    owner.paidAt = new Date().toISOString();

    const grantedTariffId = plan ? (plan.tariffId || null) : null;
    if (grantedTariffId) {
      owner.tariffId = grantedTariffId;

      owner.activePlanTariffId = grantedTariffId;
      owner.activePlanDailyPrice = plan.days ? (plan.price / plan.days) : 0;
    }
    reqData.status = 'tasdiqlandi';
    reqData.decidedAt = new Date().toISOString();
    reqData.decidedBy = decidedByUserId;
    recordPayment(owner, reqData.amount, {
      planId: reqData.planId, planLabel: reqData.planLabel, days,
      baseAmount: reqData.baseAmount != null ? reqData.baseAmount : reqData.amount,
      upgradeSurcharge: reqData.upgradeSurcharge || 0,
      source: 'subscription'
    });
    const tariffNote = reqData.tariffLabel ? `\nTarif: ${escapeHtmlServer(reqData.tariffLabel)}` : '';
    sendMessage(owner.id,
      `✅ <b>Obuna to'lovingiz tasdiqlandi!</b>\nReja: ${escapeHtmlServer(reqData.planLabel)}${tariffNote}\n` +
      `Yangi muddat: ${newUntil.toLocaleDateString('uz-UZ')}gacha.\nRahmat! 🙏`);
    return { ok: true, newUntil: owner.subscriptionUntil };
  }

  if (action === 'reject') {
    reqData.status = 'rad_etildi';
    reqData.decidedAt = new Date().toISOString();
    reqData.decidedBy = decidedByUserId;
    const trimmedReason = reasonText ? String(reasonText).trim() : '';
    reqData.rejectReason = trimmedReason || null;
    const reasonLine = trimmedReason
      ? `Sabab: ${escapeHtmlServer(trimmedReason)}`
      : 'Skrinshot noto\'g\'ri yoki summa mos emas bo\'lishi mumkin.';
    sendMessage(owner.id,
      `❌ <b>Obuna to'lovingiz rad etildi.</b>\n${reasonLine}\n` +
      `Qaytadan tarif tanlab urinib ko'ring yoki administrator bilan bog'laning.`);
    return { ok: true };
  }

  return { ok: false, reason: 'Noma\'lum amal.' };
}

function getOwnerSubscriptionAccess(owner) {
  // 68-bosqich: obuna/tarif tekshiruvi butunlay o'chirildi — mavjud har
  // qanday owner uchun har doim "faol" deb qaytariladi. Shu bir joyni
  // o'zgartirish bilan butun tizimdagi barcha joylardagi tekshiruvlar
  // (isOwnerAccessValid, checkSubscriptionAccess, getBlockedOwnerAccess,
  // pruneExpiredOwners va h.k.) avtomatik ravishda hech kimni bloklamay
  // qo'yadi — chunki ularning barchasi shu funksiya orqali ishlaydi.
  if (!owner) return { allowed: false, status: 'unknown', daysLeft: null, inGrace: false };
  return { allowed: true, status: SUBSCRIPTION_STATUS.ACTIVE, daysLeft: null, inGrace: false };
}

function checkSubscriptionAccess(userId, owners) {
  if (isAdminId(userId)) {
    return { allowed: true, status: 'admin', daysLeft: null, inGrace: false };
  }

  const list = owners || loadOwners();

  const owner = findOwner(list, userId);
  if (owner) return getOwnerSubscriptionAccess(owner);

  const staffInfo = findStaffInfo(list, userId);
  if (staffInfo) {
    const staffOwner = list.find(o => String(o.id) === String(staffInfo.ownerId));
    return getOwnerSubscriptionAccess(staffOwner);
  }

  return { allowed: false, status: 'unknown', daysLeft: null, inGrace: false };
}

function getBlockedOwnerAccess(owners, userId) {
  if (isAdminId(userId)) return null;

  const owner = findOwner(owners, userId);
  if (owner) {
    const access = getOwnerSubscriptionAccess(owner);
    return access.allowed ? null : access;
  }

  const staffInfo = findStaffInfo(owners, userId);
  if (staffInfo) {
    const staffOwner = owners.find(o => String(o.id) === String(staffInfo.ownerId));
    const access = getOwnerSubscriptionAccess(staffOwner);
    return access.allowed ? null : access;
  }

  return null;
}

// Egasi (yoki admin nomidan ish ko'rayotgan) kontekstmi?
function isOwnerRole(ctx) { return !!ctx && ctx.role === 'egasi'; }
// Kirish rad etilganda: obuna bloklangan bo'lsa maxsus ekran, aks holda sabab.
function denyAccess(res, owners, userId, fallbackReason) {
  return sendJSON(res, 200, subscriptionBlockedJSON(owners, userId, fallbackReason));
}
function sendFeatureBlocked(res, featureId) { return sendJSON(res, 200, featureBlockedResult(featureId)); }
function subscriptionBlockedJSON(owners, userId, fallbackReason) {
  const access = getBlockedOwnerAccess(owners, userId);
  if (access) return { ok: false, reason: 'subscription_blocked', access };
  return { ok: false, reason: fallbackReason };
}

async function sendSubscriptionBlockedScreen(chatId, access) {

  if (access.status === SUBSCRIPTION_STATUS.PENDING_TRIAL) {
    await sendMessage(chatId,
      "🕓 <b>So'rovingiz hali ko'rib chiqilmoqda</b>\n" +
      "Administrator tasdiqlagach, sizga xabar boradi va Mini App ochiladi.");
    return;
  }
  const graceNote = access.inGrace ? '\n(Muhlat davri ham tugadi.)' : '';
  await sendMessage(chatId,
    `⛔ <b>Obunangiz tugagan</b>\nBotdagi va Mini App'dagi amallar vaqtincha bloklandi.${graceNote}\n` +
    `Ma'lumotlaringiz (menyu, xodimlar, buyurtmalar tarixi) saqlanib qolyapti — obunani uzaytirsangiz, kirish avtomatik tiklanadi.`,
    { inline_keyboard: [[{ text: '💳 Obunani uzaytirish', callback_data: 'obuna_menyu' }]] });
}

async function guardCallbackSubscription(cq, owners, ownerId) {
  const owner = findOwner(owners, ownerId);
  const access = getOwnerSubscriptionAccess(owner);
  if (access.allowed) return false;
  await answerCallbackQuery(cq.id, '⛔ Obuna muddati tugagan.', true);
  await sendSubscriptionBlockedScreen(cq.from.id, access);
  return true;
}

const SERVER_STARTED_AT = new Date().toISOString();
const webhookStats = { received: 0, errors: 0, lastAt: null };

function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'hash yo\'q' };
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    return { ok: false, reason: 'imzo mos emas (soxta so\'rov)' };
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > 86400) {
    return { ok: false, reason: 'sessiya eskirgan' };
  }

  const userRaw = params.get('user');
  let user = null;
  try { user = userRaw ? JSON.parse(userRaw) : null; } catch (e) {}

  return { ok: true, user };
}

const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const computed = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(computed, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function normalizeLogin(login) {
  return String(login || '').trim().toLowerCase();
}

// ===== Xodimlar uchun login/parol (login = Telegram ID) =====
// Xodim o'z parolini o'rnatmaguncha (staff.passwordHash yo'q) umumiy boshlang'ich parol FAQAT
// STAFF_DEFAULT_PASSWORD muhit o'zgaruvchisi (kamida 8 belgi) berilganda ishlaydi. Kodda yozilgan
// standart parol yo'q: u holda xodim saytdagi "Parolni unutdim" orqali botdan shaxsiy parol oladi.
const STAFF_DEFAULT_PASSWORD = String(process.env.STAFF_DEFAULT_PASSWORD || '').length >= 8
  ? String(process.env.STAFF_DEFAULT_PASSWORD)
  : null;

function findStaffRecord(owners, userId) {
  for (const owner of owners) {
    const staff = (owner.staff || []).find(s => String(s.id) === String(userId));
    if (staff) return { owner, staff };
  }
  return null;
}

function verifyStaffPassword(staff, password) {
  if (staff.passwordHash) return verifyPassword(password, staff.passwordHash);
  if (!STAFF_DEFAULT_PASSWORD) return false;
  const a = Buffer.from(String(password));
  const b = Buffer.from(STAFF_DEFAULT_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function findStaffBySessionToken(owners, token) {
  for (const owner of owners) {
    const staff = (owner.staff || []).find(s => s.sessionToken === token);
    if (!staff) continue;
    if (!staff.sessionExpiresAt || new Date(staff.sessionExpiresAt).getTime() < Date.now()) {
      return { ok: false, reason: 'Sessiya muddati tugagan. Iltimos, qaytadan login/parol bilan kiring.' };
    }
    return { ok: true, user: { id: staff.id, username: staff.username || null, first_name: staff.name || 'Xodim' } };
  }
  return null;
}

// Xodim yozuvini saytga yuborishdan oldin maxfiy maydonlardan tozalaydi (parol xeshi, sessiya).
function publicStaff(s) {
  if (!s || typeof s !== 'object') return s;
  const { passwordHash, sessionToken, sessionExpiresAt, ...rest } = s;
  rest.hasOwnPassword = !!passwordHash;
  return rest;
}
function publicStaffList(list) {
  return (list || []).map(publicStaff);
}

function verifyAuth(initData) {
  if (typeof initData === 'string' && initData.startsWith('sess_')) {
    const token = initData.slice('sess_'.length);
    const owners = loadOwners();
    const owner = owners.find(o => o.sessionToken === token);
    if (!owner) {
      const staffSession = findStaffBySessionToken(owners, token);
      if (staffSession) return staffSession;
      return { ok: false, reason: 'Sessiya topilmadi. Iltimos, qaytadan login/parol bilan kiring.' };
    }
    if (!owner.sessionExpiresAt || new Date(owner.sessionExpiresAt).getTime() < Date.now()) {
      return { ok: false, reason: 'Sessiya muddati tugagan. Iltimos, qaytadan login/parol bilan kiring.' };
    }
    return {
      ok: true,
      user: {
        id: owner.id,
        username: owner.username || owner.login || null,
        first_name: (owner.profile && owner.profile.name) || owner.login || 'Egasi'
      }
    };
  }
  return verifyTelegramInitData(initData, BOT_TOKEN);
}

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

function loadJSONArray(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveJSONArray(file, arr) {
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
}

function loadOwners() { return loadJSONArray(OWNERS_FILE).map(ensureSubscriptionFields); }
function saveOwners(owners) { externalizeImages(owners); saveJSONArray(OWNERS_FILE, owners); }

// ---------------------------------------------------------------------------
// RASMLAR. Ilgari logo va taom rasmlari owners.json ichida base64 holida turardi:
// fayl 10+ MB bo'lib, har bir so'rovda to'liq o'qilardi, menyu javobi esa 4-12 MB
// edi — telefonda yuklanish 10 soniyagacha cho'zilardi. Endi rasm
// DATA_DIR/images/<hash>.<ext> fayliga yoziladi, JSON'da faqat "/img/<hash>.<ext>"
// havolasi qoladi; brauzer rasmni bir marta yuklab, keshda saqlaydi.
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const IMG_URL_RE = /^\/img\/[a-f0-9]{32}\.(png|jpg|webp)$/;
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|webp);base64,/i;
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function storeDataImage(value) {
  const m = DATA_IMAGE_RE.exec(value);
  if (!m) return value;
  const buf = Buffer.from(value.slice(m[0].length), 'base64');
  if (!buf.length) return value;
  const kind = m[1].toLowerCase();
  const ext = kind === 'png' ? 'png' : kind === 'webp' ? 'webp' : 'jpg';
  const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '.' + ext;
  const file = path.join(IMAGES_DIR, name);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      fs.writeFileSync(file + '.tmp', buf);
      fs.renameSync(file + '.tmp', file);
    }
  } catch (e) {
    console.error('Rasmni faylga yozib bo\'lmadi:', e.message);
    return value; // diskka yozilmasa — rasm eski usulda qoladi, yo'qolmaydi
  }
  return '/img/' + name;
}

// Obyekt ichidagi barcha base64 rasmlarni (logo, taomlar, kombolar, bannerlar,
// filial menyulari, buyurtmalar...) faylga chiqaradi. O'zgarish bo'lsa true.
function externalizeImages(node) {
  let changed = false;
  (function walk(obj) {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'string') {
        if (v.length > 64 && v.charCodeAt(0) === 100 /* d */ && DATA_IMAGE_RE.test(v)) {
          const url = storeDataImage(v);
          if (url !== v) { obj[key] = url; changed = true; }
        }
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  })(node || {});
  return changed;
}

// Ishga tushganda bir marta: eski owners.json ichidagi rasmlarni faylga ko'chirish.
// Ko'chirishdan oldin asl fayl owners.before-images.json nomi bilan saqlab qo'yiladi.
(function migrateInlineImages() {
  try {
    if (!fs.existsSync(OWNERS_FILE)) return;
    const before = fs.statSync(OWNERS_FILE).size;
    const owners = loadJSONArray(OWNERS_FILE);
    if (!owners.length || !externalizeImages(owners)) return;
    const keep = path.join(DATA_DIR, 'owners.before-images.json');
    if (!fs.existsSync(keep)) fs.copyFileSync(OWNERS_FILE, keep);
    saveJSONArray(OWNERS_FILE, owners);
    const after = fs.statSync(OWNERS_FILE).size;
    console.log(`Rasmlar alohida faylga ko'chirildi: owners.json ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(2)} MB`);
  } catch (e) {
    console.error('Rasmlarni ko\'chirishda xatolik (ma\'lumot o\'zgartirilmadi):', e.message);
  }
})();

// Oshxonaning standart (zaxira) ish vaqti (Toshkent bo'yicha): 10:00 dan 03:00 gacha.
// Har bir owner o'z profilida (Sozlamalar -> Ish vaqti) "09:00 - 23:00" ko'rinishida
// vaqt kiritsa, aynan o'sha vaqt ishlatiladi; aks holda shu standart qiymat qo'llanadi.
const KITCHEN_WORK_HOURS = { openHour: 10, openMinute: 0, closeHour: 3, closeMinute: 0 };
const KITCHEN_TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // Toshkent = UTC+5

function kitchenTashkentDate(input) {
  const d = (input instanceof Date) ? input : new Date(input || Date.now());
  return new Date(d.getTime() + KITCHEN_TZ_OFFSET_MS);
}

// "09:00 - 23:00", "9:00-23:00", "9-23", "9:00 dan 23:00 gacha" kabi matnni
// { openHour, openMinute, closeHour, closeMinute } ko'rinishiga o'giradi.
// Noto'g'ri/bo'sh bo'lsa null qaytaradi. Daqiqa ko'rsatilmasa 00 deb olinadi,
// ajratuvchi sifatida "-", "–", "—" yoki so'zlashuv uslubidagi "dan...gacha" qabul qilinadi.
function parseWorkHoursRange(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:[-–—]|dan)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:gacha)?/i);
  if (!m) return null;
  const openHour = parseInt(m[1], 10), openMinute = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const closeHour = parseInt(m[3], 10), closeMinute = m[4] !== undefined ? parseInt(m[4], 10) : 0;
  if ([openHour, closeHour].some(h => h < 0 || h > 23)) return null;
  if ([openMinute, closeMinute].some(mm => mm < 0 || mm > 59)) return null;
  return { openHour, openMinute, closeHour, closeMinute };
}

// Owner uchun amaldagi ish vaqtini qaytaradi: profilida kiritilgan bo'lsa o'shani,
// bo'lmasa yoki noto'g'ri formatda bo'lsa standart KITCHEN_WORK_HOURS ni.
function getOwnerWorkHours(owner) {
  const raw = owner && owner.profile && owner.profile.workHours;
  return parseWorkHoursRange(raw) || KITCHEN_WORK_HOURS;
}

function isKitchenOpenNow(hours) {
  const wh = hours || KITCHEN_WORK_HOURS;
  const now = kitchenTashkentDate();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const openMin = wh.openHour * 60 + (wh.openMinute || 0);
  const closeMin = wh.closeHour * 60 + (wh.closeMinute || 0);
  if (openMin === closeMin) return true; // 24 soat ochiq
  if (openMin < closeMin) return nowMin >= openMin && nowMin < closeMin;
  return nowMin >= openMin || nowMin < closeMin;
}

// Keyingi ochilish vaqtini haqiqiy (UTC) Date sifatida qaytaradi.
function nextKitchenOpenAt(hours) {
  const wh = hours || KITCHEN_WORK_HOURS;
  const tashkentNow = kitchenTashkentDate();
  const target = new Date(tashkentNow);
  target.setUTCHours(wh.openHour, wh.openMinute || 0, 0, 0);
  if (target <= tashkentNow) target.setUTCDate(target.getUTCDate() + 1);
  return new Date(target.getTime() - KITCHEN_TZ_OFFSET_MS);
}

const KITCHEN_REMINDERS_FILE = path.join(DATA_DIR, 'kitchen_reminders.json');
function loadKitchenReminders() { return loadJSONArray(KITCHEN_REMINDERS_FILE); }
function saveKitchenReminders(list) { saveJSONArray(KITCHEN_REMINDERS_FILE, list); }

// Oshxona ochilganda kutayotgan mijozlarga botdan avtomatik xabar yuboradi.
// Har bir owner o'zining (sozlamalardagi) ish vaqtiga qarab tekshiriladi.
setInterval(() => {
  const reminders = loadKitchenReminders();
  if (!reminders.length) return;
  const owners = loadOwners();
  const remaining = [];
  reminders.forEach(r => {
    const owner = findOwner(owners, r.ownerId);
    const hours = getOwnerWorkHours(owner);
    if (!isKitchenOpenNow(hours)) { remaining.push(r); return; }
    const restaurantName = (owner && owner.profile && owner.profile.name) || 'Toshkent Hot-Dog';
    const menuUrl = PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, '')}/?customer=${encodeURIComponent(r.ownerId)}` : null;
    sendMessage(r.userId,
      `🔓 <b>Ochildik!</b>\n${escapeHtmlServer(restaurantName)} hozir buyurtmalarni qabul qilmoqda.`,
      menuUrl ? { inline_keyboard: [[{ text: '🍽 Menyuni ochish', web_app: { url: menuUrl } }]] } : null);
  });
  if (remaining.length !== reminders.length) saveKitchenReminders(remaining);
}, 30 * 1000);

// Smena (ish smenasi) boshlash/tugatishni avtomatik ravishda oshxonaning
// ish vaqtiga to'g'irlab turadi: ish vaqti boshlanganda (oshxona ochilganda)
// egasi va tegishli xodimlarning (kassir/oshpaz/egasi-hamkor) smenasi
// avtomatik boshlanadi, ish vaqti tugaganda (oshxona yopilganda) avtomatik
// tugatiladi va shiftHistory'ga yoziladi. Xodim/egasi istalgan payt
// qo'lda ham "Tugatish"/"Boshlash" tugmasini bosib, keyingi chegaragacha
// buni o'zgartirishi mumkin — bu faqat ochilish/yopilish lahzasida ishlaydi.
const kitchenOpenStateByOwner = new Map();

function autoSyncShiftsForOwner(owner) {
  const hours = getOwnerWorkHours(owner);
  const open = isKitchenOpenNow(hours);
  const hasPrev = kitchenOpenStateByOwner.has(owner.id);
  const prevOpen = hasPrev ? kitchenOpenStateByOwner.get(owner.id) : open;
  kitchenOpenStateByOwner.set(owner.id, open);
  // Server yangi ishga tushganda holatni shunchaki eslab qoladi, lekin
  // ommaviy smena boshlash/tugatishni ishga tushirmaydi (faqat haqiqiy
  // ochilish/yopilish lahzasida ishlaydi).
  if (!hasPrev || open === prevOpen) return false;

  const now = new Date().toISOString();
  const targets = [owner, ...((owner.staff || []).filter(s =>
    staffHasRole(s, 'kassir') || staffHasRole(s, 'oshpaz') || staffHasRole(s, 'egasi')
  ))];
  let changed = false;

  targets.forEach(target => {
    const isOwnerTarget = target === owner;
    const role = isOwnerTarget ? 'egasi' : (normalizeStaffRoles(target)[0] || 'xodim');
    if (open) {
      if (!target.shiftActive) {
        target.shiftActive = true;
        target.shiftStartedAt = now;
        logStaffAction(owner, { userId: target.id, role, action: 'smena_boshladi', note: 'Ish vaqti boshlanishi bilan smena avtomatik boshlandi' });
        changed = true;
      }
    } else if (target.shiftActive) {
      if (!owner.shiftHistory) owner.shiftHistory = [];
      owner.shiftHistory.unshift({
        id: crypto.randomBytes(4).toString('hex'),
        userId: target.id,
        role,
        startedAt: target.shiftStartedAt || now,
        endedAt: now
      });
      if (owner.shiftHistory.length > 1000) owner.shiftHistory.length = 1000;
      target.shiftActive = false;
      target.shiftStartedAt = null;
      logStaffAction(owner, { userId: target.id, role, action: 'smena_tugatdi', note: 'Ish vaqti tugashi bilan smena avtomatik tugatildi' });
      changed = true;
    }
  });

  return changed;
}

setInterval(() => {
  const owners = loadOwners();
  let anyChanged = false;
  owners.forEach(owner => {
    if (autoSyncShiftsForOwner(owner)) anyChanged = true;
  });
  if (anyChanged) saveOwners(owners);
}, 60 * 1000);

function loadAdminSupportMessages() { return loadJSONArray(ADMIN_SUPPORT_FILE); }
function saveAdminSupportMessages(msgs) { saveJSONArray(ADMIN_SUPPORT_FILE, msgs); }

function loadInvites() { return loadJSONArray(INVITES_FILE); }
function saveInvites(invites) { saveJSONArray(INVITES_FILE, invites); }

function loadRequests() { return loadJSONArray(REQUESTS_FILE); }
function saveRequests(reqs) { saveJSONArray(REQUESTS_FILE, reqs); }

function loadPayments() { return loadJSONArray(PAYMENTS_FILE); }
function savePayments(list) { saveJSONArray(PAYMENTS_FILE, list); }

function loadBroadcasts() { return loadJSONArray(BROADCASTS_FILE); }
function saveBroadcasts(list) { saveJSONArray(BROADCASTS_FILE, list); }

function recordPayment(owner, amount, extra) {
  const amountVal = Number(amount) || 0;
  if (amountVal <= 0) return;
  const payments = loadPayments();
  payments.push({
    id: crypto.randomBytes(6).toString('hex'),
    ownerId: owner.id,
    ownerLabel: owner.username ? '@' + owner.username : String(owner.id),
    amount: amountVal,
    tariffId: owner.tariffId || null,

    planId: (extra && extra.planId) || null,
    planLabel: (extra && extra.planLabel) || null,
    days: (extra && extra.days) || null,
    source: (extra && extra.source) || null,

    baseAmount: (extra && extra.baseAmount != null) ? extra.baseAmount : null,
    upgradeSurcharge: (extra && extra.upgradeSurcharge) || 0,
    at: new Date().toISOString()
  });
  savePayments(payments);
}

function loadArchivedOrders() { return loadJSONArray(ARCHIVED_ORDERS_FILE); }
function saveArchivedOrders(list) { saveJSONArray(ARCHIVED_ORDERS_FILE, list); }
function archiveOwnerOrders(owner) {
  const orders = owner && owner.orders;
  if (!orders || !orders.length) return;
  const archive = loadArchivedOrders();
  archive.push({
    type: 'owner_removed',
    ownerId: owner.id,
    ownerLabel: owner.username ? '@' + owner.username : String(owner.id),
    removedAt: new Date().toISOString(),
    orders
  });
  saveArchivedOrders(archive);
}

const ORDERS_RETENTION_DAYS = parseInt(process.env.ORDERS_RETENTION_DAYS, 10) || 120;
const ORDERS_ARCHIVE_HOUR = 4;
let lastOrdersArchiveDateKey = null;

function archiveOldOrdersAcrossOwners() {
  const owners = loadOwners();
  const cutoffTime = Date.now() - ORDERS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const archive = loadArchivedOrders();
  let ownersChanged = false;
  let archiveChanged = false;
  let totalArchived = 0;

  for (const owner of owners) {
    const orders = owner.orders;
    if (!orders || !orders.length) continue;
    const keep = [];
    const old = [];
    for (const o of orders) {
      const t = new Date(o.createdAt).getTime();

      if (Number.isFinite(t) && t < cutoffTime) old.push(o);
      else keep.push(o);
    }
    if (old.length) {
      archive.push({
        type: 'retention',
        ownerId: owner.id,
        ownerLabel: owner.username ? '@' + owner.username : String(owner.id),
        archivedAt: new Date().toISOString(),
        retentionDays: ORDERS_RETENTION_DAYS,
        count: old.length,
        orders: old
      });
      owner.orders = keep;
      ownersChanged = true;
      archiveChanged = true;
      totalArchived += old.length;
    }
  }

  if (archiveChanged) saveArchivedOrders(archive);
  if (ownersChanged) saveOwners(owners);
  return totalArchived;
}

setInterval(() => {
  try {
    if (aiDirTashkentHour(new Date()) !== ORDERS_ARCHIVE_HOUR) return;
    const todayKey = aiDirDateKey(new Date());
    if (lastOrdersArchiveDateKey === todayKey) return;
    lastOrdersArchiveDateKey = todayKey;
    const count = archiveOldOrdersAcrossOwners();
    if (count > 0) console.log(`[buyurtmalar arxivlandi] ${count} ta eski buyurtma owners.json'dan archived_orders.json'ga ko'chirildi.`);
  } catch (err) {
    console.error('[buyurtmalar arxivlash xatosi]', err && err.message);
  }
}, 10 * 60 * 1000);

const TRASH_FILE = path.join(DATA_DIR, 'trash.json');
const TRASH_LOG_FILE = path.join(DATA_DIR, 'trash_log.json');
const TRASH_AUTO_PURGE_DAYS = 3;

function loadTrash() { return loadJSONArray(TRASH_FILE); }
function saveTrash(list) { saveJSONArray(TRASH_FILE, list); }
function loadTrashLog() { return loadJSONArray(TRASH_LOG_FILE); }
function saveTrashLog(list) { saveJSONArray(TRASH_LOG_FILE, list); }

function logTrashEvent(action, owner, extra) {
  const log = loadTrashLog();
  log.push(Object.assign({
    id: crypto.randomBytes(6).toString('hex'),
    action,
    ownerId: owner ? owner.id : null,
    ownerLabel: owner ? ownerLabel(owner) : null,
    at: new Date().toISOString()
  }, extra || {}));
  saveTrashLog(log);
}

function moveOwnerToTrash(owner, trashedByUserId) {
  const trash = loadTrash();
  const trashedAt = new Date();
  const autoPurgeAt = new Date(trashedAt.getTime() + TRASH_AUTO_PURGE_DAYS * 86400000);
  trash.push({
    id: crypto.randomBytes(6).toString('hex'),
    ownerSnapshot: owner,
    trashedAt: trashedAt.toISOString(),
    autoPurgeAt: autoPurgeAt.toISOString(),
    trashedBy: trashedByUserId ? String(trashedByUserId) : null,
    restoreStatus: 'none',
    restoreRequestedAt: null
  });
  saveTrash(trash);
  logTrashEvent('trashed', owner, { trashedBy: trashedByUserId ? String(trashedByUserId) : null });
}

function findTrashEntry(trash, trashId) {
  return trash.find(t => t.id === trashId);
}

function findTrashEntryByOwnerId(trash, ownerId) {
  return trash.find(t => String(t.ownerSnapshot && t.ownerSnapshot.id) === String(ownerId));
}

function restoreOwnerFromTrash(trashEntry) {
  const owners = loadOwners();
  if (findOwner(owners, trashEntry.ownerSnapshot.id)) {
    return { ok: false, reason: 'Bu ID bilan allaqachon boshqa do\'kon egasi mavjud.' };
  }
  owners.push(trashEntry.ownerSnapshot);
  saveOwners(owners);
  return { ok: true };
}

async function checkTrashAutoPurge() {
  const trash = loadTrash();
  const now = Date.now();
  const remaining = [];
  let purgedAny = false;
  for (const entry of trash) {
    if (new Date(entry.autoPurgeAt).getTime() <= now) {
      purgedAny = true;
      archiveOwnerOrders(entry.ownerSnapshot);
      logTrashEvent('purged', entry.ownerSnapshot, { reason: 'auto_3_kun' });
    } else {
      remaining.push(entry);
    }
  }
  if (purgedAny) saveTrash(remaining);
}

function loadProfiles() { return loadJSONArray(PROFILES_FILE); }
function saveProfiles(list) { saveJSONArray(PROFILES_FILE, list); }
function findProfile(userId) { return loadProfiles().find(p => String(p.id) === String(userId)); }
function isRegisteredUser(userId) {
  const p = findProfile(userId);
  return !!(p && p.registeredAt);
}

function loadTariffs() { return loadJSONArray(TARIFFS_FILE); }
function saveTariffs(list) { saveJSONArray(TARIFFS_FILE, list); }

const FEATURE_GROUPS = [
  { id: 'boshqaruv', name: "Boshqaruv va xodimlar" },
  { id: 'menyu', name: "Menyu va mahsulotlar" },
  { id: 'buyurtma', name: "Buyurtmalar va yetkazish" },
  { id: 'ombor_moliya', name: "Ombor va moliya" },
  { id: 'statistika', name: "Statistika va AI" },
  { id: 'mijoz', name: "Mijozlar (mini-ilova)" },
  { id: 'tizim', name: "Tizim va xavfsizlik" }
];
const FEATURE_CATALOG = [

  { id: 'cashier-panel', name: "Kassir paneli", group: 'boshqaruv' },
  { id: 'staff-invite', name: "Xodim taklifnomalari", group: 'boshqaruv' },
  { id: 'staff-roles', name: "Xodim rollari va huquqlari", group: 'boshqaruv' },
  { id: 'branch-manage', name: "Filiallar boshqaruvi", group: 'boshqaruv' },
  { id: 'shift-toggle', name: "Smena boshlash/tugatish", group: 'boshqaruv' },

  { id: 'menu-manage', name: "Menyu boshqaruvi", group: 'menyu' },
  { id: 'category-manage', name: "Kategoriyalar boshqaruvi", group: 'menyu' },
  { id: 'combo-manage', name: "Combo boshqaruvi", group: 'menyu' },
  { id: 'promo-manage', name: "Aksiya/promo boshqaruvi", group: 'menyu' },
  { id: 'banner-manage', name: "Reklama banner boshqaruvi", group: 'menyu' },

  { id: 'orders-manage', name: "Buyurtmalarni boshqarish", group: 'buyurtma' },
  { id: 'delivery-group', name: "Dostavka guruh xabarnomasi", group: 'buyurtma' },
  { id: 'kitchen-group', name: "Oshxona guruh xabarnomasi", group: 'buyurtma' },

  { id: 'stock-manage', name: "Ombor boshqaruvi", group: 'ombor_moliya' },
  { id: 'expense-manage', name: "Xarajatlar", group: 'ombor_moliya' },
  { id: 'cashflow', name: "Kassa oqimi", group: 'ombor_moliya' },
  { id: 'z-report', name: "Z-hisobot", group: 'ombor_moliya' },
  { id: 'bonus-settings', name: "Bonus sozlamalari", group: 'ombor_moliya' },

  { id: 'dashboard', name: "Boshqaruv paneli (Dashboard)", group: 'statistika' },
  { id: 'staff-performance', name: "Xodimlar statistikasi", group: 'statistika' },
  { id: 'ai-analytics', name: "AI tahlil", group: 'statistika' },
  { id: 'ai-director', name: "AI Direktor", group: 'statistika' },
  { id: 'audit', name: "Auditlar", group: 'statistika' },

  { id: 'customer-menu', name: "Mijoz uchun menyu va buyurtma", group: 'mijoz' },
  { id: 'customer-account', name: "Mijoz profili va tarixi", group: 'mijoz' },
  { id: 'support-chat', name: "Tezkor qo'llab-quvvatlash chat", group: 'mijoz' },
  { id: 'ai-waiter', name: "AI ofitsiant (tavsiyalar va sevimlilar)", group: 'mijoz' },

  { id: 'restaurant-brand', name: "Restoran brendi (logo, nom)", group: 'tizim' },
  { id: 'system-status', name: "Tizim holati paneli", group: 'tizim' },
  { id: 'notification-log', name: "Xatolik jurnali", group: 'tizim' }
];
function getFeatureCatalogGrouped() {
  return FEATURE_GROUPS.map(g => ({
    id: g.id,
    name: g.name,
    features: FEATURE_CATALOG.filter(f => f.group === g.id).map(f => ({ id: f.id, name: f.name }))
  }));
}

function ownerCanUseFeature(owner, featureId) {
  // 68-bosqich: tarif asosidagi funksiya cheklovi o'chirildi — barcha
  // funksiyalar har doim ochiq.
  return true;
}

function featureBlockedResult(featureId) {
  const feature = FEATURE_CATALOG.find(f => f.id === featureId);
  const label = feature ? feature.name : 'Bu funksiya';
  return {
    ok: false,
    reason: `"${label}" joriy tarifingizga kiritilmagan. Kengaytirish uchun administrator bilan bog'laning.`,
    blockedFeature: true,
    featureId
  };
}

// Tarif rejasida "Filiallar soni" cheklovi (admin panelidagi Tariflar
// bo'limida sozlanadi — qarang: /api/tariff-add, /api/tariff-rename).
// maxBranches: null yoki 0 — cheklanmagan (owner istagancha filial ocha
// oladi). Owner'ga tarif biriktirilmagan bo'lsa ham cheklanmagan.
function ownerMaxBranches(owner) {
  // 68-bosqich: tarif asosidagi filiallar soni cheklovi o'chirildi.
  return null;
}

function loadAdmins() { return loadJSONArray(ADMINS_FILE); }
function saveAdmins(admins) {
  saveJSONArray(ADMINS_FILE, admins);
  reloadAdminsCache(admins);
}

let EXTRA_ADMIN_IDS = new Set();
function reloadAdminsCache(admins) {
  const list = admins || loadAdmins();
  EXTRA_ADMIN_IDS = new Set(list.map(a => String(a.id)));
}

function addExtraAdmin(id, addedBy) {
  const idStr = String(id);
  if (idStr === String(ADMIN_ID)) return loadAdmins();
  const admins = loadAdmins();
  if (admins.some(a => String(a.id) === idStr)) return admins;
  admins.push({ id: idStr, addedAt: new Date().toISOString(), addedBy: addedBy ? String(addedBy) : null });
  saveAdmins(admins);
  return admins;
}
function removeExtraAdmin(id) {
  const idStr = String(id);
  const admins = loadAdmins().filter(a => String(a.id) !== idStr);
  saveAdmins(admins);
  return admins;
}

function isAdminId(userId) {
  // Bitta-do'kon rejimi: alohida "admin" roli o'chirilgan — ADMIN_ID endi
  // oddiy owner sifatida ishlaydi (qarang: ensureAdminIsOwner() pastda).
  // Shu tufayli /api/verify va boshqa joylardagi barcha "admin" tekshiruvlari
  // avtomatik false qaytaradi va Mini App to'g'ridan-to'g'ri owner panelini ochadi.
  return false;
}

function allAdminIds() {
  return Array.from(new Set([String(ADMIN_ID), ...EXTRA_ADMIN_IDS]));
}

function findOwner(owners, userId) {
  return owners.find(o => String(o.id) === String(userId));
}

function isOwnerAccessValid(owner) {
  return getOwnerSubscriptionAccess(owner).allowed;
}

function pruneExpiredOwners() {
  const owners = loadOwners();
  let changed = false;
  owners.forEach(owner => {
    if (owner.subscriptionStatus === SUBSCRIPTION_STATUS.PENDING_TRIAL) return;
    const nextStatus = getOwnerSubscriptionAccess(owner).allowed
      ? SUBSCRIPTION_STATUS.ACTIVE
      : SUBSCRIPTION_STATUS.BLOCKED;
    if (owner.subscriptionStatus !== nextStatus) {
      owner.subscriptionStatus = nextStatus;
      changed = true;
    }
  });
  if (changed) saveOwners(owners);
  return owners;
}

const STAFF_ROLES = {
  kassir: 'Kassir',
  // 69-bosqich: "Egasi (hamkor)" — asosiy egasi ID/username yoki havola
  // orqali boshqa odamga TO'LIQ egasi huquqini (menyu, sklad, xodimlar,
  // buyurtmalar, hisobotlar) berishi mumkin. Bu — alohida "owner" yozuvi
  // emas, owner.staff ichidagi rol="egasi" bo'lgan yozuv; resolveOwnerContext
  // orqali ular xuddi asosiy egasi kabi ishlaydi. Faqat ba'zi juda nozik
  // amallar (masalan, o'zini xodimlar ro'yxatidan o'chirish yoki hisob
  // sozlamalarining ba'zi qismlari) hali ham faqat asl egasiga tegishli
  // bo'lishi mumkin — chunki ular owner.id bilan to'g'ridan-to'g'ri ishlaydi.
  egasi: 'Egasi (hamkor)'
};

const ROLE_PANEL_FEATURE = {
  kassir: 'cashier-panel'
};

function allowedStaffRoles(owner, roles) {
  return (roles || []).filter(r => {
    const featureId = ROLE_PANEL_FEATURE[r];
    if (!featureId) return true;
    return ownerCanUseFeature(owner, featureId);
  });
}

function findBranch(owner, branchId) {
  return (owner.branches || []).find(b => String(b.id) === String(branchId));
}

function generateBranchId() {
  return crypto.randomBytes(6).toString('hex');
}

// Buyurtma qaysi guruhlarga (dostavka/oshxona) yuborilishi kerakligini
// aniqlaydi: agar buyurtma bir filialga tegishli bo'lsa va o'sha filialning
// o'ZINING guruhi ulangan bo'lsa — shu guruh ishlatiladi; aks holda markaziy
// (owner darajasidagi) guruhga tushadi. Shu tarzda har bir filial o'z
// alohida guruhiga ega bo'lishi mumkin, lekin ulanmagan filiallar markaziy
// guruhdan foydalanishda davom etadi.
function resolveOrderGroupIds(owner, order) {
  const branch = order && order.branchId ? findBranch(owner, order.branchId) : null;
  const deliveryGroupId = (branch && branch.deliveryGroupId) || owner.deliveryGroupId || null;
  const deliveryGroupThreadId = (branch && branch.deliveryGroupId) ? (branch.deliveryGroupThreadId || null) : (owner.deliveryGroupThreadId || null);
  const kitchenGroupId = (branch && branch.kitchenGroupId) || owner.kitchenGroupId || null;
  const kitchenGroupThreadId = (branch && branch.kitchenGroupId) ? (branch.kitchenGroupThreadId || null) : (owner.kitchenGroupThreadId || null);
  return { deliveryGroupId, deliveryGroupThreadId, kitchenGroupId, kitchenGroupThreadId };
}

function resolveStockPool(owner, branchId) {
  if (!branchId) return owner;
  const branch = findBranch(owner, branchId);
  if (!branch) return null;
  if (!branch.stock) branch.stock = [];
  if (!branch.stockMovements) branch.stockMovements = [];
  return branch;
}

function findStockItem(pool, id) {
  return (pool.stock || []).find(s => s.id === id);
}

// 1-bosqich: har bir filial o'zining mustaqil menyusiga ega. Filial
// qo'shilganda markaziy menyu (va bo'limlar) unga boshlang'ich nuqta
// sifatida nusxalanadi (bu nusxalash /api/branch-add ichida sodir bo'ladi).
// Shu funksiya "pool" — ya'ni markaziy (owner) yoki tanlangan filialning
// menyu/bo'lim massivlarini o'z ichiga olgan obyektni qaytaradi.
// Eski (bu funksiyadan oldin yaratilgan) filiallarda menu/categories
// hali bo'lmasligi mumkin — shunday holatda ham markaziy menyudan
// boshlang'ich nusxa olib, keyingi tahrirlar mustaqil davom etadi.
function resolveMenuPool(owner, branchId) {
  if (!branchId) return owner;
  const branch = findBranch(owner, branchId);
  if (!branch) return null;
  if (!Array.isArray(branch.menu)) branch.menu = JSON.parse(JSON.stringify(owner.menu || []));
  if (!Array.isArray(branch.categories)) branch.categories = JSON.parse(JSON.stringify(ensureOwnerCategories(owner)));
  return branch;
}

function addStockMovement(pool, entry) {
  if (!pool.stockMovements) pool.stockMovements = [];
  pool.stockMovements.unshift(Object.assign({
    id: crypto.randomBytes(4).toString('hex'),
    createdAt: new Date().toISOString()
  }, entry));
  if (pool.stockMovements.length > 500) pool.stockMovements.length = 500;
}

function checkLowStockAlert(owner, item, excludeUserId, branchId) {
  if (item.minQty === null || item.minQty === undefined) return;
  if (item.qty <= item.minQty) {
    if (!item.lowStockAlertSent) {
      item.lowStockAlertSent = true;
      const text = `⚠️ <b>Kam qoldi:</b> ${escapeHtmlServer(item.name)} — ${item.qty} ${escapeHtmlServer(item.unit)} qoldi (chegara: ${item.minQty} ${escapeHtmlServer(item.unit)}).`;
      const ownerMuted = isNotificationCategoryMuted(owner, 'lowStock');
      const targets = [owner.id, ...((owner.staff || []).filter(s => staffHasRole(s, 'sklad') && (s.branchId || null) === (branchId || null)).map(s => s.id))];
      for (const t of new Set(targets)) {
        if (String(t) === String(excludeUserId)) continue;
        if (ownerMuted && String(t) === String(owner.id)) continue;
        sendMessage(t, text);
      }
    }
  } else {
    item.lowStockAlertSent = false;
  }
}

const EXPENSE_CATEGORIES = {
  ijara: 'Ijara',
  maosh: 'Maosh',
  kommunal: 'Kommunal',
  mahsulot: 'Mahsulot xaridi',

  sklad_xarid: 'Sklad xaridlari',
  spisaniya: 'Spisaniya (isrof)',
  boshqa: 'Boshqa'
};

function ensureOwnerCategories(owner) {
  if (!Array.isArray(owner.categories)) {
    const seen = new Set();
    const migrated = [];
    (owner.menu || []).forEach(item => {
      const name = String(item.category || '').trim();
      const key = name.toLowerCase();
      if (name && !seen.has(key)) {
        seen.add(key);
        migrated.push({ id: crypto.randomBytes(4).toString('hex'), name, order: migrated.length });
      }
    });
    owner.categories = migrated;
  }
  return owner.categories;
}

function sortedOwnerCategories(owner) {
  return ensureOwnerCategories(owner).slice().sort((a, b) => a.order - b.order);
}

function findCombo(owner, id) {
  return (owner.combos || []).find(c => c.id === id);
}

function comboAutoPrice(owner, itemIds) {
  return (itemIds || []).reduce((sum, entry) => {
    const menuItem = (owner.menu || []).find(m => m.id === entry.menuItemId);
    return sum + (menuItem ? menuItem.price * entry.qty : 0);
  }, 0);
}

// Bitta taomning bir nechta narxi (masalan: kichik/katta) bo'lishi mumkin.
// menuItem.prices — [{ id, label, price }] massivi. Agar u mavjud bo'lsa,
// buyurtma vaqtida mijoz/kassir aynan qaysi narx variantini tanlaganini
// (priceId) ko'rsatishi shart.
function resolveMenuItemPriceOption(menuItem, priceId) {
  const options = Array.isArray(menuItem.prices) ? menuItem.prices : [];
  if (!options.length) {
    return { ok: true, price: menuItem.price, label: null, priceId: null };
  }
  const wanted = priceId !== undefined && priceId !== null ? String(priceId) : null;
  const found = wanted ? options.find(p => p.id === wanted) : (options.length === 1 ? options[0] : null);
  if (!found) {
    return { ok: false, reason: `"${menuItem.name}" uchun narx variantini tanlang.` };
  }
  return { ok: true, price: found.price, label: found.label, priceId: found.id };
}

// Admin panel'dan kelgan "bir nechta narx" ro'yxatini tekshiradi va tozalaydi.
// Kutilayotgan format: [{ label, price, id? }, ...]
function normalizeMenuItemPrices(rawPrices) {
  if (rawPrices === undefined || rawPrices === null || rawPrices === '') {
    return { ok: true, list: [] };
  }
  let arr = rawPrices;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch (e) { return { ok: false, reason: 'Narxlar ro\'yxati noto\'g\'ri.' }; }
  }
  if (!Array.isArray(arr)) return { ok: false, reason: 'Narxlar ro\'yxati noto\'g\'ri.' };
  if (!arr.length) return { ok: true, list: [] };
  if (arr.length < 2) return { ok: false, reason: 'Kamida 2 ta narx variantini kiriting yoki bittalik narxdan foydalaning.' };

  const list = [];
  const seenLabels = new Set();
  for (const raw of arr) {
    const label = String((raw && raw.label) || '').trim();
    const priceNum = Number(raw && raw.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return { ok: false, reason: `${label ? '"' + label + '"' : 'Narx varianti'} uchun narxni to\'g\'ri kiriting.` };
    if (label) {
      const labelKey = label.toLowerCase();
      if (seenLabels.has(labelKey)) return { ok: false, reason: `"${label}" nomi takrorlangan — har bir variant nomi boshqacha bo\'lsin.` };
      seenLabels.add(labelKey);
    }
    list.push({
      id: (raw && raw.id && String(raw.id)) || crypto.randomBytes(4).toString('hex'),
      label,
      price: priceNum
    });
  }
  return { ok: true, list };
}

function comboStockNeeds(owner, combo, comboQty) {
  const needs = [];
  for (const entry of ((combo && combo.itemIds) || [])) {
    const menuItem = (owner.menu || []).find(m => m.id === entry.menuItemId);
    if (!menuItem) continue;
    const unitsNeeded = entry.qty * comboQty;
    if (menuItem.directStockId) {
      needs.push({ stockId: menuItem.directStockId, qty: Math.round(unitsNeeded * 1000) / 1000, viaName: menuItem.name });
      continue;
    }
    const recipe = Array.isArray(menuItem.recipe) ? menuItem.recipe : [];
    for (const ing of recipe) {
      needs.push({ stockId: ing.stockId, qty: Math.round(ing.qty * unitsNeeded * 1000) / 1000, viaName: menuItem.name });
    }
  }
  return needs;
}

function menuItemOutOfStock(owner, menuItem) {
  if (!menuItem) return false;
  if (menuItem.directStockId) {
    const stockItem = (owner.stock || []).find(s => s.id === menuItem.directStockId);
    if (!stockItem) return false;
    return stockItem.qty < 1;
  }
  const recipe = Array.isArray(menuItem.recipe) ? menuItem.recipe : [];
  if (!recipe.length) return false;
  return recipe.some(ing => {
    const stockItem = (owner.stock || []).find(s => s.id === ing.stockId);
    if (!stockItem) return false;
    return stockItem.qty < ing.qty;
  });
}

function comboOutOfStock(owner, combo) {
  if (!combo) return false;
  const needs = comboStockNeeds(owner, combo, 1);
  return needs.some(need => {
    const stockItem = (owner.stock || []).find(s => s.id === need.stockId);
    if (!stockItem) return false;
    return stockItem.qty < need.qty;
  });
}

const CARD_ONLY_AFTER_CANCELLED_DELIVERIES = 2;
function customerCancelledDeliveryCount(owner, userId) {
  return (owner.orders || []).filter(o =>
    String(o.customerId) === String(userId) &&
    o.orderType === 'dostavka' &&
    o.status === 'bekor_qilindi'
  ).length;
}
function customerIsCardOnlyRestricted(owner, userId) {

  if ((owner.cardOnlyOverrides || []).some(id => String(id) === String(userId))) return false;
  return customerCancelledDeliveryCount(owner, userId) >= CARD_ONLY_AFTER_CANCELLED_DELIVERIES;
}

function ownerRatedOrders(owner) {
  return (owner.orders || []).filter(o => Number.isFinite(o.customerRating));
}
function ownerAverageRating(owner) {
  const rated = ownerRatedOrders(owner);
  if (!rated.length) return { avg: null, count: 0 };
  const sum = rated.reduce((s, o) => s + o.customerRating, 0);
  return { avg: Math.round((sum / rated.length) * 10) / 10, count: rated.length };
}

const STOCK_UNITS = { kg: 'kg', g: 'g', l: 'l', ml: 'ml', dona: 'dona' };
// Sklad mahsuloti buzilib/isrof bo'lib spisaniya qilinganda tanlanadigan sabablar
// (masalan: katlet kuysa, non qotib qolsa yoki yirtilsa).
const WRITEOFF_REASONS = {
  kuydi: 'Kuydi (kuyib qoldi)',
  qotib_qoldi: 'Qotib qoldi',
  yirtildi: 'Yirtildi / shikastlandi',
  tushib_ketdi: "Tushib ketdi / to'kildi",
  muddati_otdi: "Muddati o'tdi / buzilgan",
  boshqa: 'Boshqa sabab'
};
const ORDER_TYPES = { olib_ketish: 'Olib ketish', dostavka: 'Dostavka', zal: 'Zal', tashqari: 'Tashqari' };
// "zal" turi faqat kassir/ega tomonidan (zalda o'tirgan mijoz uchun) yaratiladi —
// mijozning botdagi buyurtma oynasida bu tur ko'rsatilmaydi (pastda CUSTOMER_ORDER_TYPES'ga qarang).
const CUSTOMER_ORDER_TYPES = { olib_ketish: 'Olib ketish', dostavka: 'Dostavka' };
const PAYMENT_TYPES = { naqd: 'Naqd', karta: 'Karta', click: 'Click', dostavka_orqali: 'Naqd' };

// Har bir taom NOMI uchun tayyorlanish vaqti (daqiqada) — oshxona guruhidagi
// jonli taymer shu vaqtga qarab yashil/sariq/qizil rangda ko'rsatiladi.
// Solishtirish katta-kichik harf va bo'sh joylarga sezgir emas, shuningdek
// narx varianti qo'shimchasini ("Nomi (200gr)" kabi) e'tiborga olmaydi.
const PREP_TIME_MINUTES = {
  'SALAT': 5,
  'QAZILI': 10,
  'HOT-LET': 10,
  'ASSORTI': 15,
  'SHASHLIK ASSORTI': 20,
  'GAMBURGER': 10
};
const PREP_TIME_MINUTES_NORMALIZED = Object.fromEntries(
  Object.entries(PREP_TIME_MINUTES).map(([k, v]) => [k.trim().toLowerCase(), v])
);
// Sariq -> qizilga o'tish chegarasi: belgilangan vaqtdan necha barobar
// oshsa qizil bo'lib qoladi (0 dan target gacha yashil, target dan
// target*RED gacha sariq, undan keyin qizil).
const PREP_TIME_RED_MULTIPLIER = 1.5;
const KITCHEN_TIMER_UPDATE_MS = 20000;

// Buyurtmadagi har bir taom nomidan narx varianti qo'shimchasini
// ("Nomi (200gr)" -> "Nomi") olib tashlab, solishtirish uchun tayyorlaydi.
function normalizeItemNameForPrepMatch(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

// Menyuda alohida ko'rsatilmagan taomlar uchun standart tayyorlanish
// vaqti (daqiqada). Shu tufayli taymer HAR BIR buyurtma uchun ishlaydi,
// hatto uning taomi PREP_TIME_MINUTES ro'yxatida bo'lmasa ham.
const DEFAULT_PREP_TIME_MINUTES = 10;

// Buyurtma tarkibidagi taomlar nomiga qarab eng uzoq tayyorlanish
// vaqtini (soniyada) topadi. Nomi PREP_TIME_MINUTES'da yo'q taomlar
// hisobga olinmaydi; hech biri mos kelmasa DEFAULT_PREP_TIME_MINUTES
// ishlatiladi (taymer baribir ko'rsatiladi va sanaydi).
function orderPrepTargetSeconds(order) {
  let maxMinutes = 0;
  for (const it of (order.items || [])) {
    const key = normalizeItemNameForPrepMatch(it.name);
    const minutes = PREP_TIME_MINUTES_NORMALIZED[key];
    if (minutes && minutes > maxMinutes) maxMinutes = minutes;
  }
  if (maxMinutes === 0) maxMinutes = DEFAULT_PREP_TIME_MINUTES;
  return maxMinutes * 60;
}



function fmtMmSs(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// Buyurtma yaratilgan paytdan boshlab o'tgan vaqtga qarab holatni
// aniqlaydi: 'green' (vaqt ichida), 'yellow' (vaqtdan oshdi),
// 'red' (ancha oshdi). targetSec bo'lmasa (mos taom topilmagan) null.
function kitchenTimerStatus(order) {
  const targetSec = orderPrepTargetSeconds(order);
  if (targetSec === null) return null;
  const elapsedSec = Math.max(0, (Date.now() - new Date(order.createdAt).getTime()) / 1000);
  let color = 'green';
  if (elapsedSec > targetSec * PREP_TIME_RED_MULTIPLIER) color = 'red';
  else if (elapsedSec > targetSec) color = 'yellow';
  return { color, targetSec, elapsedSec };
}

const KITCHEN_TIMER_LABELS = {
  green: { emoji: '🟢', text: 'Vaqt ichida' },
  yellow: { emoji: '🟡', text: 'Vaqtdan oshdi' },
  red: { emoji: '🔴', text: 'Ancha kechikdi' }
};

// Xabarga qo'shiladigan taymer qatori. O'tgan vaqt (elapsed) / maqsad
// vaqti ko'rinishida ko'rsatiladi va har KITCHEN_TIMER_UPDATE_MS
// millisekundda (quyidagi setInterval) xabar qayta tahrirlanib, sekundlar
// yangilanib turadi.
function kitchenTimerLine(order) {
  const status = kitchenTimerStatus(order);
  if (!status) return null;
  const label = KITCHEN_TIMER_LABELS[status.color];
  return `${label.emoji} ${label.text} (${fmtMmSs(status.elapsedSec)} / ${fmtMmSs(status.targetSec)})`;
}

function orderIncomeAmount(o) {
  if (o.status === 'bekor_qilindi') return 0;
  if (o.paymentProofStatus === 'kutilmoqda' || o.paymentProofStatus === 'rad_etildi') return 0;
  return o.total || 0;
}

const ORDER_STATUSES = { yangi: 'Yangi', tayyorlanmoqda: 'Tayyorlanmoqda', tayyor: 'Tayyor' };

const ORDER_DELAY_THRESHOLD_MINUTES = 20;

const ORDER_REQUEST_CACHE_TTL_MS = 10 * 60 * 1000;
const orderRequestCache = new Map();

function getCachedOrderResponse(ownerId, userId, requestId) {
  if (!requestId) return null;
  const key = `${ownerId}:${userId}:${requestId}`;
  const entry = orderRequestCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    orderRequestCache.delete(key);
    return null;
  }
  return entry.response;
}

function setCachedOrderResponse(ownerId, userId, requestId, response) {
  if (!requestId) return;
  const key = `${ownerId}:${userId}:${requestId}`;
  orderRequestCache.set(key, { response, expiresAt: Date.now() + ORDER_REQUEST_CACHE_TTL_MS });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of orderRequestCache) {
    if (entry.expiresAt < now) orderRequestCache.delete(key);
  }
}, 5 * 60 * 1000);

function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(STAFF_ROLES, role);
}

const MAX_MENU_IMAGE_BASE64_CHARS = 3_000_000;
function isValidImageValue(value) {
  if (!value) return true;
  if (/^https?:\/\//i.test(value)) return true;
  if (IMG_URL_RE.test(value)) return true; // allaqachon saqlangan rasm
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(value)) {
    return value.length <= MAX_MENU_IMAGE_BASE64_CHARS;
  }
  return false;
}

function normalizeStaffRoles(staff) {
  if (!staff) return [];
  if (Array.isArray(staff.roles) && staff.roles.length) {
    return staff.roles.filter(isValidRole);
  }
  if (staff.role && isValidRole(staff.role)) return [staff.role];
  return [];
}

function staffHasRole(staff, role) {
  return normalizeStaffRoles(staff).includes(role);
}

function ctxHasRole(ctx, role) {
  if (!ctx) return false;
  if (ctx.role === 'egasi') return role === 'egasi';
  return Array.isArray(ctx.roles) ? ctx.roles.includes(role) : ctx.role === role;
}

function ctxHasAnyRole(ctx, roles) {
  return roles.some(r => ctxHasRole(ctx, r));
}

// Avtomatik hisobotlar (kunlik, haftalik, AI direktor) kimlarga yuborilishi
// kerakligini aniqlaydi: asosiy egasi + "Egasi (hamkor)" roli berilgan barcha
// xodimlar (havola orqali qo'shilganlar ham shular qatorida — chunki ular
// ham owner.staff ichida rol="egasi" bilan saqlanadi).
function ownerReportRecipientIds(owner) {
  const staffEgasi = (owner.staff || []).filter(s => staffHasRole(s, 'egasi')).map(s => s.id);
  return Array.from(new Set([owner.id, ...staffEgasi].map(String)));
}

function rolesLabel(roles) {
  return (roles || []).map(r => STAFF_ROLES[r] || r).join(', ') || '—';
}

function findStaffInfo(owners, userId) {
  for (const owner of owners) {
    const staff = (owner.staff || []).find(s => String(s.id) === String(userId));
    if (staff) {
      const rawRoles = normalizeStaffRoles(staff);
      const roles = allowedStaffRoles(owner, rawRoles);
      return {
        ownerId: owner.id,
        ownerName: (owner.profile && owner.profile.name) || null,
        ownerLogoUrl: (owner.profile && owner.profile.logoUrl) || null,
        ownerBrandColor: (owner.profile && owner.profile.brandColor) || null,
        role: roles[0] || null,
        roles,
        rawRoles,
        staff
      };
    }
  }
  return null;
}

function resolveOwnerContext(owners, userId, opts) {

  if (opts && opts.targetOwnerId && isAdminId(userId)) {
    const targetOwner = findOwner(owners, opts.targetOwnerId);
    if (!targetOwner) return null;
    return { owner: targetOwner, role: 'egasi', roles: ['egasi'], branchId: null, isAdminActing: true };
  }
  const owner = findOwner(owners, userId);
  if (isOwnerAccessValid(owner)) return { owner, role: 'egasi', roles: ['egasi'], branchId: null };

  const staffInfo = findStaffInfo(owners, userId);
  if (staffInfo) {
    const staffOwner = owners.find(o => String(o.id) === String(staffInfo.ownerId));
    if (staffOwner) {
      return {
        owner: staffOwner,
        role: staffInfo.role,
        roles: staffInfo.roles,
        branchId: staffInfo.staff.branchId || null
      };
    }
  }
  return null;
}

function findCustomer(owner, userId) {
  return (owner.customers || []).find(c => String(c.id) === String(userId));
}

function findOrCreateCustomer(owner, userId, tgUser) {
  if (!owner.customers) owner.customers = [];
  let c = findCustomer(owner, userId);
  if (!c) {
    c = {
      id: String(userId),
      username: (tgUser && tgUser.username) || null,
      firstName: (tgUser && tgUser.first_name) || null,
      favorites: [],
      addresses: [],
      bonusPoints: 0,
      ordersCount: 0,
      totalSpent: 0,
      createdAt: new Date().toISOString()
    };
    owner.customers.push(c);
  } else {
    if (tgUser && tgUser.username) c.username = tgUser.username;
    if (tgUser && tgUser.first_name) c.firstName = tgUser.first_name;

    if (!Array.isArray(c.addresses)) c.addresses = [];
  }
  return c;
}

function buildAiWaiterRecommendations(owner, userId, availableMenu) {
  const customer = findCustomer(owner, userId);
  const empty = { favorites: [], similar: [] };
  if (!customer || !customer.itemFrequency || customer.ordersCount < 1) return empty;

  const freqEntries = Object.entries(customer.itemFrequency).sort((a, b) => b[1] - a[1]);
  if (!freqEntries.length) return empty;

  const favorites = [];
  for (const [itemId, count] of freqEntries) {
    const item = availableMenu.find(m => m.id === itemId);
    if (item) favorites.push(Object.assign({}, item, { orderedCount: count }));
    if (favorites.length >= 4) break;
  }
  if (!favorites.length) return empty;

  const triedIds = new Set(freqEntries.map(([id]) => id));
  const topCategories = [...new Set(favorites.slice(0, 2).map(f => f.category).filter(Boolean))];
  const similar = [];
  if (topCategories.length) {
    for (const item of availableMenu) {
      if (triedIds.has(item.id)) continue;
      if (!item.category || !topCategories.includes(item.category)) continue;
      similar.push(item);
      if (similar.length >= 4) break;
    }
  }

  return { favorites, similar };
}

const MAX_CUSTOMER_ADDRESSES = 15;

function findCustomerAddress(customer, addressId) {
  return (customer.addresses || []).find(a => a.id === addressId);
}

function findActivePromo(owner, promoId) {
  if (!promoId) return null;
  const promo = (owner.promotions || []).find(p => p.id === promoId && p.active);
  return promo || null;
}

function applyPromoDiscount(owner, promoId, subtotal) {
  const promo = findActivePromo(owner, promoId);
  if (!promo) return { promo: null, discountAmount: 0 };
  if (promo.minTotal && subtotal < promo.minTotal) return { promo: null, discountAmount: 0 };
  const discountAmount = Math.round(subtotal * (promo.discountPercent / 100));
  return { promo, discountAmount };
}

// Har juma kuni (Toshkent vaqti bo'yicha) avtomatik ishlaydigan "4+1"
// aksiyasi: ichimliklardan tashqari BARCHA mahsulotlarga tegishli — bir xil
// mahsulotdan (bir xil taom + bir xil narx varianti) har 5 tasi uchun 1 tasi
// bepul bo'ladi (4 tasi pullanadi). Owner qo'lda tanlaydigan oddiy
// foizli promo (promoId) bilan bir vaqtda ham ishlashi mumkin — ikkalasi
// ham subtotal'dan ayriladi. Ichimlik ekanligi mahsulot kategoriyasi
// nomida "ichim" so'zi borligiga qarab aniqlanadi (masalan "Ichimliklar").
function isDrinkCategoryName(category) {
  return !!category && /ichim/i.test(String(category));
}

function isTashkentFridayNow() {
  return kitchenTashkentDate().getUTCDay() === 5;
}

function computeBuy4Get1FreePromo(orderItems) {
  if (!isTashkentFridayNow()) return { discountAmount: 0, noteHtml: null };
  const groups = new Map();
  (orderItems || []).forEach(it => {
    if (isDrinkCategoryName(it.category)) return;
    if (!it.qty || !it.price) return;
    const key = `${it.isCombo ? 'combo:' : 'item:'}${it.id}:${it.priceId || ''}`;
    const g = groups.get(key);
    if (g) { g.qty += it.qty; } else { groups.set(key, { qty: it.qty, price: it.price, name: it.name }); }
  });
  let discountAmount = 0;
  const freeLines = [];
  groups.forEach(g => {
    const freeUnits = Math.floor(g.qty / 5);
    if (freeUnits > 0) {
      discountAmount += freeUnits * g.price;
      freeLines.push(`${escapeHtmlServer(g.name)} x${freeUnits} bepul`);
    }
  });
  if (!discountAmount) return { discountAmount: 0, noteHtml: null };
  return { discountAmount, noteHtml: `🎁 <b>4+1 aksiya (juma)</b>: ${freeLines.join(', ')}` };
}

function logStaffAction(owner, entry) {
  if (!owner.staffActionLog) owner.staffActionLog = [];
  owner.staffActionLog.unshift(Object.assign({
    id: crypto.randomBytes(4).toString('hex'),
    errorCount: 0,
    createdAt: new Date().toISOString()
  }, entry));
  if (owner.staffActionLog.length > 2000) owner.staffActionLog.length = 2000;
}

const TELEGRAM_TIMEOUT_MS = 15000;
function telegramApi(method, params) {
  return new Promise((resolve, reject) => {
    // POST (form-urlencoded): uzun xabarlar URL uzunligi chegarasiga urilmaydi
    const body = new URLSearchParams(params || {}).toString();
    const req = https.request(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(TELEGRAM_TIMEOUT_MS, () => req.destroy(new Error(`Telegram ${method} timeout`)));
    req.on('error', reject);
    req.end(body);
  });
}

function telegramApiUploadPhoto(chatId, buffer, mimeType, fields) {
  return new Promise((resolve, reject) => {
    const boundary = '----uzbotBoundary' + crypto.randomBytes(16).toString('hex');
    const CRLF = '\r\n';
    const chunks = [];
    const pushField = (name, value) => {
      if (value === undefined || value === null || value === '') return;
      chunks.push(Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${String(value)}${CRLF}`, 'utf8'
      ));
    };
    pushField('chat_id', chatId);
    Object.keys(fields || {}).forEach(k => pushField(k, fields[k]));
    const ext = (mimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    chunks.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="photo"; filename="broadcast.${ext}"${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`, 'utf8'
    ));
    chunks.push(buffer);
    chunks.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'));
    const body = Buffer.concat(chunks);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendPhoto`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, replyMarkup, threadId) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup);
  if (threadId) params.message_thread_id = threadId;
  return telegramApi('sendMessage', params).then(result => {
    if (!result || !result.ok) {
      const reason = (result && result.description) || 'noma\'lum xatolik';
      console.error(`[sendMessage xato] chat_id=${chatId}: ${reason}`);
    }
    return result;
  }).catch(err => {
    console.error(`[sendMessage tarmoq xatosi] chat_id=${chatId}: ${(err && err.message) || err}`);
    return null;
  });
}

function notifyStaffList(owner, targetIds, text, context, category) {

  const ownerMuted = category && isNotificationCategoryMuted(owner, category);
  const uniqueIds = [...new Set((targetIds || []).map(String))]
    .filter(id => !(ownerMuted && id === String(owner.id)));
  const promises = uniqueIds.map(targetId => sendMessage(targetId, text).then(result => {
    if (!result || !result.ok) {
      const reason = (result && result.description) || 'yuborilmadi (tarmoq xatosi)';
      const staff = (owner.staff || []).find(s => String(s.id) === String(targetId));
      if (!owner.notificationErrors) owner.notificationErrors = [];
      owner.notificationErrors.unshift({
        id: crypto.randomBytes(4).toString('hex'),
        targetId,
        targetName: staff ? staffDisplayName(staff) : (String(targetId) === String(owner.id) ? 'Egasi' : `ID: ${targetId}`),
        reason,
        context: context || null,
        createdAt: new Date().toISOString()
      });
      if (owner.notificationErrors.length > 50) owner.notificationErrors.length = 50;
    }
  }));
  return Promise.all(promises);
}

const NOTIFICATION_CATEGORIES = {
  newOrder: 'Yangi buyurtma xabarlari',
  lowStock: 'Ombordagi kam qoldiq ogohlantirishlari'
};

function isNotificationCategoryMuted(owner, category) {
  return !!(owner && owner.notificationPrefs && owner.notificationPrefs[category] === false);
}

function answerCallbackQuery(callbackId, text, showAlert) {
  const params = { callback_query_id: callbackId };
  if (text) params.text = text;
  if (showAlert) params.show_alert = 'true';
  return telegramApi('answerCallbackQuery', params).catch(() => {});
}

function editMessageText(chatId, messageId, text, replyMarkup) {
  const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup);
  else params.reply_markup = JSON.stringify({ inline_keyboard: [] });
  return telegramApi('editMessageText', params).catch(() => {});
}

function editMessageCaption(chatId, messageId, caption, replyMarkup) {
  const params = { chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML' };
  if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup);
  else params.reply_markup = JSON.stringify({ inline_keyboard: [] });
  return telegramApi('editMessageCaption', params).catch(() => {});
}

function copyMessageWithKeyboard(targetChatId, fromChatId, messageId, caption, replyMarkup) {
  const params = {
    chat_id: targetChatId, from_chat_id: fromChatId, message_id: messageId,
    caption, parse_mode: 'HTML'
  };
  if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup);
  return telegramApi('copyMessage', params).catch(() => {});
}

function locationMapsLink(location) {
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return null;
  return `https://maps.google.com/?q=${location.lat},${location.lng}`;
}

// --- Dostavka xizmat zonasi (geofencing) ---
// Filial markazidan belgilangan radiusdan tashqaridagi joylashuvlarga
// (masalan Samarqand, Xorazm va h.k.) dostavka buyurtmasi berilishining
// oldini olish uchun. Markaz koordinatasi — Zafar shaharchasi, Bekobod
// tumani, Toshkent viloyati.
const DELIVERY_ZONE_CENTER = { lat: 40.37639, lng: 69.25139 };
const DELIVERY_ZONE_RADIUS_KM = 10;

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Yer radiusi (km)
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function isWithinDeliveryZone(location) {
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return false;
  return distanceKm(location.lat, location.lng, DELIVERY_ZONE_CENTER.lat, DELIVERY_ZONE_CENTER.lng) <= DELIVERY_ZONE_RADIUS_KM;
}

function displayName(user) {
  if (!user) return 'Noma\'lum';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return name || (user.username ? '@' + user.username : String(user.id));
}

function customerDisplayName(userId, tgUser) {
  const profile = findProfile(userId);
  if (profile && profile.firstName) {
    return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  }
  return displayName(tgUser);
}

function orderCustomerContactLabel(order) {
  const lines = [`Mijoz: ${escapeHtmlServer(order.customerName)}`];
  if (order.customerPhone) lines.push(`Tel: ${escapeHtmlServer(order.customerPhone)}`);
  return lines.join('\n');
}

// Har bir buyurtma yakunlangach (mijoz oldi / kuryer yetkazdi / avtomatik
// yopilgan bo'lsa ham) — mijozga yulduzcha bilan baholash so'raladi.
// Uch joyda ham (dostavka, stol/olib ketish qo'lda, 2 soatlik avtomatik
// yopilish) bir xil xabar yuborilishi uchun bitta umumiy funksiya.
function sendOrderRatingRequest(owner, order) {
  if (!order.customerId || order.customerRating) return;
  const ratingKeyboard = {
    inline_keyboard: [[
      { text: '1⭐️', callback_data: `rate:${owner.id}:${order.id}:1` },
      { text: '2⭐️', callback_data: `rate:${owner.id}:${order.id}:2` },
      { text: '3⭐️', callback_data: `rate:${owner.id}:${order.id}:3` },
      { text: '4⭐️', callback_data: `rate:${owner.id}:${order.id}:4` },
      { text: '5⭐️', callback_data: `rate:${owner.id}:${order.id}:5` }
    ]]
  };
  sendMessage(order.customerId, '✅ Buyurtmangiz uchun rahmat!\n\nXizmatimizni qanday baholaysiz?', ratingKeyboard);
}

function staffDisplayName(staff) {
  if (!staff) return null;
  const profile = findProfile(staff.id);
  if (profile && profile.firstName) {
    return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  }
  return staff.username ? '@' + staff.username : `ID: ${staff.id}`;
}

function fmtNum(n) {
  const num = Math.round(Number(n) || 0);
  return num.toLocaleString('ru-RU').replace(/,/g, ' ');
}

function escapeHtmlServer(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function orderItemsTextWithPrices(order) {
  return order.items.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
}

function notifyDeliveryGroup(owner, order, creatorLabel) {
  const groups = resolveOrderGroupIds(owner, order);
  if (!groups.deliveryGroupId) return;
  if (!ownerCanUseFeature(owner, 'delivery-group')) return;
  const itemsText = orderItemsTextWithPrices(order);
  const mapsLink = locationMapsLink(order.location);
  const addressLines = [
    mapsLink ? `📍 Joylashuv: ${mapsLink}` : null,
    order.addressNote ? `📝 Manzil izohi: ${escapeHtmlServer(order.addressNote)}` : null,
    order.extraPhone ? `📞 Qo'shimcha tel: ${escapeHtmlServer(order.extraPhone)}` : null,
    order.comment ? `💬 Izoh: ${escapeHtmlServer(order.comment)}` : null,
  ].filter(Boolean).join('\n');
  const typeLabel = ORDER_TYPES[order.orderType] || order.orderType;
  const headerEmoji = order.orderType === 'dostavka' ? '🚚' : '🥡';
  const text = `${headerEmoji} <b>Yangi buyurtma</b> (${typeLabel})${creatorLabel ? '\n' + creatorLabel : ''}\n${itemsText}\n\nJami: ${fmtNum(order.total)} so'm\nTo'lov: ${PAYMENT_TYPES[order.paymentType] || order.paymentType}` +
    (addressLines ? `\n\n${addressLines}` : '');
  sendMessage(groups.deliveryGroupId, text, {
    inline_keyboard: [[
      { text: '✅ Qabul qilish', callback_data: `dgaccept:${owner.id}:${order.id}` },
      { text: '✅ Tayyor', callback_data: `dgready:${owner.id}:${order.id}` }
    ]]
  }, groups.deliveryGroupThreadId).then(result => {
    if (result && result.ok && result.result && result.result.message_id) {
      const owners2 = loadOwners();
      const o2 = findOwner(owners2, owner.id);
      const ord2 = o2 && (o2.orders || []).find(x => x.id === order.id);
      if (ord2) {
        ord2.deliveryGroupMsgId = result.result.message_id;
        saveOwners(owners2);
      }
    }
  }).catch(err => {
    console.error(`[notifyDeliveryGroup xatosi] owner=${owner.id} order=${order.id}: ${(err && err.message) || err}`);
  });
}

// Oshxona guruhidagi buyurtma xabarining o'zgarmas (taymersiz) qismi —
// dastlabki yuborishda ham, keyingi jonli taymer yangilanishlarida ham
// shundan foydalaniladi.
function kitchenGroupBaseText(order, creatorLabel) {
  const itemsText = orderItemsTextWithPrices(order);
  const typeLabel = ORDER_TYPES[order.orderType] || order.orderType;
  const commentLine = order.comment ? `\n💬 Izoh: ${escapeHtmlServer(order.comment)}` : '';
  const autoPromoLine = order.autoPromoNote ? `\n${order.autoPromoNote}` : '';
  const mapsLink = locationMapsLink(order.location);
  // Alohida dostavka guruhi endi ishlatilmaydi — shuning uchun dostavka
  // buyurtmalari uchun kerak bo'lgan barcha ma'lumotlar (mijoz, manzil,
  // to'lov turi) ham shu bitta oshxona guruh xabariga qo'shiladi.
  const addressLines = [
    mapsLink ? `📍 Joylashuv: ${mapsLink}` : null,
    order.addressNote ? `📝 Manzil izohi: ${escapeHtmlServer(order.addressNote)}` : null,
    order.extraPhone ? `📞 Qo'shimcha tel: ${escapeHtmlServer(order.extraPhone)}` : null,
  ].filter(Boolean).join('\n');
  const headerEmoji = order.orderType === 'dostavka' ? '🚚' : '👨‍🍳';
  return `${headerEmoji} <b>Yangi buyurtma</b> (${typeLabel})${creatorLabel ? '\n' + creatorLabel : ''}\n${itemsText}\n\nJami: ${fmtNum(order.total)} so'm\nTo'lov: ${PAYMENT_TYPES[order.paymentType] || order.paymentType}${commentLine}${autoPromoLine}` +
    (addressLines ? `\n\n${addressLines}` : '');
}

function kitchenGroupFullText(order) {
  const base = order.kitchenBaseText || kitchenGroupBaseText(order, order.kitchenCreatorLabel);
  const timerLine = kitchenTimerLine(order);
  return timerLine ? `⏱ ${timerLine}\n\n${base}` : base;
}

// Buyurtma "tayyor" yoki "bekor qilindi" holatiga o'tgach (ilova orqali
// bo'lsa ham, guruhdagi tugma orqali bo'lsa ham) — endi tebranib turadigan
// ⏱ taймer o'rniga QOTGAN (frozen) yakuniy qator ko'rsatiladi: nechi
// daqiqa-soniyada tayyor bo'lganini darhol ko'rsatadi, keyingi 20 soniyalik
// siklni kutmaydi (chunki tsikl faqat 'yangi'/'tayyorlanmoqda' holatidagi
// buyurtmalarni ko'rib chiqadi va bu buyurtmaga endi umuman tegmaydi).
function kitchenGroupFinalText(order) {
  const base = order.kitchenBaseText || kitchenGroupBaseText(order, order.kitchenCreatorLabel);
  if (order.status === 'tayyor') {
    const readyAt = order.readyAt || order.updatedAt;
    const ms = readyAt ? (new Date(readyAt).getTime() - new Date(order.createdAt).getTime()) : null;
    const durationText = ms !== null ? ` (${fmtMmSs(ms / 1000)} da)` : '';
    return `✅ Tayyor${durationText}\n\n${base}`;
  }
  if (order.status === 'bekor_qilindi') {
    return `❌ Bekor qilindi\n\n${base}`;
  }
  return kitchenGroupFullText(order);
}

function notifyKitchenGroup(owner, order, creatorLabel) {
  // Oshxonaga ketayotgan xabar bilan bir vaqtda chek ham chiqadi (agent rejimida).
  try { autoPrintKitchenTicket(owner, order); } catch (e) { console.error('Avto-chek xatosi:', e.message); }
  const groups = resolveOrderGroupIds(owner, order);
  if (!groups.kitchenGroupId) return;
  if (!ownerCanUseFeature(owner, 'kitchen-group')) return;
  try {
    order.kitchenCreatorLabel = creatorLabel || null;
    order.kitchenBaseText = kitchenGroupBaseText(order, creatorLabel);
    const text = kitchenGroupFullText(order);
    sendMessage(groups.kitchenGroupId, text, {
      inline_keyboard: [[
        { text: '✅ Tayyor', callback_data: `kgready:${owner.id}:${order.id}` }
      ]]
    }, groups.kitchenGroupThreadId).then(result => {
      if (result && result.ok && result.result && result.result.message_id) {
        const owners2 = loadOwners();
        const o2 = findOwner(owners2, owner.id);
        const ord2 = o2 && (o2.orders || []).find(x => x.id === order.id);
        if (ord2) {
          ord2.kitchenGroupMsgId = result.result.message_id;
          ord2.kitchenCreatorLabel = order.kitchenCreatorLabel;
          ord2.kitchenBaseText = order.kitchenBaseText;
          const initialStatus = kitchenTimerStatus(ord2);
          ord2.kitchenTimerColor = initialStatus ? initialStatus.color : null;
          saveOwners(owners2);
        }
      }
    }).catch(err => {
      console.error(`[notifyKitchenGroup xatosi] owner=${owner.id} order=${order.id}: ${(err && err.message) || err}`);
    });
  } catch (err) {
    console.error(`[notifyKitchenGroup kutilmagan xatosi] owner=${owner.id} order=${order.id}: ${(err && err.message) || err}`);
  }
}

// Har KITCHEN_TIMER_UPDATE_MS millisekundda — oshxona guruhida hali
// "tayyor" deb belgilanmagan buyurtmalarning xabari AVTOMATIK tahrirlanadi
// (har tikda, holat o'zgarmagan bo'lsa ham) — shu tarzda taymer va
// rang (🟢/🟡/🔴) doim yangilanib turadi.
//
// Eski, uzoq vaqt "Tayyor" bosilmagan buyurtmalar (masalan sinov
// uchun qolib ketgan) MAX_TIMER_AGE_MS'dan oshsa — taymer ularga
// UMUMAN tegmaydi (chunki ular haqiqiy faol buyurtma emas, va
// ko'plab shunday eski xabar bir vaqtda tahrirlanib, flood control'ni
// keltirib chiqarishi mumkin edi).
//
// Qo'shimcha ehtiyot chorasi: bir tikda ko'pi bilan MAX_EDITS_PER_TICK
// ta xabar tahrirlanadi — qolganlari navbatdagi tikka qoladi, shunday
// qilib guruhga bir vaqtning o'zida ko'p so'rov ketmaydi.
const MAX_TIMER_AGE_MS = 3 * 60 * 60 * 1000; // 3 soatdan eski buyurtmalarga tegilmaydi
const MAX_EDITS_PER_TICK = 5;
const kitchenTimerBackoffUntil = new Map();
// Barcha oshxona guruh xabarlari (turli egalar/filiallar) o'rtasida
// navbat bilan (round-robin) yangilash uchun ko'rsatkich. MUHIM: avvalgi
// versiyada har tikda ro'yxat DOIM boshidan boshlab tekshirilib,
// birinchi topilgan MAX_EDITS_PER_TICK ta buyurtma yangilanardi va
// ortig'iga navbat yetmasa shu tikda tashlab ketilardi. Agar bitta
// (asosiy) filialda doim MAX_EDITS_PER_TICK'dan ko'p faol buyurtma bo'lsa,
// ro'yxatda undan keyin turgan boshqa filiallarning buyurtmalari HECH
// QACHON navbatga yetmay, taymeri butunlay yangilanmay qolardi (aynan
// "boshqa filialda taymer ishlamayabdi / bir marta ishlab keyin to'xtadi"
// muammosi shundan edi). Endi navbat oldingi to'xtagan joydan davom
// etadi — shu bilan hamma buyurtma, band bo'lsa ham, ertami-kechmi
// o'z yangilanish navbatini oladi.
let kitchenTimerRRIndex = 0;
setInterval(() => {
  const owners = loadOwners();
  let ownersChanged = false;

  const candidates = [];
  for (const owner of owners) {
    const hasAnyKitchenGroup = !!owner.kitchenGroupId || (owner.branches || []).some(b => b.kitchenGroupId);
    if (!hasAnyKitchenGroup) continue;
    if (!ownerCanUseFeature(owner, 'kitchen-group')) continue;
    for (const order of (owner.orders || [])) {
      // Bitta buyurtmadagi kutilmagan xato (masalan noto'g'ri/yetishmayotgan
      // maydon) endi FAQAT shu buyurtmani o'tkazib yuboradi — avvalgi
      // versiyada bunday xato butun tsiklni (shu owner'dan keyingi barcha
      // owner/filiallarni) shu tikda to'xtatib qo'yishi mumkin edi.
      try {
        if (order.status !== 'yangi' && order.status !== 'tayyorlanmoqda') continue;
        if (!order.kitchenGroupMsgId) continue;
        const ageMs = Date.now() - new Date(order.createdAt).getTime();
        if (ageMs > MAX_TIMER_AGE_MS) continue;
        const groups = resolveOrderGroupIds(owner, order);
        if (!groups.kitchenGroupId) continue;
        if (Date.now() < (kitchenTimerBackoffUntil.get(groups.kitchenGroupId) || 0)) continue;
        const status = kitchenTimerStatus(order);
        if (!status) continue;
        candidates.push({ owner, order, groups, status });
      } catch (err) {
        console.error(`[kitchen-timer] buyurtmani tekshirishda xato: owner=${owner.id} order=${order && order.id}: ${(err && err.message) || err}`);
      }
    }
  }

  if (candidates.length > 0) {
    const startIdx = kitchenTimerRRIndex % candidates.length;
    const batchSize = Math.min(MAX_EDITS_PER_TICK, candidates.length);
    for (let i = 0; i < batchSize; i++) {
      const { owner, order, groups, status } = candidates[(startIdx + i) % candidates.length];
      try {
        order.kitchenTimerColor = status.color;
        ownersChanged = true;
        const text = kitchenGroupFullText(order);
        const keyboard = { inline_keyboard: [[{ text: '✅ Tayyor', callback_data: `kgready:${owner.id}:${order.id}` }]] };
        editMessageText(groups.kitchenGroupId, order.kitchenGroupMsgId, text, keyboard).then(result => {
          if (result && result.error_code === 429) {
            const retryAfterSec = Math.max((result.parameters && result.parameters.retry_after) || 30, 60);
            kitchenTimerBackoffUntil.set(groups.kitchenGroupId, Date.now() + retryAfterSec * 1000 + 2000);
            console.error(`[kitchen-timer] flood control (429): chat=${groups.kitchenGroupId} retry_after=${retryAfterSec}s — taymer vaqtincha to'xtatildi`);
          } else if (!result || result.ok === false) {
            console.error(`[kitchen-timer] tahrirlash muvaffaqiyatsiz: chat=${groups.kitchenGroupId} order=${order.id} javob=${result ? JSON.stringify(result.description || result) : 'tarmoq xatosi'}`);
          }
        }).catch(err => {
          console.error(`[kitchen-timer] editMessageText va'da xatosi: owner=${owner.id} order=${order.id}: ${(err && err.message) || err}`);
        });
      } catch (err) {
        console.error(`[kitchen-timer] xabarni tahrirlashda xato: owner=${owner.id} order=${order.id}: ${(err && err.message) || err}`);
      }
    }
    kitchenTimerRRIndex = (startIdx + batchSize) % candidates.length;
  }

  if (ownersChanged) saveOwners(owners);
}, KITCHEN_TIMER_UPDATE_MS);


// Dostavka buyurtmalarida — oshpaz "Tayyor" deb belgilagach, ENDI dostavka
// guruhiga xabar boradi (avvalroq emas). Bu yerda tugma yo'q — chunki
// kuryerning o'zi "Yetkazildi"/"Mijoz qabul qilmadi" amallarini mini-ilova
// orqali (kuryer taxtasidan) bajaradi, shu sabab bu shunchaki xabar beruvchi
// (informatsion) xabar.
function notifyDeliveryGroupOrderReady(owner, order) {
  const groups = resolveOrderGroupIds(owner, order);
  if (!groups.deliveryGroupId) return;
  if (!ownerCanUseFeature(owner, 'delivery-group')) return;
  if (order.orderType !== 'dostavka') return;
  const itemsText = orderItemsTextWithPrices(order);
  const text = `🚚 <b>Buyurtma tayyor — yetkazishga oling</b>\n${orderCustomerContactLabel(order)}\n${itemsText}\n\nJami: ${fmtNum(order.total)} so'm\nTo'lov: ${PAYMENT_TYPES[order.paymentType] || order.paymentType}`;
  sendMessage(groups.deliveryGroupId, text, {
    inline_keyboard: [[
      { text: '✅ Yetkazildi', callback_data: `dgdelivered:${owner.id}:${order.id}` }
    ]]
  }, groups.deliveryGroupThreadId).then(result => {
    if (result && result.ok && result.result && result.result.message_id) {
      const owners2 = loadOwners();
      const o2 = findOwner(owners2, owner.id);
      const ord2 = o2 && (o2.orders || []).find(x => x.id === order.id);
      if (ord2) {
        ord2.deliveryReadyGroupMsgId = result.result.message_id;
        saveOwners(owners2);
      }
    }
  }).catch(err => {
    console.error(`[notifyDeliveryGroupOrderReady xatosi] owner=${owner.id} order=${order.id}: ${(err && err.message) || err}`);
  });
}

function syncGroupMessagesForOrder(owner, order, opts) {
  const skipKitchenTextFinalize = !!(opts && opts.skipKitchenTextFinalize);
  const groups = resolveOrderGroupIds(owner, order);
  const targets = [
    { chatId: groups.deliveryGroupId, msgId: order.deliveryGroupMsgId, prefix: 'dg' },
    { chatId: groups.kitchenGroupId, msgId: order.kitchenGroupMsgId, prefix: 'kg' }
  ].filter(t => t.chatId && t.msgId);
  if (!targets.length) return;

  for (const t of targets) {
    let kb = { inline_keyboard: [] };
    if (t.prefix === 'kg') {
      // Oshpazlar guruhida "Qabul qilish" bosqichi yo'q — buyurtma "yangi"
      // yoki "tayyorlanmoqda" bo'lishidan qat'i nazar, faqat "Tayyor"
      // tugmasi ko'rinadi (bosilganda ikkalasi ham bir yo'la bajariladi).
      if (order.status === 'yangi' || order.status === 'tayyorlanmoqda') {
        kb = { inline_keyboard: [[{ text: '✅ Tayyor', callback_data: `kgready:${owner.id}:${order.id}` }]] };
      }
    } else if (order.status === 'yangi') {
      kb = { inline_keyboard: [[
        { text: '✅ Qabul qilish', callback_data: `${t.prefix}accept:${owner.id}:${order.id}` },
        { text: '✅ Tayyor', callback_data: `${t.prefix}ready:${owner.id}:${order.id}` }
      ]] };
    } else if (order.status === 'tayyorlanmoqda') {
      kb = { inline_keyboard: [[{ text: '✅ Tayyor', callback_data: `${t.prefix}ready:${owner.id}:${order.id}` }]] };
    }

    // Oshxona guruhidagi buyurtma "tayyor" yoki "bekor qilindi" bo'lib
    // qolgan bo'lsa — bu terminal holat, va 20 soniyalik davriy taймer
    // endi bu buyurtmaga umuman tegmaydi (faqat 'yangi'/'tayyorlanmoqda'
    // buyurtmalarni ko'rib chiqadi). Shu sabab bu yerda, DARHOL, xabar
    // MATNINI ham (nafaqat tugmalarni) yakuniy holatga yangilaymiz — aks
    // holda eski ⏱ taймer qatori abadiy o'sha qiymatda "qotib" qolardi.
    if (t.prefix === 'kg' && !skipKitchenTextFinalize && (order.status === 'tayyor' || order.status === 'bekor_qilindi')) {
      editMessageText(t.chatId, t.msgId, kitchenGroupFinalText(order), kb.inline_keyboard.length ? kb : null).catch(err => {
        console.error(`[syncGroupMessagesForOrder xatosi] owner=${owner.id} order=${order.id} chat=${t.chatId}: ${(err && err.message) || err}`);
      });
      continue;
    }

    telegramApi('editMessageReplyMarkup', {
      chat_id: t.chatId, message_id: t.msgId,
      reply_markup: JSON.stringify(kb)
    }).catch(err => {
      console.error(`[syncGroupMessagesForOrder xatosi] owner=${owner.id} order=${order.id} chat=${t.chatId}: ${(err && err.message) || err}`);
    });
  }
}

const EXPIRY_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const DEFAULT_REMINDER_DAYS = 1;

function ownerLabel(owner) {
  return owner.username ? '@' + owner.username : `ID: ${owner.id}`;
}

function ownerReminderBeforeMs(owner) {
  let reminderDays = DEFAULT_REMINDER_DAYS;
  if (owner.tariffId) {
    const tariff = loadTariffs().find(t => t.id === owner.tariffId);
    if (tariff && Number.isFinite(tariff.reminderDays) && tariff.reminderDays > 0) {
      reminderDays = tariff.reminderDays;
    }
  }
  return reminderDays * 24 * 60 * 60 * 1000;
}

async function checkOwnerExpirations() {
  const owners = loadOwners();
  let changed = false;

  for (const owner of owners) {

    if (owner.subscriptionStatus === SUBSCRIPTION_STATUS.PENDING_TRIAL) continue;

    const access = getOwnerSubscriptionAccess(owner);

    if (!access.allowed) {
      if (owner.subscriptionStatus !== SUBSCRIPTION_STATUS.BLOCKED) {
        owner.subscriptionStatus = SUBSCRIPTION_STATUS.BLOCKED;
        changed = true;
      }
      if (!owner.blockedNotifiedAt) {
        owner.blockedNotifiedAt = new Date().toISOString();
        changed = true;
        await sendMessage(ADMIN_ID,
          `⏰ <b>Obuna muddati tugadi</b>\n${ownerLabel(owner)} (ID: <code>${owner.id}</code>) uchun Mini App'ga kirish bloklandi.\nMa'lumotlari (menyu, xodimlar, buyurtmalar) saqlanib qolyapti — obuna uzaytirilsa, kirish avtomatik tiklanadi.`);
        await sendMessage(owner.id,
          `⏰ Sizning obuna muddatingiz tugadi, Mini App'ga kirish bloklandi.\nMa'lumotlaringiz saqlanib qolyapti — obunani uzaytirsangiz, kirish avtomatik tiklanadi.\nUzaytirish uchun Mini App'dagi "💳 Obuna" bo'limini oching yoki quyidagi tugmani bosing.`,
          { inline_keyboard: [[{ text: '💳 Obunani uzaytirish', callback_data: 'obuna_menyu' }]] });
      }
      continue;
    }

    if (owner.subscriptionStatus !== SUBSCRIPTION_STATUS.ACTIVE) {
      owner.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
      changed = true;
    }
    if (owner.blockedNotifiedAt) {
      owner.blockedNotifiedAt = null;
      changed = true;
    }

    if (owner.subscriptionUntil && !owner.reminderSentAt) {
      const expiresMs = new Date(owner.subscriptionUntil).getTime();
      const now = Date.now();
      if (Number.isFinite(expiresMs) && expiresMs > now && expiresMs - now <= ownerReminderBeforeMs(owner)) {
        changed = true;
        owner.reminderSentAt = new Date().toISOString();
        const daysLeft = Math.max(1, Math.ceil((expiresMs - now) / 86400000));
        await sendMessage(ADMIN_ID,
          `🔔 <b>Obuna tugashiga oz qoldi</b>\n${ownerLabel(owner)} (ID: <code>${owner.id}</code>) — taxminan ${daysLeft} kundan keyin tugaydi.`);
        await sendMessage(owner.id,
          `🔔 Sizning obunangiz tez orada tugaydi (taxminan ${daysLeft} kun qoldi).\nUzaytirish uchun Mini App'dagi "💳 Obuna" bo'limini oching yoki quyidagi tugmani bosing.`,
          { inline_keyboard: [[{ text: '💳 Obunani uzaytirish', callback_data: 'obuna_menyu' }]] });
      }
    }
  }

  if (changed) saveOwners(owners);
}

function createInvite() {
  const token = crypto.randomBytes(16).toString('hex');
  const invites = loadInvites();
  invites.push({ token, createdAt: new Date().toISOString(), used: false, usedBy: null, usedAt: null });
  saveInvites(invites);
  return token;
}

function findInvite(token) {
  const invites = loadInvites();
  return invites.find(i => i.token === token);
}

function markInviteUsed(token, userId) {
  const invites = loadInvites();
  const inv = invites.find(i => i.token === token);
  if (inv) { inv.used = true; inv.usedBy = String(userId); inv.usedAt = new Date().toISOString(); saveInvites(invites); }
}

function createRequest(user, token) {
  const reqId = crypto.randomBytes(4).toString('hex');
  const reqs = loadRequests();
  reqs.push({
    reqId,
    token,
    userId: String(user.id),
    username: user.username || null,
    firstName: user.first_name || null,
    createdAt: new Date().toISOString()
  });
  saveRequests(reqs);
  return reqId;
}

function findRequest(reqId) {
  return loadRequests().find(r => r.reqId === reqId);
}

function removeRequest(reqId) {
  const reqs = loadRequests().filter(r => r.reqId !== reqId);
  saveRequests(reqs);
}

const DAY_LABELS = { '1': '1 kun', '7': '7 kun', '30': '30 kun', 'p': 'Doimiy' };

function daysKeyboard(reqId) {
  return {
    inline_keyboard: [
      [
        { text: '1 kun', callback_data: `apr:${reqId}:1` },
        { text: '7 kun', callback_data: `apr:${reqId}:7` },
        { text: '30 kun', callback_data: `apr:${reqId}:30` }
      ],
      [{ text: 'Doimiy ruxsat', callback_data: `apr:${reqId}:p` }],
      [{ text: '✏️ Boshqa son (kun kiritish)', callback_data: `custom:${reqId}` }],
      [{ text: '❌ Rad etish', callback_data: `rej:${reqId}` }]
    ]
  };
}

const AWAITING_FILE = path.join(DATA_DIR, 'awaiting.json');

const BACKUP_FILE_DEFS = [
  { key: 'owners', file: OWNERS_FILE },
  { key: 'admins', file: ADMINS_FILE },
  { key: 'invites', file: INVITES_FILE },
  { key: 'requests', file: REQUESTS_FILE },
  { key: 'profiles', file: PROFILES_FILE },
  { key: 'tariffs', file: TARIFFS_FILE },
  { key: 'payments', file: PAYMENTS_FILE },
  { key: 'archived_orders', file: ARCHIVED_ORDERS_FILE },
  { key: 'subscription_plans', file: SUBSCRIPTION_PLANS_FILE },
  { key: 'settings', file: SETTINGS_FILE },
  { key: 'broadcasts', file: BROADCASTS_FILE },
  { key: 'trash', file: TRASH_FILE },
  { key: 'trash_log', file: TRASH_LOG_FILE },
  { key: 'awaiting', file: AWAITING_FILE }
];
const BACKUP_FORMAT_VERSION = 1;

const PRE_RESTORE_BACKUP_DIR = path.join(DATA_DIR, 'pre_restore_backups');

const pendingBackupRestores = new Map();
const BACKUP_RESTORE_TOKEN_TTL_MS = 10 * 60 * 1000;

function readJSONFileRaw(file) {
  try {
    if (!fs.existsSync(file)) return { present: false, value: null };
    const raw = fs.readFileSync(file, 'utf8');
    return { present: true, value: JSON.parse(raw) };
  } catch (e) {
    return { present: false, value: null, error: e.message };
  }
}

function buildBackupSnapshot(adminId) {
  const files = {};
  const counts = {};
  for (const def of BACKUP_FILE_DEFS) {
    const r = readJSONFileRaw(def.file);
    files[def.key] = r.present ? r.value : (Array.isArray(r.value) ? [] : null);
    counts[def.key] = Array.isArray(files[def.key]) ? files[def.key].length
      : (files[def.key] && typeof files[def.key] === 'object' ? Object.keys(files[def.key]).length : 0);
  }
  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: String(adminId),
    counts,
    files
  };
}

function writeJSONFileAtomic(file, value) {
  const tmp = file + '.tmp' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function applyBackupSnapshot(snapshot) {
  const applied = [];
  for (const def of BACKUP_FILE_DEFS) {
    if (!snapshot.files || !(def.key in snapshot.files)) continue;
    const value = snapshot.files[def.key];
    if (value === null || value === undefined) continue;
    writeJSONFileAtomic(def.file, value);
    applied.push(def.key);
  }
  reloadAdminsCache();
  return applied;
}

function savePreRestoreSafetySnapshot(adminId) {
  try {
    fs.mkdirSync(PRE_RESTORE_BACKUP_DIR, { recursive: true });
    const snapshot = buildBackupSnapshot(adminId);
    const filename = `pre_restore_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filePath = path.join(PRE_RESTORE_BACKUP_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');

    const files = fs.readdirSync(PRE_RESTORE_BACKUP_DIR).filter(f => f.startsWith('pre_restore_')).sort();
    while (files.length > 10) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(PRE_RESTORE_BACKUP_DIR, old)); } catch (e) {}
    }
    return filename;
  } catch (e) {
    console.error('pre-restore xavfsizlik nusxasini saqlashda xatolik:', e.message);
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pendingBackupRestores.entries()) {
    if (now - entry.createdAt > BACKUP_RESTORE_TOKEN_TTL_MS) pendingBackupRestores.delete(token);
  }
}, 5 * 60 * 1000);

function getAwaitingCustom() {
  try {
    const raw = fs.readFileSync(AWAITING_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function setAwaitingCustom(reqId, promptMessageId) {
  fs.writeFileSync(AWAITING_FILE, JSON.stringify({ kind: 'approve_days', reqId, promptMessageId }), 'utf8');
}

function setAwaitingSubRejectReason(ownerId, chatId, messageId, hasPhoto, originalContent) {
  fs.writeFileSync(AWAITING_FILE, JSON.stringify({ kind: 'sub_reject_reason', ownerId, chatId, messageId, hasPhoto, originalContent }), 'utf8');
}

function clearAwaitingCustom() {
  try { fs.unlinkSync(AWAITING_FILE); } catch (e) {}
}

function isPlausiblePhone(str) {
  const cleaned = String(str).replace(/[\s\-()]/g, '');
  // Faqat O'zbekiston raqamlarini qabul qilamiz: +998 (yoki 998) va undan keyin 9 ta raqam
  return /^\+?998\d{9}$/.test(cleaned);
}

function approveRequest(reqInfo, days) {
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400000).toISOString();
  const owners = loadOwners();
  const already = findOwner(owners, reqInfo.userId);
  if (already) {
    already.expiresAt = expiresAt;
    already.username = reqInfo.username || already.username;
    already.reminderSentAt = null;
  } else {
    owners.push({
      id: reqInfo.userId,
      username: reqInfo.username || null,
      addedAt: new Date().toISOString(),
      expiresAt,
      price: 0,
      paid: false,
      paidAt: null
    });
  }
  saveOwners(owners);
  removeRequest(reqInfo.reqId);
  const label = days === null ? 'Doimiy' : `${days} kun`;
  return label;
}

const pendingSelfRegistration = new Set();

// Ro'yxatdan o'tish jarayonini boshlaydi ("Oshxonangiz nomini yozing" deb
// so'raydi). Ikki joydan chaqiriladi: (1) inline tugma (self_register_start
// callback — pastda), (2) Mini App ichidagi "Hamkor bo'lish" havolasi orqali
// kelgan /start owner_register (handleStartCommand ichida) — mantiq ikki
// joyda takrorlanmasin deb bitta manbaga jamlandi.
async function beginSelfRegistration(userId) {
  if (isAdminId(userId)) {
    await sendMessage(userId, 'Siz administratorsiz, ro\'yxatdan o\'tishning hojati yo\'q.');
    return;
  }
  const owners = loadOwners();
  if (findOwner(owners, userId)) {
    await sendMessage(userId, 'Siz allaqachon ro\'yxatdan o\'tgansiz. Mini App tugmasi orqali oching.');
    return;
  }
  if (findStaffInfo(owners, userId)) {
    await sendMessage(userId, 'Siz allaqachon boshqa oshxonaning xodimisiz, alohida ega sifatida ro\'yxatdan o\'ta olmaysiz.');
    return;
  }
  pendingSelfRegistration.add(String(userId));
  await sendMessage(userId, 'Oshxonangiz nomini yozib yuboring (masalan: "Sardor Osh Markazi").');
}

const pendingReviewComments = new Map();
const REVIEW_COMMENT_WINDOW_MS = 30 * 60 * 1000;

async function handleStartCommand(chatId, from, text) {
  const parts = text.split(' ');
  const payload = parts.length > 1 ? parts[1].trim() : '';

  if (!payload) {
    if (isAdminId(from.id)) {
      await sendMessage(chatId, 'Salom, admin! Mini App tugmasi orqali boshqaruv panelini oching.');
      return;
    }
    const owners = loadOwners();
    if (findOwner(owners, from.id) || findStaffInfo(owners, from.id)) {
      const skCtx = skResolveCtx(owners, from.id);
      if (skCtx) {
        await sendMessage(chatId, "Salom! Mini App tugmasi orqali boshqaruv panelini oching.\n\n📦 Ostatka, 📖 retsept va 🧮 audit uchun quyidagi tugmani bosing:",
          { inline_keyboard: [[{ text: '🗄 Sklad (ostatka / retsept / audit)', callback_data: 'sk:menu' }]] });
        return;
      }
      await sendMessage(chatId, 'Salom! Mini App tugmasi orqali boshqaruv panelini oching.');
      return;
    }

    const trash = loadTrash();
    const trashEntry = findTrashEntryByOwnerId(trash, from.id);
    if (trashEntry) {
      if (trashEntry.restoreStatus === 'pending') {
        await sendMessage(chatId,
          '🕓 Oshxonangizni tiklash so\'rovingiz allaqachon adminga yuborilgan, tasdiqlanishini kuting.');
        return;
      }
      const daysLeft = Math.max(0, Math.ceil((new Date(trashEntry.autoPurgeAt).getTime() - Date.now()) / 86400000));
      await sendMessage(chatId,
        `⚠️ Oshxonangiz o'chirilgan (Savatchada saqlanmoqda, ${daysLeft} kun ichida tiklash mumkin).\n` +
        `Barcha ma'lumotlaringiz (menyu, xodimlar, sozlamalar) saqlanib turibdi. Tiklashni so'rasangiz, so'rovingiz administratorga yuboriladi.`,
        { inline_keyboard: [[{ text: '🔄 Tiklashni so\'rash', callback_data: `request_restore:${trashEntry.id}` }]] });
      return;
    }

    if (!PUBLIC_URL) {
      await sendMessage(chatId,
        `👋 <b>Pulsar</b>ga xush kelibsiz!\n` +
        `Bu — oshxonangiz uchun buyurtma qabul qilish va boshqarish tizimi (menyu, xodimlar, sklad, hisobotlar).\n\n` +
        `O'z oshxonangizni ro'yxatdan o'tkazish uchun quyidagi tugmani bosing:`,
        { inline_keyboard: [[{ text: "📝 Ro'yxatdan o'tish", callback_data: 'self_register_start' }]] });
      return;
    }

    const entryMenuUrl = `${PUBLIC_URL.replace(/\/$/, '')}/`;
    await sendMessage(chatId,
      `👋 <b>Pulsar</b>ga xush kelibsiz!\n` +
      `Buyurtma berish uchun quyidagi tugmani bosing:`,
      { inline_keyboard: [
        [{ text: '🍽 Menyuni ochish', web_app: { url: entryMenuUrl } }]
      ] });
    return;
  }

  // Mini App ichidagi "Siz ham oshxona egasimisiz? Hamkor bo'ling" havolasi
  // shu payload bilan botga qaytaradi (qarang: /api/partner-register-link
  // va renderCustomerEntry ichidagi "Hamkor bo'lish" tugmasi). Ilgari bu
  // tugma HAR BIR yangi mijozga /start xabarida ko'rsatilardi va ular
  // "oshxona egasimisiz?" deb so'ralgandek tuyular edi — endi mijozlar
  // to'g'ridan-to'g'ri menyuga o'tadi, hamkorlik esa ilova ichida (kamroq
  // ko'zga tashlanadigan joyda) taklif qilinadi.
  if (payload === 'owner_register') {
    await beginSelfRegistration(from.id);
    return;
  }

  if (payload.startsWith('menu_')) {
    const ownerId = payload.replace(/^menu_/, '').trim();
    const owners = pruneExpiredOwners();
    const owner = findOwner(owners, ownerId);
    if (!owner || !isOwnerAccessValid(owner)) {
      await sendMessage(chatId, 'Kechirasiz, bu oshxona menyusi hozircha mavjud emas.');
      return;
    }
    if (!PUBLIC_URL) {
      await sendMessage(chatId, 'Menyu havolasi hozircha sozlanmagan. Iltimos, oshxona bilan bog\'laning.');
      return;
    }
    const restaurantName = (owner.profile && owner.profile.name) || 'Oshxona';
    const menuUrl = `${PUBLIC_URL.replace(/\/$/, '')}/?customer=${encodeURIComponent(owner.id)}`;
    const welcomeText = `🍽 <b>${escapeHtmlServer(restaurantName)}</b> menyusiga xush kelibsiz!`;
    await sendMessage(chatId, welcomeText, {
      inline_keyboard: [[{ text: '🍽 Menyuni ochish', web_app: { url: menuUrl } }]]
    });
    return;
  }

  if (payload.startsWith('staffinv_')) {
    const rest = payload.replace(/^staffinv_/, '');
    const sepIdx = rest.indexOf('_');
    const ownerId = sepIdx >= 0 ? rest.slice(0, sepIdx) : '';
    const token = sepIdx >= 0 ? rest.slice(sepIdx + 1) : '';

    const owners = pruneExpiredOwners();
    const owner = findOwner(owners, ownerId);
    const invite = owner && (owner.staffInvites || []).find(i => i.token === token);

    if (!owner || !invite || invite.used || new Date(invite.expiresAt) <= new Date()) {
      await sendMessage(chatId, 'Bu havola yaroqsiz yoki allaqachon ishlatilgan. Iltimos, menejerdan yangi havola so\'rang.');
      return;
    }
    if (isAdminId(from.id)) {
      await sendMessage(chatId, 'Siz administratorsiz, xodim bo\'la olmaysiz.');
      return;
    }
    if (findOwner(owners, from.id)) {
      await sendMessage(chatId, 'Siz allaqachon oshxona egasisiz, xodim bo\'la olmaysiz.');
      return;
    }
    const existingStaff = findStaffInfo(owners, from.id);
    if (existingStaff) {
      await sendMessage(chatId, existingStaff.ownerId === owner.id
        ? 'Siz allaqachon shu oshxonaning xodimisiz. Mini App tugmasi orqali oching.'
        : 'Siz boshqa oshxonada xodim sifatida ro\'yxatdasiz.');
      return;
    }

    invite.used = true;
    invite.usedBy = String(from.id);
    invite.usedAt = new Date().toISOString();

    if (!owner.staff) owner.staff = [];
    owner.staff.push({
      id: String(from.id),
      username: from.username || null,
      role: invite.roles[0],
      roles: invite.roles,
      branchId: invite.branchId || null,
      addedAt: new Date().toISOString()
    });
    saveOwners(owners);

    await sendMessage(chatId,
      `👋 Siz <b>${escapeHtmlServer((owner.profile && owner.profile.name) || 'oshxona')}</b> jamoasiga <b>${escapeHtmlServer(rolesLabel(invite.roles))}</b> sifatida qo\'shildingiz.\nMini App tugmasi orqali oching.`);
    sendMessage(owner.id, `✅ ${escapeHtmlServer(displayName(from))}${from.username ? ' (@' + escapeHtmlServer(from.username) + ')' : ''} taklif havolasi orqali <b>${escapeHtmlServer(rolesLabel(invite.roles))}</b> sifatida jamoaga qo\'shildi.`);
    return;
  }

  const token = payload.replace(/^inv_/, '');
  const invite = findInvite(token);

  if (isAdminId(from.id)) {
    await sendMessage(chatId, 'Siz allaqachon administratorsiz.');
    return;
  }

  if (!invite || invite.used) {
    await sendMessage(chatId, 'Bu havola yaroqsiz yoki allaqachon ishlatilgan. Iltimos, admindan yangi havola so\'rang.');
    return;
  }

  const owners = pruneExpiredOwners();
  const existing = findOwner(owners, from.id);
  if (existing && isOwnerAccessValid(existing)) {
    markInviteUsed(token, from.id);
    await sendMessage(chatId, 'Sizda allaqachon kirish huquqi mavjud. Mini App tugmasi orqali oching.');
    return;
  }

  markInviteUsed(token, from.id);
  const reqId = createRequest(from, token);

  await sendMessage(chatId, 'So\'rovingiz adminga yuborildi. Iltimos, tasdiqlanishini kuting.');

  const infoText = `🆕 <b>Yangi do'kon egasi so'rovi</b>\n` +
    `Ism: ${displayName(from)}\n` +
    (from.username ? `Username: @${from.username}\n` : '') +
    `ID: <code>${from.id}</code>\n\n` +
    `Necha kunga ruxsat berasiz?`;
  await sendMessage(ADMIN_ID, infoText, daysKeyboard(reqId));
}

// ==========================================================================
// SKLAD BOT-MENYU: "Retsept qo'shish", "Ostatka qo'shish" va "Audit"
// funksiyalarini oshxona egasi (yoki "Egasi (hamkor)" xodimi) uchun
// to'g'ridan-to'g'ri Telegram bot ichida, tugmalar orqali, sodda va tez
// bajarish imkonini beradi. Bu — Mini App'dagi shu funksiyalarning O'RNINI
// bosmaydi, faqat qo'shimcha tezkor yo'l: Mini App'dagi "Sklad", "Retsept"
// va "Audit" bo'limlari avvalgidek to'liq ishlab turadi.
// Holat (foydalanuvchi qaysi bosqichda ekani) userId bo'yicha xotirada
// saqlanadi — bir nechta ega/hamkor bir vaqtda alohida-alohida foydalana oladi.
// ==========================================================================
const botFlowState = new Map();

function skClearState(userId) {
  botFlowState.delete(String(userId));
}

function skResolveCtx(owners, userId) {
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx || !ctxHasAnyRole(ctx, ['egasi', 'sklad'])) return null;
  return ctx;
}

function skPool(ctx) {
  return resolveStockPool(ctx.owner, ctx.role === 'egasi' ? null : ctx.branchId);
}

async function sendSkladMenu(chatId, userId) {
  skClearState(userId);
  await sendMessage(chatId,
    "📋 <b>Sklad bo'limi</b>\nKerakli amalni tanlang:",
    { inline_keyboard: [
      [{ text: "📦 Ostatka qo'shish", callback_data: 'sk:stockadd' }],
      [{ text: '📖 Retseptga mahsulot qo\'shish', callback_data: 'sk:recipe' }],
      [{ text: '🧮 Audit topshirish', callback_data: 'sk:audit' }]
    ] });
}

function skBackCancelRow() {
  return [
    [{ text: '⬅️ Sklad menyusi', callback_data: 'sk:menu' }],
    [{ text: '❌ Bekor qilish', callback_data: 'sk:cancel' }]
  ];
}

async function sendStockAddMenu(ctx, chatId) {
  const pool = skPool(ctx);
  const items = (pool ? (pool.stock || []) : []).slice().sort((a, b) => a.name.localeCompare(b.name, 'uz'));
  const rows = items.slice(0, 40).map(it => ([{ text: `${it.name} (${it.qty} ${it.unit})`, callback_data: `sk:stockadd:pick:${it.id}` }]));
  rows.push([{ text: "➕ Yangi mahsulot qo'shish", callback_data: 'sk:stockadd:new' }]);
  rows.push(...skBackCancelRow());
  await sendMessage(chatId, "📦 <b>Ostatka qo'shish</b>\nQaysi mahsulotga qo'shasiz? Yoki yangi mahsulot yarating:", { inline_keyboard: rows });
}

async function sendRecipeMenuList(ctx, chatId) {
  const menu = (ctx.owner.menu || []).filter(m => !m.directStockId).slice().sort((a, b) => a.name.localeCompare(b.name, 'uz'));
  if (!menu.length) {
    await sendMessage(chatId, "Hozircha retsept belgilash mumkin bo'lgan taom yo'q. Avval Mini App orqali menyuga taom qo'shing.", { inline_keyboard: skBackCancelRow() });
    return;
  }
  const rows = menu.slice(0, 40).map(m => {
    const count = Array.isArray(m.recipe) ? m.recipe.length : 0;
    return [{ text: `${m.name}${count ? ` (${count} ta ingredient)` : ''}`, callback_data: `sk:recipe:item:${m.id}` }];
  });
  rows.push(...skBackCancelRow());
  await sendMessage(chatId, "📖 <b>Retseptga mahsulot qo'shish</b>\nQaysi taom uchun retsept belgilaysiz?", { inline_keyboard: rows });
}

async function sendRecipeIngredientList(ctx, chatId, menuItem) {
  const pool = skPool(ctx);
  const stock = (pool ? (pool.stock || []) : []).slice().sort((a, b) => a.name.localeCompare(b.name, 'uz'));
  if (!stock.length) {
    await sendMessage(chatId, "Skladda hali mahsulot yo'q. Avval \"Ostatka qo'shish\" orqali sklad mahsulotini qo'shing.", { inline_keyboard: skBackCancelRow() });
    return;
  }
  const recipe = Array.isArray(menuItem.recipe) ? menuItem.recipe : [];
  const rows = stock.slice(0, 40).map(s => {
    const existing = recipe.find(r => r.stockId === s.id);
    const label = existing ? `${s.name} ✅ (${existing.qty} ${s.unit})` : `${s.name} (${s.unit})`;
    return [{ text: label, callback_data: `sk:recipe:ing:${menuItem.id}:${s.id}` }];
  });
  rows.push([{ text: '✅ Tugatish', callback_data: `sk:recipe:done:${menuItem.id}` }]);
  rows.push(...skBackCancelRow());
  await sendMessage(chatId, `📖 <b>${escapeHtmlServer(menuItem.name)}</b>\nQaysi sklad mahsulotini retseptga qo'shasiz? (✅ — retseptda allaqachon bor)`, { inline_keyboard: rows });
}

function skAuditPromptText(state) {
  const cur = state.items[state.index];
  return `🧮 <b>Audit</b> (${state.index + 1}/${state.items.length})\n` +
    `${escapeHtmlServer(cur.name)} — hozir tizimda: <b>${cur.qty} ${escapeHtmlServer(cur.unit)}</b>\n\n` +
    `Haqiqiy (ko'zdan kechirib o'lchangan) miqdorni yozing:`;
}

function skAuditKeyboard() {
  return { inline_keyboard: [
    [{ text: "⏭ O'tkazib yuborish", callback_data: 'sk:audit:skip' }],
    [{ text: '✅ Shu yergacha yakunlash', callback_data: 'sk:audit:finish' }],
    [{ text: '❌ Bekor qilish', callback_data: 'sk:cancel' }]
  ] };
}

async function sendAuditPrompt(chatId, state) {
  await sendMessage(chatId, skAuditPromptText(state), skAuditKeyboard());
}

async function finalizeAudit(userId, chatId) {
  const state = botFlowState.get(String(userId));
  if (!state || state.kind !== 'audit') return;
  skClearState(userId);

  if (!state.entries.length) {
    await sendMessage(chatId, "Audit bekor qilindi — hech qanday mahsulot uchun miqdor kiritilmadi.");
    return;
  }

  const owners = loadOwners();
  const ctx = skResolveCtx(owners, userId);
  if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
  const pool = resolveStockPool(ctx.owner, state.branchId);
  if (!pool) { await sendMessage(chatId, "Bunday filial topilmadi."); return; }

  const auditEntries = [];
  for (const e of state.entries) {
    const stockItem = findStockItem(pool, e.stockId);
    if (!stockItem) continue;
    const systemQty = stockItem.qty;
    const diff = Math.round((e.actualQty - systemQty) * 1000) / 1000;
    auditEntries.push({ stockId: stockItem.id, name: stockItem.name, unit: stockItem.unit, systemQty, actualQty: e.actualQty, diff });
    if (diff !== 0) {
      addStockMovement(pool, {
        stockId: stockItem.id, stockName: stockItem.name, type: 'audit_tuzatish',
        qty: diff, unit: stockItem.unit,
        note: diff > 0 ? 'Audit: ortiqcha topildi' : 'Audit: kamomad topildi',
        userId
      });
    }
    stockItem.qty = e.actualQty;
    checkLowStockAlert(ctx.owner, stockItem, userId, state.branchId);
  }

  if (!auditEntries.length) {
    await sendMessage(chatId, "Hech qanday mos mahsulot topilmadi.");
    return;
  }

  if (!pool.audits) pool.audits = [];
  const audit = {
    id: crypto.randomBytes(4).toString('hex'),
    date: new Date().toISOString().slice(0, 10),
    branchId: state.branchId,
    entries: auditEntries,
    createdBy: String(userId),
    createdAt: new Date().toISOString()
  };
  pool.audits.unshift(audit);
  if (pool.audits.length > 60) pool.audits.length = 60;

  const kamomadCount = auditEntries.filter(e => e.diff < 0).length;
  const ortiqchaCount = auditEntries.filter(e => e.diff > 0).length;
  logStaffAction(ctx.owner, {
    userId, role: ctx.role, action: 'audit_topshirdi',
    note: `${auditEntries.length} mahsulot tekshirildi (bot orqali)${kamomadCount ? `, ${kamomadCount} ta kamomad` : ''}${ortiqchaCount ? `, ${ortiqchaCount} ta ortiqcha` : ''}`,
    errorCount: kamomadCount
  });

  saveOwners(owners);

  const lines = auditEntries.map(e => {
    const mark = e.diff === 0 ? '✅' : (e.diff > 0 ? '➕' : '➖');
    const diffText = e.diff !== 0 ? ` (${e.diff > 0 ? '+' : ''}${e.diff})` : '';
    return `${mark} ${escapeHtmlServer(e.name)}: ${e.systemQty} → ${e.actualQty} ${escapeHtmlServer(e.unit)}${diffText}`;
  }).join('\n');
  await sendMessage(chatId, `✅ <b>Audit yakunlandi</b>\n${lines}`, { inline_keyboard: [[{ text: '⬅️ Sklad menyusi', callback_data: 'sk:menu' }]] });
}

// Foydalanuvchidan matn kutilayotgan bosqichlarni qayta ishlaydi (miqdor,
// narx, yangi mahsulot nomi va h.k.). true qaytarsa — xabar shu yerda
// to'liq ishlov berilgan (boshqa handlerlar ishga tushmasin).
async function handleSkTextInput(from, chatId, text) {
  const userId = String(from.id);
  const state = botFlowState.get(userId);
  if (!state) return false;

  const owners = loadOwners();
  const ctx = skResolveCtx(owners, userId);
  if (!ctx) {
    skClearState(userId);
    await sendMessage(chatId, 'Ruxsatingiz yo\'q.');
    return true;
  }

  const parseNum = (t) => {
    const n = Number(String(t).trim().replace(',', '.'));
    return n;
  };

  if (state.kind === 'stock_qty') {
    const qtyNum = parseNum(text);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      await sendMessage(chatId, "Iltimos, musbat son yuboring (masalan: 5 yoki 2.5). Bekor qilish uchun /bekor yozing.");
      return true;
    }
    const pool = skPool(ctx);
    const item = pool && findStockItem(pool, state.stockId);
    if (!item) { skClearState(userId); await sendMessage(chatId, "Mahsulot topilmadi."); return true; }

    item.qty = Math.round((item.qty + qtyNum) * 1000) / 1000;
    addStockMovement(pool, { stockId: item.id, stockName: item.name, type: 'kirim', qty: qtyNum, unit: item.unit, note: "Bot orqali kiritildi", userId });
    checkLowStockAlert(ctx.owner, item, userId, ctx.role === 'egasi' ? null : ctx.branchId);
    logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'sklad_kirim', note: `${item.name}: +${qtyNum} ${item.unit} (bot)` });

    if (item.price) {
      if (!ctx.owner.expenses) ctx.owner.expenses = [];
      ctx.owner.expenses.unshift({
        id: crypto.randomBytes(4).toString('hex'),
        amount: Math.round(qtyNum * item.price * 100) / 100,
        category: 'sklad_xarid',
        note: `${item.name} — ${qtyNum} ${item.unit} (bot)`,
        createdAt: new Date().toISOString(),
        createdBy: userId,
        source: 'stock',
        stockId: item.id
      });
      if (ctx.owner.expenses.length > 500) ctx.owner.expenses.length = 500;
    }
    saveOwners(owners);
    skClearState(userId);
    await sendMessage(chatId, `✅ <b>${escapeHtmlServer(item.name)}</b>: +${qtyNum} ${escapeHtmlServer(item.unit)}\nYangi qoldiq: ${item.qty} ${escapeHtmlServer(item.unit)}`,
      { inline_keyboard: [[{ text: "📦 Yana ostatka qo'shish", callback_data: 'sk:stockadd' }], [{ text: '⬅️ Sklad menyusi', callback_data: 'sk:menu' }]] });
    return true;
  }

  if (state.kind === 'stock_new_name') {
    const nameTrim = String(text || '').trim();
    if (nameTrim.length < 2 || nameTrim.length > 60) {
      await sendMessage(chatId, "Iltimos, mahsulot nomini 2-60 belgi oralig'ida yozing. Bekor qilish uchun /bekor yozing.");
      return true;
    }
    state.kind = 'stock_new_unit';
    state.name = nameTrim;
    await sendMessage(chatId, `Birlikni tanlang — <b>${escapeHtmlServer(nameTrim)}</b>:`, {
      inline_keyboard: [
        [{ text: 'kg', callback_data: 'sk:stockadd:unit:kg' }, { text: 'g', callback_data: 'sk:stockadd:unit:g' }],
        [{ text: 'l', callback_data: 'sk:stockadd:unit:l' }, { text: 'ml', callback_data: 'sk:stockadd:unit:ml' }],
        [{ text: 'dona', callback_data: 'sk:stockadd:unit:dona' }],
        [{ text: '❌ Bekor qilish', callback_data: 'sk:cancel' }]
      ]
    });
    return true;
  }

  if (state.kind === 'stock_new_qty') {
    const qtyNum = parseNum(text);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      await sendMessage(chatId, "Iltimos, musbat son yuboring (masalan: 10). Bekor qilish uchun /bekor yozing.");
      return true;
    }
    state.qty = qtyNum;
    state.kind = 'stock_new_price';
    await sendMessage(chatId, `1 ${escapeHtmlServer(state.unit)} narxini yozing (so'm, masalan: 15000):`);
    return true;
  }

  if (state.kind === 'stock_new_price') {
    const priceNum = parseNum(text);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      await sendMessage(chatId, "Iltimos, narxni musbat son bilan yozing (masalan: 15000). Bekor qilish uchun /bekor yozing.");
      return true;
    }
    const pool = skPool(ctx);
    if (!pool) { skClearState(userId); await sendMessage(chatId, 'Filial topilmadi.'); return true; }
    if (!pool.stock) pool.stock = [];

    let item = pool.stock.find(s => s.name.toLowerCase() === state.name.toLowerCase() && s.unit === state.unit);
    if (item) {
      item.qty = Math.round((item.qty + state.qty) * 1000) / 1000;
      item.price = priceNum;
    } else {
      item = {
        id: crypto.randomBytes(4).toString('hex'),
        name: state.name,
        qty: state.qty,
        unit: state.unit,
        price: priceNum,
        minQty: null,
        lowStockAlertSent: false,
        addedAt: new Date().toISOString()
      };
      pool.stock.push(item);
    }

    addStockMovement(pool, { stockId: item.id, stockName: item.name, type: 'kirim', qty: state.qty, unit: item.unit, note: "Bot orqali kiritildi (yangi)", userId });
    checkLowStockAlert(ctx.owner, item, userId, ctx.role === 'egasi' ? null : ctx.branchId);
    logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'sklad_kirim', note: `${item.name}: +${state.qty} ${item.unit} (bot, yangi)` });

    if (!ctx.owner.expenses) ctx.owner.expenses = [];
    ctx.owner.expenses.unshift({
      id: crypto.randomBytes(4).toString('hex'),
      amount: Math.round(state.qty * priceNum * 100) / 100,
      category: 'sklad_xarid',
      note: `${item.name} — ${state.qty} ${item.unit} (bot)`,
      createdAt: new Date().toISOString(),
      createdBy: userId,
      source: 'stock',
      stockId: item.id
    });
    if (ctx.owner.expenses.length > 500) ctx.owner.expenses.length = 500;

    saveOwners(owners);
    skClearState(userId);
    await sendMessage(chatId, `✅ <b>${escapeHtmlServer(item.name)}</b> skladga qo'shildi: ${item.qty} ${escapeHtmlServer(item.unit)} (narxi: ${fmtNum(priceNum)} so'm)`,
      { inline_keyboard: [[{ text: "📦 Yana ostatka qo'shish", callback_data: 'sk:stockadd' }], [{ text: '⬅️ Sklad menyusi', callback_data: 'sk:menu' }]] });
    return true;
  }

  if (state.kind === 'recipe_qty') {
    const qtyNum = parseNum(text);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      await sendMessage(chatId, "Iltimos, musbat son yuboring (masalan: 0.05). Bekor qilish uchun /bekor yozing.");
      return true;
    }
    const menuItem = (ctx.owner.menu || []).find(m => m.id === state.menuId);
    if (!menuItem) { skClearState(userId); await sendMessage(chatId, "Taom topilmadi."); return true; }
    if (!Array.isArray(menuItem.recipe)) menuItem.recipe = [];
    const existing = menuItem.recipe.find(r => r.stockId === state.stockId);
    if (existing) existing.qty = qtyNum;
    else menuItem.recipe.push({ stockId: state.stockId, qty: qtyNum });
    saveOwners(owners);

    await sendMessage(chatId, `✅ <b>${escapeHtmlServer(menuItem.name)}</b> retseptiga qo'shildi: ${qtyNum} ${escapeHtmlServer(state.unit)} — ${escapeHtmlServer(state.stockName)}`);
    skClearState(userId);
    await sendRecipeIngredientList(ctx, chatId, menuItem);
    return true;
  }

  if (state.kind === 'audit') {
    const cur = state.items[state.index];
    if (!cur) { await finalizeAudit(userId, chatId); return true; }
    const qtyNum = parseNum(text);
    if (!Number.isFinite(qtyNum) || qtyNum < 0) {
      await sendMessage(chatId, "Iltimos, 0 yoki musbat son yuboring (masalan: 3.5). Yoki quyidagi tugmalardan birini bosing.", skAuditKeyboard());
      return true;
    }
    state.entries.push({ stockId: cur.id, actualQty: qtyNum });
    state.index += 1;
    if (state.index < state.items.length) {
      await sendAuditPrompt(chatId, state);
    } else {
      await finalizeAudit(userId, chatId);
    }
    return true;
  }

  // Holat mavjud, lekin hozirgi bosqich tugma bosishni kutmoqda (masalan,
  // birlik tanlash) — matnli javob unga mos kelmaydi.
  await sendMessage(chatId, "Iltimos, yuqoridagi tugmalardan birini tanlang. Bekor qilish uchun /bekor yozing.");
  return true;
}

async function handleTelegramUpdate(update) {
  if (update.message && update.message.text) {
    const msg = update.message;
    const text = msg.text.trim();
    const from = msg.from;
    const chatId = msg.chat.id;

    // /myid — foydalanuvchining Telegram ID raqami (ilova/saytga kirish logini va "Parolni unutdim" uchun).
    // Guruhda yozilsa, guruh ID si ham ko'rsatiladi.
    if (text === '/myid' || text.startsWith('/myid@')) {
      let reply = `🆔 Sizning Telegram ID raqamingiz:\n<code>${from.id}</code>\n\n` +
        '<i>Ustiga bossangiz, nusxa olinadi. Xodimlar ilovaga kirishda login o\'rniga shu raqamni yozadi.</i>';
      if (msg.chat.type !== 'private') reply += `\n\n👥 Bu guruh ID si: <code>${chatId}</code>`;
      await sendMessage(chatId, reply, null, msg.message_thread_id);
      return;
    }

    if (msg.chat.type === 'private' && (text === '/bekor') && botFlowState.has(String(from.id))) {
      skClearState(from.id);
      await sendMessage(chatId, 'Bekor qilindi.');
      return;
    }

    if (msg.chat.type === 'private' && (text === '/sklad' || text.startsWith('/sklad@'))) {
      const owners = pruneExpiredOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) {
        await sendMessage(chatId, "Bu buyruq faqat oshxona egasi (yoki uning hamkori) uchun mavjud.");
        return;
      }
      await sendSkladMenu(chatId, from.id);
      return;
    }

    if (msg.chat.type === 'private' && !text.startsWith('/') && botFlowState.has(String(from.id))) {
      const handled = await handleSkTextInput(from, chatId, text);
      if (handled) return;
    }

    // /biriktir va /oshpaz_biriktir buyruqlari ixtiyoriy filial kodi bilan
    // yozilishi mumkin (masalan "/biriktir a1b2c3d4e5f6") — shunda ushbu
    // guruh aynan o'sha filialga bog'lanadi va faqat o'sha filial
    // buyurtmalari shu guruhga keladi. Kod ko'rsatilmasa — avvalgidek
    // markaziy (owner darajasidagi) guruh sifatida biriktiriladi. Filial
    // kodini Mini App'dagi "Filiallar" bo'limidan tayyor buyruq shaklida
    // nusxalab olish mumkin — shu bilan jarayon soddalashtirildi.
    if ((msg.chat.type === 'group' || msg.chat.type === 'supergroup') && /^\/biriktir(@\S+)?(\s+\S+)?$/.test(text)) {
      const owners = pruneExpiredOwners();
      // Guruhni biriktirish — asosiy egasiga ham, unga "Egasi (hamkor)"
      // sifatida to'liq huquq berilgan hamkorlarga ham ruxsat etiladi
      // (ular alohida owner yozuvi emas, shuning uchun resolveOwnerContext
      // orqali aniqlanadi — findOwner faqat asosiy egasini topadi).
      const ctx = resolveOwnerContext(owners, from.id);
      if (!isOwnerRole(ctx)) {
        const blocked = getBlockedOwnerAccess(owners, from.id);
        if (blocked) await sendSubscriptionBlockedScreen(chatId, blocked);
        else await sendMessage(chatId, 'Faqat tasdiqlangan oshxona egasi guruhni biriktira oladi.');
        return;
      }
      const owner = ctx.owner;
      if (!ownerCanUseFeature(owner, 'delivery-group')) {
        await sendMessage(chatId, featureBlockedResult('delivery-group').reason);
        return;
      }
      const branchCode = text.split(/\s+/)[1] || null;
      let branch = null;
      if (branchCode) {
        branch = findBranch(owner, branchCode);
        if (!branch) { await sendMessage(chatId, `❌ "${escapeHtmlServer(branchCode)}" kodli filial topilmadi. Kodni Mini App'dagi Filiallar bo'limidan qaytadan nusxalab ko'ring.`); return; }
      }
      const target = branch || owner;
      target.deliveryGroupId = String(chatId);
      target.deliveryGroupTitle = msg.chat.title || null;
      target.deliveryGroupThreadId = msg.message_thread_id || null;
      saveOwners(owners);
      const scopeLabel = branch ? `<b>${escapeHtmlServer(branch.name)}</b> filiali` : `<b>${escapeHtmlServer((owner.profile && owner.profile.name) || 'oshxona')}</b>`;
      await sendMessage(chatId,
        `✅ Bu guruh ${scopeLabel} uchun admin guruhi sifatida biriktirildi.\n` +
        `Endi ${branch ? 'shu filialga tegishli' : 'mijozlar istalgan turda (Stolga, Olib ketish yoki Dostavka)'} buyurtma bersa, "Qabul qilish" va "Tayyor" tugmali xabarlar shu guruhga keladi.` +
        (target.deliveryGroupThreadId ? `\n\n📌 Xabarlar aynan shu mavzu (topic)ga yozib boriladi.` : ''),
        null, target.deliveryGroupThreadId);
      return;
    }

    if ((msg.chat.type === 'group' || msg.chat.type === 'supergroup') && /^\/bekor_biriktir(@\S+)?$/.test(text)) {
      const owners = loadOwners();
      const ctx = resolveOwnerContext(owners, from.id);
      const owner = ctx ? ctx.owner : null;
      if (owner) {
        const pools = [owner, ...(owner.branches || [])];
        const target = pools.find(p => String(p.deliveryGroupId) === String(chatId));
        if (target) {
          target.deliveryGroupId = null;
          target.deliveryGroupTitle = null;
          target.deliveryGroupThreadId = null;
          saveOwners(owners);
          await sendMessage(chatId, 'Bu guruh admin guruhi sifatidan olib tashlandi.');
        }
      }
      return;
    }

    if ((msg.chat.type === 'group' || msg.chat.type === 'supergroup') && /^\/oshpaz_biriktir(@\S+)?(\s+\S+)?$/.test(text)) {
      const owners = pruneExpiredOwners();
      const ctx = resolveOwnerContext(owners, from.id);
      if (!isOwnerRole(ctx)) {
        const blocked = getBlockedOwnerAccess(owners, from.id);
        if (blocked) await sendSubscriptionBlockedScreen(chatId, blocked);
        else await sendMessage(chatId, 'Faqat tasdiqlangan oshxona egasi guruhni biriktira oladi.');
        return;
      }
      const owner = ctx.owner;
      if (!ownerCanUseFeature(owner, 'kitchen-group')) {
        await sendMessage(chatId, featureBlockedResult('kitchen-group').reason);
        return;
      }
      const branchCode = text.split(/\s+/)[1] || null;
      let branch = null;
      if (branchCode) {
        branch = findBranch(owner, branchCode);
        if (!branch) { await sendMessage(chatId, `❌ "${escapeHtmlServer(branchCode)}" kodli filial topilmadi. Kodni Mini App'dagi Filiallar bo'limidan qaytadan nusxalab ko'ring.`); return; }
      }
      const target = branch || owner;
      target.kitchenGroupId = String(chatId);
      target.kitchenGroupTitle = msg.chat.title || null;
      target.kitchenGroupThreadId = msg.message_thread_id || null;
      saveOwners(owners);
      const scopeLabel = branch ? `<b>${escapeHtmlServer(branch.name)}</b> filiali` : `<b>${escapeHtmlServer((owner.profile && owner.profile.name) || 'oshxona')}</b>`;
      await sendMessage(chatId,
        `✅ Bu guruh ${scopeLabel} uchun Oshpazlar guruhi sifatida biriktirildi.\n` +
        `Endi ${branch ? 'shu filialga tegishli' : 'har bir'} yangi buyurtma shu guruhga ham, "Qabul qilish" va "Tayyor" tugmalari bilan yuboriladi.` +
        (target.kitchenGroupThreadId ? `\n\n📌 Xabarlar aynan shu mavzu (topic)ga yozib boriladi.` : ''),
        null, target.kitchenGroupThreadId);
      return;
    }

    if ((msg.chat.type === 'group' || msg.chat.type === 'supergroup') && /^\/oshpaz_bekor_biriktir(@\S+)?$/.test(text)) {
      const owners = loadOwners();
      const ctx = resolveOwnerContext(owners, from.id);
      const owner = ctx ? ctx.owner : null;
      if (owner) {
        const pools = [owner, ...(owner.branches || [])];
        const target = pools.find(p => String(p.kitchenGroupId) === String(chatId));
        if (target) {
          target.kitchenGroupId = null;
          target.kitchenGroupTitle = null;
          target.kitchenGroupThreadId = null;
          saveOwners(owners);
          await sendMessage(chatId, 'Bu guruh Oshpazlar guruhi sifatidan olib tashlandi.');
        }
      }
      return;
    }

    if (!text.startsWith('/') && pendingReviewComments.has(String(from.id))) {
      const pending = pendingReviewComments.get(String(from.id));
      pendingReviewComments.delete(String(from.id));
      if (pending.expiresAt >= Date.now()) {
        const owners = loadOwners();
        const owner = findOwner(owners, pending.ownerId);
        const order = owner && (owner.orders || []).find(o => String(o.id) === String(pending.orderId));
        if (owner && order && !order.customerComment) {
          const commentTrim = text.trim().slice(0, 500);
          if (commentTrim) {
            order.customerComment = commentTrim;
            order.customerCommentAt = new Date().toISOString();
            saveOwners(owners);
            await sendMessage(chatId, 'Fikringiz uchun rahmat! 🙏');

            const starsText = '⭐️'.repeat(order.customerRating || 0);
            const notifyText = `💬 <b>Mijoz sharhi</b> (${starsText})\n"${escapeHtmlServer(commentTrim)}"\n\nMijoz: ${orderCustomerContactLabel(order)}`;
            const staffList = owner.staff || [];
            const targetIds = staffList.filter(s => ['egasi', 'kassir'].includes(s.role)).map(s => s.id);
            for (const targetId of new Set([owner.id, ...targetIds])) {
              sendMessage(targetId, notifyText);
            }
            for (const adminId of allAdminIds()) {
              sendMessage(adminId, `${notifyText}\n\nOshxona: ${escapeHtmlServer((owner.profile && owner.profile.name) || owner.id)}`);
            }
          }
        }
      }
      return;
    }

    if (!isAdminId(from.id) && !text.startsWith('/') && pendingSelfRegistration.has(String(from.id))) {
      const restaurantName = text.trim();
      if (restaurantName.length < 2 || restaurantName.length > 60) {
        await sendMessage(chatId, "Iltimos, oshxona nomini 2 tadan 60 belgigacha oralig'ida yozing.");
        return;
      }
      pendingSelfRegistration.delete(String(from.id));

      const owners = loadOwners();

      if (findOwner(owners, from.id)) {
        await sendMessage(chatId, 'Siz allaqachon ro\'yxatdan o\'tgansiz. Mini App tugmasi orqali oching.');
        return;
      }

      const newOwner = {
        id: String(from.id),
        username: from.username || null,
        addedAt: new Date().toISOString(),
        expiresAt: null,
        price: 0,
        paid: false,
        paidAt: null,

        subscriptionStatus: SUBSCRIPTION_STATUS.PENDING_TRIAL,
        subscriptionUntil: null,
        graceUntil: null,
        trialGivenAt: null,
        profile: { name: restaurantName }
      };
      owners.push(newOwner);
      saveOwners(owners);

      await sendMessage(chatId,
        `✅ So'rovingiz qabul qilindi!\n<b>${escapeHtmlServer(restaurantName)}</b> nomi bilan ro'yxatga olindi.\n` +
        `Administrator tasdiqlashini kuting — tasdiqlangach shu yerga xabar boradi.`);

      const adminText =
        `🆕 <b>Yangi oshxona — o'zi ro'yxatdan o'tdi</b>\n` +
        `Oshxona: <b>${escapeHtmlServer(restaurantName)}</b>\n` +
        `Ega: ${displayName(from)}${from.username ? ' (@' + escapeHtmlServer(from.username) + ')' : ''}\n` +
        `ID: <code>${from.id}</code>\n\n` +
        `Sinov muddatini tasdiqlaysizmi? (tasdiqlansa ${SUBSCRIPTION_TRIAL_DAYS} kunlik standart sinov beriladi)`;
      const approveKb = {
        inline_keyboard: [[
          { text: '✅ Tasdiqlash', callback_data: `approve_trial:${newOwner.id}` },
          { text: '❌ Rad etish', callback_data: `reject_trial:${newOwner.id}` }
        ]]
      };
      for (const adminId of allAdminIds()) {
        sendMessage(adminId, adminText, approveKb);
      }
      return;
    }

    if (isAdminId(from.id) && !text.startsWith('/')) {
      const awaiting = getAwaitingCustom();
      if (awaiting && awaiting.kind === 'approve_days' && awaiting.reqId) {
        const reqInfo = findRequest(awaiting.reqId);
        if (!reqInfo) {
          clearAwaitingCustom();
          await sendMessage(chatId, 'Bu so\'rov allaqachon ko\'rib chiqilgan.');
          return;
        }
        const n = parseInt(text, 10);
        if (!Number.isInteger(n) || n <= 0 || String(n) !== text) {
          await sendMessage(chatId, 'Iltimos, faqat musbat butun son yuboring (masalan: 14). Bekor qilish uchun /bekor yozing.');
          return;
        }
        clearAwaitingCustom();
        const label = approveRequest(reqInfo, n);
        if (awaiting.promptMessageId) {
          await editMessageText(chatId, awaiting.promptMessageId,
            `✅ <b>Tasdiqlandi</b>\n${displayName(reqInfo)} (ID: <code>${reqInfo.userId}</code>)\nRuxsat muddati: ${label}`);
        } else {
          await sendMessage(chatId, `✅ Tasdiqlandi. Ruxsat muddati: ${label}`);
        }
        await sendMessage(reqInfo.userId,
          `✅ So'rovingiz tasdiqlandi! Sizga <b>${label}</b> muddatga kirish huquqi berildi.\nMini App tugmasi orqali oching.`);
        return;
      }

      if (awaiting && awaiting.kind === 'sub_reject_reason' && awaiting.ownerId) {
        const owners = loadOwners();
        const owner = findOwner(owners, awaiting.ownerId);
        clearAwaitingCustom();
        if (!owner || !owner.subscriptionPaymentRequest || owner.subscriptionPaymentRequest.status !== 'kutilmoqda_tasdiq') {
          await sendMessage(chatId, 'Bu so\'rov allaqachon ko\'rib chiqilgan.');
          return;
        }
        const reasonText = text.trim();
        decideSubscriptionPayment(owner, 'reject', from.id, reasonText);
        saveOwners(owners);

        const restaurantName = ownerLabel(owner);
        const extraLine = `❌ Rad etildi — ${displayName(from)}\nSabab: ${escapeHtmlServer(reasonText)}`;
        if (awaiting.chatId && awaiting.messageId) {
          const mergedContent = `${awaiting.originalContent || ''}\n\n${extraLine}`;
          if (awaiting.hasPhoto) {
            await editMessageCaption(awaiting.chatId, awaiting.messageId, mergedContent, null);
          } else {
            await editMessageText(awaiting.chatId, awaiting.messageId, mergedContent, null);
          }
        } else {
          await sendMessage(chatId, `❌ Rad etildi. Oshxona: ${escapeHtmlServer(restaurantName)}\nSabab: ${escapeHtmlServer(reasonText)}`);
        }
        return;
      }
    }

    if (isAdminId(from.id) && text === '/bekor') {
      const awaiting = getAwaitingCustom();
      if (awaiting) {
        clearAwaitingCustom();
        await sendMessage(chatId, 'Bekor qilindi.');
      }
      return;
    }

    if (text === '/hisobot' || text.startsWith('/hisobot@') || text.startsWith('/hisobot ')) {
      const owners = pruneExpiredOwners();
      const ctx = resolveOwnerContext(owners, from.id);
      if (!isOwnerRole(ctx)) {
        await sendMessage(chatId, "Bu buyruq faqat oshxona egasi va uning hamkorlariga mavjud.");
        return;
      }
      await sendMessage(chatId, buildFullHisobotText(ctx.owner));
      return;
    }

    if (text.startsWith('/start')) {
      await handleStartCommand(chatId, from, text);
      return;
    }
    return;
  }

  if (update.message && update.message.photo && update.message.chat && update.message.chat.type === 'private') {
    const msg = update.message;
    const from = msg.from;
    const chatId = msg.chat.id;
    const userId = String(from.id);

    const owners = loadOwners();
    let targetOwner = null;
    let targetOrder = null;
    for (const owner of owners) {
      for (const order of (owner.orders || [])) {
        if (String(order.customerId) !== userId) continue;
        if (order.paymentConfirmMethod !== 'skrinshot') continue;
        if (order.paymentProofStatus !== 'kutilmoqda' && order.paymentProofStatus !== 'rad_etildi') continue;
        if (!targetOrder || new Date(order.createdAt) > new Date(targetOrder.createdAt)) {
          targetOwner = owner;
          targetOrder = order;
        }
      }
    }

    if (!targetOwner || !targetOrder) {

      const subOwner = findOwner(owners, userId);
      if (subOwner && subOwner.subscriptionPaymentRequest &&
          subOwner.subscriptionPaymentRequest.status === 'kutilmoqda_skrinshot') {
        const reqData = subOwner.subscriptionPaymentRequest;
        const photos = msg.photo;
        const bestPhoto = photos[photos.length - 1];
        reqData.screenshotFileId = bestPhoto.file_id;
        reqData.status = 'kutilmoqda_tasdiq';
        reqData.screenshotSentAt = new Date().toISOString();
        saveOwners(owners);

        await sendMessage(chatId, '📤 Skrinshot qabul qilindi. Administrator tasdiqlashini kuting...');

        const surchargeCaptionLine = (reqData.upgradeSurcharge > 0)
          ? `\nAsosiy narx: ${fmtNum(reqData.baseAmount)} so'm + tarif farqi ustamasi (qolgan ${reqData.upgradeRemainingDays} kun): ${fmtNum(reqData.upgradeSurcharge)} so'm`
          : '';
        const caption = `💳 <b>Obuna to'lovi tasdiqlash so'raladi</b>\n` +
          `Oshxona: ${escapeHtmlServer(ownerLabel(subOwner))} (ID: <code>${subOwner.id}</code>)\n` +
          `Tarif: ${escapeHtmlServer(reqData.planLabel)}\nSumma: ${fmtNum(reqData.amount)} so'm${surchargeCaptionLine}`;
        const subKb = {
          inline_keyboard: [[
            { text: '✅ Tasdiqlash', callback_data: `subok:${subOwner.id}` },
            { text: '❌ Rad etish', callback_data: `subrej:${subOwner.id}` }
          ]]
        };
        for (const adminId of allAdminIds()) {
          copyMessageWithKeyboard(adminId, chatId, msg.message_id, caption, subKb);
        }
      }

      return;
    }

    const photos = msg.photo;
    const bestPhoto = photos[photos.length - 1];
    targetOrder.paymentProofFileId = bestPhoto.file_id;
    targetOrder.paymentProofStatus = 'kutilmoqda';
    targetOrder.paymentProofSentAt = new Date().toISOString();
    saveOwners(owners);

    await sendMessage(chatId, '📤 Skrinshot qabul qilindi, tasdiqlanishini kuting...');

    const itemsText = targetOrder.items.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
    const caption = `💳 <b>To'lov tasdiqlash so'raladi</b>\n` +
      `${orderCustomerContactLabel(targetOrder)}\n${itemsText}\n\n` +
      `Jami: ${fmtNum(targetOrder.total)} so'm\n${ORDER_TYPES[targetOrder.orderType] || targetOrder.orderType}`;
    const approveKb = {
      inline_keyboard: [[
        { text: '✅ Tasdiqlash', callback_data: `payok:${targetOwner.id}:${targetOrder.id}` },
        { text: '❌ Rad etish', callback_data: `payrej:${targetOwner.id}:${targetOrder.id}` }
      ]]
    };
    const approvers = [targetOwner.id, ...((targetOwner.staff || []).filter(s => staffHasRole(s, 'kassir')).map(s => s.id))];
    for (const approverId of new Set(approvers.map(String))) {
      copyMessageWithKeyboard(approverId, chatId, msg.message_id, caption, approveKb);
    }
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const from = cq.from;
    const data = cq.data || '';
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const messageId = cq.message && cq.message.message_id;

    if (data.startsWith('pwreset:') || data.startsWith('pwresetno:')) {
      await handlePasswordResetCallback(cq, data, chatId, messageId);
      return;
    }

    if (data === 'sk:menu') {
      await answerCallbackQuery(cq.id);
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      await sendSkladMenu(chatId, from.id);
      return;
    }

    if (data === 'sk:cancel') {
      await answerCallbackQuery(cq.id);
      skClearState(from.id);
      await sendMessage(chatId, 'Bekor qilindi.', { inline_keyboard: [[{ text: '⬅️ Sklad menyusi', callback_data: 'sk:menu' }]] });
      return;
    }

    if (data === 'sk:stockadd') {
      await answerCallbackQuery(cq.id);
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      skClearState(from.id);
      await sendStockAddMenu(ctx, chatId);
      return;
    }

    if (data.startsWith('sk:stockadd:pick:')) {
      await answerCallbackQuery(cq.id);
      const stockId = data.slice('sk:stockadd:pick:'.length);
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      const pool = skPool(ctx);
      const item = pool && findStockItem(pool, stockId);
      if (!item) { await sendMessage(chatId, 'Mahsulot topilmadi.'); return; }
      botFlowState.set(String(from.id), { kind: 'stock_qty', stockId: item.id, name: item.name, unit: item.unit });
      await sendMessage(chatId, `<b>${escapeHtmlServer(item.name)}</b> — hozir: ${item.qty} ${escapeHtmlServer(item.unit)}\n\nNecha ${escapeHtmlServer(item.unit)} qo'shilsin? (masalan: 5)\n\nBekor qilish uchun /bekor yozing.`);
      return;
    }

    if (data === 'sk:stockadd:new') {
      await answerCallbackQuery(cq.id);
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      botFlowState.set(String(from.id), { kind: 'stock_new_name' });
      await sendMessage(chatId, "Yangi mahsulot nomini yozing (masalan: \"Un\"):\n\nBekor qilish uchun /bekor yozing.");
      return;
    }

    if (data.startsWith('sk:stockadd:unit:')) {
      await answerCallbackQuery(cq.id);
      const unit = data.slice('sk:stockadd:unit:'.length);
      const state = botFlowState.get(String(from.id));
      if (!state || state.kind !== 'stock_new_unit' || !Object.prototype.hasOwnProperty.call(STOCK_UNITS, unit)) {
        await sendMessage(chatId, 'Bu amal muddati o\'tgan. Qaytadan /sklad buyrug\'ini yuboring.');
        return;
      }
      state.unit = unit;
      state.kind = 'stock_new_qty';
      await sendMessage(chatId, `Miqdorni yozing (${escapeHtmlServer(unit)}, masalan: 10):`);
      return;
    }

    if (data === 'sk:recipe') {
      await answerCallbackQuery(cq.id);
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      skClearState(from.id);
      await sendRecipeMenuList(ctx, chatId);
      return;
    }

    if (data.startsWith('sk:recipe:item:')) {
      await answerCallbackQuery(cq.id);
      const menuId = data.slice('sk:recipe:item:'.length);
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      const menuItem = (ctx.owner.menu || []).find(m => m.id === menuId);
      if (!menuItem) { await sendMessage(chatId, 'Taom topilmadi.'); return; }
      if (menuItem.directStockId) {
        await sendMessage(chatId, `<b>${escapeHtmlServer(menuItem.name)}</b> — "to'g'ridan skladdan" turida, unga alohida retsept qo'shib bo'lmaydi.`, { inline_keyboard: skBackCancelRow() });
        return;
      }
      await sendRecipeIngredientList(ctx, chatId, menuItem);
      return;
    }

    if (data.startsWith('sk:recipe:ing:')) {
      await answerCallbackQuery(cq.id);
      const rest = data.slice('sk:recipe:ing:'.length);
      const sepIdx = rest.indexOf(':');
      const menuId = sepIdx >= 0 ? rest.slice(0, sepIdx) : '';
      const stockId = sepIdx >= 0 ? rest.slice(sepIdx + 1) : '';
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      const menuItem = (ctx.owner.menu || []).find(m => m.id === menuId);
      if (!menuItem) { await sendMessage(chatId, 'Taom topilmadi.'); return; }
      const pool = skPool(ctx);
      const stockItem = pool && findStockItem(pool, stockId);
      if (!stockItem) { await sendMessage(chatId, 'Sklad mahsuloti topilmadi.'); return; }
      botFlowState.set(String(from.id), { kind: 'recipe_qty', menuId: menuItem.id, menuName: menuItem.name, stockId: stockItem.id, stockName: stockItem.name, unit: stockItem.unit });
      await sendMessage(chatId, `1 dona "<b>${escapeHtmlServer(menuItem.name)}</b>" uchun necha ${escapeHtmlServer(stockItem.unit)} "${escapeHtmlServer(stockItem.name)}" kerak?\n(masalan: 0.05)\n\nBekor qilish uchun /bekor yozing.`);
      return;
    }

    if (data.startsWith('sk:recipe:done:')) {
      await answerCallbackQuery(cq.id, 'Saqlandi ✅');
      const menuId = data.slice('sk:recipe:done:'.length);
      skClearState(from.id);
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      const menuItem = (ctx.owner.menu || []).find(m => m.id === menuId);
      const count = menuItem && Array.isArray(menuItem.recipe) ? menuItem.recipe.length : 0;
      await sendMessage(chatId, `✅ <b>${escapeHtmlServer(menuItem ? menuItem.name : '')}</b> retsepti saqlandi (${count} ta ingredient).`, { inline_keyboard: [[{ text: '⬅️ Sklad menyusi', callback_data: 'sk:menu' }]] });
      return;
    }

    if (data === 'sk:audit') {
      await answerCallbackQuery(cq.id);
      const owners = loadOwners();
      const ctx = skResolveCtx(owners, from.id);
      if (!ctx) { await sendMessage(chatId, 'Ruxsatingiz yo\'q.'); return; }
      const pool = skPool(ctx);
      const items = (pool ? (pool.stock || []) : []).slice().sort((a, b) => a.name.localeCompare(b.name, 'uz'));
      if (!items.length) {
        await sendMessage(chatId, "Skladda hali mahsulot yo'q. Avval \"Ostatka qo'shish\" orqali sklad mahsulotini qo'shing.", { inline_keyboard: skBackCancelRow() });
        return;
      }
      const state = {
        kind: 'audit',
        branchId: ctx.role === 'egasi' ? null : ctx.branchId,
        items: items.map(i => ({ id: i.id, name: i.name, unit: i.unit, qty: i.qty })),
        index: 0,
        entries: []
      };
      botFlowState.set(String(from.id), state);
      await sendAuditPrompt(chatId, state);
      return;
    }

    if (data === 'sk:audit:skip') {
      await answerCallbackQuery(cq.id);
      const state = botFlowState.get(String(from.id));
      if (!state || state.kind !== 'audit') { await sendMessage(chatId, 'Bu amal muddati o\'tgan. Qaytadan /sklad buyrug\'ini yuboring.'); return; }
      state.index += 1;
      if (state.index < state.items.length) {
        await sendAuditPrompt(chatId, state);
      } else {
        await finalizeAudit(from.id, chatId);
      }
      return;
    }

    if (data === 'sk:audit:finish') {
      await answerCallbackQuery(cq.id);
      const state = botFlowState.get(String(from.id));
      if (!state || state.kind !== 'audit') { await sendMessage(chatId, 'Bu amal muddati o\'tgan. Qaytadan /sklad buyrug\'ini yuboring.'); return; }
      await finalizeAudit(from.id, chatId);
      return;
    }

    if (data === 'obuna_menyu') {
      await answerCallbackQuery(cq.id);
      const owners = loadOwners();
      const owner = findOwner(owners, from.id);
      if (!owner) {
        await sendMessage(from.id, 'Siz do\'kon egasi sifatida ro\'yxatdan o\'tmagansiz. Administrator bilan bog\'laning.');
        return;
      }
      await sendObunaPlansMenu(owner, from.id);
      return;
    }

    if (data.startsWith('subplan:')) {
      const [, planId] = data.split(':');
      const owners = loadOwners();
      const owner = findOwner(owners, from.id);
      if (!owner) { await answerCallbackQuery(cq.id, 'Oshxona topilmadi.'); return; }
      const plan = loadSubscriptionPlans()[planId];
      if (!plan) { await answerCallbackQuery(cq.id, 'Tarif topilmadi.'); return; }
      const reqData = createSubscriptionPaymentRequest(owner, planId);
      saveOwners(owners);
      await answerCallbackQuery(cq.id, 'Tarif tanlandi ✅');
      const surchargeLine = (reqData.upgradeSurcharge > 0)
        ? `\n➕ Tarif farqi ustamasi (qolgan ${reqData.upgradeRemainingDays} kun uchun): ${fmtNum(reqData.upgradeSurcharge)} so'm` +
          `\n💰 <b>Jami to'lov: ${fmtNum(reqData.amount)} so'm</b>`
        : '';
      await sendMessage(from.id,
        `✅ Siz <b>${escapeHtmlServer(plan.label)}</b> tarifini tanladingiz (${fmtNum(plan.price)} so'm).${surchargeLine}\n\n` +
        `Endi to'lov chekining (skrinshotning) RASMINI shu botga yuboring — administrator tekshirib ` +
        `tasdiqlagach, obunangiz avtomatik yangilanadi.`);
      return;
    }

    if (data === 'self_register_start') {
      await answerCallbackQuery(cq.id);
      await beginSelfRegistration(from.id);
      return;
    }

    if (data.startsWith('request_restore:')) {
      const trashId = data.slice('request_restore:'.length);
      await answerCallbackQuery(cq.id);
      const trash = loadTrash();
      const entry = findTrashEntry(trash, trashId);
      if (!entry) {
        await sendMessage(from.id, 'Bu so\'rov muddati o\'tgan yoki allaqachon ko\'rib chiqilgan.');
        return;
      }
      if (String(entry.ownerSnapshot.id) !== String(from.id)) {
        await sendMessage(from.id, 'Bu so\'rov sizga tegishli emas.');
        return;
      }
      if (entry.restoreStatus === 'pending') {
        await sendMessage(from.id, '🕓 So\'rovingiz allaqachon adminga yuborilgan, tasdiqlanishini kuting.');
        return;
      }
      entry.restoreStatus = 'pending';
      entry.restoreRequestedAt = new Date().toISOString();
      saveTrash(trash);
      logTrashEvent('restore_requested', entry.ownerSnapshot, {});

      await sendMessage(from.id, '📤 So\'rovingiz administratorga yuborildi, tasdiqlanishini kuting.');
      const restaurantName = (entry.ownerSnapshot.profile && entry.ownerSnapshot.profile.name) || 'oshxona';
      const daysLeft = Math.max(0, Math.ceil((new Date(entry.autoPurgeAt).getTime() - Date.now()) / 86400000));
      const kb = {
        inline_keyboard: [[
          { text: '✅ Tiklash', callback_data: `restore_approve:${trashId}` },
          { text: '❌ Rad etish', callback_data: `restore_reject:${trashId}` }
        ]]
      };
      for (const adminId of allAdminIds()) {
        await sendMessage(adminId,
          `🔄 <b>Tiklash so'ralmoqda</b>\nOshxona: <b>${escapeHtmlServer(restaurantName)}</b> (ID: <code>${entry.ownerSnapshot.id}</code>)\n` +
          `Savatchadan avtomatik o'chirilishiga: ${daysLeft} kun qoldi.`, kb);
      }
      return;
    }

    if (data.startsWith('restore_approve:') || data.startsWith('restore_reject:')) {
      if (!isAdminId(from.id)) { await answerCallbackQuery(cq.id, 'Faqat admin tasdiqlay oladi.', true); return; }
      const isApprove = data.startsWith('restore_approve:');
      const trashId = data.slice((isApprove ? 'restore_approve:' : 'restore_reject:').length);
      const trash = loadTrash();
      const entry = findTrashEntry(trash, trashId);
      if (!entry) { await answerCallbackQuery(cq.id, 'Bu yozuv Savatchada topilmadi (allaqachon ko\'rib chiqilgan bo\'lishi mumkin).', true); return; }

      const restaurantName = (entry.ownerSnapshot.profile && entry.ownerSnapshot.profile.name) || 'oshxona';

      if (isApprove) {
        const result = restoreOwnerFromTrash(entry);
        if (!result.ok) { await answerCallbackQuery(cq.id, result.reason, true); return; }
        saveTrash(trash.filter(t => t.id !== trashId));
        logTrashEvent('restored', entry.ownerSnapshot, { restoredBy: String(from.id), via: 'bot_request' });

        await answerCallbackQuery(cq.id, '✅ Tiklandi.');
        if (chatId && messageId) {
          await editMessageText(chatId, messageId, `✅ <b>Tiklandi</b>\nOshxona: <b>${escapeHtmlServer(restaurantName)}</b>`);
        }
        await sendMessage(entry.ownerSnapshot.id,
          `✅ <b>Oshxonangiz tiklandi!</b>\nBarcha ma'lumotlaringiz (menyu, xodimlar, sozlamalar) saqlanib qolgan. Mini App tugmasi orqali oching.`);
      } else {
        entry.restoreStatus = 'rejected';
        saveTrash(trash);
        logTrashEvent('restore_rejected', entry.ownerSnapshot, { rejectedBy: String(from.id) });

        await answerCallbackQuery(cq.id, '❌ Rad etildi.');
        if (chatId && messageId) {
          await editMessageText(chatId, messageId, `❌ <b>Rad etildi</b>\nOshxona: <b>${escapeHtmlServer(restaurantName)}</b>`);
        }
        await sendMessage(entry.ownerSnapshot.id,
          '❌ Afsuski, tiklash so\'rovingiz rad etildi. Savollar bo\'lsa, administrator bilan bog\'laning.');
      }
      return;
    }

    if (data.startsWith('approve_trial:')) {
      if (!isAdminId(from.id)) { await answerCallbackQuery(cq.id, 'Faqat admin tasdiqlay oladi.', true); return; }
      const ownerId = data.slice('approve_trial:'.length);
      const owners = loadOwners();
      const owner = findOwner(owners, ownerId);
      if (!owner) { await answerCallbackQuery(cq.id, 'Bu so\'rov topilmadi (allaqachon ko\'rib chiqilgan bo\'lishi mumkin).', true); return; }
      if (owner.subscriptionStatus !== SUBSCRIPTION_STATUS.PENDING_TRIAL) {
        await answerCallbackQuery(cq.id, 'Bu so\'rov allaqachon ko\'rib chiqilgan.', true);
        return;
      }
      const until = new Date(Date.now() + SUBSCRIPTION_TRIAL_DAYS * 86400000).toISOString();
      owner.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
      owner.subscriptionUntil = until;
      owner.trialGivenAt = new Date().toISOString();
      owner.graceUntil = null;
      saveOwners(owners);

      await answerCallbackQuery(cq.id, '✅ Tasdiqlandi.');
      if (chatId && messageId) {
        await editMessageText(chatId, messageId,
          `✅ <b>Tasdiqlandi</b>\nOshxona: <b>${escapeHtmlServer((owner.profile && owner.profile.name) || 'oshxona')}</b>\nSinov muddati: ${SUBSCRIPTION_TRIAL_DAYS} kun`);
      }
      await sendMessage(owner.id,
        `✅ So'rovingiz tasdiqlandi!\nSizga <b>${SUBSCRIPTION_TRIAL_DAYS} kunlik</b> bepul sinov muddati berildi.\nMini App tugmasi orqali oching va oshxonangizni sozlashni boshlang.`);
      return;
    }

    if (data.startsWith('reject_trial:')) {
      if (!isAdminId(from.id)) { await answerCallbackQuery(cq.id, 'Faqat admin rad eta oladi.', true); return; }
      const ownerId = data.slice('reject_trial:'.length);
      const owners = loadOwners();
      const owner = findOwner(owners, ownerId);
      if (!owner) { await answerCallbackQuery(cq.id, 'Bu so\'rov topilmadi (allaqachon ko\'rib chiqilgan bo\'lishi mumkin).', true); return; }
      if (owner.subscriptionStatus !== SUBSCRIPTION_STATUS.PENDING_TRIAL) {
        await answerCallbackQuery(cq.id, 'Bu so\'rov allaqachon ko\'rib chiqilgan.', true);
        return;
      }
      const restaurantName = (owner.profile && owner.profile.name) || 'oshxona';
      const remaining = owners.filter(o => String(o.id) !== String(ownerId));
      saveOwners(remaining);

      await answerCallbackQuery(cq.id, '❌ Rad etildi.');
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, `❌ <b>Rad etildi</b>\nOshxona: <b>${escapeHtmlServer(restaurantName)}</b>`);
      }
      await sendMessage(ownerId, '❌ Afsuski, ro\'yxatdan o\'tish so\'rovingiz rad etildi. Savollar bo\'lsa, administrator bilan bog\'laning.');
      return;
    }

    if (data.startsWith('rate:')) {
      const [, ownerId, orderId, starsRaw] = data.split(':');
      const stars = Number(starsRaw);
      const owners = loadOwners();
      const owner = findOwner(owners, ownerId);
      if (!owner) { await answerCallbackQuery(cq.id, 'Oshxona topilmadi.'); return; }
      const order = (owner.orders || []).find(o => o.id === orderId);
      if (!order) { await answerCallbackQuery(cq.id, 'Buyurtma topilmadi.'); return; }
      if (String(order.customerId) !== String(from.id)) {
        await answerCallbackQuery(cq.id, 'Bu baho boshqa mijozga tegishli.');
        return;
      }
      if (order.customerRating) {
        await answerCallbackQuery(cq.id, 'Siz bu buyurtmaga allaqachon baho bergansiz, rahmat! 🙏');
        return;
      }
      if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
        await answerCallbackQuery(cq.id, 'Noto\'g\'ri baho.');
        return;
      }

      order.customerRating = stars;
      order.customerRatedAt = new Date().toISOString();
      saveOwners(owners);

      const starsText = '⭐️'.repeat(stars);
      if (chatId && messageId) {
        await editMessageText(chatId, messageId,
          `${cq.message.text || ''}\n\nSizning bahoyingiz: ${starsText}\nRahmat! 🙏`, null);
      }
      await answerCallbackQuery(cq.id, 'Bahoyingiz uchun rahmat! 🙏');

      pendingReviewComments.set(String(from.id), {
        ownerId: String(owner.id),
        orderId: String(order.id),
        expiresAt: Date.now() + REVIEW_COMMENT_WINDOW_MS
      });
      await sendMessage(from.id, '✍️ Fikr-mulohazangiz bo\'lsa, shu yerga yozib qoldiring (ixtiyoriy — o\'tkazib yuborishingiz ham mumkin).');

      if (stars <= 3) {
        const itemsText = order.items.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
        const alertText = `⚠️ <b>Past baho olindi</b> (${starsText})\n${itemsText}\n\nJami: ${fmtNum(order.total)} so'm\nMijoz: ${orderCustomerContactLabel(order)}`;
        const staffList = owner.staff || [];
        const targetIds = staffList.filter(s => ['egasi', 'kassir'].includes(s.role)).map(s => s.id);
        for (const targetId of new Set([owner.id, ...targetIds])) {
          sendMessage(targetId, alertText);
        }
      }
      return;
    }

    if (data.startsWith('dgaccept:') || data.startsWith('dgready:') || data.startsWith('kgaccept:') || data.startsWith('kgready:')) {
      const [action, ownerId, orderId] = data.split(':');
      const isKitchen = action.startsWith('kg');
      const stageField = isKitchen ? 'kitchenGroupStage' : 'deliveryGroupStage';
      const acceptedByField = isKitchen ? 'kitchenAcceptedBy' : 'deliveryAcceptedBy';
      const acceptedAtField = isKitchen ? 'kitchenAcceptedAt' : 'deliveryAcceptedAt';
      const readyByField = isKitchen ? 'kitchenReadyBy' : 'deliveryReadyBy';
      const readyAtField = isKitchen ? 'kitchenReadyAt' : 'deliveryReadyAt';
      const owners = loadOwners();
      const owner = findOwner(owners, ownerId);
      if (!owner) { await answerCallbackQuery(cq.id, 'Oshxona topilmadi.'); return; }
      if (await guardCallbackSubscription(cq, owners, ownerId)) return;
      const order = (owner.orders || []).find(o => o.id === orderId);
      if (!order) { await answerCallbackQuery(cq.id, 'Buyurtma topilmadi.'); return; }

      if (action === 'dgaccept' || action === 'kgaccept') {
        if (order.status !== 'yangi') {

          await answerCallbackQuery(cq.id, 'Allaqachon qabul qilingan.');
          syncGroupMessagesForOrder(owner, order);
          return;
        }
        order[stageField] = 'qabul_qilindi';
        order[acceptedByField] = from.id;
        order[acceptedAtField] = new Date().toISOString();

        order.status = 'tayyorlanmoqda';
        order.updatedAt = new Date().toISOString();
        order.updatedBy = String(from.id);
        if (!order.startedAt) order.startedAt = order.updatedAt;
        saveOwners(owners);

        if (chatId && messageId) {
          await editMessageText(chatId, messageId,
            `${cq.message.text || ''}\n\n✅ Qabul qilindi — ${displayName(from)}`,
            { inline_keyboard: [[{ text: '✅ Tayyor', callback_data: `${isKitchen ? 'kgready' : 'dgready'}:${ownerId}:${orderId}` }]] });
        }
        syncGroupMessagesForOrder(owner, order);
        if (order.customerId) {
          await sendMessage(order.customerId, '✅ Buyurtmangiz qabul qilindi, tez orada tayyorlanadi!');
        }
        await answerCallbackQuery(cq.id, 'Qabul qilindi ✅');
        return;
      }

      if (action === 'dgready' || action === 'kgready') {
        if (order.status === 'tayyor') {
          await answerCallbackQuery(cq.id, 'Allaqachon tayyor deb belgilangan.');
          syncGroupMessagesForOrder(owner, order);
          return;
        }

        if (order.status !== 'tayyorlanmoqda') {
          if (action === 'kgready' && order.status === 'yangi') {
            // Oshpazlar guruhida "Qabul qilish" bosqichi olib tashlangan —
            // "Tayyor" to'g'ridan-to'g'ri "yangi"dan bosilsa, qabul qilish
            // ham shu zahoti (orqa fonda) belgilanadi.
            order.kitchenGroupStage = 'qabul_qilindi';
            order.kitchenAcceptedBy = from.id;
            order.kitchenAcceptedAt = new Date().toISOString();
            if (!order.startedAt) order.startedAt = order.kitchenAcceptedAt;
          } else {
            await answerCallbackQuery(cq.id, 'Avval "✅ Qabul qilish" tugmasini bosing.', true);
            return;
          }
        }
        order[stageField] = 'tayyor';
        order[readyByField] = from.id;
        order[readyAtField] = new Date().toISOString();

        order.status = 'tayyor';
        order.updatedAt = new Date().toISOString();
        order.updatedBy = String(from.id);
        if (!order.readyAt) order.readyAt = order.updatedAt;
        saveOwners(owners);

        if (chatId && messageId) {
          await editMessageText(chatId, messageId,
            `${cq.message.text || ''}\n\n✅ Tayyor — ${displayName(from)}`, null);
        }
        syncGroupMessagesForOrder(owner, order, { skipKitchenTextFinalize: isKitchen });
        notifyDeliveryGroupOrderReady(owner, order);
        if (order.customerId) {
          const readyMsg = order.orderType === 'dostavka'
            ? '✅ Buyurtmangiz tayyor, kuryer yo\'lda!'
            : '✅ Buyurtmangiz tayyor!';
          await sendMessage(order.customerId, readyMsg);
        }

        {
          const itemsText = order.items.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
          const orderLabel = `${ORDER_TYPES[order.orderType] || order.orderType}`;
          const readyText = `✅ <b>Buyurtma tayyor</b> (${orderLabel})\n${itemsText}\n\nJami: ${fmtNum(order.total)} so'm`;
          const staffList = owner.staff || [];
          const targetRoles = order.orderType === 'dostavka' ? ['kassir', 'dostavka'] : ['kassir'];
          const targetIds = staffList.filter(s => targetRoles.includes(s.role)).map(s => s.id);
          for (const targetId of new Set(targetIds.map(String))) {
            if (targetId === String(from.id)) continue;
            sendMessage(targetId, readyText);
          }
        }
        await answerCallbackQuery(cq.id, 'Tayyor deb belgilandi ✅');
        return;
      }
    }

    // Buyurtma allaqachon "Tayyor" bo'lgach, kassir unga yangi mahsulot
    // qo'shsa — shu qo'shimcha alohida oshxona guruhiga yuboriladi va
    // shu yerda unga alohida "Tayyor" bosiladi (asosiy buyurtma holatiga
    // tegmaydi). Qarang: /api/edit-order.
    if (data.startsWith('kgaddready:')) {
      const [, ownerId, orderId, additionId] = data.split(':');
      const owners = loadOwners();
      const owner = findOwner(owners, ownerId);
      if (!owner) { await answerCallbackQuery(cq.id, 'Oshxona topilmadi.'); return; }
      if (await guardCallbackSubscription(cq, owners, ownerId)) return;
      const order = (owner.orders || []).find(o => o.id === orderId);
      if (!order) { await answerCallbackQuery(cq.id, 'Buyurtma topilmadi.'); return; }
      const addition = (order.additions || []).find(a => a.id === additionId);
      if (!addition) { await answerCallbackQuery(cq.id, 'Topilmadi.'); return; }
      if (addition.ready) {
        await answerCallbackQuery(cq.id, 'Allaqachon tayyor deb belgilangan.');
        return;
      }
      addition.ready = true;
      addition.readyBy = from.id;
      addition.readyAt = new Date().toISOString();
      saveOwners(owners);

      if (chatId && messageId) {
        await editMessageText(chatId, messageId,
          `${cq.message.text || ''}\n\n✅ Tayyor — ${displayName(from)}`, null);
      }

      {
        const itemsText = addition.items.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
        const orderLabel = `#${order.orderNumber || order.id}`;
        const readyText = `✅ <b>Qo'shimcha tayyor</b> (Buyurtma ${orderLabel})\n${itemsText}`;
        const staffList = owner.staff || [];
        const targetIds = staffList.filter(s => staffHasRole(s, 'kassir')).map(s => s.id);
        for (const targetId of new Set([owner.id, ...targetIds].map(String))) {
          if (targetId === String(from.id)) continue;
          sendMessage(targetId, readyText);
        }
      }
      await answerCallbackQuery(cq.id, 'Tayyor deb belgilandi ✅');
      return;
    }

    // Dostavka guruhida "✅ Yetkazildi" tugmasi — kuryer mini-ilovani
    // ochmasdan, to'g'ridan-to'g'ri guruhdan buyurtmani yetkazilgan deb
    // belgilashi mumkin (qarang: notifyDeliveryGroupOrderReady()). Bu
    // /api/deliver-order bilan bir xil natijaga olib keladi — mijozga
    // baho so'rovi ham shu yerdan yuboriladi.
    if (data.startsWith('dgdelivered:')) {
      const [, ownerId, orderId] = data.split(':');
      const owners = loadOwners();
      const owner = findOwner(owners, ownerId);
      if (!owner) { await answerCallbackQuery(cq.id, 'Oshxona topilmadi.'); return; }
      if (await guardCallbackSubscription(cq, owners, ownerId)) return;
      const order = (owner.orders || []).find(o => o.id === orderId);
      if (!order) { await answerCallbackQuery(cq.id, 'Buyurtma topilmadi.'); return; }
      if (order.orderType !== 'dostavka') {
        await answerCallbackQuery(cq.id, 'Bu buyurtma dostavka turi emas.');
        return;
      }
      if (order.deliveredBy) {
        await answerCallbackQuery(cq.id, 'Bu buyurtma allaqachon yetkazilgan deb belgilangan.');
        syncGroupMessagesForOrder(owner, order);
        return;
      }

      order.deliveredBy = from.id;
      order.deliveredAt = new Date().toISOString();
      logStaffAction(owner, { userId: String(from.id), role: 'dostavka', action: 'yetkazdi', orderId: order.id, note: `${fmtNum(order.total)} so'm — yetkazib berildi (guruhdan)` });
      saveOwners(owners);

      if (chatId && messageId) {
        await editMessageText(chatId, messageId,
          `${cq.message.text || ''}\n\n✅ Yetkazildi — ${displayName(from)}`, null);
      }
      sendOrderRatingRequest(owner, order);
      await answerCallbackQuery(cq.id, 'Yetkazildi deb belgilandi ✅');
      return;
    }

    if (data.startsWith('payok:') || data.startsWith('payrej:')) {
      const [action, ownerId, orderId] = data.split(':');
      const owners = loadOwners();
      const owner = findOwner(owners, ownerId);
      if (!owner) { await answerCallbackQuery(cq.id, 'Oshxona topilmadi.'); return; }
      if (await guardCallbackSubscription(cq, owners, ownerId)) return;
      const order = (owner.orders || []).find(o => o.id === orderId);
      if (!order) { await answerCallbackQuery(cq.id, 'Buyurtma topilmadi.'); return; }

      const isOwnerUser = String(owner.id) === String(from.id);
      const isCashier = (owner.staff || []).some(s => staffHasRole(s, 'kassir') && String(s.id) === String(from.id));
      if (!isOwnerUser && !isCashier) {
        await answerCallbackQuery(cq.id, 'Sizda bu amal uchun ruxsat yo\'q (faqat kassir yoki egasi).');
        return;
      }

      const editConfirmMessage = (extraLine) => {
        if (!chatId || !messageId) return Promise.resolve();
        if (cq.message && cq.message.photo) {
          return editMessageCaption(chatId, messageId, `${cq.message.caption || ''}\n\n${extraLine}`, null);
        }
        return editMessageText(chatId, messageId, `${cq.message.text || ''}\n\n${extraLine}`, null);
      };

      if (order.paymentProofStatus !== 'kutilmoqda') {
        await answerCallbackQuery(cq.id, 'Bu so\'rov allaqachon ko\'rib chiqilgan.');
        await editConfirmMessage('(allaqachon ko\'rib chiqilgan)');
        return;
      }

      if (action === 'payok') {
        order.paymentProofStatus = 'tasdiqlandi';
        order.paymentProofApprovedBy = from.id;
        order.paymentProofApprovedAt = new Date().toISOString();
        saveOwners(owners);

        const itemsText = order.items.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
        const notifyText = `🆕 <b>Yangi mijoz buyurtmasi</b> (${ORDER_TYPES[order.orderType]})\n` +
          `${orderCustomerContactLabel(order)}\n${itemsText}\n\nJami: ${fmtNum(order.total)} so'm\nTo'lov: ${PAYMENT_TYPES[order.paymentType]} (✅ tasdiqlangan)`;
        const notifyTargets = [owner.id, ...((owner.staff || []).filter(s => staffHasRole(s, 'oshpaz') || staffHasRole(s, 'kassir')).map(s => s.id))];
        await notifyStaffList(owner, notifyTargets, notifyText, `Buyurtma #${order.id} (to'lov tasdiqlangach)`, 'newOrder');
        saveOwners(owners);
        // Dostavka guruhi FAQAT dostavka buyurtmalari uchun (va faqat
        // oshpaz "Tayyor" deganda — qarang: notifyDeliveryGroupOrderReady).
        // Stolga / Olib ketish buyurtmalari bu guruhga umuman yuborilmaydi.
        notifyKitchenGroup(owner, order, orderCustomerContactLabel(order));

        if (order.customerId) {
          const okText = order.paymentConfirmMethod === 'naqd_kassa'
            ? '✅ To\'lovingiz qabul qilindi! Taomingiz tayyorlanishni boshladi. Yoqimli ishtaha! 😊'
            : '✅ To\'lovingiz tasdiqlandi! Buyurtmangiz oshxonaga yuborildi.';
          await sendMessage(order.customerId, okText);
        }
        await editConfirmMessage(`✅ Tasdiqlandi — ${displayName(from)}`);
        await answerCallbackQuery(cq.id, 'Tasdiqlandi ✅');
        return;
      }

      if (action === 'payrej') {
        order.paymentProofStatus = 'rad_etildi';
        order.paymentProofRejectedBy = from.id;
        order.paymentProofRejectedAt = new Date().toISOString();
        saveOwners(owners);

        if (order.customerId) {
          const rejText = order.paymentConfirmMethod === 'naqd_kassa'
            ? '❌ Buyurtmangiz bekor qilindi. Savol bo\'lsa, kassaga murojaat qiling.'
            : '❌ To\'lov skrinshoti tasdiqlanmadi. Iltimos, to\'g\'ri skrinshotni qayta (rasm qilib) yuboring ' +
              'yoki oshxona bilan bog\'laning.';
          await sendMessage(order.customerId, rejText);
        }
        await editConfirmMessage(`❌ Rad etildi — ${displayName(from)}`);
        await answerCallbackQuery(cq.id, 'Rad etildi ❌');
        return;
      }
    }

    if (!isAdminId(from.id)) {
      await answerCallbackQuery(cq.id, 'Faqat admin qaror qabul qila oladi.');
      return;
    }

    if (data.startsWith('subok:') || data.startsWith('subrej:')) {
      const [action, ownerId] = data.split(':');
      const owners = loadOwners();
      const owner = findOwner(owners, ownerId);
      if (!owner) { await answerCallbackQuery(cq.id, 'Oshxona topilmadi.'); return; }

      const editConfirmMessage = (extraLine) => {
        if (!chatId || !messageId) return Promise.resolve();
        if (cq.message && cq.message.photo) {
          return editMessageCaption(chatId, messageId, `${cq.message.caption || ''}\n\n${extraLine}`, null);
        }
        return editMessageText(chatId, messageId, `${cq.message.text || ''}\n\n${extraLine}`, null);
      };

      const reqData = owner.subscriptionPaymentRequest;
      if (!reqData || reqData.status !== 'kutilmoqda_tasdiq') {
        await answerCallbackQuery(cq.id, 'Bu so\'rov allaqachon ko\'rib chiqilgan.');
        await editConfirmMessage('(allaqachon ko\'rib chiqilgan)');
        return;
      }

      if (action === 'subrej') {

        const hasPhoto = !!(cq.message && cq.message.photo);
        const originalContent = hasPhoto ? (cq.message.caption || '') : (cq.message.text || '');
        setAwaitingSubRejectReason(owner.id, chatId, messageId, hasPhoto, originalContent);
        await answerCallbackQuery(cq.id, 'Rad etish sababini yozing');
        await sendMessage(from.id,
          `✏️ <b>${escapeHtmlServer(ownerLabel(owner))}</b> uchun rad etish sababini yozib yuboring ` +
          `(masalan: "Skrinshot noaniq" yoki "Summa mos emas"). Bekor qilish uchun /bekor yozing.`);
        return;
      }

      const result = decideSubscriptionPayment(owner, 'approve', from.id);
      saveOwners(owners);

      await editConfirmMessage(`✅ Tasdiqlandi — ${displayName(from)}`);
      await answerCallbackQuery(cq.id, 'Tasdiqlandi ✅');
      return;
    }

    if (data.startsWith('custom:')) {
      const [, reqId] = data.split(':');
      const reqInfo = findRequest(reqId);
      if (!reqInfo) {
        await answerCallbackQuery(cq.id, 'Bu so\'rov allaqachon ko\'rib chiqilgan.');
        return;
      }
      setAwaitingCustom(reqId, messageId);
      await editMessageText(chatId, messageId,
        `🆕 <b>Yangi do'kon egasi so'rovi</b>\n${displayName(reqInfo)} (ID: <code>${reqInfo.userId}</code>)\n\n` +
        `✏️ Necha kunga ruxsat berishni istaysiz? Kun sonini oddiy xabar qilib yuboring (masalan: 14).\nBekor qilish uchun /bekor yozing.`);
      await answerCallbackQuery(cq.id);
      return;
    }

    if (data.startsWith('apr:')) {
      const [, reqId, daysKey] = data.split(':');
      const reqInfo = findRequest(reqId);
      if (!reqInfo) {
        await answerCallbackQuery(cq.id, 'Bu so\'rov allaqachon ko\'rib chiqilgan.');
        return;
      }

      const days = daysKey === 'p' ? null : parseInt(daysKey, 10);
      const label = approveRequest(reqInfo, days);

      await editMessageText(chatId, messageId,
        `✅ <b>Tasdiqlandi</b>\n${displayName(reqInfo)} (ID: <code>${reqInfo.userId}</code>)\nRuxsat muddati: ${label}`);
      await sendMessage(reqInfo.userId,
        `✅ So'rovingiz tasdiqlandi! Sizga <b>${label}</b> muddatga kirish huquqi berildi.\nMini App tugmasi orqali oching.`);
      await answerCallbackQuery(cq.id, 'Tasdiqlandi ✅');
      return;
    }

    if (data.startsWith('rej:')) {
      const [, reqId] = data.split(':');
      const reqInfo = findRequest(reqId);
      if (!reqInfo) {
        await answerCallbackQuery(cq.id, 'Bu so\'rov allaqachon ko\'rib chiqilgan.');
        return;
      }
      removeRequest(reqId);
      await editMessageText(chatId, messageId,
        `❌ <b>Rad etildi</b>\n${displayName(reqInfo)} (ID: <code>${reqInfo.userId}</code>)`);
      await sendMessage(reqInfo.userId, '❌ Kechirasiz, so\'rovingiz rad etildi.');
      await answerCallbackQuery(cq.id, 'Rad etildi');
      return;
    }
  }
}

async function resolveUserInput(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return { error: 'Ma\'lumot kiritilmagan' };

  if (/^\d{5,}$/.test(trimmed)) {
    return { id: trimmed };
  }

  let m = trimmed.match(/id=(\d{5,})/);
  if (m) return { id: m[1] };

  m = trimmed.match(/(?:t\.me\/|@)([a-zA-Z0-9_]{4,32})/i);
  if (m) {
    const username = m[1];
    try {
      const result = await telegramApi('getChat', { chat_id: '@' + username });
      if (result.ok && result.result && result.result.id) {
        return { id: String(result.result.id), username: result.result.username || username };
      }
      return { error: 'Foydalanuvchi topilmadi. Unga botga /start yozishni so\'rang yoki to\'g\'ridan-to\'g\'ri Telegram ID raqamini kiriting (ID ni @userinfobot orqali bilib olish mumkin).' };
    } catch (e) {
      return { error: 'Telegram bilan bog\'lanishda xatolik yuz berdi. Qaytadan urinib ko\'ring.' };
    }
  }

  return { error: 'Noto\'g\'ri format. Telegram ID raqamini, @username yoki t.me havolasini kiriting.' };
}

// Katta javoblar gzip bilan siqiladi (JSON odatda 5-10 marta kichrayadi).
function sendJSON(res, status, obj) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (res.acceptsGzip && body.length > 1400) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
    return res.end(zlib.gzipSync(body, { level: 5 }));
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
const sendOk = (res, data) => sendJSON(res, 200, Object.assign({ ok: true }, data));
const sendFail = (res, reason, extra) => sendJSON(res, 200, Object.assign({ ok: false, reason }, extra));
function bodyErrorReason(err) {
  return err && err.message === 'body_too_large'
    ? "So'rov hajmi juda katta (odatda yuklangan rasm judayam katta bo'lgani uchun). Rasmni kichikroq/ boshqasiga almashtirib, qaytadan urinib ko'ring."
    : "noto'g'ri so'rov";
}

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
function readBody(req, cb) {
  let body = '';
  let tooLarge = false;
  req.on('data', chunk => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > MAX_REQUEST_BODY_BYTES) {
      tooLarge = true;
      cb(new Error('body_too_large'));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    let parsed;
    try { parsed = JSON.parse(body || '{}'); }
    catch (e) {
      // Diagnostika: JSON.parse nima uchun muvaffaqiyatsiz bo'lganini
      // server konsolida ko'rish uchun (masalan Replit/PM2 log'larida).
      console.error(
        `readBody JSON parse xatosi [${req.method} ${req.url}]:`,
        e.message,
        '| body uzunligi:', body.length,
        '| body boshi:', body.slice(0, 300),
        '| body oxiri:', body.slice(-100)
      );
      return cb(e);
    }
    // cb tashqarida chaqiriladi: handler ichidagi xato qayta cb(err) ga tushmasin
    cb(null, parsed);
  });
  req.on('error', (e) => {
    console.error(`readBody req oqim xatosi [${req.method} ${req.url}]:`, e.message);
    if (!tooLarge) { tooLarge = true; cb(e); }
  });
}

const AI_DIRECTOR_HOUR = 8;
const AI_DIRECTOR_TZ_OFFSET_MS = 5 * 60 * 60 * 1000;

function aiDirDateKey(input) {
  const d = (input instanceof Date) ? input : new Date(input);
  return new Date(d.getTime() + AI_DIRECTOR_TZ_OFFSET_MS).toISOString().slice(0, 10);
}
function aiDirDayStartFromKey(dateKey) {
  return new Date(new Date(dateKey + 'T00:00:00.000Z').getTime() - AI_DIRECTOR_TZ_OFFSET_MS);
}

// Har bir oshxona uchun kunlik tartib raqami (#1, #2, #3...) — har kuni 1 dan qayta boshlanadi.
function getNextOrderNumber(owner) {
  const todayKey = aiDirDateKey(new Date());
  if (!owner.orderNumberState || owner.orderNumberState.date !== todayKey) {
    owner.orderNumberState = { date: todayKey, seq: 0 };
  }
  owner.orderNumberState.seq += 1;
  return owner.orderNumberState.seq;
}
function aiDirDayStart(input) {
  return aiDirDayStartFromKey(aiDirDateKey(input));
}
function aiDirTashkentHour(input) {
  const d = (input instanceof Date) ? input : new Date(input);
  return new Date(d.getTime() + AI_DIRECTOR_TZ_OFFSET_MS).getUTCHours();
}

const AI_DIRECTOR_WEEKLY_DAY = 1;
function aiDirTashkentWeekday(input) {
  const d = (input instanceof Date) ? input : new Date(input);
  return new Date(d.getTime() + AI_DIRECTOR_TZ_OFFSET_MS).getUTCDay();
}

function aiDirWeekKey(input) {
  const d = (input instanceof Date) ? input : new Date(input);
  const tashkent = new Date(d.getTime() + AI_DIRECTOR_TZ_OFFSET_MS);
  const day = tashkent.getUTCDay();
  const diffToMonday = (day === 0) ? -6 : (1 - day);
  const monday = new Date(tashkent.getTime());
  monday.setUTCDate(monday.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}

function aiDirCashBucket(owner, fromDate, toDate) {
  const orders = (owner.orders || []).filter(o => { const t = new Date(o.createdAt); return t >= fromDate && t < toDate; });
  const expenses = (owner.expenses || []).filter(e => { const t = new Date(e.createdAt); return t >= fromDate && t < toDate; });
  const income = orders.reduce((s, o) => s + orderIncomeAmount(o), 0);
  const expense = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  return { income, expense, net: income - expense, orderCount: orders.length };
}

function aiDirItemStats(owner, fromDate, toDate) {
  const orders = (owner.orders || []).filter(o => { const t = new Date(o.createdAt); return t >= fromDate && t < toDate; });
  const byId = new Map();
  for (const o of orders) {
    for (const it of (o.items || [])) {
      const cur = byId.get(it.id) || { id: it.id, name: it.name, qty: 0, revenue: 0 };
      cur.qty += it.qty;
      cur.revenue += it.price * it.qty;
      byId.set(it.id, cur);
    }
  }
  return byId;
}

function aiDirDecliningItems(owner) {
  const todayStart = aiDirDayStart(new Date());
  const last7Start = new Date(todayStart.getTime() - 7 * 86400000);
  const prev7Start = new Date(todayStart.getTime() - 14 * 86400000);

  const last7 = aiDirItemStats(owner, last7Start, todayStart);
  const prev7 = aiDirItemStats(owner, prev7Start, last7Start);

  const declining = [];
  for (const [id, cur] of last7) {
    const prev = prev7.get(id);
    if (!prev || prev.qty < 5) continue;
    const changePercent = ((cur.qty - prev.qty) / prev.qty) * 100;
    if (changePercent <= -15) {
      declining.push({ id, name: cur.name, qtyNow: cur.qty, qtyPrev: prev.qty, changePercent: Math.round(changePercent) });
    }
  }
  declining.sort((a, b) => a.changePercent - b.changePercent);
  return declining;
}

function aiDirStockRunway(owner) {
  const since = new Date(Date.now() - 7 * 86400000);
  const pools = [owner, ...(owner.branches || [])];
  const result = [];
  for (const pool of pools) {
    const usageById = new Map();
    for (const m of (pool.stockMovements || [])) {
      if (m.type !== 'chiqim') continue;
      if (!m.note || !m.note.startsWith('Buyurtma:')) continue;
      if (new Date(m.createdAt) < since) continue;
      usageById.set(m.stockId, (usageById.get(m.stockId) || 0) + m.qty);
    }
    for (const item of (pool.stock || [])) {
      const used7d = usageById.get(item.id) || 0;
      if (used7d <= 0) continue;
      const avgDaily = used7d / 7;
      if (avgDaily <= 0) continue;
      result.push({ name: item.name, unit: item.unit, qty: item.qty, avgDaily, daysLeft: item.qty / avgDaily });
    }
  }
  result.sort((a, b) => a.daysLeft - b.daysLeft);
  return result;
}

function aiDirTopItem(owner) {
  const todayStart = aiDirDayStart(new Date());
  const last7Start = new Date(todayStart.getTime() - 7 * 86400000);
  const stats = aiDirItemStats(owner, last7Start, todayStart);
  let top = null;
  for (const it of stats.values()) {
    if (!top || it.revenue > top.revenue) top = it;
  }
  return top;
}

// --- Foyda marjasi, hafta kuni, combo foydasi va kassir cheki tahlili ---

function menuItemUnitCost(owner, menuItem) {
  if (!menuItem) return null;
  if (menuItem.directStockId) {
    const stockItem = (owner.stock || []).find(s => s.id === menuItem.directStockId);
    return stockItem ? (stockItem.price || 0) : null;
  }
  const recipe = Array.isArray(menuItem.recipe) ? menuItem.recipe : [];
  if (!recipe.length) return null;
  let cost = 0;
  for (const ing of recipe) {
    const stockItem = (owner.stock || []).find(s => s.id === ing.stockId);
    if (!stockItem) return null;
    cost += ing.qty * (stockItem.price || 0);
  }
  return cost;
}

function comboUnitCost(owner, combo) {
  if (!combo || !Array.isArray(combo.itemIds)) return null;
  let cost = 0;
  for (const entry of combo.itemIds) {
    const menuItem = (owner.menu || []).find(m => m.id === entry.menuItemId);
    const unitCost = menuItemUnitCost(owner, menuItem);
    if (unitCost === null) return null;
    cost += unitCost * entry.qty;
  }
  return cost;
}

function orderLineCost(owner, item) {
  if (item.isCombo) {
    const combo = findCombo(owner, item.id);
    const unitCost = comboUnitCost(owner, combo);
    return unitCost === null ? null : unitCost * item.qty;
  }
  const menuItem = (owner.menu || []).find(m => m.id === item.id);
  const unitCost = menuItemUnitCost(owner, menuItem);
  return unitCost === null ? null : unitCost * item.qty;
}

function aiDirItemMarginStats(owner, fromDate, toDate) {
  const orders = (owner.orders || []).filter(o => { const t = new Date(o.createdAt); return t >= fromDate && t < toDate; });
  const byId = new Map();
  for (const o of orders) {
    for (const it of (o.items || [])) {
      const cost = orderLineCost(owner, it);
      if (cost === null) continue;
      const revenue = it.price * it.qty;
      const cur = byId.get(it.id) || { id: it.id, name: it.name, revenue: 0, cost: 0, qty: 0 };
      cur.revenue += revenue;
      cur.cost += cost;
      cur.qty += it.qty;
      byId.set(it.id, cur);
    }
  }
  return byId;
}

function aiDirMarginDrops(owner) {
  const todayStart = aiDirDayStart(new Date());
  const last7Start = new Date(todayStart.getTime() - 7 * 86400000);
  const prev7Start = new Date(todayStart.getTime() - 14 * 86400000);
  const cur = aiDirItemMarginStats(owner, last7Start, todayStart);
  const prev = aiDirItemMarginStats(owner, prev7Start, last7Start);

  const drops = [];
  for (const [id, c] of cur) {
    const p = prev.get(id);
    if (!p || p.revenue <= 0 || c.revenue <= 0 || p.qty < 3) continue;
    const curMargin = ((c.revenue - c.cost) / c.revenue) * 100;
    const prevMargin = ((p.revenue - p.cost) / p.revenue) * 100;
    const diff = curMargin - prevMargin;
    if (diff <= -5) {
      drops.push({ id, name: c.name, curMargin: Math.round(curMargin), prevMargin: Math.round(prevMargin), diff: Math.round(diff) });
    }
  }
  drops.sort((a, b) => a.diff - b.diff);
  return drops;
}

function aiDirWeekdayStaffing(owner) {
  const since = new Date(Date.now() - 56 * 86400000);
  const orders = (owner.orders || []).filter(o => new Date(o.createdAt) >= since);
  if (orders.length < 14) return null;

  const dayTotals = new Array(7).fill(0);
  for (const o of orders) dayTotals[new Date(o.createdAt).getDay()]++;

  const avgPerDay = orders.length / 7;
  if (avgPerDay <= 0) return null;

  let best = null;
  for (let day = 0; day < 7; day++) {
    const diffPercent = ((dayTotals[day] - avgPerDay) / avgPerDay) * 100;
    if (!best || diffPercent > best.diffPercent) best = { day, count: dayTotals[day], diffPercent };
  }
  if (best && best.diffPercent >= 15) {
    const weekdayLabels = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
    return { day: best.day, dayLabel: weekdayLabels[best.day], diffPercent: Math.round(best.diffPercent) };
  }
  return null;
}

function aiDirTopComboProfit(owner) {
  const todayStart = aiDirDayStart(new Date());
  const last30Start = new Date(todayStart.getTime() - 30 * 86400000);
  const orders = (owner.orders || []).filter(o => { const t = new Date(o.createdAt); return t >= last30Start && t < todayStart; });

  const byId = new Map();
  for (const o of orders) {
    for (const it of (o.items || [])) {
      if (!it.isCombo) continue;
      const cost = orderLineCost(owner, it);
      if (cost === null) continue;
      const revenue = it.price * it.qty;
      const cur = byId.get(it.id) || { id: it.id, name: it.name, profit: 0, qty: 0 };
      cur.profit += (revenue - cost);
      cur.qty += it.qty;
      byId.set(it.id, cur);
    }
  }
  let top = null;
  for (const c of byId.values()) {
    if (!top || c.profit > top.profit) top = c;
  }
  return top;
}

function aiDirCashierName(owner, id) {
  if (String(id) === String(owner.id)) return 'Egasi';
  const staff = (owner.staff || []).find(s => String(s.id) === String(id));
  return staffDisplayName(staff) || `Xodim (ID: ${id})`;
}

function aiDirCashierAvgCheck(owner) {
  const todayStart = aiDirDayStart(new Date());
  const last7Start = new Date(todayStart.getTime() - 7 * 86400000);
  const orders = (owner.orders || []).filter(o => {
    const t = new Date(o.createdAt);
    return t >= last7Start && t < todayStart && o.createdBy && o.source !== 'customer';
  });
  if (orders.length < 10) return null;

  const byCashier = new Map();
  let overallSum = 0;
  for (const o of orders) {
    const total = o.total || 0;
    overallSum += total;
    const cur = byCashier.get(o.createdBy) || { id: o.createdBy, sum: 0, count: 0 };
    cur.sum += total;
    cur.count += 1;
    byCashier.set(o.createdBy, cur);
  }
  if (byCashier.size < 2) return null;
  const overallAvg = overallSum / orders.length;
  if (overallAvg <= 0) return null;

  let worst = null;
  for (const c of byCashier.values()) {
    if (c.count < 3) continue;
    const avg = c.sum / c.count;
    const diffPercent = ((avg - overallAvg) / overallAvg) * 100;
    if (diffPercent <= -10 && (!worst || diffPercent < worst.diffPercent)) {
      worst = { id: c.id, avg, diffPercent: Math.round(diffPercent), count: c.count };
    }
  }
  if (!worst) return null;
  worst.name = aiDirCashierName(owner, worst.id);
  return worst;
}

function buildAiDirectorText(owner) {
  const todayStart = aiDirDayStart(new Date());
  const yestStart = new Date(todayStart.getTime() - 86400000);
  const dayBeforeStart = new Date(todayStart.getTime() - 2 * 86400000);

  const yesterday = aiDirCashBucket(owner, yestStart, todayStart);
  const dayBefore = aiDirCashBucket(owner, dayBeforeStart, yestStart);
  const incomeChangePercent = dayBefore.income > 0
    ? Math.round(((yesterday.income - dayBefore.income) / dayBefore.income) * 100)
    : null;

  const topItem = aiDirTopItem(owner);
  const runway = aiDirStockRunway(owner);
  const urgentStock = runway.filter(r => r.daysLeft <= 3).slice(0, 3);
  const declining = aiDirDecliningItems(owner);
  const marginDrops = aiDirMarginDrops(owner);
  const weakCashier = aiDirCashierAvgCheck(owner);

  const lines = ['📊 <b>Bugungi holat</b>', ''];
  lines.push(`Kecha tushum: <b>${fmtNum(yesterday.income)} so'm</b>` +
    (incomeChangePercent !== null ? ` (${incomeChangePercent > 0 ? '+' : ''}${incomeChangePercent}%)` : ''));
  lines.push(`Foyda: <b>${fmtNum(yesterday.net)} so'm</b>`);
  if (topItem) lines.push(`Eng ko'p tushum keltirgan taom (7 kun): <b>${escapeHtmlServer(topItem.name)}</b>`);

  if (urgentStock.length) {
    lines.push('');
    for (const s of urgentStock) {
      lines.push(s.daysLeft < 1
        ? `⚠️ ${escapeHtmlServer(s.name)} bugun tugashi mumkin.`
        : `⚠️ ${escapeHtmlServer(s.name)} taxminan ${Math.floor(s.daysLeft)} kunga yetadi.`);
    }
  }

  if (marginDrops.length) {
    const m = marginDrops[0];
    lines.push('');
    lines.push(`📉 <b>${escapeHtmlServer(m.name)}</b>ning foyda marjasi pasaygan: ${m.prevMargin}% → ${m.curMargin}%.`);
  }

  if (weakCashier) {
    lines.push('');
    lines.push(`👤 <b>${escapeHtmlServer(weakCashier.name)}</b>ning o'rtacha cheki boshqalardan ${Math.abs(weakCashier.diffPercent)}% past (so'nggi 7 kun).`);
  }

  if (declining.length) {
    const d = declining[0];
    lines.push('');
    lines.push(`Oxirgi 7 kunda <b>${escapeHtmlServer(d.name)}</b> savdosi ${Math.abs(d.changePercent)}% kamaygan.`);
    lines.push('');
    lines.push(`💡 <b>Tavsiya:</b> bugun ${escapeHtmlServer(d.name)} uchun aksiya qiling yoki xaridni kamaytiring.`);
  }

  return lines.join('\n');
}

async function sendAiDirectorDigest(owner, force) {
  const todayKey = aiDirDateKey(new Date());
  if (!force && owner.aiDirectorLastSent === todayKey) return false;
  const text = buildAiDirectorText(owner);
  for (const recipientId of ownerReportRecipientIds(owner)) {
    await sendMessage(recipientId, text);
  }
  owner.aiDirectorLastSent = todayKey;
  return true;
}

function buildAiWeeklyDirectorText(owner) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const prevWeekAgo = new Date(now.getTime() - 14 * 86400000);

  const thisWeek = aiDirCashBucket(owner, weekAgo, now);
  const prevWeek = aiDirCashBucket(owner, prevWeekAgo, weekAgo);
  const incomeChangePercent = prevWeek.income > 0
    ? Math.round(((thisWeek.income - prevWeek.income) / prevWeek.income) * 100)
    : null;

  const itemStats = Array.from(aiDirItemStats(owner, weekAgo, now).values())
    .sort((a, b) => b.revenue - a.revenue).slice(0, 3);

  const runway = aiDirStockRunway(owner);
  const urgentStock = runway.filter(r => r.daysLeft <= 3).slice(0, 5);
  const declining = aiDirDecliningItems(owner);
  const topCombo = aiDirTopComboProfit(owner);
  const staffing = aiDirWeekdayStaffing(owner);

  const lines = ['📅 <b>Haftalik hisobot</b>', ''];
  lines.push(`Haftalik tushum: <b>${fmtNum(thisWeek.income)} so'm</b>` +
    (incomeChangePercent !== null ? ` (${incomeChangePercent > 0 ? '+' : ''}${incomeChangePercent}%)` : ''));
  lines.push(`Haftalik foyda: <b>${fmtNum(thisWeek.net)} so'm</b> (${thisWeek.orderCount} ta buyurtma)`);

  if (itemStats.length) {
    lines.push('');
    lines.push('🏆 <b>Eng ko\'p sotilgan taomlar (7 kun):</b>');
    itemStats.forEach((it, i) => lines.push(`${i + 1}. ${escapeHtmlServer(it.name)} — ${it.qty} dona (${fmtNum(it.revenue)} so'm)`));
  }

  if (topCombo) {
    lines.push('');
    lines.push(`🎁 Eng yuqori foyda keltirgan combo (30 kun): <b>${escapeHtmlServer(topCombo.name)}</b> — ${fmtNum(topCombo.profit)} so'm sof foyda.`);
  }

  if (staffing) {
    lines.push('');
    lines.push(`📈 <b>${escapeHtmlServer(staffing.dayLabel)}</b> kuni sotuv o'rtachadan ${staffing.diffPercent}% yuqori. Shu kuni xodim sonini ko'paytirishni o'ylab ko'ring.`);
  }

  if (urgentStock.length) {
    lines.push('');
    lines.push('⚠️ <b>Tez tugaydigan mahsulotlar:</b>');
    for (const s of urgentStock) {
      lines.push(s.daysLeft < 1
        ? `• ${escapeHtmlServer(s.name)} — bugun-erta tugashi mumkin`
        : `• ${escapeHtmlServer(s.name)} — taxminan ${Math.floor(s.daysLeft)} kunga yetadi`);
    }
  }

  if (declining.length) {
    const d = declining[0];
    lines.push('');
    lines.push(`Oxirgi 7 kunda <b>${escapeHtmlServer(d.name)}</b> savdosi ${Math.abs(d.changePercent)}% kamaygan.`);
    lines.push(`💡 <b>Tavsiya:</b> ${escapeHtmlServer(d.name)} uchun aksiya qiling yoki keyingi haftaga xaridni kamaytiring.`);
  }

  return lines.join('\n');
}

async function sendAiWeeklyDirectorDigest(owner, force) {
  const weekKey = aiDirWeekKey(new Date());
  if (!force && owner.aiWeeklyLastSent === weekKey) return false;
  const text = buildAiWeeklyDirectorText(owner);
  for (const recipientId of ownerReportRecipientIds(owner)) {
    await sendMessage(recipientId, text);
  }
  owner.aiWeeklyLastSent = weekKey;
  return true;
}

// ---- Kunlik savdo/xarajat hisoboti — avtomatik yuborish (67-bosqich) ----
// Bu Z-hisobot ("Kunni yopish") bilan bir xil ma'lumotni hisoblaydi, lekin
// egasi qo'lda tugma bosishini kutmay, har kuni ertalab soat 08:00'da
// (AI Direktor bilan bir vaqtda) O'TGAN KUNNING to'liq yopilgan
// ma'lumotini o'zi Telegram'ga yuboradi. Shu bilan birga, agar o'sha kun
// uchun hali Z-hisobot qo'lda yopilmagan bo'lsa — buni ham avtomatik
// owner.zReports tarixiga yozib qo'yadi, shunda egasi "Kunni yopish"
// tugmasini bosishni unutib qo'yса ham tarix uzilib qolmaydi.
function buildDailyReportData(owner, dateKey) {
  const dayStart = aiDirDayStartFromKey(dateKey);
  const dayEnd = new Date(dayStart.getTime() + 86400000);

  const orders = (owner.orders || []).filter(o => {
    const t = new Date(o.createdAt);
    return t >= dayStart && t < dayEnd;
  });
  const expenses = (owner.expenses || []).filter(e => {
    const t = new Date(e.createdAt);
    return t >= dayStart && t < dayEnd;
  });

  const dostavkaOrders = orders.filter(o => o.orderType === 'dostavka' && o.paymentType === 'dostavka_orqali');
  const kassaOrders = orders.filter(o => !(o.orderType === 'dostavka' && o.paymentType === 'dostavka_orqali'));
  const kassaIncome = kassaOrders.reduce((s, o) => s + orderIncomeAmount(o), 0);
  const dostavkaIncome = dostavkaOrders.reduce((s, o) => s + orderIncomeAmount(o), 0);
  const income = kassaIncome + dostavkaIncome;

  const paymentBreakdown = {};
  for (const key of Object.keys(PAYMENT_TYPES)) paymentBreakdown[key] = 0;
  for (const o of orders) {
    const pt = Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, o.paymentType) ? o.paymentType : 'naqd';
    paymentBreakdown[pt] = (paymentBreakdown[pt] || 0) + orderIncomeAmount(o);
  }

  const expenseByCategory = {};
  for (const key of Object.keys(EXPENSE_CATEGORIES)) expenseByCategory[key] = 0;
  for (const e of expenses) {
    const cat = Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORIES, e.category) ? e.category : 'boshqa';
    expenseByCategory[cat] = (expenseByCategory[cat] || 0) + (e.amount || 0);
  }
  const expense = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const cancelledCount = (owner.orders || []).filter(o => {
    const t = new Date(o.cancelledAt || o.createdAt);
    return o.status === 'bekor_qilindi' && t >= dayStart && t < dayEnd;
  }).length;

  return {
    date: dateKey,
    income, kassaIncome, dostavkaIncome, orderCount: orders.length, cancelledCount,
    paymentBreakdown, expense, expenseByCategory, net: income - expense
  };
}

function buildDailyReportText(owner, dateKey) {
  const r = buildDailyReportData(owner, dateKey);
  const lines = [`📊 <b>Kunlik hisobot</b> — ${r.date}`, ''];
  lines.push(`💰 Tushum: <b>${fmtNum(r.income)} so'm</b>`);
  lines.push(`📦 Buyurtmalar: ${r.orderCount} ta` + (r.cancelledCount ? ` (${r.cancelledCount} ta bekor qilingan)` : ''));
  lines.push('');
  lines.push('💳 To\'lov turlari bo\'yicha:');
  const mergedPaymentBreakdown = { ...r.paymentBreakdown };
  mergedPaymentBreakdown.naqd = (mergedPaymentBreakdown.naqd || 0) + (mergedPaymentBreakdown.dostavka_orqali || 0);
  mergedPaymentBreakdown.dostavka_orqali = 0;
  for (const key of Object.keys(PAYMENT_TYPES)) {
    if (key === 'dostavka_orqali') continue;
    if (mergedPaymentBreakdown[key]) lines.push(`  • ${PAYMENT_TYPES[key]}: ${fmtNum(mergedPaymentBreakdown[key])} so'm`);
  }
  lines.push('');
  lines.push(`🧾 Xarajat: <b>${fmtNum(r.expense)} so'm</b>`);
  for (const key of Object.keys(EXPENSE_CATEGORIES)) {
    if (r.expenseByCategory[key]) lines.push(`  • ${EXPENSE_CATEGORIES[key]}: ${fmtNum(r.expenseByCategory[key])} so'm`);
  }
  lines.push('');
  lines.push(`📈 Sof foyda: <b>${fmtNum(r.net)} so'm</b>`);
  return lines.join('\n');
}

async function sendDailyReportDigest(owner, force) {
  const yesterdayKey = aiDirDateKey(new Date(Date.now() - 86400000));
  if (!force && owner.dailyReportLastSent === yesterdayKey) return false;
  const text = buildDailyReportText(owner, yesterdayKey);
  for (const recipientId of ownerReportRecipientIds(owner)) {
    await sendMessage(recipientId, text);
  }
  owner.dailyReportLastSent = yesterdayKey;

  // Agar o'sha kun uchun hali Z-hisobot qo'lda yopilmagan bo'lsa, shu
  // ma'lumot bilan avtomatik yozib qo'yamiz (tarix uzilib qolmasligi uchun).
  if (!force) {
    if (!owner.zReports) owner.zReports = [];
    if (!owner.zReports.some(z => z.date === yesterdayKey)) {
      const built = buildDailyReportData(owner, yesterdayKey);
      owner.zReports.unshift(Object.assign({
        id: crypto.randomBytes(4).toString('hex'),
        createdAt: new Date().toISOString(),
        createdBy: 'auto'
      }, built));
      if (owner.zReports.length > 90) owner.zReports.length = 90;
    }
  }
  return true;
}

// ---- /hisobot buyrug'i — barcha hisobot va tahlillarni bittada yig'ib
// yuboradi. Egasi va "Egasi (hamkor)" xodimlar uchun ochiq (qarang:
// resolveOwnerContext — ikkalasi ham role === 'egasi' qaytaradi).
function buildZReportSummaryText(owner) {
  const list = (owner.zReports || []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  if (!list.length) return null;
  const lines = ["🧾 <b>So'nggi kunlar (Z-hisobot):</b>"];
  for (const z of list) {
    lines.push(`  • ${z.date}: tushum ${fmtNum(z.income)} so'm, sof foyda ${fmtNum(z.net)} so'm`);
  }
  return lines.join('\n');
}

function buildStaffTopPerformerText(owner) {
  if (!(owner.staff || []).length) return null;
  const from = new Date(Date.now() - 30 * 86400000);
  const log = (owner.staffActionLog || []).filter(e => new Date(e.createdAt) >= from);
  if (!log.length) return null;
  const report = (owner.staff || []).map(staff => {
    const mine = log.filter(e => String(e.userId) === String(staff.id));
    const actionCount = mine.length;
    const errorCount = mine.reduce((s, e) => s + (e.errorCount || 0), 0);
    return { name: staffDisplayName(staff), actionCount, errorCount, score: actionCount - errorCount * 2 };
  }).filter(r => r.actionCount > 0);
  if (!report.length) return null;
  report.sort((a, b) => b.score - a.score);
  const top = report[0];
  return `👤 Oxirgi 30 kunda eng faol xodim: <b>${escapeHtmlServer(top.name)}</b> — ${top.actionCount} ta amal` +
    (top.errorCount ? `, ${top.errorCount} ta xato` : '') + '.';
}

function buildFullHisobotText(owner) {
  const sections = [];
  sections.push(`📋 <b>To'liq hisobot</b> — ${escapeHtmlServer((owner.profile && owner.profile.name) || 'Oshxona')}`);

  const yesterdayKey = aiDirDateKey(new Date(Date.now() - 86400000));
  sections.push(buildDailyReportText(owner, yesterdayKey));

  if (ownerCanUseFeature(owner, 'ai-analytics')) {
    sections.push(buildAiDirectorText(owner));
    sections.push(buildAiWeeklyDirectorText(owner));
  }

  if (ownerCanUseFeature(owner, 'z-report')) {
    const zText = buildZReportSummaryText(owner);
    if (zText) sections.push(zText);
  }

  if (ownerCanUseFeature(owner, 'staff-performance')) {
    const staffText = buildStaffTopPerformerText(owner);
    if (staffText) sections.push(staffText);
  }

  return sections.join('\n\n————————————\n\n');
}

setInterval(() => {
  if (aiDirTashkentHour(new Date()) !== AI_DIRECTOR_HOUR) return;
  const isWeeklyDay = aiDirTashkentWeekday(new Date()) === AI_DIRECTOR_WEEKLY_DAY;
  const owners = pruneExpiredOwners();
  let changed = false;
  (async () => {
    for (const owner of owners) {
      if (!isOwnerAccessValid(owner)) continue;
      if (owner.aiDirectorEnabled !== false) {
        const sent = await sendAiDirectorDigest(owner, false);
        if (sent) changed = true;
      }
      if (isWeeklyDay && owner.aiWeeklyEnabled !== false) {
        const sentWeekly = await sendAiWeeklyDirectorDigest(owner, false);
        if (sentWeekly) changed = true;
      }
      if (owner.dailyReportEnabled !== false && ownerCanUseFeature(owner, 'z-report')) {
        const sentDaily = await sendDailyReportDigest(owner, false);
        if (sentDaily) changed = true;
      }
    }
    if (changed) saveOwners(owners);
  })().catch(() => {});
}, 10 * 60 * 1000);

const CUSTOMER_AUTO_RECEIVE_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const owners = loadOwners();
  let changed = false;
  for (const owner of owners) {
    for (const order of (owner.orders || [])) {
      if (order.orderType === 'dostavka') continue;
      if (order.status !== 'tayyor') continue;
      if (order.customerReceivedAt) continue;
      const readyTime = new Date(order.readyAt || order.updatedAt || order.createdAt).getTime();
      if (Date.now() - readyTime >= CUSTOMER_AUTO_RECEIVE_MS) {
        order.customerReceivedAt = new Date().toISOString();
        order.customerReceivedAuto = true;
        changed = true;
        sendOrderRatingRequest(owner, order);
      }
    }
  }
  if (changed) saveOwners(owners);
}, 15 * 60 * 1000);

// MUHIM: bu ikkita handler bo'lmasa, kod ichida istalgan joyda kutilmagan
// (uncaught) xato chiqsa — butun Node.js process qulab tushar edi, Railway
// uni qayta ishga tushirguncha (bir necha soniya) HAMMA foydalanuvchi uchun
// server o'lik bo'lib turar, va aynan shu daqiqada mini-app'ni ochgan odam
// oq ekran ko'rar edi. Endi bunday xatolar faqat log'ga yoziladi, server esa
// ishlashda davom etadi.
process.on('uncaughtException', (err) => {
  console.error('[FATAL, lekin ushlab qolindi] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL, lekin ushlab qolindi] unhandledRejection:', reason && reason.stack || reason);
});

const server = http.createServer((req, res) => {
  try {
    return handleRequest(req, res);
  } catch (err) {
    console.error('[so\'rovni qayta ishlashda xatolik]', req.method, req.url, err && err.stack || err);
    try {
      if (!res.headersSent) {
        sendJSON(res, 500, { ok: false, reason: 'Serverda vaqtinchalik xatolik. Qayta urinib ko\'ring.' });
      } else {
        res.end();
      }
    } catch (e2) {
      try { res.end(); } catch (_) {}
    }
  }
});

// ==========================================================================
// HTTP API — barcha endpointlar shu registry orqali ro'yxatga olinadi.
//   route(url, fn)  — xom handler: fn(payload, res)
//   authed(url, fn) — Telegram initData tekshirilgan: fn(payload, res, { user, userId })
// Body o'qish, JSON xatosi va handler ichidagi istisnolar markazda ushlanadi.
// ==========================================================================
const API_ROUTES = new Map();
function route(url, handler) { API_ROUTES.set(url, handler); }
function authed(url, handler) {
  API_ROUTES.set(url, (payload, res) => {
    const check = verifyAuth(payload.initData);
    if (!check.ok) return sendFail(res, check.reason);
    return handler(payload, res, { user: check.user, userId: String(check.user && check.user.id) });
  });
}


route('/api/verify', (payload, res) => {
  const { initData } = payload;
  if (!initData) return sendJSON(res, 400, { ok: false, reason: 'initData yo\'q' });

  const result = verifyAuth(initData);
  if (!result.ok) return sendFail(res, result.reason);

  const userId = String(result.user && result.user.id);
  const admin = isAdminId(userId);
  const owners = pruneExpiredOwners();
  const owner = findOwner(owners, userId);
  const ownerOk = isOwnerAccessValid(owner);
  const staffInfo = (!admin && !ownerOk) ? findStaffInfo(owners, userId) : null;

  const staffBlocked = !!(staffInfo && staffInfo.rawRoles.length > 0 && staffInfo.roles.length === 0);
  const ok = admin || ownerOk || !!(staffInfo && !staffBlocked);

  return sendJSON(res, 200, {
    ok,
    isAdmin: admin,
    isOwner: !admin && ownerOk,
    role: staffInfo ? staffInfo.role : null,
    roles: staffInfo ? staffInfo.roles : null,
    roleLabel: staffInfo ? rolesLabel(staffInfo.roles) : null,
    ownerRestaurantName: staffInfo ? staffInfo.ownerName : (ownerOk ? ((owner.profile && owner.profile.name) || null) : null),
    ownerLogoUrl: staffInfo ? staffInfo.ownerLogoUrl : (ownerOk ? ((owner.profile && owner.profile.logoUrl) || null) : null),
    ownerBrandColor: staffInfo ? staffInfo.ownerBrandColor : (ownerOk ? ((owner.profile && owner.profile.brandColor) || null) : null),
    hasProfile: !admin && ownerOk && !!(owner && owner.profile && owner.profile.completedAt),

    hasOwnerLogin: !admin && ownerOk && !!(owner && owner.login && owner.passwordHash),
    personRegistered: admin || isRegisteredUser(userId),
    reason: ok
      ? null
      : (staffBlocked
          ? 'Lavozimingiz (' + rolesLabel(staffInfo.rawRoles) + ') joriy tarifda yopilgan. Administrator bilan bog\'laning.'
          : 'Bu ilova faqat administrator, tasdiqlangan do\'kon egalari va ularning xodimlari uchun.')
  });
});

authed('/api/profile-register', (payload, res, { user }) => {
  const { firstName, lastName, phone } = payload;

  const ism = String(firstName || '').trim();
  const familiya = String(lastName || '').trim();
  const raqam = String(phone || '').trim();

  if (!ism || ism.length > 60) {
    return sendFail(res, 'Ismingizni to\'g\'ri kiriting.');
  }
  if (!familiya || familiya.length > 60) {
    return sendFail(res, 'Familiyangizni to\'g\'ri kiriting.');
  }
  if (!isPlausiblePhone(raqam)) {
    return sendFail(res, 'Telefon raqam noto\'g\'ri formatda (masalan: +998901234567).');
  }

  const userId = String(user.id);
  const profiles = loadProfiles();
  const idx = profiles.findIndex(p => String(p.id) === userId);
  const profile = {
    id: userId,
    username: (user && user.username) || null,
    firstName: ism,
    lastName: familiya,
    phone: raqam,
    registeredAt: new Date().toISOString()
  };
  if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
  saveProfiles(profiles);

  return sendOk(res);
});

authed('/api/staff-list', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const owner = ownerCtx.owner;

  return sendOk(res, { staff: publicStaffList(owner.staff) });
});

authed('/api/add-staff', async (payload, res, { userId }) => {
  const { input, role, roles, branchId } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi xodim qo\'sha oladi');
  const owner = ownerCtx.owner;

  const rolesArr = Array.isArray(roles) ? roles : (role ? [role] : []);
  const uniqueRoles = [...new Set(rolesArr)].filter(isValidRole)
    // 69-bosqich: 'egasi' boshqa rollar bilan birga tanlangan bo'lsa ham,
    // har doim ro'yxat boshida bo'lishi kerak — chunki ctx.role (birinchi
    // rol) 'egasi' bo'lgandagina to'liq egasi huquqi to'g'ri ishlaydi.
    .sort((a, b) => (a === 'egasi' ? -1 : b === 'egasi' ? 1 : 0));
  if (!uniqueRoles.length) {
    return sendFail(res, 'Kamida bitta lavozim tanlang.');
  }

  let branchIdVal = null;
  if (branchId) {
    if (!findBranch(owner, branchId)) {
      return sendFail(res, 'Bunday filial topilmadi.');
    }
    branchIdVal = branchId;
  }

  const resolved = await resolveUserInput(input);
  if (resolved.error) return sendFail(res, resolved.error);

  if (isAdminId(resolved.id)) {
    return sendFail(res, 'Bu foydalanuvchi administrator, xodim qilib bo\'lmaydi.');
  }
  if (findOwner(owners, resolved.id)) {
    return sendFail(res, 'Bu foydalanuvchi allaqachon oshxona egasi.');
  }
  const existingStaff = findStaffInfo(owners, resolved.id);
  if (existingStaff) {
    return sendFail(res, existingStaff.ownerId === owner.id
      ? 'Bu foydalanuvchi allaqachon sizning xodimingiz.'
      : 'Bu foydalanuvchi boshqa oshxonada xodim sifatida ro\'yxatda.');
  }

  if (!owner.staff) owner.staff = [];
  owner.staff.push({
    id: resolved.id,
    username: resolved.username || null,
    role: uniqueRoles[0],
    roles: uniqueRoles,
    branchId: branchIdVal,
    addedAt: new Date().toISOString()
  });
  saveOwners(owners);

  sendMessage(resolved.id,
    `👋 Sizni <b>${(owner.profile && owner.profile.name) || 'oshxona'}</b> jamoasiga <b>${rolesLabel(uniqueRoles)}</b> sifatida qo\'shishdi.\nMini App tugmasi orqali oching.`);

  return sendOk(res);
});

authed('/api/create-staff-invite', (payload, res, { userId }) => {
  const { role, roles, branchId } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi havola yarata oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'staff-invite')) return sendFeatureBlocked(res, 'staff-invite');

  const rolesArr = Array.isArray(roles) ? roles : (role ? [role] : []);
  const uniqueRoles = [...new Set(rolesArr)].filter(isValidRole)
    // Havola orqali "Egasi (hamkor)" huquqi berilmaydi — bu faqat
    // ID/username orqali to'g'ridan-to'g'ri qo'shishda mavjud, chunki
    // havola har kimga yuborilishi va noto'g'ri odamga to'liq egasi
    // huquqi tegib qolishi mumkin.
    .filter(r => r !== 'egasi');
  if (!uniqueRoles.length) {
    return sendFail(res, 'Kamida bitta lavozim tanlang. Egasi (hamkor) huquqi havola orqali berilmaydi.');
  }

  let branchIdVal = null;
  if (branchId) {
    if (!findBranch(owner, branchId)) {
      return sendFail(res, 'Bunday filial topilmadi.');
    }
    branchIdVal = branchId;
  }

  if (!BOT_USERNAME || BOT_USERNAME === 'BOT_USERNAME_BU_YERGA') {
    return sendFail(res, 'Serverda BOT_USERNAME sozlanmagan.');
  }

  const token = crypto.randomBytes(16).toString('hex');
  if (!owner.staffInvites) owner.staffInvites = [];

  owner.staffInvites = owner.staffInvites.filter(inv => !inv.used && new Date(inv.expiresAt) > new Date());
  owner.staffInvites.push({
    token,
    roles: uniqueRoles,
    branchId: branchIdVal,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    used: false,
    usedBy: null,
    usedAt: null
  });
  saveOwners(owners);

  const link = `https://t.me/${BOT_USERNAME}?start=staffinv_${owner.id}_${token}`;
  return sendOk(res, { link, roles: uniqueRoles });
});

authed('/api/set-staff-roles', (payload, res, { userId }) => {
  const { id, roles } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'staff-roles')) return sendFeatureBlocked(res, 'staff-roles');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const staff = (owner.staff || []).find(s => String(s.id) === String(id));
  if (!staff) return sendFail(res, 'Bunday xodim topilmadi');

  const uniqueRoles = [...new Set(Array.isArray(roles) ? roles : [])].filter(isValidRole);
  if (!uniqueRoles.length) {
    return sendFail(res, 'Kamida bitta lavozim tanlang.');
  }

  staff.roles = uniqueRoles;
  staff.role = uniqueRoles[0];
  saveOwners(owners);

  return sendOk(res, { staff: publicStaff(staff) });
});

authed('/api/set-staff-branch', (payload, res, { userId }) => {
  const { id, branchId } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ownerCtx.owner;
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const staff = (owner.staff || []).find(s => String(s.id) === String(id));
  if (!staff) return sendFail(res, 'Bunday xodim topilmadi');

  if (branchId) {
    if (!findBranch(owner, branchId)) return sendFail(res, 'Bunday filial topilmadi.');
    staff.branchId = branchId;
  } else {
    staff.branchId = null;
  }
  saveOwners(owners);

  return sendOk(res, { staff: publicStaff(staff) });
});

authed('/api/remove-staff', (payload, res, { userId }) => {
  const { id } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ownerCtx.owner;
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  owner.staff = (owner.staff || []).filter(s => String(s.id) !== String(id));
  saveOwners(owners);

  return sendOk(res);
});

authed('/api/branch-list', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');

  return sendOk(res, {
    branches: ctx.owner.branches || [],
    maxBranches: ownerMaxBranches(ctx.owner),
    centralBranchName: ctx.owner.centralBranchName || null
  });
});

authed('/api/central-branch-rename', (payload, res, { userId }) => {
  const { name } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ownerCtx.owner;

  const trimmedName = String(name || '').trim();
  owner.centralBranchName = trimmedName || null;
  saveOwners(owners);

  return sendOk(res, { centralBranchName: owner.centralBranchName });
});

authed('/api/branch-add', (payload, res, { userId }) => {
  const { name, address, phone } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi filial qo\'sha oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'branch-manage')) return sendFeatureBlocked(res, 'branch-manage');

  const trimmedName = String(name || '').trim();
  const trimmedAddress = String(address || '').trim();
  if (!trimmedName || !trimmedAddress) {
    return sendFail(res, 'Filial nomi va manzilini kiriting.');
  }

  const maxBranches = ownerMaxBranches(owner);
  const currentCount = (owner.branches || []).length;
  if (maxBranches && currentCount >= maxBranches) {
    return sendJSON(res, 200, {
      ok: false,
      reason: `Joriy tarifingiz bo'yicha ko'pi bilan ${maxBranches} ta filial ochish mumkin. Kengaytirish uchun administrator bilan bog'laning.`,
      blockedFeature: true,
      featureId: 'branch-manage'
    });
  }

  if (!owner.branches) owner.branches = [];
  const newBranch = {
    id: generateBranchId(),
    name: trimmedName,
    address: trimmedAddress,
    phone: phone ? String(phone).trim() : null,
    createdAt: new Date().toISOString(),
    // 1-bosqich: markaziy menyu va bo'limlar boshlang'ich nuqta sifatida
    // filialga nusxalanadi — shu paytdan boshlab filial menyusi mustaqil
    // tahrirlanadi va markaziy menyudagi keyingi o'zgarishlarga bog'liq bo'lmaydi.
    menu: JSON.parse(JSON.stringify(owner.menu || [])),
    categories: JSON.parse(JSON.stringify(ensureOwnerCategories(owner)))
  };
  owner.branches.push(newBranch);
  saveOwners(owners);

  return sendOk(res, { branch: newBranch });
});


authed('/api/branch-remove', (payload, res, { userId }) => {
  const { id } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ownerCtx.owner;
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  owner.branches = (owner.branches || []).filter(b => String(b.id) !== String(id));
  saveOwners(owners);

  return sendOk(res);
});

authed('/api/menu-list', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(ctx.owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');
  const stockPool = resolveStockPool(ctx.owner, branchId) || ctx.owner;

  const menuWithStock = (pool.menu || []).map(m => Object.assign({}, m, { outOfStock: menuItemOutOfStock(stockPool, m) }));
  return sendOk(res, { menu: menuWithStock, categories: sortedOwnerCategories(pool), role: ctx.role, branchId, branches: ctx.owner.branches || [] });
});

authed('/api/category-list', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(ctx.owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  return sendOk(res, { categories: sortedOwnerCategories(pool), branchId });
});

authed('/api/category-add', (payload, res, { userId }) => {
  const { name } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Faqat oshxona egasi bo\'limlarni boshqara oladi');
  const owner = ctx.owner;
  if (!ctx.isAdminActing && !ownerCanUseFeature(owner, 'category-manage')) return sendFeatureBlocked(res, 'category-manage');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  const nameTrim = String(name || '').trim();
  if (!nameTrim) return sendFail(res, 'Bo\'lim nomini kiriting.');

  const categories = ensureOwnerCategories(pool);
  const exists = categories.some(c => c.name.toLowerCase() === nameTrim.toLowerCase());
  if (exists) return sendFail(res, 'Bunday bo\'lim allaqachon mavjud.');

  const maxOrder = categories.reduce((max, c) => Math.max(max, c.order), -1);
  const category = { id: crypto.randomBytes(4).toString('hex'), name: nameTrim, order: maxOrder + 1 };
  categories.push(category);
  saveOwners(owners);

  return sendOk(res, { category, categories: sortedOwnerCategories(pool) });
});

authed('/api/category-remove', (payload, res, { userId }) => {
  const { id } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ctx.owner;
  if (!ctx.isAdminActing && !ownerCanUseFeature(owner, 'category-manage')) return sendFeatureBlocked(res, 'category-manage');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  ensureOwnerCategories(pool);
  pool.categories = pool.categories.filter(c => c.id !== id);

  pool.categories.sort((a, b) => a.order - b.order).forEach((c, i) => { c.order = i; });
  saveOwners(owners);

  return sendOk(res, { categories: sortedOwnerCategories(pool) });
});

authed('/api/category-reorder', (payload, res, { userId }) => {
  const { orderedIds } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ctx.owner;
  if (!ctx.isAdminActing && !ownerCanUseFeature(owner, 'category-manage')) return sendFeatureBlocked(res, 'category-manage');
  if (!Array.isArray(orderedIds)) return sendFail(res, 'Tartib ro\'yxati noto\'g\'ri.');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  const categories = ensureOwnerCategories(pool);
  const byId = new Map(categories.map(c => [c.id, c]));
  let nextOrder = 0;
  orderedIds.forEach(id => {
    const c = byId.get(String(id));
    if (c) { c.order = nextOrder++; byId.delete(String(id)); }
  });

  categories.slice().sort((a, b) => a.order - b.order)
    .filter(c => byId.has(c.id))
    .forEach(c => { c.order = nextOrder++; });

  saveOwners(owners);
  return sendOk(res, { categories: sortedOwnerCategories(pool) });
});

authed('/api/menu-add', (payload, res, { userId }) => {
  const { name, price, prices, category, description, imageUrl, directStockId } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Faqat oshxona egasi menyuni boshqara oladi');
  const owner = ctx.owner;
  if (!ctx.isAdminActing && !ownerCanUseFeature(owner, 'menu-manage')) return sendFeatureBlocked(res, 'menu-manage');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');
  const stockPool = resolveStockPool(owner, branchId);

  const nameTrim = String(name || '').trim();
  if (!nameTrim) return sendFail(res, 'Taom nomini kiriting.');

  const pricesResult = normalizeMenuItemPrices(prices);
  if (!pricesResult.ok) return sendFail(res, pricesResult.reason);

  let priceNum;
  if (pricesResult.list.length) {
    priceNum = Math.min(...pricesResult.list.map(p => p.price));
  } else {
    priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return sendFail(res, 'Narxni to\'g\'ri kiriting.');
  }
  const imageTrim = String(imageUrl || '').trim();
  if (!isValidImageValue(imageTrim)) {
    return sendFail(res, 'Rasm noto\'g\'ri formatda yoki hajmi katta (rasmni kichikroq tanlang).');
  }

  let directStockIdVal = null;
  if (directStockId !== undefined && directStockId !== null && directStockId !== '') {
    const stockItem = findStockItem(stockPool, directStockId);
    if (!stockItem) return sendFail(res, 'Bunday sklad mahsuloti topilmadi.');
    directStockIdVal = directStockId;
  }

  if (!pool.menu) pool.menu = [];
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    name: nameTrim,
    price: priceNum,
    prices: pricesResult.list.length ? pricesResult.list : undefined,
    category: String(category || '').trim() || null,
    description: String(description || '').trim() || null,
    imageUrl: imageTrim || null,
    available: true,
    directStockId: directStockIdVal,
    addedAt: new Date().toISOString()
  };
  pool.menu.push(item);
  saveOwners(owners);

  return sendOk(res, { item });
});

authed('/api/menu-update', (payload, res, { userId }) => {
  const { id, name, price, prices, category, description, imageUrl, available, directStockId } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Faqat oshxona egasi menyuni boshqara oladi');
  const owner = ctx.owner;
  if (!ctx.isAdminActing && !ownerCanUseFeature(owner, 'menu-manage')) return sendFeatureBlocked(res, 'menu-manage');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');
  const stockPool = resolveStockPool(owner, branchId);

  const item = (pool.menu || []).find(m => m.id === id);
  if (!item) return sendFail(res, 'Taom topilmadi.');

  if (name !== undefined) {
    const nameTrim = String(name || '').trim();
    if (!nameTrim) return sendFail(res, 'Taom nomini kiriting.');
    item.name = nameTrim;
  }
  if (prices !== undefined) {
    const pricesResult = normalizeMenuItemPrices(prices);
    if (!pricesResult.ok) return sendFail(res, pricesResult.reason);
    if (pricesResult.list.length) {
      item.prices = pricesResult.list;
      item.price = Math.min(...pricesResult.list.map(p => p.price));
    } else {
      item.prices = undefined;
    }
  }
  if (price !== undefined) {
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return sendFail(res, 'Narxni to\'g\'ri kiriting.');
    if (!Array.isArray(item.prices) || !item.prices.length) item.price = priceNum;
  }
  if (category !== undefined) item.category = String(category || '').trim() || null;
  if (description !== undefined) item.description = String(description || '').trim() || null;
  if (imageUrl !== undefined) {
    const imageTrim = String(imageUrl || '').trim();
    if (!isValidImageValue(imageTrim)) {
      return sendFail(res, 'Rasm noto\'g\'ri formatda yoki hajmi katta (rasmni kichikroq tanlang).');
    }
    item.imageUrl = imageTrim || null;
  }
  if (available !== undefined) item.available = !!available;

  if (directStockId !== undefined) {
    const directTrim = String(directStockId || '').trim();
    if (!directTrim) {
      item.directStockId = null;
    } else {

      if (Array.isArray(item.recipe) && item.recipe.length) {
        return sendFail(res, 'Bu taomda retsept bor — avval retseptni tozalang, keyin turi o\'zgartiring.');
      }
      const stockItem = findStockItem(stockPool, directTrim);
      if (!stockItem) return sendFail(res, 'Bunday sklad mahsuloti topilmadi.');
      item.directStockId = directTrim;
    }
  }
  saveOwners(owners);

  return sendOk(res, { item });
});

authed('/api/menu-remove', (payload, res, { userId }) => {
  const { id } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ctx.owner;
  if (!ctx.isAdminActing && !ownerCanUseFeature(owner, 'menu-manage')) return sendFeatureBlocked(res, 'menu-manage');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  pool.menu = (pool.menu || []).filter(m => m.id !== id);
  saveOwners(owners);

  return sendOk(res);
});

authed('/api/combo-list', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');

  const combos = (ctx.owner.combos || []).map(c => Object.assign({}, c, {
    price: c.priceMode === 'auto' ? comboAutoPrice(ctx.owner, c.itemIds) : c.price,
    outOfStock: comboOutOfStock(ctx.owner, c)
  }));
  return sendOk(res, { combos });
});

authed('/api/combo-add', (payload, res, { userId }) => {
  const { name, itemIds, priceMode, price, category, imageUrl } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi combo boshqara oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'combo-manage')) return sendFeatureBlocked(res, 'combo-manage');

  const nameTrim = String(name || '').trim();
  if (!nameTrim) return sendFail(res, 'Combo nomini kiriting.');

  if (!Array.isArray(itemIds) || itemIds.length < 2) {
    return sendFail(res, 'Combo tarkibida kamida 2 ta taom bo\'lishi kerak.');
  }
  const cleanItemIds = [];
  for (const entry of itemIds) {
    const menuItem = (owner.menu || []).find(m => m.id === entry.menuItemId);
    if (!menuItem) return sendFail(res, 'Tarkibda menyuda mavjud bo\'lmagan taom bor.');
    const qtyNum = Number(entry.qty) || 1;
    if (qtyNum <= 0) return sendFail(res, 'Har bir taom miqdori musbat bo\'lishi kerak.');
    cleanItemIds.push({ menuItemId: entry.menuItemId, qty: qtyNum });
  }

  const priceModeVal = priceMode === 'manual' ? 'manual' : 'auto';
  let priceVal;
  if (priceModeVal === 'manual') {
    priceVal = Number(price);
    if (!Number.isFinite(priceVal) || priceVal <= 0) return sendFail(res, 'Combo narxini to\'g\'ri kiriting.');
  } else {
    priceVal = comboAutoPrice(owner, cleanItemIds);
  }

  const imageTrim = String(imageUrl || '').trim();
  if (!isValidImageValue(imageTrim)) {
    return sendFail(res, 'Rasm noto\'g\'ri formatda yoki hajmi katta (rasmni kichikroq tanlang).');
  }

  if (!owner.combos) owner.combos = [];
  const combo = {
    id: crypto.randomBytes(4).toString('hex'),
    name: nameTrim,
    itemIds: cleanItemIds,
    priceMode: priceModeVal,
    price: priceVal,
    category: String(category || '').trim() || null,
    imageUrl: imageTrim || null,
    available: true,
    addedAt: new Date().toISOString()
  };
  owner.combos.push(combo);
  saveOwners(owners);

  return sendOk(res, { combo });
});

authed('/api/combo-update', (payload, res, { userId }) => {
  const { id, name, itemIds, priceMode, price, category, imageUrl, available } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi combo boshqara oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'combo-manage')) return sendFeatureBlocked(res, 'combo-manage');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const combo = findCombo(owner, id);
  if (!combo) return sendFail(res, 'Combo topilmadi.');

  if (name !== undefined) {
    const nameTrim = String(name || '').trim();
    if (!nameTrim) return sendFail(res, 'Combo nomini kiriting.');
    combo.name = nameTrim;
  }
  if (itemIds !== undefined) {
    if (!Array.isArray(itemIds) || itemIds.length < 2) {
      return sendFail(res, 'Combo tarkibida kamida 2 ta taom bo\'lishi kerak.');
    }
    const cleanItemIds = [];
    for (const entry of itemIds) {
      const menuItem = (owner.menu || []).find(m => m.id === entry.menuItemId);
      if (!menuItem) return sendFail(res, 'Tarkibda menyuda mavjud bo\'lmagan taom bor.');
      const qtyNum = Number(entry.qty) || 1;
      if (qtyNum <= 0) return sendFail(res, 'Har bir taom miqdori musbat bo\'lishi kerak.');
      cleanItemIds.push({ menuItemId: entry.menuItemId, qty: qtyNum });
    }
    combo.itemIds = cleanItemIds;
  }
  if (priceMode !== undefined) combo.priceMode = priceMode === 'manual' ? 'manual' : 'auto';
  if (combo.priceMode === 'manual') {
    if (price !== undefined) {
      const priceVal = Number(price);
      if (!Number.isFinite(priceVal) || priceVal <= 0) return sendFail(res, 'Combo narxini to\'g\'ri kiriting.');
      combo.price = priceVal;
    }
  } else {

    combo.price = comboAutoPrice(owner, combo.itemIds);
  }
  if (category !== undefined) combo.category = String(category || '').trim() || null;
  if (imageUrl !== undefined) {
    const imageTrim = String(imageUrl || '').trim();
    if (!isValidImageValue(imageTrim)) {
      return sendFail(res, 'Rasm noto\'g\'ri formatda yoki hajmi katta (rasmni kichikroq tanlang).');
    }
    combo.imageUrl = imageTrim || null;
  }
  if (available !== undefined) combo.available = !!available;
  saveOwners(owners);

  return sendOk(res, { combo });
});

authed('/api/combo-remove', (payload, res, { userId }) => {
  const { id } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'combo-manage')) return sendFeatureBlocked(res, 'combo-manage');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  owner.combos = (owner.combos || []).filter(c => c.id !== id);
  saveOwners(owners);

  return sendOk(res);
});

// Mijoz Mini App ichida "Siz ham oshxona egasimisiz? Hamkor bo'ling"
// havolasini bossa, shu endpoint bot username'ni qaytaradi — keyin
// frontend Telegram.WebApp.openTelegramLink(`https://t.me/${botUsername}
// ?start=owner_register`) chaqiradi. Owner'ga emas, HAR QANDAY ro'yxatdan
// o'tgan Telegram foydalanuvchisiga ochiq (mijoz bo'lishi kerak, shu
// sababli isOwnerAccessValid tekshiruvi YO'Q — faqat initData haqiqiyligi
// tekshiriladi).
authed('/api/partner-register-link', (payload, res) => {
  if (!BOT_USERNAME || BOT_USERNAME === 'BOT_USERNAME_BU_YERGA') {
    return sendFail(res, 'Serverda BOT_USERNAME sozlanmagan.');
  }
  return sendOk(res, { botUsername: BOT_USERNAME });
});

authed('/api/customer-link', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const owner = ownerCtx.owner;
  if (!BOT_USERNAME || BOT_USERNAME === 'BOT_USERNAME_BU_YERGA') {
    return sendFail(res, 'Serverda BOT_USERNAME sozlanmagan.');
  }
  const link = `https://t.me/${BOT_USERNAME}?start=menu_${owner.id}`;
  return sendOk(res, { link });
});

authed('/api/delivery-group-status', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'delivery-group')) return sendFeatureBlocked(res, 'delivery-group');
  return sendOk(res, {
    bound: !!owner.deliveryGroupId,
    groupTitle: owner.deliveryGroupTitle || null,
    threadBound: !!owner.deliveryGroupThreadId
  });
});

authed('/api/delivery-group-remove', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'delivery-group')) return sendFeatureBlocked(res, 'delivery-group');
  owner.deliveryGroupId = null;
  owner.deliveryGroupTitle = null;
  owner.deliveryGroupThreadId = null;
  saveOwners(owners);
  return sendOk(res);
});

authed('/api/kitchen-group-status', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'kitchen-group')) return sendFeatureBlocked(res, 'kitchen-group');
  return sendOk(res, {
    bound: !!owner.kitchenGroupId,
    groupTitle: owner.kitchenGroupTitle || null,
    threadBound: !!owner.kitchenGroupThreadId
  });
});

authed('/api/kitchen-group-remove', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'kitchen-group')) return sendFeatureBlocked(res, 'kitchen-group');
  owner.kitchenGroupId = null;
  owner.kitchenGroupTitle = null;
  owner.kitchenGroupThreadId = null;
  saveOwners(owners);
  return sendOk(res);
});

authed('/api/promo-list', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const owner = ownerCtx.owner;
  return sendOk(res, { promotions: owner.promotions || [] });
});

authed('/api/promo-add', (payload, res, { userId }) => {
  const { title, description, discountPercent, minTotal } = payload;
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi qo\'sha oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'promo-manage')) return sendFeatureBlocked(res, 'promo-manage');

  const titleTrim = String(title || '').trim();
  const percentNum = Number(discountPercent);
  if (!titleTrim) return sendFail(res, 'Aksiya nomini kiriting.');
  if (!Number.isFinite(percentNum) || percentNum <= 0 || percentNum > 90) {
    return sendFail(res, 'Chegirma foizi 1-90 oralig\'ida bo\'lishi kerak.');
  }
  let minTotalNum = null;
  if (minTotal !== undefined && minTotal !== null && minTotal !== '') {
    const n = Number(minTotal);
    if (!Number.isFinite(n) || n < 0) return sendFail(res, 'Minimal summa noto\'g\'ri.');
    minTotalNum = n;
  }

  if (!owner.promotions) owner.promotions = [];
  const promo = {
    id: crypto.randomBytes(4).toString('hex'),
    title: titleTrim,
    description: String(description || '').trim() || null,
    discountPercent: percentNum,
    minTotal: minTotalNum,
    active: true,
    createdAt: new Date().toISOString()
  };
  owner.promotions.push(promo);
  saveOwners(owners);
  return sendOk(res, { promo });
});

authed('/api/promo-toggle', (payload, res, { userId }) => {
  const { id } = payload;
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ownerCtx.owner;

  const promo = (owner.promotions || []).find(p => p.id === id);
  if (!promo) return sendFail(res, 'Aksiya topilmadi.');
  promo.active = !promo.active;
  saveOwners(owners);
  return sendOk(res, { promo });
});

authed('/api/promo-remove', (payload, res, { userId }) => {
  const { id } = payload;
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ownerCtx.owner;
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  owner.promotions = (owner.promotions || []).filter(p => p.id !== id);
  saveOwners(owners);
  return sendOk(res);
});

function isBannerWithinWindow(banner) {
  const now = Date.now();
  if (banner.startAt && new Date(banner.startAt).getTime() > now) return false;
  if (banner.endAt && new Date(banner.endAt).getTime() < now) return false;
  // Banner faqat haftaning muayyan kunida (masalan har juma) ko'rinishi
  // uchun bog'langan bo'lsa — bugun (Toshkent vaqti) o'sha kun bo'lmasa,
  // ko'rsatilmaydi. Owner buni bir marta sozlaydi, keyin har hafta
  // avtomatik o'zi chiqib-yashirinib turadi.
  if (banner.weeklyDay !== null && banner.weeklyDay !== undefined) {
    if (kitchenTashkentDate().getUTCDay() !== banner.weeklyDay) return false;
  }
  return true;
}

function activeOwnerBanners(owner) {
  const regular = (owner.banners || [])
    .filter(b => b.active !== false && isBannerWithinWindow(b))
    .map(b => ({ id: b.id, imageUrl: b.imageUrl, title: b.title, link: b.link }));

  // Juma banneri — bu oddiy bannerlar ro'yxatidan butunlay alohida
  // saqlanadi (owner.fridayBanner). Faqat bugun (Toshkent vaqti bo'yicha)
  // juma bo'lsa va o'chirib qo'yilmagan bo'lsa, mijozlar ekraniga
  // qo'shilib chiqadi — boshqa bannerlarni boshqarishga hech qanday
  // ta'sir qilmaydi.
  const fb = owner.fridayBanner;
  if (fb && fb.imageUrl && fb.active !== false && isTashkentFridayNow()) {
    regular.unshift({ id: 'friday-banner', imageUrl: fb.imageUrl, title: fb.title, link: fb.link });
  }
  return regular;
}

authed('/api/banner-list', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const owner = ownerCtx.owner;
  return sendOk(res, { banners: owner.banners || [] });
});

authed('/api/banner-add', (payload, res, { userId }) => {
  const { imageUrl, title, link, startAt, endAt, weeklyDay } = payload;
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi qo\'sha oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'banner-manage')) return sendFeatureBlocked(res, 'banner-manage');

  const imageTrim = String(imageUrl || '').trim();
  if (!imageTrim) return sendFail(res, 'Banner uchun rasm tanlang.');
  if (!isValidImageValue(imageTrim)) {
    return sendFail(res, 'Rasm noto\'g\'ri formatda yoki hajmi katta (rasmni kichikroq tanlang).');
  }
  const linkTrim = String(link || '').trim();
  if (linkTrim && !/^https?:\/\//i.test(linkTrim)) {
    return sendFail(res, 'Havola http:// yoki https:// bilan boshlanishi kerak.');
  }
  let startAtVal = null;
  if (startAt) {
    const d = new Date(startAt);
    if (isNaN(d.getTime())) return sendFail(res, 'Boshlanish sanasi noto\'g\'ri.');
    startAtVal = d.toISOString();
  }
  let endAtVal = null;
  if (endAt) {
    const d = new Date(endAt);
    if (isNaN(d.getTime())) return sendFail(res, 'Tugash sanasi noto\'g\'ri.');
    endAtVal = d.toISOString();
  }
  if (startAtVal && endAtVal && new Date(endAtVal).getTime() <= new Date(startAtVal).getTime()) {
    return sendFail(res, 'Tugash sanasi boshlanish sanasidan keyin bo\'lishi kerak.');
  }
  let weeklyDayVal = null;
  if (weeklyDay !== undefined && weeklyDay !== null && weeklyDay !== '') {
    const n = parseInt(weeklyDay, 10);
    if (!Number.isInteger(n) || n < 0 || n > 6) return sendFail(res, 'Hafta kuni noto\'g\'ri.');
    weeklyDayVal = n;
  }

  if (!owner.banners) owner.banners = [];
  const banner = {
    id: crypto.randomBytes(4).toString('hex'),
    imageUrl: imageTrim,
    title: String(title || '').trim() || null,
    link: linkTrim || null,
    active: true,
    startAt: startAtVal,
    endAt: endAtVal,
    weeklyDay: weeklyDayVal,
    createdAt: new Date().toISOString()
  };
  owner.banners.unshift(banner);
  saveOwners(owners);
  return sendOk(res, { banner });
});


authed('/api/banner-toggle', (payload, res, { userId }) => {
  const { id } = payload;
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ownerCtx.owner;

  const banner = (owner.banners || []).find(b => b.id === id);
  if (!banner) return sendFail(res, 'Banner topilmadi.');
  banner.active = !banner.active;
  saveOwners(owners);
  return sendOk(res, { banner });
});

authed('/api/banner-remove', (payload, res, { userId }) => {
  const { id } = payload;
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ownerCtx.owner;
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  owner.banners = (owner.banners || []).filter(b => b.id !== id);
  saveOwners(owners);
  return sendOk(res);
});

// === Juma banneri (Friday banner) ===
// Bu bo'lim yuqoridagi oddiy "Reklama bannerlari" (owner.banners) bilan
// umuman bog'liq emas — alohida maydonda (owner.fridayBanner, bitta
// obyekt) saqlanadi. Shu sababli bu yerdagi qo'shish/o'chirish/yoqish
// amallari boshqa bannerlarga hech qanday tarzda aralashmaydi. Faqat
// haftaning juma kuni avtomatik ko'rinadi (qarang: activeOwnerBanners).

authed('/api/friday-banner-get', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const owner = ownerCtx.owner;
  return sendOk(res, { banner: owner.fridayBanner || null });
});

authed('/api/friday-banner-save', (payload, res, { userId }) => {
  const { imageUrl, title, link } = payload;
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi qo\'sha oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'banner-manage')) return sendFeatureBlocked(res, 'banner-manage');

  const imageTrim = String(imageUrl || '').trim();
  if (!imageTrim) return sendFail(res, 'Banner uchun rasm tanlang.');
  if (!isValidImageValue(imageTrim)) {
    return sendFail(res, 'Rasm noto\'g\'ri formatda yoki hajmi katta (rasmni kichikroq tanlang).');
  }
  const linkTrim = String(link || '').trim();
  if (linkTrim && !/^https?:\/\//i.test(linkTrim)) {
    return sendFail(res, 'Havola http:// yoki https:// bilan boshlanishi kerak.');
  }
  const prevActive = owner.fridayBanner ? owner.fridayBanner.active !== false : true;
  owner.fridayBanner = {
    imageUrl: imageTrim,
    title: String(title || '').trim() || null,
    link: linkTrim || null,
    active: prevActive,
    updatedAt: new Date().toISOString()
  };
  saveOwners(owners);
  return sendOk(res, { banner: owner.fridayBanner });
});

authed('/api/friday-banner-toggle', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const owner = ownerCtx.owner;
  if (!owner.fridayBanner) return sendFail(res, 'Juma banneri topilmagan.');
  owner.fridayBanner.active = owner.fridayBanner.active === false ? true : false;
  saveOwners(owners);
  return sendOk(res, { banner: owner.fridayBanner });
});

authed('/api/friday-banner-remove', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ownerCtx.owner;
  owner.fridayBanner = null;
  saveOwners(owners);
  return sendOk(res);
});

authed('/api/bonus-settings-get', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'bonus-settings')) return sendFeatureBlocked(res, 'bonus-settings');
  return sendOk(res, { settings: owner.bonusSettings || { enabled: false, earnPercent: 5 } });
});

authed('/api/bonus-settings-save', (payload, res, { userId }) => {
  const { enabled, earnPercent } = payload;
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi saqlay oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'bonus-settings')) return sendFeatureBlocked(res, 'bonus-settings');

  const percentNum = Number(earnPercent);
  if (!Number.isFinite(percentNum) || percentNum < 0 || percentNum > 50) {
    return sendFail(res, 'Bonus foizi 0-50 oralig\'ida bo\'lishi kerak.');
  }
  owner.bonusSettings = { enabled: !!enabled, earnPercent: percentNum };
  saveOwners(owners);
  return sendOk(res, { settings: owner.bonusSettings });
});

route('/api/restaurant-brand', (payload, res) => {
  const { ownerId } = payload;
  if (!ownerId) return sendJSON(res, 200, { ok: false });
  const owner = findOwner(loadOwners(), ownerId);
  if (!owner) return sendJSON(res, 200, { ok: false });
  return sendOk(res, {
    name: (owner.profile && owner.profile.name) || 'Oshxona',
    logoUrl: (owner.profile && owner.profile.logoUrl) || null,
    brandColor: (owner.profile && owner.profile.brandColor) || null
  });
});

authed('/api/customer-restaurants-list', (payload, res) => {
  const owners = pruneExpiredOwners();
  const restaurants = owners
    .filter(o => isOwnerAccessValid(o) && o.profile && o.profile.completedAt)
    .map(o => {
      const rating = ownerAverageRating(o);
      return {
        id: o.id,
        name: o.profile.name,
        address: o.profile.address,
        logoUrl: o.profile.logoUrl || null,
        brandColor: o.profile.brandColor || null,
        avgRating: rating.avg,
        ratingCount: rating.count
      };
    });

  return sendOk(res, { restaurants });
});

authed('/api/customer-verify', (payload, res, { user }) => {
  const { ownerId } = payload;
  if (!ownerId) return sendFail(res, 'Oshxona aniqlanmadi.');

  const userId = String(user.id);
  const owners = pruneExpiredOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner || !isOwnerAccessValid(owner)) {
    return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  }

  const customer = findOrCreateCustomer(owner, userId, user);
  saveOwners(owners);

  return sendOk(res, {
    restaurant: {
      id: owner.id,
      name: (owner.profile && owner.profile.name) || 'Oshxona',
      address: (owner.profile && owner.profile.address) || null,
      phone: (owner.profile && owner.profile.phone) || null,
      workHours: (owner.profile && owner.profile.workHours) || null,
      logoUrl: (owner.profile && owner.profile.logoUrl) || null,
      brandColor: (owner.profile && owner.profile.brandColor) || null,
      paymentCard: owner.customerPaymentCard || { cardNumber: '', cardHolder: '' },
      // 3-bosqich: mijoz qaysi filialdan buyurtma berishini tanlashi uchun —
      // filiallar ro'yxati (faqat mijozga kerakli maydonlar bilan).
      centralBranchName: owner.centralBranchName || null,
      branches: (owner.branches || []).map(b => ({ id: b.id, name: b.name, address: b.address || null }))
    },
    customer: { favorites: customer.favorites, addresses: customer.addresses || [], bonusPoints: customer.bonusPoints, cardOnlyRestricted: customerIsCardOnlyRestricted(owner, userId) },
    personRegistered: isRegisteredUser(userId),
    bonusEnabled: !!(owner.bonusSettings && owner.bonusSettings.enabled)
  });
});

route('/api/kitchen-status', (payload, res) => {
  const { initData, ownerId } = payload || {};
  const owner = ownerId ? findOwner(loadOwners(), ownerId) : null;
  const hours = getOwnerWorkHours(owner);
  const open = isKitchenOpenNow(hours);
  let alreadyReminded = false;
  if (initData && ownerId) {
    const check = verifyAuth(initData);
    if (check.ok) {
      const userId = String(check.user.id);
      const reminders = loadKitchenReminders();
      alreadyReminded = reminders.some(r => String(r.userId) === userId && String(r.ownerId) === String(ownerId));
    }
  }
  return sendOk(res, {
    open,
    opensAt: open ? null : nextKitchenOpenAt(hours).toISOString(),
    openHour: hours.openHour,
    openMinute: hours.openMinute || 0,
    closeHour: hours.closeHour,
    closeMinute: hours.closeMinute || 0,
    alreadyReminded
  });
});

route('/api/kitchen-remind', (payload, res) => {
  const { initData, ownerId } = payload || {};
  const check = verifyAuth(initData);
  if (!check.ok) return sendFail(res, check.reason);
  if (!ownerId) return sendFail(res, 'Oshxona aniqlanmadi.');
  const owner = findOwner(loadOwners(), ownerId);
  if (isKitchenOpenNow(getOwnerWorkHours(owner))) return sendFail(res, 'Oshxona hozir ochiq.');

  const userId = String(check.user.id);
  const reminders = loadKitchenReminders();
  const exists = reminders.some(r => String(r.userId) === userId && String(r.ownerId) === String(ownerId));
  if (!exists) {
    reminders.push({
      id: crypto.randomBytes(4).toString('hex'),
      userId,
      ownerId: String(ownerId),
      createdAt: new Date().toISOString()
    });
    saveKitchenReminders(reminders);
  }
  return sendOk(res);
});

authed('/api/customer-menu-list', (payload, res, { user }) => {
  const { ownerId, branchId } = payload;
  const owners = pruneExpiredOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner || !isOwnerAccessValid(owner)) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'customer-menu')) return sendFeatureBlocked(res, 'customer-menu');

  // 3-bosqich: mijoz tanlagan filial mustaqil menyusini (va o'sha
  // filialning skladiga bog'liq "tugadi" holatini) ko'rsatadi. branchId
  // yuborilmasa (yoki filiallar umuman yo'q bo'lsa) — markaziy menyu.
  const menuPool = resolveMenuPool(owner, branchId);
  if (branchId && !menuPool) return sendFail(res, 'Bunday filial topilmadi.');
  const stockPool = resolveStockPool(owner, branchId) || owner;

  const menu = (menuPool.menu || []).filter(m => m.available !== false)
    .map(m => Object.assign({}, m, { outOfStock: menuItemOutOfStock(stockPool, m) }));

  const combos = (owner.combos || []).filter(c => c.available !== false).map(c => Object.assign({}, c, {
    price: c.priceMode === 'auto' ? comboAutoPrice(owner, c.itemIds) : c.price,
    outOfStock: comboOutOfStock(owner, c)
  }));
  const promotions = (owner.promotions || []).filter(p => p.active);

  const banners = activeOwnerBanners(owner);
  const recommendations = ownerCanUseFeature(owner, 'ai-waiter')
    ? buildAiWaiterRecommendations(owner, String(user.id), menu)
    : { favorites: [], similar: [] };
  return sendOk(res, { menu, combos, promotions, banners, categories: sortedOwnerCategories(menuPool), recommendations, branchId: branchId || null });
});

authed('/api/customer-favorite-toggle', (payload, res, { user }) => {
  const { ownerId, itemId } = payload;
  if (!itemId) return sendFail(res, 'Taom ko\'rsatilmagan.');

  const userId = String(user.id);
  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner || !isOwnerAccessValid(owner)) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'ai-waiter')) return sendFeatureBlocked(res, 'ai-waiter');

  const customer = findOrCreateCustomer(owner, userId, user);
  const idx = customer.favorites.indexOf(itemId);
  if (idx >= 0) customer.favorites.splice(idx, 1);
  else customer.favorites.push(itemId);
  saveOwners(owners);

  return sendOk(res, { favorites: customer.favorites });
});

authed('/api/customer-address-list', (payload, res, { user, userId }) => {
  const { ownerId } = payload;

  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner || !isOwnerAccessValid(owner)) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'customer-account')) return sendFeatureBlocked(res, 'customer-account');

  const customer = findOrCreateCustomer(owner, userId, user);
  return sendOk(res, { addresses: customer.addresses || [] });
});

authed('/api/customer-address-save', (payload, res, { user, userId }) => {
  const { ownerId, addressId, label, addressNote, location, extraPhone } = payload;

  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner || !isOwnerAccessValid(owner)) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'customer-account')) return sendFeatureBlocked(res, 'customer-account');

  const labelTrim = String(label || '').trim().slice(0, 40);
  if (!labelTrim) return sendFail(res, 'Manzil nomini kiriting (masalan: Uy, Ish).');

  let loc = null;
  if (location && typeof location.lat === 'number' && typeof location.lng === 'number' &&
      Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180) {
    loc = { lat: location.lat, lng: location.lng };
  }
  const addressNoteTrim = String(addressNote || '').trim().slice(0, 300);
  if (!loc && !addressNoteTrim) {
    return sendFail(res, 'Joylashuvni aniqlang yoki manzilni yozib qoldiring.');
  }
  const extraPhoneTrim = String(extraPhone || '').trim().slice(0, 30);
  if (extraPhoneTrim && !isPlausiblePhone(extraPhoneTrim)) {
    return sendFail(res, 'Telefon raqamini O\'zbekiston formatida kiriting (masalan: +998901234567).');
  }

  const customer = findOrCreateCustomer(owner, userId, user);
  if (!Array.isArray(customer.addresses)) customer.addresses = [];

  let addr = addressId ? findCustomerAddress(customer, addressId) : null;
  if (addr) {
    addr.label = labelTrim;
    addr.addressNote = addressNoteTrim;
    addr.location = loc;
    addr.extraPhone = extraPhoneTrim;
    addr.updatedAt = new Date().toISOString();
  } else {
    if (customer.addresses.length >= MAX_CUSTOMER_ADDRESSES) {
      return sendFail(res, `Ko'pi bilan ${MAX_CUSTOMER_ADDRESSES} ta manzil saqlash mumkin.`);
    }
    addr = {
      id: crypto.randomBytes(4).toString('hex'),
      label: labelTrim,
      addressNote: addressNoteTrim,
      location: loc,
      extraPhone: extraPhoneTrim,
      createdAt: new Date().toISOString()
    };
    customer.addresses.push(addr);
  }
  saveOwners(owners);
  return sendOk(res, { addresses: customer.addresses });
});

authed('/api/customer-address-remove', (payload, res, { user }) => {
  const { ownerId, addressId } = payload;
  if (!addressId) return sendFail(res, 'Manzil ko\'rsatilmagan.');

  const userId = String(user.id);
  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner || !isOwnerAccessValid(owner)) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'customer-account')) return sendFeatureBlocked(res, 'customer-account');

  const customer = findOrCreateCustomer(owner, userId, user);
  const idx = (customer.addresses || []).findIndex(a => a.id === addressId);
  if (idx < 0) return sendFail(res, 'Manzil topilmadi.');
  customer.addresses.splice(idx, 1);
  saveOwners(owners);
  return sendOk(res, { addresses: customer.addresses });
});

authed('/api/customer-orders-history', (payload, res, { userId }) => {
  const { ownerId } = payload;

  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'customer-account')) return sendFeatureBlocked(res, 'customer-account');

  const orders = (owner.orders || [])
    .filter(o => String(o.customerId) === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);

  return sendOk(res, { orders });
});

authed('/api/customer-confirm-received', (payload, res, { userId }) => {
  const { ownerId, orderId } = payload;

  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'customer-account')) return sendFeatureBlocked(res, 'customer-account');

  const order = (owner.orders || []).find(o => o.id === orderId);
  if (!order) return sendFail(res, 'Buyurtma topilmadi.');
  if (String(order.customerId) !== userId) return sendFail(res, 'Bu sizning buyurtmangiz emas.');
  if (order.orderType === 'dostavka') return sendFail(res, 'Dostavka buyurtmalarini kuryer belgilaydi.');
  if (order.status !== 'tayyor') return sendFail(res, 'Buyurtma hali tayyor emas.');
  if (order.customerReceivedAt) return sendFail(res, 'Bu buyurtma allaqachon olingan deb belgilangan.');

  order.customerReceivedAt = new Date().toISOString();
  saveOwners(owners);

  return sendOk(res, { order });
});

authed('/api/customer-notifications', (payload, res, { userId }) => {
  const { ownerId } = payload;

  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'customer-account')) return sendFeatureBlocked(res, 'customer-account');

  const myOrders = (owner.orders || [])
    .filter(o => String(o.customerId) === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30);

  const notifications = [];
  myOrders.forEach(o => {
    const items = o.items || [];
    const itemsText = items.slice(0, 3).map(it => it.name).join(', ') + (items.length > 3 ? ' va yana...' : '');

    notifications.push({
      id: `${o.id}-created`, type: 'order', icon: 'clipboard',
      title: 'Buyurtma qabul qilindi',
      text: `${itemsText} — ${fmtNum(o.total)} so'm`,
      time: o.createdAt
    });

    if (o.status === 'tayyorlanmoqda' || (o.status === 'tayyor' && o.startedAt)) {
      notifications.push({
        id: `${o.id}-progress`, type: 'order', icon: 'chef-hat',
        title: 'Buyurtmangiz tayyorlanmoqda',
        text: itemsText,
        time: o.startedAt || o.updatedAt || o.createdAt
      });
    }

    if (o.status === 'tayyor') {
      notifications.push({
        id: `${o.id}-ready`, type: 'order', icon: 'check-circle',
        title: o.orderType === 'dostavka' ? 'Buyurtmangiz tayyor — kuryerga topshirilmoqda' : 'Buyurtmangiz tayyor!',
        text: itemsText,
        time: o.readyAt || o.updatedAt || o.createdAt
      });
    }

    if (o.deliveredAt) {
      notifications.push({
        id: `${o.id}-delivered`, type: 'order', icon: 'check-circle',
        title: 'Buyurtmangiz yetkazib berildi',
        text: itemsText,
        time: o.deliveredAt
      });
    }

    if (o.status === 'bekor_qilindi' && o.cancelledAt) {
      notifications.push({
        id: `${o.id}-cancelled`, type: 'order', icon: 'x-circle',
        title: 'Dostavka bekor qilindi',
        text: o.cancelReason || 'Kechirasiz, buyurtmangizni yetkazib bera olmadik.',
        time: o.cancelledAt
      });
    }

    if (o.paymentProofApprovedAt) {
      notifications.push({
        id: `${o.id}-payok`, type: 'order', icon: 'card',
        title: 'To\'lovingiz tasdiqlandi',
        text: itemsText,
        time: o.paymentProofApprovedAt
      });
    }

    if (o.paymentProofRejectedAt) {
      notifications.push({
        id: `${o.id}-payrej`, type: 'order', icon: 'x-circle',
        title: 'To\'lov tasdiqlanmadi',
        text: 'Iltimos, to\'g\'ri chekni qayta yuboring yoki oshxona bilan bog\'laning.',
        time: o.paymentProofRejectedAt
      });
    }
  });

  (owner.promotions || []).filter(p => p.active).forEach(p => {
    notifications.push({
      id: `promo-${p.id}`, type: 'promo', icon: 'star',
      title: `Yangi aksiya: ${p.title}`,
      text: `${p.discountPercent}% chegirma${p.minTotal ? ` (${fmtNum(p.minTotal)} so'mdan buyurtmalarga)` : ''}`,
      time: p.createdAt
    });
  });

  notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
  return sendOk(res, { notifications: notifications.slice(0, 50) });
});

function supportThreadMessages(owner, customerId) {
  return (owner.supportMessages || [])
    .filter(m => String(m.customerId) === String(customerId))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

authed('/api/support-send', async (payload, res, { user, userId }) => {
  const { ownerId, text } = payload;

  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner || !isOwnerAccessValid(owner)) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'support-chat')) return sendFeatureBlocked(res, 'support-chat');

  const textTrim = String(text || '').trim().slice(0, 1000);
  if (!textTrim) return sendFail(res, 'Xabar matni bo\'sh bo\'lmasligi kerak.');

  if (!Array.isArray(owner.supportMessages)) owner.supportMessages = [];
  const customer = findOrCreateCustomer(owner, userId, user);
  const msg = {
    id: crypto.randomBytes(4).toString('hex'),
    customerId: userId,
    from: 'customer',
    text: textTrim,
    at: new Date().toISOString(),
    readByCustomer: true,
    readByStaff: false
  };
  owner.supportMessages.push(msg);
  saveOwners(owners);

  const staffTargets = [owner.id, ...((owner.staff || []).filter(s => staffHasRole(s, 'egasi') || staffHasRole(s, 'kassir')).map(s => s.id))];
  const profile = findProfile(userId);
  const alertText = `🆘 <b>Yordam so'rovi</b>\n${orderCustomerContactLabel({ customerName: customerDisplayName(userId, user), customerPhone: (profile && profile.phone) || null })}\n\n${escapeHtmlServer(textTrim)}`;
  for (const targetId of new Set(staffTargets.map(String))) {
    sendMessage(targetId, alertText);
  }

  return sendOk(res, { messages: supportThreadMessages(owner, userId) });
});

authed('/api/support-thread', (payload, res, { userId }) => {
  const { ownerId } = payload;

  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'support-chat')) return sendFeatureBlocked(res, 'support-chat');

  let changed = false;
  (owner.supportMessages || []).forEach(m => {
    if (String(m.customerId) === userId && m.from === 'staff' && !m.readByCustomer) {
      m.readByCustomer = true;
      changed = true;
    }
  });
  if (changed) saveOwners(owners);

  return sendOk(res, { messages: supportThreadMessages(owner, userId) });
});

authed('/api/support-inbox', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx || !ctxHasAnyRole(ctx, ['egasi', 'kassir'])) {
    return sendFail(res, 'Bu bo\'limga faqat egasi/kassir kira oladi');
  }
  if (!ownerCanUseFeature(ctx.owner, 'support-chat')) return sendFeatureBlocked(res, 'support-chat');

  const byCustomer = new Map();
  for (const m of (ctx.owner.supportMessages || [])) {
    const list = byCustomer.get(m.customerId) || [];
    list.push(m);
    byCustomer.set(m.customerId, list);
  }
  const threads = [];
  for (const [customerId, msgs] of byCustomer.entries()) {
    msgs.sort((a, b) => new Date(a.at) - new Date(b.at));
    const last = msgs[msgs.length - 1];
    const customer = findCustomer(ctx.owner, customerId);
    threads.push({
      customerId,
      customerName: (customer && customer.firstName) || `ID: ${customerId}`,
      lastText: last.text,
      lastAt: last.at,
      lastFrom: last.from,
      unreadCount: msgs.filter(m => m.from === 'customer' && !m.readByStaff).length
    });
  }
  threads.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  return sendOk(res, { threads });
});

authed('/api/support-thread-staff', (payload, res, { userId }) => {
  const { customerId } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx || !ctxHasAnyRole(ctx, ['egasi', 'kassir'])) {
    return sendFail(res, 'Bu bo\'limga faqat egasi/kassir kira oladi');
  }
  if (!ownerCanUseFeature(ctx.owner, 'support-chat')) return sendFeatureBlocked(res, 'support-chat');
  if (!customerId) return sendFail(res, 'Mijoz tanlanmagan.');

  let changed = false;
  (ctx.owner.supportMessages || []).forEach(m => {
    if (String(m.customerId) === String(customerId) && m.from === 'customer' && !m.readByStaff) {
      m.readByStaff = true;
      changed = true;
    }
  });
  if (changed) saveOwners(owners);

  return sendOk(res, { messages: supportThreadMessages(ctx.owner, customerId) });
});

authed('/api/support-reply', async (payload, res, { userId }) => {
  const { customerId, text } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx || !ctxHasAnyRole(ctx, ['egasi', 'kassir'])) {
    return sendFail(res, 'Bu bo\'limga faqat egasi/kassir kira oladi');
  }
  if (!ownerCanUseFeature(ctx.owner, 'support-chat')) return sendFeatureBlocked(res, 'support-chat');
  if (!customerId) return sendFail(res, 'Mijoz tanlanmagan.');

  const textTrim = String(text || '').trim().slice(0, 1000);
  if (!textTrim) return sendFail(res, 'Xabar matni bo\'sh bo\'lmasligi kerak.');

  if (!Array.isArray(ctx.owner.supportMessages)) ctx.owner.supportMessages = [];
  const msg = {
    id: crypto.randomBytes(4).toString('hex'),
    customerId: String(customerId),
    from: 'staff',
    text: textTrim,
    at: new Date().toISOString(),
    readByCustomer: false,
    readByStaff: true
  };
  ctx.owner.supportMessages.push(msg);
  saveOwners(owners);

  await sendMessage(customerId, `💬 <b>Oshxonadan javob</b>\n${escapeHtmlServer(textTrim)}`);

  return sendOk(res, { messages: supportThreadMessages(ctx.owner, customerId) });
});

function adminSupportThreadMessages(ownerId) {
  return loadAdminSupportMessages()
    .filter(m => String(m.ownerId) === String(ownerId))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

authed('/api/owner-admin-support-send', async (payload, res, { userId }) => {
  const { text } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return sendFail(res, 'Faqat oshxona egasi adminga yoza oladi.');
  const owner = ownerCtx.owner;

  const textTrim = String(text || '').trim().slice(0, 1000);
  if (!textTrim) return sendFail(res, 'Xabar matni bo\'sh bo\'lmasligi kerak.');

  const msgs = loadAdminSupportMessages();
  msgs.push({
    id: crypto.randomBytes(4).toString('hex'),
    ownerId: owner.id,
    from: 'owner',
    text: textTrim,
    at: new Date().toISOString(),
    readByOwner: true,
    readByAdmin: false
  });
  saveAdminSupportMessages(msgs);

  const alertText = `🆘 <b>Egadan xabar</b>\nOshxona: <b>${escapeHtmlServer((owner.profile && owner.profile.name) || owner.id)}</b> (ID: <code>${owner.id}</code>)\n\n${escapeHtmlServer(textTrim)}`;
  for (const adminId of allAdminIds()) {
    sendMessage(adminId, alertText);
  }

  return sendOk(res, { messages: adminSupportThreadMessages(owner.id) });
});

authed('/api/owner-admin-support-thread', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return sendFail(res, 'Faqat oshxona egasi ko\'ra oladi.');
  const owner = ownerCtx.owner;

  const msgs = loadAdminSupportMessages();
  let changed = false;
  msgs.forEach(m => {
    if (String(m.ownerId) === owner.id && m.from === 'admin' && !m.readByOwner) {
      m.readByOwner = true;
      changed = true;
    }
  });
  if (changed) saveAdminSupportMessages(msgs);

  return sendOk(res, { messages: adminSupportThreadMessages(owner.id) });
});

authed('/api/admin-support-inbox', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  const owners = loadOwners();
  const msgs = loadAdminSupportMessages();
  const byOwner = new Map();
  for (const m of msgs) {
    const list = byOwner.get(m.ownerId) || [];
    list.push(m);
    byOwner.set(m.ownerId, list);
  }
  const threads = [];
  for (const [ownerId, list] of byOwner.entries()) {
    list.sort((a, b) => new Date(a.at) - new Date(b.at));
    const last = list[list.length - 1];
    const owner = findOwner(owners, ownerId);
    threads.push({
      ownerId,
      ownerName: (owner && owner.profile && owner.profile.name) || `ID: ${ownerId}`,
      lastText: last.text,
      lastAt: last.at,
      lastFrom: last.from,
      unreadCount: list.filter(m => m.from === 'owner' && !m.readByAdmin).length
    });
  }
  threads.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  return sendOk(res, { threads });
});

authed('/api/admin-support-thread', (payload, res, { userId }) => {
  const { ownerId } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');
  if (!ownerId) return sendFail(res, 'Oshxona tanlanmagan.');

  const msgs = loadAdminSupportMessages();
  let changed = false;
  msgs.forEach(m => {
    if (String(m.ownerId) === String(ownerId) && m.from === 'owner' && !m.readByAdmin) {
      m.readByAdmin = true;
      changed = true;
    }
  });
  if (changed) saveAdminSupportMessages(msgs);

  return sendOk(res, { messages: adminSupportThreadMessages(ownerId) });
});

authed('/api/admin-support-reply', async (payload, res, { userId }) => {
  const { ownerId, text } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin javob bera oladi');
  if (!ownerId) return sendFail(res, 'Oshxona tanlanmagan.');

  const textTrim = String(text || '').trim().slice(0, 1000);
  if (!textTrim) return sendFail(res, 'Xabar matni bo\'sh bo\'lmasligi kerak.');

  const msgs = loadAdminSupportMessages();
  msgs.push({
    id: crypto.randomBytes(4).toString('hex'),
    ownerId: String(ownerId),
    from: 'admin',
    text: textTrim,
    at: new Date().toISOString(),
    readByOwner: false,
    readByAdmin: true
  });
  saveAdminSupportMessages(msgs);

  await sendMessage(ownerId, `💬 <b>Admindan xabar</b>\n${escapeHtmlServer(textTrim)}`);

  return sendOk(res, { messages: adminSupportThreadMessages(ownerId) });
});

authed('/api/customer-order', async (payload, res, { user, userId }) => {
  const { ownerId, items, orderType, paymentType, promoId, usePoints, location, addressNote, extraPhone, comment, requestId, branchId } = payload;

  const owners = loadOwners();
  const owner = findOwner(owners, ownerId);
  if (!owner || !isOwnerAccessValid(owner)) return sendFail(res, 'Bu oshxona hozircha mavjud emas.');
  if (!ownerCanUseFeature(owner, 'customer-menu')) return sendFeatureBlocked(res, 'customer-menu');

  // 3-bosqich: mijoz tanlagan filialning mustaqil menyusi/skladi asosida
  // buyurtma tekshiriladi va shakllantiriladi (branchId bo'lmasa — markaziy).
  const menuPool = resolveMenuPool(owner, branchId);
  if (branchId && !menuPool) return sendFail(res, 'Bunday filial topilmadi.');
  const stockPool = resolveStockPool(owner, branchId) || owner;
  const orderBranch = branchId ? findBranch(owner, branchId) : null;

  if (!isRegisteredUser(userId)) {
    return sendJSON(res, 200, {
      ok: false,
      reason: 'Buyurtma berishdan oldin ism, familiya va telefon raqamingizni kiritib ro\'yxatdan o\'ting.'
    });
  }

  const cachedResponse = getCachedOrderResponse(owner.id, userId, requestId);
  if (cachedResponse) return sendJSON(res, 200, cachedResponse);

  if (!Array.isArray(items) || !items.length) {
    return sendFail(res, 'Savat bo\'sh. Kamida bitta taom tanlang.');
  }
  if (!Object.prototype.hasOwnProperty.call(CUSTOMER_ORDER_TYPES, orderType)) {
    return sendFail(res, 'Buyurtma turini tanlang.');
  }
  if (!Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, paymentType)) {
    return sendFail(res, 'To\'lov turini tanlang.');
  }
  if (orderType === 'dostavka' && paymentType === 'naqd') {
    return sendFail(res, 'Bu turdagi naqd to\'lov dostavka buyurtmalarida mavjud emas. "Naqd" (dostavka orqali) yoki Karta tanlang.');
  }

  if (orderType !== 'dostavka' && paymentType === 'dostavka_orqali') {
    return sendFail(res, '"Naqd" to\'lovi (dostavkada) faqat Dostavka buyurtmalarida mavjud.');
  }

  if (orderType === 'dostavka' && paymentType === 'dostavka_orqali' && customerIsCardOnlyRestricted(owner, userId)) {
    return sendFail(res, 'Avvalgi buyurtma(lar)ingizda kuryer sizga bog\'lana olmagani sababli, endi faqat Karta orqali oldindan to\'lov bilan buyurtma bera olasiz.');
  }

  let deliveryLocation = null;
  if (orderType === 'dostavka') {
    if (location && typeof location.lat === 'number' && typeof location.lng === 'number' &&
        Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180) {
      deliveryLocation = { lat: location.lat, lng: location.lng };
    }
    if (!deliveryLocation) {
      return sendFail(res, 'Dostavka uchun joylashuvingizni (location) yuborishingiz shart. Manzil izohi yetarli emas.');
    }
    if (!isWithinDeliveryZone(deliveryLocation)) {
      return sendFail(res, `Kechirasiz, bu manzil xizmat zonasidan tashqarida (dostavka radiusi ${DELIVERY_ZONE_RADIUS_KM} km). Iltimos, xizmat zonamiz ichidagi manzilni tanlang.`);
    }
    const extraPhoneTrimmed = String(extraPhone || '').trim();
    if (!isPlausiblePhone(extraPhoneTrimmed)) {
      return sendFail(res, 'Telefon raqamini O\'zbekiston formatida kiriting (masalan: +998901234567).');
    }
  }
  const addressNoteFinal = orderType === 'dostavka' ? String(addressNote || '').trim().slice(0, 300) : null;
  const extraPhoneFinal = orderType === 'dostavka' ? String(extraPhone || '').trim().slice(0, 30) : null;
  const commentFinal = String(comment || '').trim().slice(0, 300) || null;

  const menu = (menuPool.menu || []).filter(m => m.available !== false);
  const combosAvailable = (owner.combos || []).filter(c => c.available !== false);
  const orderItems = [];
  for (const it of items) {
    const qty = parseInt(it.qty, 10);
    if (!Number.isInteger(qty) || qty <= 0) return sendFail(res, 'Miqdor noto\'g\'ri.');
    if (it.isCombo) {
      const combo = combosAvailable.find(c => c.id === it.id);
      if (!combo) return sendFail(res, 'Menyuda mavjud bo\'lmagan combo tanlangan.');
      orderItems.push({ id: combo.id, name: combo.name, price: combo.price, qty, isCombo: true, category: combo.category || null });
      continue;
    }
    const menuItem = menu.find(m => m.id === it.id);
    if (!menuItem) return sendFail(res, 'Menyuda mavjud bo\'lmagan taom tanlangan.');
    const priceOpt = resolveMenuItemPriceOption(menuItem, it.priceId);
    if (!priceOpt.ok) return sendFail(res, priceOpt.reason);
    orderItems.push({ id: menuItem.id, name: priceOpt.label ? `${menuItem.name} (${priceOpt.label})` : menuItem.name, price: priceOpt.price, priceId: priceOpt.priceId, qty, directStockId: menuItem.directStockId || null, category: menuItem.category || null });
  }
  const subtotal = orderItems.reduce((sum, it) => sum + it.price * it.qty, 0);

  const { promo, discountAmount: manualDiscountAmount } = applyPromoDiscount(owner, promoId, subtotal);
  const buy4get1 = computeBuy4Get1FreePromo(orderItems);
  const discountAmount = manualDiscountAmount + buy4get1.discountAmount;
  let total = Math.max(0, subtotal - discountAmount);

  const customer = findOrCreateCustomer(owner, userId, user);
  let pointsUsed = 0;
  if (usePoints) {
    const requested = Math.max(0, Math.floor(Number(usePoints) || 0));
    pointsUsed = Math.min(requested, customer.bonusPoints, total);
    total -= pointsUsed;
  }

  if (!owner.stock) owner.stock = [];

  const stockCheck = checkStockAvailabilityPooled(owner, orderItems, menu, stockPool);
  if (!stockCheck.ok) {
    return sendFail(res, stockCheck.reason);
  }

  for (const it of orderItems) {
    if (it.isCombo) {
      const combo = findCombo(owner, it.id);
      if (combo) {
        for (const need of comboStockNeeds(owner, combo, it.qty)) {
          const stockItem = findStockItem(owner, need.stockId);
          if (!stockItem) continue;
          stockItem.qty = Math.max(0, Math.round((stockItem.qty - need.qty) * 1000) / 1000);
          addStockMovement(owner, {
            stockId: stockItem.id, stockName: stockItem.name, type: 'chiqim',
            qty: need.qty, unit: stockItem.unit,
            note: `Combo: ${combo.name} (${need.viaName}) x${it.qty}`,
            userId
          });
          checkLowStockAlert(owner, stockItem, userId);
        }
      }
      continue;
    }
    const menuItem = menu.find(m => m.id === it.id);

    if (menuItem && menuItem.directStockId) {
      const stockItem = findStockItem(stockPool, menuItem.directStockId);
      if (stockItem) {
        const consumeQty = it.qty;
        stockItem.qty = Math.max(0, Math.round((stockItem.qty - consumeQty) * 1000) / 1000);
        addStockMovement(stockPool, {
          stockId: stockItem.id, stockName: stockItem.name, type: 'chiqim',
          qty: consumeQty, unit: stockItem.unit,
          note: `To'g'ridan sotildi: ${menuItem.name} x${it.qty}`,
          userId
        });
        checkLowStockAlert(owner, stockItem, userId, branchId || null);
      }
      continue;
    }
    const recipe = (menuItem && Array.isArray(menuItem.recipe)) ? menuItem.recipe : [];
    for (const ing of recipe) {
      const stockItem = findStockItem(stockPool, ing.stockId);
      if (!stockItem) continue;
      const consumeQty = Math.round(ing.qty * it.qty * 1000) / 1000;
      stockItem.qty = Math.max(0, Math.round((stockItem.qty - consumeQty) * 1000) / 1000);
      addStockMovement(stockPool, {
        stockId: stockItem.id, stockName: stockItem.name, type: 'chiqim',
        qty: consumeQty, unit: stockItem.unit,
        note: `Mijoz buyurtmasi: ${menuItem.name} x${it.qty}`,
        userId
      });
      checkLowStockAlert(owner, stockItem, userId, branchId || null);
    }
  }

  let pointsEarned = 0;
  if (owner.bonusSettings && owner.bonusSettings.enabled) {
    pointsEarned = Math.floor(total * (owner.bonusSettings.earnPercent || 0) / 100);
  }
  customer.bonusPoints = Math.max(0, customer.bonusPoints - pointsUsed + pointsEarned);
  customer.ordersCount = (customer.ordersCount || 0) + 1;
  customer.totalSpent = (customer.totalSpent || 0) + total;

  if (!customer.itemFrequency || typeof customer.itemFrequency !== 'object') customer.itemFrequency = {};
  for (const it of orderItems) {
    if (!it.id) continue;
    customer.itemFrequency[it.id] = (customer.itemFrequency[it.id] || 0) + (it.qty || 1);
  }
  customer.lastOrderedAt = new Date().toISOString();

  if (!owner.orders) owner.orders = [];
  const order = {
    id: crypto.randomBytes(4).toString('hex'),
    orderNumber: getNextOrderNumber(owner),
    items: orderItems,
    subtotal,
    promoId: promo ? promo.id : null,
    promoTitle: promo ? promo.title : null,
    discountAmount,
    autoPromoNote: buy4get1.noteHtml,
    pointsUsed,
    pointsEarned,
    total,
    orderType,
    location: deliveryLocation,
    addressNote: addressNoteFinal,
    extraPhone: extraPhoneFinal,
    comment: commentFinal,
    paymentType,
    status: 'yangi',

    paymentProofStatus: (paymentType === 'karta') ? 'kutilmoqda' : null,
    paymentConfirmMethod: paymentType === 'karta' ? 'skrinshot' : null,
    paymentProofFileId: null,

    branchId: orderBranch ? orderBranch.id : null,
    customerId: userId,
    customerName: customerDisplayName(userId, user),
    customerPhone: (findProfile(userId) || {}).phone || null,
    source: 'customer',
    createdAt: new Date().toISOString(),
    createdBy: userId
  };
  owner.orders.push(order);
  logStaffAction(owner, { userId, role: 'mijoz', action: 'buyurtma_yaratdi', orderId: order.id, note: `Mijoz buyurtmasi — ${fmtNum(total)} so'm` });
  saveOwners(owners);

  if (paymentType === 'karta') {

    const payCard = owner.customerPaymentCard || {};
    const cardLine = payCard.cardNumber
      ? `\n\n💳 To'lov: <code>${escapeHtmlServer(payCard.cardNumber)}</code>` +
        (payCard.cardHolder ? ` (${escapeHtmlServer(payCard.cardHolder)})` : '')
      : '\n\n⚠️ Oshxona hali to\'lov kartasini kiritmagan — to\'lov uchun kassaga murojaat qiling.';
    await sendMessage(userId,
      '💳 Buyurtmangiz qabul qilindi, lekin hali <b>TASDIQLANMAGAN</b>.' + cardLine + '\n\n' +
      'Iltimos, to\'lov chekining (skrinshotning) RASMINI shu botga yuboring - ' +
      'kassir yoki oshxona egasi tekshirib tasdiqlagach, buyurtmangiz oshxonaga yuboriladi.');
  } else {
    const itemsText = orderItems.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
    const commentLine = order.comment ? `\n💬 Izoh: ${escapeHtmlServer(order.comment)}` : '';
    const branchLine = orderBranch ? `\n🏬 Filial: ${escapeHtmlServer(orderBranch.name)}` : '';
    const autoPromoLine = order.autoPromoNote ? `\n${order.autoPromoNote}` : '';
    const notifyText = `🆕 <b>Yangi mijoz buyurtmasi</b> (${ORDER_TYPES[orderType]})\n` +
      `${orderCustomerContactLabel(order)}\n${itemsText}\n\nJami: ${fmtNum(total)} so'm\nTo'lov: ${PAYMENT_TYPES[paymentType]}${commentLine}${branchLine}${autoPromoLine}`;
    const notifyTargets = [owner.id, ...((owner.staff || []).filter(s => staffHasRole(s, 'oshpaz') || staffHasRole(s, 'kassir')).map(s => s.id))];
    await notifyStaffList(owner, notifyTargets, notifyText, `Buyurtma #${order.id} (mijoz)`, 'newOrder');
    notifyKitchenGroup(owner, order, orderCustomerContactLabel(order));
    saveOwners(owners);
  }

  const successResponse = {
    ok: true, orderId: order.id, total, discountAmount, pointsUsed, pointsEarned,
    bonusBalance: customer.bonusPoints, paymentPending: !!order.paymentProofStatus,
    paymentConfirmMethod: order.paymentConfirmMethod
  };
  setCachedOrderResponse(owner.id, userId, requestId, successResponse);
  return sendJSON(res, 200, successResponse);
});

function checkStockAvailability(owner, orderItems, menu) {
  const needed = new Map();
  for (const it of orderItems) {
    if (it.isCombo) {
      const combo = findCombo(owner, it.id);
      if (!combo) continue;
      for (const need of comboStockNeeds(owner, combo, it.qty)) {
        needed.set(need.stockId, Math.round(((needed.get(need.stockId) || 0) + need.qty) * 1000) / 1000);
      }
      continue;
    }
    const menuItem = menu.find(m => m.id === it.id);

    if (menuItem && menuItem.directStockId) {
      const consumeQty = it.qty;
      needed.set(menuItem.directStockId, Math.round(((needed.get(menuItem.directStockId) || 0) + consumeQty) * 1000) / 1000);
      continue;
    }
    const recipe = (menuItem && Array.isArray(menuItem.recipe)) ? menuItem.recipe : [];
    for (const ing of recipe) {
      const consumeQty = Math.round(ing.qty * it.qty * 1000) / 1000;
      needed.set(ing.stockId, Math.round(((needed.get(ing.stockId) || 0) + consumeQty) * 1000) / 1000);
    }
  }
  for (const [stockId, requiredQty] of needed) {
    const stockItem = findStockItem(owner, stockId);
    if (!stockItem) continue;
    if (stockItem.qty < requiredQty) {
      return {
        ok: false,
        reason: `Omborda "${stockItem.name}" yetarli emas (kerak: ${requiredQty} ${stockItem.unit}, mavjud: ${stockItem.qty} ${stockItem.unit}).`,
        stockName: stockItem.name
      };
    }
  }
  return { ok: true };
}

// 3-bosqich: mijoz filial tanlab buyurtma berganda, taomning tarkibiy
// qismlari (directStockId/recipe) o'sha FILIALNING skladidan hisoblanishi
// kerak (chunki filial menyusi mustaqil bo'lgani kabi, uning skladi ham
// mustaqil — /api/stock-* endpointlari buni allaqachon shunday boshqaradi).
// Combo'lar esa hali ham markaziy ("owner") darajasida qoladi, chunki
// combo tizimi filiallarga bog'lanmagan.
function checkStockAvailabilityPooled(owner, orderItems, menu, stockPool) {
  const neededCombo = new Map();
  const neededPool = new Map();
  for (const it of orderItems) {
    if (it.isCombo) {
      const combo = findCombo(owner, it.id);
      if (!combo) continue;
      for (const need of comboStockNeeds(owner, combo, it.qty)) {
        neededCombo.set(need.stockId, Math.round(((neededCombo.get(need.stockId) || 0) + need.qty) * 1000) / 1000);
      }
      continue;
    }
    const menuItem = menu.find(m => m.id === it.id);
    if (menuItem && menuItem.directStockId) {
      const consumeQty = it.qty;
      neededPool.set(menuItem.directStockId, Math.round(((neededPool.get(menuItem.directStockId) || 0) + consumeQty) * 1000) / 1000);
      continue;
    }
    const recipe = (menuItem && Array.isArray(menuItem.recipe)) ? menuItem.recipe : [];
    for (const ing of recipe) {
      const consumeQty = Math.round(ing.qty * it.qty * 1000) / 1000;
      neededPool.set(ing.stockId, Math.round(((neededPool.get(ing.stockId) || 0) + consumeQty) * 1000) / 1000);
    }
  }
  for (const [stockId, requiredQty] of neededCombo) {
    const stockItem = findStockItem(owner, stockId);
    if (!stockItem) continue;
    if (stockItem.qty < requiredQty) {
      return {
        ok: false,
        reason: `Omborda "${stockItem.name}" yetarli emas (kerak: ${requiredQty} ${stockItem.unit}, mavjud: ${stockItem.qty} ${stockItem.unit}).`,
        stockName: stockItem.name
      };
    }
  }
  for (const [stockId, requiredQty] of neededPool) {
    const stockItem = findStockItem(stockPool, stockId);
    if (!stockItem) continue;
    if (stockItem.qty < requiredQty) {
      return {
        ok: false,
        reason: `Omborda "${stockItem.name}" yetarli emas (kerak: ${requiredQty} ${stockItem.unit}, mavjud: ${stockItem.qty} ${stockItem.unit}).`,
        stockName: stockItem.name
      };
    }
  }
  return { ok: true };
}

const ORDER_STATUS_TRANSITIONS = {
  yangi: ['tayyorlanmoqda'],
  tayyorlanmoqda: ['tayyor'],
  tayyor: []
};

function orderNeedsKitchen(order) {
  const items = (order && order.items) || [];
  if (!items.length) return true;
  return items.some(it => !it.directStockId);
}

function canSetOrderStatus(ctx, order, newStatus) {
  if (!Object.prototype.hasOwnProperty.call(ORDER_STATUSES, newStatus)) return false;

  // To'lov (karta skrinshoti yoki stoldagi naqd) hali tasdiqlanmagan bo'lsa -
  // buyurtma holatini HECH KIM (egasi ham) o'zgartira olmasligi kerak,
  // aks holda mijoz to'lamasdan turib taom tayyorlana boshlaydi.
  if (order && order.paymentProofStatus === 'kutilmoqda') return false;

  if (ctxHasRole(ctx, 'egasi')) return true;

  const currentStatus = order ? order.status : 'yangi';
  let allowedNext = ORDER_STATUS_TRANSITIONS[currentStatus] || [];

  if (currentStatus === 'yangi' && !orderNeedsKitchen(order)) {
    allowedNext = allowedNext.concat('tayyor');
  }
  if (!allowedNext.includes(newStatus)) return false;

  if (ctxHasRole(ctx, 'oshpaz') && (newStatus === 'tayyorlanmoqda' || newStatus === 'tayyor')) return true;
  if (ctxHasRole(ctx, 'kassir') && newStatus === 'tayyor') return true;
  return false;
}

authed('/api/create-order', async (payload, res, { user, userId }) => {
  const { items, orderType, paymentType, requestId, comment } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['kassir', 'egasi'])) {
    return sendFail(res, 'Faqat kassir buyurtma yaratishi mumkin');
  }

  const cachedResponse = getCachedOrderResponse(ctx.owner.id, userId, requestId);
  if (cachedResponse) return sendJSON(res, 200, cachedResponse);

  if (!Array.isArray(items) || !items.length) {
    return sendFail(res, 'Savat bo\'sh. Kamida bitta taom tanlang.');
  }
  if (!Object.prototype.hasOwnProperty.call(ORDER_TYPES, orderType)) {
    return sendFail(res, 'Buyurtma turini tanlang.');
  }
  if (!Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, paymentType)) {
    return sendFail(res, 'To\'lov turini tanlang.');
  }
  if (orderType === 'dostavka' && paymentType === 'naqd') {
    return sendFail(res, 'Bu turdagi naqd to\'lov dostavka buyurtmalarida mavjud emas. "Naqd" (dostavka orqali) yoki Karta tanlang.');
  }

  if (orderType !== 'dostavka' && paymentType === 'dostavka_orqali') {
    return sendFail(res, '"Naqd" to\'lovi (dostavkada) faqat Dostavka buyurtmalarida mavjud.');
  }

  // 4-bosqich: kassir/ega o'zi biriktirilgan (yoki tanlagan) filialning
  // mustaqil menyusi va skladi asosida buyurtma yaratadi. Combo'lar
  // hamon markaziy darajada qoladi (filiallarga bog'lanmagan).
  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const menuPool = resolveMenuPool(ctx.owner, branchId);
  if (branchId && !menuPool) return sendFail(res, 'Bunday filial topilmadi.');
  const stockPool = resolveStockPool(ctx.owner, branchId) || ctx.owner;

  const menu = menuPool.menu || [];
  const combosAvailable = ctx.owner.combos || [];
  const orderItems = [];
  for (const it of items) {
    const qty = parseInt(it.qty, 10);
    if (!Number.isInteger(qty) || qty <= 0) return sendFail(res, 'Miqdor noto\'g\'ri.');
    if (it.isCombo) {
      const combo = combosAvailable.find(c => c.id === it.id);
      if (!combo) return sendFail(res, 'Menyuda mavjud bo\'lmagan combo tanlangan.');
      orderItems.push({ id: combo.id, name: combo.name, price: combo.price, qty, isCombo: true, category: combo.category || null });
      continue;
    }
    const menuItem = menu.find(m => m.id === it.id);
    if (!menuItem) return sendFail(res, 'Menyuda mavjud bo\'lmagan taom tanlangan.');
    const priceOpt = resolveMenuItemPriceOption(menuItem, it.priceId);
    if (!priceOpt.ok) return sendFail(res, priceOpt.reason);
    orderItems.push({ id: menuItem.id, name: priceOpt.label ? `${menuItem.name} (${priceOpt.label})` : menuItem.name, price: priceOpt.price, priceId: priceOpt.priceId, qty, directStockId: menuItem.directStockId || null, category: menuItem.category || null });
  }
  const subtotal = orderItems.reduce((sum, it) => sum + it.price * it.qty, 0);
  const buy4get1 = computeBuy4Get1FreePromo(orderItems);
  const total = Math.max(0, subtotal - buy4get1.discountAmount);

  if (!ctx.owner.stock) ctx.owner.stock = [];

  const stockCheck = checkStockAvailabilityPooled(ctx.owner, orderItems, menu, stockPool);
  if (!stockCheck.ok) {
    return sendFail(res, stockCheck.reason);
  }

  for (const it of orderItems) {
    if (it.isCombo) {
      const combo = findCombo(ctx.owner, it.id);
      if (combo) {
        for (const need of comboStockNeeds(ctx.owner, combo, it.qty)) {
          const stockItem = findStockItem(ctx.owner, need.stockId);
          if (!stockItem) continue;
          stockItem.qty = Math.max(0, Math.round((stockItem.qty - need.qty) * 1000) / 1000);
          addStockMovement(ctx.owner, {
            stockId: stockItem.id, stockName: stockItem.name, type: 'chiqim',
            qty: need.qty, unit: stockItem.unit,
            note: `Combo: ${combo.name} (${need.viaName}) x${it.qty}`,
            userId
          });
          checkLowStockAlert(ctx.owner, stockItem, userId);
        }
      }
      continue;
    }
    const menuItem = menu.find(m => m.id === it.id);

    if (menuItem && menuItem.directStockId) {
      const stockItem = findStockItem(stockPool, menuItem.directStockId);
      if (stockItem) {
        const consumeQty = it.qty;
        stockItem.qty = Math.max(0, Math.round((stockItem.qty - consumeQty) * 1000) / 1000);
        addStockMovement(stockPool, {
          stockId: stockItem.id, stockName: stockItem.name, type: 'chiqim',
          qty: consumeQty, unit: stockItem.unit,
          note: `To'g'ridan sotildi: ${menuItem.name} x${it.qty}`,
          userId
        });
        checkLowStockAlert(ctx.owner, stockItem, userId, branchId);
      }
      continue;
    }
    const recipe = (menuItem && Array.isArray(menuItem.recipe)) ? menuItem.recipe : [];
    for (const ing of recipe) {
      const stockItem = findStockItem(stockPool, ing.stockId);
      if (!stockItem) continue;
      const consumeQty = Math.round(ing.qty * it.qty * 1000) / 1000;
      stockItem.qty = Math.max(0, Math.round((stockItem.qty - consumeQty) * 1000) / 1000);
      addStockMovement(stockPool, {
        stockId: stockItem.id, stockName: stockItem.name, type: 'chiqim',
        qty: consumeQty, unit: stockItem.unit,
        note: `Buyurtma: ${menuItem.name} x${it.qty}`,
        userId
      });
      checkLowStockAlert(ctx.owner, stockItem, userId, branchId);
    }
  }

  if (!ctx.owner.orders) ctx.owner.orders = [];
  const commentFinal = String(comment || '').trim().slice(0, 300) || null;
  const order = {
    id: crypto.randomBytes(4).toString('hex'),
    orderNumber: getNextOrderNumber(ctx.owner),
    items: orderItems,
    subtotal,
    discountAmount: buy4get1.discountAmount,
    autoPromoNote: buy4get1.noteHtml,
    total,
    orderType,
    paymentType,
    comment: commentFinal,
    status: 'yangi',
    branchId,

    createdAt: new Date().toISOString(),
    createdBy: userId
  };
  ctx.owner.orders.push(order);
  logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'buyurtma_yaratdi', orderId: order.id, note: `${ORDER_TYPES[orderType]} — ${fmtNum(total)} so'm` });
  saveOwners(owners);

  const itemsText = orderItems.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
  const commentLine = commentFinal ? `\n📝 Izoh: ${escapeHtmlServer(commentFinal)}` : '';
  const autoPromoLine = order.autoPromoNote ? `\n${order.autoPromoNote}` : '';
  const notifyText = `🆕 <b>Yangi buyurtma</b> (${ORDER_TYPES[orderType]})\n` +
    `${itemsText}\n\nJami: ${fmtNum(total)} so'm\nTo'lov: ${PAYMENT_TYPES[paymentType]}${commentLine}${autoPromoLine}`;
  const notifyTargets = [ctx.owner.id, ...((ctx.owner.staff || []).filter(s => staffHasRole(s, 'oshpaz')).map(s => s.id))];
  await notifyStaffList(ctx.owner, notifyTargets, notifyText, `Buyurtma #${order.id} (kassir)`, 'newOrder');
  notifyKitchenGroup(ctx.owner, order, `Yaratdi: ${escapeHtmlServer(displayName(user))} (kassir)`);
  saveOwners(owners);

  const successResponse = {
    ok: true, orderId: order.id, total,
    printQueued: willAutoPrint(ctx.owner),
    agentOnline: isAgentOnline(ctx.owner)
  };
  setCachedOrderResponse(ctx.owner.id, userId, requestId, successResponse);
  return sendJSON(res, 200, successResponse);
});

// Mavjud buyurtmani tahrirlash (kassir yoki egasi): mahsulot qo'shish/olib tashlash/
// miqdorini o'zgartirish — mijoz qo'shimcha narsa xohlasa yangi buyurtma ochmasdan,
// shu buyurtmani tahrirlab qo'yish uchun. Faqat hali oshxonaga "Tayyor" bo'lmagan
// (yangi / tayyorlanmoqda) buyurtmalarni tahrirlash mumkin.
authed('/api/edit-order', async (payload, res, { userId }) => {
  const { orderId, items, orderType, paymentType, comment } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['kassir', 'egasi'])) {
    return sendFail(res, 'Faqat kassir yoki ega buyurtmani tahrirlashi mumkin');
  }
  if (!ownerCanUseFeature(ctx.owner, 'orders-manage')) return sendFeatureBlocked(res, 'orders-manage');

  const order = (ctx.owner.orders || []).find(o => o.id === orderId);
  if (!order) return sendFail(res, 'Buyurtma topilmadi.');

  if (order.paymentProofStatus === 'kutilmoqda') {
    return sendFail(res, 'To\'lovi hali tasdiqlanmagan buyurtmani tahrirlab bo\'lmaydi.');
  }
  if (order.status === 'bekor_qilindi') {
    return sendFail(res, 'Bekor qilingan buyurtmani tahrirlab bo\'lmaydi.');
  }

  if (!Array.isArray(items) || !items.length) {
    return sendFail(res, 'Savat bo\'sh. Kamida bitta taom qoldiring.');
  }

  const finalOrderType = Object.prototype.hasOwnProperty.call(ORDER_TYPES, orderType) ? orderType : order.orderType;
  const finalPaymentType = Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, paymentType) ? paymentType : order.paymentType;
  if (finalOrderType === 'dostavka' && finalPaymentType === 'naqd') {
    return sendFail(res, 'Bu turdagi naqd to\'lov dostavka buyurtmalarida mavjud emas. "Naqd" (dostavka orqali) yoki Karta tanlang.');
  }
  if (finalOrderType !== 'dostavka' && finalPaymentType === 'dostavka_orqali') {
    return sendFail(res, '"Naqd" to\'lovi (dostavkada) faqat Dostavka buyurtmalarida mavjud.');
  }

  // 4-bosqich: buyurtma qaysi filialga tegishli bo'lsa (order.branchId),
  // tahrirlash ham o'sha filialning mustaqil menyusi/skladi asosida
  // amalga oshiriladi (combo'lar hamon markaziy darajada qoladi).
  const branchId = order.branchId || null;
  const menuPool = resolveMenuPool(ctx.owner, branchId) || ctx.owner;
  const stockPool = resolveStockPool(ctx.owner, branchId) || ctx.owner;

  const menu = menuPool.menu || [];
  const combosAvailable = ctx.owner.combos || [];
  const newOrderItems = [];
  for (const it of items) {
    const qty = parseInt(it.qty, 10);
    if (!Number.isInteger(qty) || qty <= 0) return sendFail(res, 'Miqdor noto\'g\'ri.');
    if (it.isCombo) {
      const combo = combosAvailable.find(c => c.id === it.id);
      if (!combo) return sendFail(res, 'Menyuda mavjud bo\'lmagan combo tanlangan.');
      newOrderItems.push({ id: combo.id, name: combo.name, price: combo.price, qty, isCombo: true, category: combo.category || null });
      continue;
    }
    const menuItem = menu.find(m => m.id === it.id);
    if (!menuItem) return sendFail(res, 'Menyuda mavjud bo\'lmagan taom tanlangan.');
    const priceOpt = resolveMenuItemPriceOption(menuItem, it.priceId);
    if (!priceOpt.ok) return sendFail(res, priceOpt.reason);
    newOrderItems.push({ id: menuItem.id, name: priceOpt.label ? `${menuItem.name} (${priceOpt.label})` : menuItem.name, price: priceOpt.price, priceId: priceOpt.priceId, qty, directStockId: menuItem.directStockId || null, category: menuItem.category || null });
  }
  const newSubtotal = newOrderItems.reduce((sum, it) => sum + it.price * it.qty, 0);
  const newBuy4get1 = computeBuy4Get1FreePromo(newOrderItems);
  const newTotal = Math.max(0, newSubtotal - newBuy4get1.discountAmount);

  // Buyurtma allaqachon "Tayyor" bo'lgan bo'lsa-yu, kassir shu tahrirlashda
  // yangi mahsulot qo'shsa (yoki miqdorini oshirsa) — o'sha ORTIQCHA qismni
  // aniqlab olamiz, keyinroq shuni alohida oshxona guruhiga yuboramiz.
  const orderWasReady = order.status === 'tayyor';
  const itemKey = (it) => `${it.isCombo ? 'combo:' : ''}${it.id}:${it.priceId || ''}`;
  const oldQtyByKey = new Map();
  (order.items || []).forEach(it => {
    const k = itemKey(it);
    oldQtyByKey.set(k, (oldQtyByKey.get(k) || 0) + it.qty);
  });
  const addedItems = [];
  newOrderItems.forEach(it => {
    const delta = it.qty - (oldQtyByKey.get(itemKey(it)) || 0);
    if (delta > 0) addedItems.push({ name: it.name, qty: delta });
  });

  if (!ctx.owner.stock) ctx.owner.stock = [];

  // Har bir mahsulot ro'yxati uchun kerakli ombor miqdorlarini hisoblaydi
  // (create-order'dagi checkStockAvailabilityPooled bilan bir xil mantiq):
  // combo'lar markaziy ombordan, oddiy taomlar esa filial (yoki markaziy)
  // skladidan alohida hisoblanadi.
  function stockNeedsForItems(orderItems) {
    const neededCombo = new Map();
    const neededPool = new Map();
    for (const it of orderItems) {
      if (it.isCombo) {
        const combo = findCombo(ctx.owner, it.id);
        if (!combo) continue;
        for (const need of comboStockNeeds(ctx.owner, combo, it.qty)) {
          neededCombo.set(need.stockId, Math.round(((neededCombo.get(need.stockId) || 0) + need.qty) * 1000) / 1000);
        }
        continue;
      }
      const menuItem = menu.find(m => m.id === it.id);
      if (menuItem && menuItem.directStockId) {
        neededPool.set(menuItem.directStockId, Math.round(((neededPool.get(menuItem.directStockId) || 0) + it.qty) * 1000) / 1000);
        continue;
      }
      const recipe = (menuItem && Array.isArray(menuItem.recipe)) ? menuItem.recipe : [];
      for (const ing of recipe) {
        const consumeQty = Math.round(ing.qty * it.qty * 1000) / 1000;
        neededPool.set(ing.stockId, Math.round(((neededPool.get(ing.stockId) || 0) + consumeQty) * 1000) / 1000);
      }
    }
    return { neededCombo, neededPool };
  }

  // Eski buyurtma allaqachon ombordan yechilgan edi — shuning uchun faqat
  // ESKI va YANGI ehtiyoj o'rtasidagi FARQNI (delta) ombordan yechamiz yoki qaytaramiz.
  const oldNeeds = stockNeedsForItems(order.items || []);
  const newNeeds = stockNeedsForItems(newOrderItems);

  function computeDeltas(oldMap, newMap) {
    const ids = new Set([...oldMap.keys(), ...newMap.keys()]);
    const deltas = new Map();
    for (const id of ids) {
      const delta = Math.round(((newMap.get(id) || 0) - (oldMap.get(id) || 0)) * 1000) / 1000;
      if (delta !== 0) deltas.set(id, delta);
    }
    return deltas;
  }

  const comboDeltas = computeDeltas(oldNeeds.neededCombo, newNeeds.neededCombo);
  const poolDeltas = computeDeltas(oldNeeds.neededPool, newNeeds.neededPool);

  for (const [stockId, delta] of comboDeltas) {
    if (delta <= 0) continue;
    const stockItem = findStockItem(ctx.owner, stockId);
    if (!stockItem) continue;
    if (stockItem.qty < delta) {
      return sendFail(res, `Omborda "${stockItem.name}" yetarli emas (kerak: ${delta} ${stockItem.unit}, mavjud: ${stockItem.qty} ${stockItem.unit}).`);
    }
  }
  for (const [stockId, delta] of poolDeltas) {
    if (delta <= 0) continue;
    const stockItem = findStockItem(stockPool, stockId);
    if (!stockItem) continue;
    if (stockItem.qty < delta) {
      return sendFail(res, `Omborda "${stockItem.name}" yetarli emas (kerak: ${delta} ${stockItem.unit}, mavjud: ${stockItem.qty} ${stockItem.unit}).`);
    }
  }

  for (const [stockId, delta] of comboDeltas) {
    const stockItem = findStockItem(ctx.owner, stockId);
    if (!stockItem) continue;
    stockItem.qty = Math.max(0, Math.round((stockItem.qty - delta) * 1000) / 1000);
    addStockMovement(ctx.owner, {
      stockId: stockItem.id, stockName: stockItem.name, type: delta > 0 ? 'chiqim' : 'kirim',
      qty: Math.abs(delta), unit: stockItem.unit,
      note: `Buyurtma tahrirlandi: #${order.orderNumber || order.id}`,
      userId
    });
    checkLowStockAlert(ctx.owner, stockItem, userId);
  }
  for (const [stockId, delta] of poolDeltas) {
    const stockItem = findStockItem(stockPool, stockId);
    if (!stockItem) continue;
    stockItem.qty = Math.max(0, Math.round((stockItem.qty - delta) * 1000) / 1000);
    addStockMovement(stockPool, {
      stockId: stockItem.id, stockName: stockItem.name, type: delta > 0 ? 'chiqim' : 'kirim',
      qty: Math.abs(delta), unit: stockItem.unit,
      note: `Buyurtma tahrirlandi: #${order.orderNumber || order.id}`,
      userId
    });
    checkLowStockAlert(ctx.owner, stockItem, userId, branchId);
  }

  const oldItemsSummary = (order.items || []).map(it => `${it.name} x${it.qty}`).join(', ') || '—';
  order.items = newOrderItems;
  order.subtotal = newSubtotal;
  order.discountAmount = newBuy4get1.discountAmount;
  order.autoPromoNote = newBuy4get1.noteHtml;
  order.total = newTotal;
  order.orderType = finalOrderType;
  order.paymentType = finalPaymentType;
  if (Object.prototype.hasOwnProperty.call(payload, 'comment')) {
    order.comment = String(comment || '').trim().slice(0, 300) || null;
  }
  order.editedAt = new Date().toISOString();
  order.editedBy = userId;

  logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'buyurtma_tahrirlandi', orderId: order.id, note: `Yangi: ${fmtNum(newTotal)} so'm (avvalgi: ${oldItemsSummary})` });
  saveOwners(owners);

  const itemsText = newOrderItems.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
  const editCommentLine = order.comment ? `\n📝 Izoh: ${escapeHtmlServer(order.comment)}` : '';
  const editAutoPromoLine = order.autoPromoNote ? `\n${order.autoPromoNote}` : '';
  const notifyText = `✏️ <b>Buyurtma tahrirlandi</b> (${ORDER_TYPES[finalOrderType]})\n${itemsText}\n\nJami: ${fmtNum(newTotal)} so'm\nTo'lov: ${PAYMENT_TYPES[finalPaymentType]}${editCommentLine}${editAutoPromoLine}`;
  const notifyTargets = [ctx.owner.id, ...((ctx.owner.staff || []).filter(s => staffHasRole(s, 'oshpaz')).map(s => s.id))];
  await notifyStaffList(ctx.owner, notifyTargets, notifyText, `Buyurtma #${order.id} tahrirlandi`, 'newOrder');
  saveOwners(owners);

  // Buyurtma "Tayyor" bo'lgach qo'shilgan mahsulotlar — alohida oshxona
  // guruhiga, o'zining mustaqil "Tayyor" tugmasi bilan yuboriladi.
  if (orderWasReady && addedItems.length) {
    const addition = {
      id: crypto.randomBytes(4).toString('hex'),
      items: addedItems,
      createdAt: new Date().toISOString(),
      createdBy: userId,
      ready: false,
      readyBy: null,
      readyAt: null
    };
    if (!order.additions) order.additions = [];
    order.additions.push(addition);
    saveOwners(owners);

    const addGroups = resolveOrderGroupIds(ctx.owner, order);
    if (addGroups.kitchenGroupId && ownerCanUseFeature(ctx.owner, 'kitchen-group')) {
      const addItemsText = addedItems.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
      const orderLabel = `#${order.orderNumber || order.id}`;
      const addText = `➕ <b>Qo'shimcha buyurtma</b> (Buyurtma ${orderLabel})\n${addItemsText}`;
      sendMessage(addGroups.kitchenGroupId, addText, {
        inline_keyboard: [[
          { text: '✅ Tayyor', callback_data: `kgaddready:${ctx.owner.id}:${order.id}:${addition.id}` }
        ]]
      }, addGroups.kitchenGroupThreadId).then(result => {
        if (result && result.ok && result.result && result.result.message_id) {
          const owners2 = loadOwners();
          const o2 = findOwner(owners2, ctx.owner.id);
          const ord2 = o2 && (o2.orders || []).find(x => x.id === order.id);
          const add2 = ord2 && (ord2.additions || []).find(a => a.id === addition.id);
          if (add2) {
            add2.kitchenGroupMsgId = result.result.message_id;
            saveOwners(owners2);
          }
        }
      }).catch(err => {
        console.error(`[kgaddready xabar xatosi] owner=${ctx.owner.id} order=${order.id}: ${(err && err.message) || err}`);
      });
    }
  }

  return sendOk(res, { order });
});

authed('/api/orders-list', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'kassir', 'oshpaz', 'dostavka'])) {
    return sendFail(res, 'Bu bo\'limni ko\'rishga ruxsatingiz yo\'q');
  }
  if (!ownerCanUseFeature(ctx.owner, 'orders-manage')) return sendFeatureBlocked(res, 'orders-manage');

  let orders = (ctx.owner.orders || [])
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (ctx.role === 'egasi') {
    const branchId = Object.prototype.hasOwnProperty.call(payload, 'branchId') ? payload.branchId : undefined;
    orders = orders.filter(o => matchesBranchFilter(o, branchId));
  } else if (ctx.branchId) {
    orders = orders.filter(o => (o.branchId || null) === ctx.branchId);
  }

  if (ctxHasRole(ctx, 'dostavka')) {
    orders = orders.filter(o => o.orderType === 'dostavka' && o.status === 'tayyor' && !o.deliveredBy);
  }

  orders = orders.slice(0, 100);
  return sendOk(res, { orders, role: ctx.role });
});

function filterOwnerOrderHistory(ctx, payload) {
  const { dateFrom, dateTo, employeeId, paymentType, orderType } = payload;
  let orders = (ctx.owner.orders || []).slice();

  if (dateFrom) {
    const from = new Date(dateFrom + 'T00:00:00');
    if (!isNaN(from.getTime())) orders = orders.filter(o => new Date(o.createdAt) >= from);
  }
  if (dateTo) {
    const to = new Date(dateTo + 'T23:59:59');
    if (!isNaN(to.getTime())) orders = orders.filter(o => new Date(o.createdAt) <= to);
  }
  if (employeeId) {
    orders = orders.filter(o => String(o.createdBy) === String(employeeId));
  }
  if (paymentType && Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, paymentType)) {
    orders = orders.filter(o => o.paymentType === paymentType);
  }
  if (orderType && Object.prototype.hasOwnProperty.call(ORDER_TYPES, orderType)) {
    orders = orders.filter(o => o.orderType === orderType);
  }
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const nameCache = new Map();
  const staffNameById = (id) => {
    if (!id) return null;
    if (nameCache.has(id)) return nameCache.get(id);
    let name;
    if (String(id) === String(ctx.owner.id)) {
      name = 'Egasi';
    } else {
      const staff = (ctx.owner.staff || []).find(s => String(s.id) === String(id));
      name = staff ? staffDisplayName(staff) : `ID: ${id}`;
    }
    nameCache.set(id, name);
    return name;
  };

  return { orders, staffNameById };
}

authed('/api/order-history', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!isOwnerAccessValid(ctx.owner) || ctx.role !== 'egasi') {
    return sendFail(res, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  }

  let page = parseInt(payload.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const PAGE_SIZE = 30;

  const { orders, staffNameById } = filterOwnerOrderHistory(ctx, payload);

  const totalCount = orders.length;
  const totalSum = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const pageOrders = orders.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const resultOrders = pageOrders.map(o => ({
    id: o.id,
    items: o.items,
    total: o.total,
    orderType: o.orderType,
    paymentType: o.paymentType,
    status: o.status,
    createdAt: o.createdAt,
    createdBy: o.createdBy,
    createdByName: staffNameById(o.createdBy)
  }));

  const employees = [{ id: ctx.owner.id, name: 'Egasi' }];
  (ctx.owner.staff || []).forEach(s => {
    employees.push({ id: s.id, name: staffDisplayName(s) });
  });

  return sendOk(res, {
    orders: resultOrders,
    page, totalPages, totalCount, totalSum,
    pageSize: PAGE_SIZE,
    employees
  });
});

function pdfSanitizeText(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').split('').map(ch => {
    const code = ch.charCodeAt(0);
    return (code >= 0x20 && code <= 0x7E) || (code >= 0xA0 && code <= 0xFF) ? ch : '?';
  }).join('');
}
function pdfEscapeText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function pdfCellText(value, width, fontSize) {
  const avgCharWidth = fontSize * 0.56;
  const maxChars = Math.max(1, Math.floor(width / avgCharWidth));
  let t = pdfSanitizeText(value);
  if (t.length > maxChars) t = t.slice(0, Math.max(0, maxChars - 2)) + '..';
  return pdfEscapeText(t);
}

function buildSimplePdfReport(title, generatedAtLabel, headers, colWidths, rows) {
  const pageWidth = 595, pageHeight = 842;
  const marginX = 40, topY = 802, bottomMargin = 40;
  const titleFontSize = 13, headerFontSize = 8, cellFontSize = 7.5, lineHeight = 13;
  const headerY = topY - 26;
  const firstRowY = headerY - lineHeight - 2;
  const rowsPerPage = Math.max(5, Math.floor((firstRowY - bottomMargin) / lineHeight));

  const pages = [];
  for (let i = 0; i < rows.length; i += rowsPerPage) pages.push(rows.slice(i, i + rowsPerPage));
  if (!pages.length) pages.push([]);

  function colX(idx) {
    let x = marginX;
    for (let i = 0; i < idx; i++) x += colWidths[i];
    return x;
  }

  const pageStreams = pages.map((pageRows, pIdx) => {
    let s = 'BT\n';
    s += `/F1 ${titleFontSize} Tf\n1 0 0 1 ${marginX} ${topY} Tm\n(${pdfEscapeText(pdfSanitizeText(title))}) Tj\n`;
    s += `/F1 7 Tf\n1 0 0 1 ${pageWidth - marginX - 130} ${topY} Tm\n(${pdfEscapeText(pdfSanitizeText(generatedAtLabel))}) Tj\n`;
    s += `/F1 ${headerFontSize} Tf\n`;
    headers.forEach((h, i) => {
      s += `1 0 0 1 ${colX(i)} ${headerY} Tm\n(${pdfCellText(h, colWidths[i], headerFontSize)}) Tj\n`;
    });
    s += `/F1 ${cellFontSize} Tf\n`;
    pageRows.forEach((row, ri) => {
      const y = firstRowY - ri * lineHeight;
      row.forEach((val, ci) => {
        s += `1 0 0 1 ${colX(ci)} ${y} Tm\n(${pdfCellText(val, colWidths[ci], cellFontSize)}) Tj\n`;
      });
    });
    s += `/F1 6.5 Tf\n1 0 0 1 ${marginX} ${bottomMargin - 15} Tm\n(${pdfEscapeText(String(pIdx + 1) + ' / ' + pages.length)}) Tj\n`;
    s += 'ET';
    return s;
  });

  const objects = [];
  const pageCount = pageStreams.length;
  const firstPageObjNum = 4;
  const pageObjNums = [], contentObjNums = [];
  for (let i = 0; i < pageCount; i++) {
    pageObjNums.push(firstPageObjNum + i * 2);
    contentObjNums.push(firstPageObjNum + i * 2 + 1);
  }
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map(n => n + ' 0 R').join(' ')}] /Count ${pageCount} >>\nendobj\n`;
  objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`;
  for (let i = 0; i < pageCount; i++) {
    const pObjNum = pageObjNums[i], cObjNum = contentObjNums[i];
    objects[pObjNum] = `${pObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cObjNum} 0 R >>\nendobj\n`;
    const streamBody = pageStreams[i];
    const byteLen = Buffer.byteLength(streamBody, 'latin1');
    objects[cObjNum] = `${cObjNum} 0 obj\n<< /Length ${byteLen} >>\nstream\n${streamBody}\nendstream\nendobj\n`;
  }
  const maxObjNum = 3 + pageCount * 2;
  let pdf = '%PDF-1.4\n';
  const offsets = new Array(maxObjNum + 1).fill(0);
  for (let n = 1; n <= maxObjNum; n++) {
    offsets[n] = Buffer.byteLength(pdf, 'latin1');
    pdf += objects[n];
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxObjNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObjNum; n++) {
    pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxObjNum + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function csvEscapeCell(value) {
  const s = String(value == null ? '' : value);
  return /[";\n,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

authed('/api/order-history-export', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!isOwnerAccessValid(ctx.owner) || ctx.role !== 'egasi') {
    return sendFail(res, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  }
  if (!ownerCanUseFeature(ctx.owner, 'orders-manage')) return sendFeatureBlocked(res, 'orders-manage');

  const format = payload.format === 'pdf' ? 'pdf' : 'csv';
  const { orders, staffNameById } = filterOwnerOrderHistory(ctx, payload);
  const exportOrders = orders.slice(0, 2000);
  const totalSum = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const nowLabel = new Date().toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const restaurantName = (ctx.owner.name || 'Oshxona');

  const rows = exportOrders.map(o => {
    const d = new Date(o.createdAt);
    const sana = d.toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const itemsText = (o.items || []).map(it => `${it.name} x${it.qty}`).join(', ');
    return [
      sana,
      ORDER_TYPES[o.orderType] || o.orderType,
      PAYMENT_TYPES[o.paymentType] || o.paymentType,
      ORDER_STATUSES[o.status] || o.status,
      itemsText,
      String(o.total || 0),
      staffNameById(o.createdBy) || ''
    ];
  });

  if (format === 'csv') {
    const headers = ['Sana', 'Turi', "To'lov", 'Holat', 'Taomlar', 'Summa', 'Xodim'];
    let csv = headers.map(csvEscapeCell).join(',') + '\r\n';
    csv += rows.map(r => r.map(csvEscapeCell).join(',')).join('\r\n');
    csv += `\r\n\r\n${csvEscapeCell('Jami: ' + rows.length + ' ta buyurtma, ' + totalSum + ' so\'m')}\r\n`;
    const filename = `buyurtmalar_${new Date().toISOString().slice(0, 10)}.csv`;

    const content = '\uFEFF' + csv;
    return sendOk(res, { format: 'csv', filename, mime: 'text/csv;charset=utf-8', content });
  }

  const headers = ['Sana', 'Turi', "To'lov", 'Holat', 'Summa', 'Xodim'];
  const colWidths = [95, 65, 65, 70, 75, 145];
  const pdfRows = rows.map(r => [r[0], r[1], r[2], r[3], r[5] + " so'm", r[6]]);
  const pdfBuffer = buildSimplePdfReport(
    `${restaurantName} — Buyurtmalar tarixi (${rows.length} ta, ${totalSum} so'm)`,
    nowLabel, headers, colWidths, pdfRows
  );
  const filename = `buyurtmalar_${new Date().toISOString().slice(0, 10)}.pdf`;
  return sendOk(res, { format: 'pdf', filename, mime: 'application/pdf', contentBase64: pdfBuffer.toString('base64') });
});

authed('/api/my-stats', (payload, res, { userId }) => {
  const { period } = payload;

  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['kassir', 'oshpaz', 'dostavka', 'sklad'])) {
    return sendFail(res, 'Bu bo\'lim faqat xodimlarga ko\'rinadi');
  }

  const fromDate = resolvePeriodStart(period);
  const orders = ctx.owner.orders || [];
  const stats = { period: period || 'today' };

  if (ctxHasRole(ctx, 'kassir')) {
    const mine = orders.filter(o => String(o.createdBy) === userId && new Date(o.createdAt) >= fromDate);
    stats.kassir = {
      orderCount: mine.length,
      totalAmount: mine.reduce((sum, o) => sum + (o.total || 0), 0)
    };
  }
  if (ctxHasRole(ctx, 'oshpaz')) {

    const mine = orders.filter(o => o.status === 'tayyor' && String(o.updatedBy) === userId && o.readyAt && new Date(o.readyAt) >= fromDate);
    stats.oshpaz = {
      orderCount: mine.length
    };
  }
  if (ctxHasRole(ctx, 'dostavka')) {
    const mine = orders.filter(o => o.orderType === 'dostavka' && String(o.deliveredBy) === userId && new Date(o.deliveredAt || o.createdAt) >= fromDate);
    const totalAmount = mine.reduce((sum, o) => sum + (o.total || 0), 0);
    const commissionPercent = Number.isFinite(ctx.owner.courierCommissionPercent) ? ctx.owner.courierCommissionPercent : 10;
    stats.dostavka = {
      orderCount: mine.length,
      totalAmount,
      commission: Math.round(totalAmount * commissionPercent / 100)
    };
  }
  if (ctxHasRole(ctx, 'sklad')) {
    const movements = (ctx.owner.stockMovements || []).filter(m => String(m.userId) === userId && new Date(m.createdAt) >= fromDate);
    stats.sklad = {
      movementCount: movements.length,
      kirimCount: movements.filter(m => m.type === 'kirim').length,
      chiqimCount: movements.filter(m => m.type === 'chiqim').length
    };
  }

  return sendOk(res, { stats });
});

authed('/api/shift-status', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['kassir', 'oshpaz', 'egasi'])) {
    return sendFail(res, 'Bu bo\'lim faqat kassir, oshpaz va egasi uchun');
  }
  const target = ctx.role === 'egasi' ? ctx.owner : (ctx.owner.staff || []).find(s => String(s.id) === userId);
  if (!target) return sendFail(res, 'Xodim topilmadi');

  return sendOk(res, { active: !!target.shiftActive, startedAt: target.shiftStartedAt || null });
});

authed('/api/shift-toggle', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['kassir', 'oshpaz', 'egasi'])) {
    return sendFail(res, 'Bu bo\'lim faqat kassir, oshpaz va egasi uchun');
  }
  const target = ctx.role === 'egasi' ? ctx.owner : (ctx.owner.staff || []).find(s => String(s.id) === userId);
  if (!target) return sendFail(res, 'Xodim topilmadi');
  if (!ownerCanUseFeature(ctx.owner, 'shift-toggle')) return sendFeatureBlocked(res, 'shift-toggle');

  const now = new Date().toISOString();
  if (target.shiftActive) {
    if (!ctx.owner.shiftHistory) ctx.owner.shiftHistory = [];
    ctx.owner.shiftHistory.unshift({
      id: crypto.randomBytes(4).toString('hex'),
      userId,
      role: ctx.role,
      startedAt: target.shiftStartedAt || now,
      endedAt: now
    });
    if (ctx.owner.shiftHistory.length > 1000) ctx.owner.shiftHistory.length = 1000;
    target.shiftActive = false;
    target.shiftStartedAt = null;
    logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'smena_tugatdi', note: 'Ish smenasini tugatdi' });
  } else {
    target.shiftActive = true;
    target.shiftStartedAt = now;
    logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'smena_boshladi', note: 'Ish smenasini boshladi' });
  }
  saveOwners(owners);

  return sendOk(res, { active: !!target.shiftActive, startedAt: target.shiftStartedAt || null });
});

authed('/api/update-order-status', async (payload, res, { userId }) => {
  const { orderId, status } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'kassir', 'oshpaz'])) {
    return sendFail(res, 'Bu amalga ruxsatingiz yo\'q');
  }
  if (!ownerCanUseFeature(ctx.owner, 'orders-manage')) return sendFeatureBlocked(res, 'orders-manage');

  if (!Object.prototype.hasOwnProperty.call(ORDER_STATUSES, status)) {
    return sendFail(res, 'Noto\'g\'ri holat.');
  }

  const order = (ctx.owner.orders || []).find(o => o.id === orderId);
  if (!order) return sendFail(res, 'Buyurtma topilmadi.');
  if (order.status === status) {
    return sendOk(res, { order });
  }
  if (!canSetOrderStatus(ctx, order, status)) {
    const reason = order.paymentProofStatus === 'kutilmoqda'
      ? 'Mijozning to\'lovi hali tasdiqlanmagan - avval to\'lovni tasdiqlang, shundan keyin buyurtma holatini o\'zgartirish mumkin.'
      : 'Bu buyurtma hozirgi holatidan bunday o\'tishni qabul qilmaydi (masalan, "Tayyorlanmoqda" bosqichisiz "Tayyor" deb belgilab bo\'lmaydi).';
    return sendJSON(res, 200, { ok: false, reason });
  }

  order.status = status;
  order.updatedAt = new Date().toISOString();
  order.updatedBy = userId;
  if (status === 'tayyorlanmoqda' && !order.startedAt) order.startedAt = order.updatedAt;
  if (status === 'tayyor' && !order.readyAt) order.readyAt = order.updatedAt;

  logStaffAction(ctx.owner, { userId, role: ctx.role, action: `holat_${status}`, orderId: order.id, note: `Buyurtma ${ORDER_STATUSES[status]} deb belgilandi` });
  saveOwners(owners);

  syncGroupMessagesForOrder(ctx.owner, order);
  if (status === 'tayyor') notifyDeliveryGroupOrderReady(ctx.owner, order);

  if (status === 'tayyor') {
    const itemsText = order.items.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
    const orderLabel = `${ORDER_TYPES[order.orderType] || order.orderType}`;
    const readyText = `✅ <b>Buyurtma tayyor</b> (${orderLabel})\n${itemsText}\n\nJami: ${fmtNum(order.total)} so'm`;

    const staffList = ctx.owner.staff || [];
    const targetRoles = order.orderType === 'dostavka' ? ['kassir', 'dostavka'] : ['kassir'];
    const targetIds = staffList.filter(s => targetRoles.includes(s.role)).map(s => s.id);
    for (const targetId of new Set(targetIds)) {
      if (String(targetId) === userId) continue;
      sendMessage(targetId, readyText);
    }
  }

  return sendOk(res, { order });
});

authed('/api/staff-mark-received', (payload, res, { userId }) => {
  const { orderId } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'kassir'])) {
    return sendFail(res, 'Bu amalga ruxsatingiz yo\'q');
  }
  if (!ownerCanUseFeature(ctx.owner, 'orders-manage')) return sendFeatureBlocked(res, 'orders-manage');

  const order = (ctx.owner.orders || []).find(o => o.id === orderId);
  if (!order) return sendFail(res, 'Buyurtma topilmadi.');
  if (order.orderType === 'dostavka') return sendFail(res, 'Dostavka buyurtmalarini kuryer belgilaydi.');
  if (order.status !== 'tayyor') return sendFail(res, 'Buyurtma hali tayyor emas.');
  if (order.customerReceivedAt) return sendFail(res, 'Bu buyurtma allaqachon olingan deb belgilangan.');

  order.customerReceivedAt = new Date().toISOString();
  order.customerReceivedBy = userId;
  logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'mijoz_oldi', orderId: order.id, note: `${fmtNum(order.total)} so'm — mijoz oldi deb belgilandi` });
  saveOwners(owners);

  // Dostavka buyurtmalarida (/api/deliver-order) qilingani kabi — mijoz
  // buyurtmasini olgach, xizmatni yulduzcha bilan baholashi so'raladi.
  sendOrderRatingRequest(ctx.owner, order);

  return sendOk(res, { order });
});

authed('/api/deliver-order', (payload, res, { userId }) => {
  const { orderId } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['dostavka', 'egasi'])) {
    return sendFail(res, 'Faqat kuryer bu amalni bajara oladi');
  }
  if (!ownerCanUseFeature(ctx.owner, 'orders-manage')) return sendFeatureBlocked(res, 'orders-manage');

  const order = (ctx.owner.orders || []).find(o => o.id === orderId);
  if (!order) return sendFail(res, 'Buyurtma topilmadi.');
  if (order.orderType !== 'dostavka') {
    return sendFail(res, 'Bu buyurtma dostavka turi emas.');
  }
  if (order.deliveredBy) {
    return sendFail(res, 'Bu buyurtma allaqachon yetkazilgan deb belgilangan.');
  }

  order.deliveredBy = userId;
  order.deliveredAt = new Date().toISOString();
  logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'yetkazdi', orderId: order.id, note: `${fmtNum(order.total)} so'm — yetkazib berildi` });
  saveOwners(owners);

  sendOrderRatingRequest(ctx.owner, order);

  return sendOk(res, { order });
});

authed('/api/reject-delivery-order', (payload, res, { userId }) => {
  const { orderId, reason, returnedItems } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['dostavka', 'egasi'])) {
    return sendFail(res, 'Faqat kuryer bu amalni bajara oladi');
  }
  if (!ownerCanUseFeature(ctx.owner, 'orders-manage')) return sendFeatureBlocked(res, 'orders-manage');

  const order = (ctx.owner.orders || []).find(o => o.id === orderId);
  if (!order) return sendFail(res, 'Buyurtma topilmadi.');
  if (order.orderType !== 'dostavka') {
    return sendFail(res, 'Bu buyurtma dostavka turi emas.');
  }
  if (order.deliveredBy) {
    return sendFail(res, 'Bu buyurtma allaqachon yetkazilgan deb belgilangan.');
  }
  if (order.status === 'bekor_qilindi') {
    return sendOk(res, { order });
  }

  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) {
    return sendFail(res, 'Bekor qilish sababini yozish majburiy.');
  }

  order.status = 'bekor_qilindi';
  order.cancelReason = trimmedReason.slice(0, 200);
  order.cancelledBy = userId;
  order.cancelledAt = new Date().toISOString();

  const returnedNotes = [];
  if (Array.isArray(returnedItems)) {
    for (const r of returnedItems) {
      const idx = Number(r && r.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= order.items.length) continue;
      const orderItem = order.items[idx];
      if (!orderItem || !orderItem.directStockId) continue;
      const returnQty = Math.min(Math.max(0, Math.floor(Number(r.qty) || 0)), orderItem.qty);
      if (returnQty <= 0) continue;
      const stockItem = findStockItem(ctx.owner, orderItem.directStockId);
      if (!stockItem) continue;
      stockItem.qty = Math.round((stockItem.qty + returnQty) * 1000) / 1000;
      addStockMovement(ctx.owner, {
        stockId: stockItem.id, stockName: stockItem.name, type: 'kirim',
        qty: returnQty, unit: stockItem.unit,
        note: `Bekor qilingan buyurtma #${order.id} — ochilmagan, skladga qaytarildi: ${orderItem.name} x${returnQty}`,
        userId
      });
      returnedNotes.push(`${orderItem.name} x${returnQty}`);
    }
  }
  if (returnedNotes.length) order.returnedToStock = returnedNotes;

  logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'dostavka_bekor', orderId: order.id, note: order.cancelReason });
  saveOwners(owners);

  syncGroupMessagesForOrder(ctx.owner, order);

  const itemsText = order.items.map(it => `• ${escapeHtmlServer(it.name)} x${it.qty}`).join('\n');
  const staffRecord = (ctx.owner.staff || []).find(s => String(s.id) === userId);
  const courierLabel = staffDisplayName(staffRecord) || `ID: ${userId}`;
  const returnedLine = returnedNotes.length
    ? `\nSkladga qaytarildi: ${escapeHtmlServer(returnedNotes.join(', '))}`
    : '';
  const alertText = `❌ <b>Dostavka bekor qilindi</b>\n${itemsText}\n\nJami: ${fmtNum(order.total)} so'm\nSabab: ${escapeHtmlServer(order.cancelReason)}\nKuryer: ${escapeHtmlServer(courierLabel)}${returnedLine}`;
  const staffList = ctx.owner.staff || [];
  const targetIds = staffList.filter(s => ['egasi', 'kassir'].includes(s.role)).map(s => s.id);
  for (const targetId of new Set([ctx.owner.id, ...targetIds])) {
    if (String(targetId) === userId) continue;
    sendMessage(targetId, alertText);
  }

  if (order.customerId) {
    sendMessage(order.customerId, '❌ Kechirasiz, dostavka buyurtmangiz bekor qilindi (yetkazib berish amalga oshmadi). Savol bo\'lsa, oshxonaga murojaat qiling.');
  }

  return sendOk(res, { order });
});

authed('/api/undo-deliver-order', (payload, res, { userId }) => {
  const { orderId } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasRole(ctx, 'egasi')) {
    return sendFail(res, 'Faqat oshxona egasi bu amalni bajara oladi');
  }
  if (!ownerCanUseFeature(ctx.owner, 'orders-manage')) return sendFeatureBlocked(res, 'orders-manage');

  const order = (ctx.owner.orders || []).find(o => o.id === orderId);
  if (!order) return sendFail(res, 'Buyurtma topilmadi.');
  if (!order.deliveredBy) {
    return sendFail(res, 'Bu buyurtma "Yetkazildi" deb belgilanmagan.');
  }

  const previousDeliveredBy = order.deliveredBy;
  order.deliveredBy = null;
  order.deliveredAt = null;
  logStaffAction(ctx.owner, {
    userId, role: ctx.role, action: 'yetkazish_bekor',
    orderId: order.id,
    note: `"Yetkazildi" belgisi bekor qilindi (avval: ${previousDeliveredBy})`
  });
  saveOwners(owners);

  return sendOk(res, { order });
});

authed('/api/stock-list', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'sklad'])) {
    return sendFail(res, 'Bu bo\'limni ko\'rishga ruxsatingiz yo\'q');
  }

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveStockPool(ctx.owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  const stock = (pool.stock || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'uz'));
  return sendOk(res, { stock, units: STOCK_UNITS, branches: ctx.owner.branches || [], branchId });
});

authed('/api/stock-add', (payload, res, { userId }) => {
  const { name, qty, unit, price, minQty } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'sklad'])) {
    return sendFail(res, 'Bu amalga ruxsatingiz yo\'q');
  }
  if (!ctx.isAdminActing && !ownerCanUseFeature(ctx.owner, 'stock-manage')) return sendFeatureBlocked(res, 'stock-manage');

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveStockPool(ctx.owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  const nameTrim = String(name || '').trim();
  const qtyNum = Number(qty);
  if (!nameTrim) return sendFail(res, 'Mahsulot nomini kiriting.');
  if (!Object.prototype.hasOwnProperty.call(STOCK_UNITS, unit)) {
    return sendFail(res, 'Birlikni tanlang (kg, g, l, ml, dona).');
  }
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    return sendFail(res, 'Miqdorni to\'g\'ri kiriting.');
  }

  if (price === undefined || price === null || price === '') {
    return sendFail(res, 'Narxni kiriting — u avtomatik xarajat yozish uchun kerak.');
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return sendFail(res, 'Narx musbat son bo\'lishi kerak.');
  }
  let minQtyNum = null;
  if (minQty !== undefined && minQty !== null && minQty !== '') {
    minQtyNum = Number(minQty);
    if (!Number.isFinite(minQtyNum) || minQtyNum < 0) return sendFail(res, 'Kam qolish chegarasi musbat son bo\'lishi kerak.');
  }

  if (!pool.stock) pool.stock = [];
  let item = pool.stock.find(s => s.name.toLowerCase() === nameTrim.toLowerCase() && s.unit === unit);

  if (item) {
    item.qty = Math.round((item.qty + qtyNum) * 1000) / 1000;
    if (priceNum) item.price = priceNum;
    if (minQtyNum !== null) item.minQty = minQtyNum;
  } else {
    item = {
      id: crypto.randomBytes(4).toString('hex'),
      name: nameTrim,
      qty: qtyNum,
      unit,
      price: priceNum,
      minQty: minQtyNum,
      lowStockAlertSent: false,
      addedAt: new Date().toISOString()
    };
    pool.stock.push(item);
  }

  addStockMovement(pool, {
    stockId: item.id, stockName: item.name, type: 'kirim',
    qty: qtyNum, unit, note: 'Qo\'lda kiritildi', userId
  });
  checkLowStockAlert(ctx.owner, item, userId, branchId);
  logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'sklad_kirim', note: `${item.name}: +${qtyNum} ${unit}` });

  if (!ctx.owner.expenses) ctx.owner.expenses = [];
  ctx.owner.expenses.unshift({
    id: crypto.randomBytes(4).toString('hex'),
    amount: Math.round(qtyNum * priceNum * 100) / 100,
    category: 'sklad_xarid',
    note: `${item.name} — ${qtyNum} ${unit}`,
    createdAt: new Date().toISOString(),
    createdBy: userId,
    source: 'stock',
    stockId: item.id
  });
  if (ctx.owner.expenses.length > 500) ctx.owner.expenses.length = 500;

  saveOwners(owners);

  return sendOk(res, { item });
});

authed('/api/stock-remove', (payload, res, { userId }) => {
  const { id, branchId } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ctx.owner;
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const pool = resolveStockPool(owner, branchId || null);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  pool.stock = (pool.stock || []).filter(s => s.id !== id);

  if (!branchId) {
    (owner.menu || []).forEach(m => {
      if (Array.isArray(m.recipe)) m.recipe = m.recipe.filter(r => r.stockId !== id);
    });
  }
  saveOwners(owners);

  return sendOk(res);
});

// Buzilgan/isrof bo'lgan sklad mahsulotini spisaniya qilish (masalan: katlet
// kuysa, non qotib qolsa yoki yirtilsa) — miqdor ombordan ayiriladi, sababi
// harakatlar tarixiga yoziladi va yo'qotish summasi Moliyaga xarajat sifatida tushadi.
authed('/api/stock-writeoff', (payload, res, { userId }) => {
  const { id, qty, reason, note, branchId } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'sklad'])) {
    return sendFail(res, 'Bu amalga ruxsatingiz yo\'q');
  }
  if (!ctx.isAdminActing && !ownerCanUseFeature(ctx.owner, 'stock-manage')) return sendFeatureBlocked(res, 'stock-manage');

  const resolvedBranchId = ctx.role === 'egasi' ? (branchId || null) : ctx.branchId;
  const pool = resolveStockPool(ctx.owner, resolvedBranchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  if (!id) return sendFail(res, 'Mahsulot tanlanmagan.');
  const item = findStockItem(pool, id);
  if (!item) return sendFail(res, 'Bunday mahsulot omborda topilmadi.');

  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    return sendFail(res, 'Miqdorni to\'g\'ri kiriting.');
  }
  if (qtyNum > item.qty) {
    return sendFail(res, `Omborda yetarli emas (bor: ${item.qty} ${item.unit}).`);
  }
  if (!Object.prototype.hasOwnProperty.call(WRITEOFF_REASONS, reason)) {
    return sendFail(res, 'Spisaniya sababini tanlang.');
  }
  const noteTrim = String(note || '').trim().slice(0, 200);
  if (reason === 'boshqa' && !noteTrim) {
    return sendFail(res, '"Boshqa sabab" tanlansa, izoh yozish shart.');
  }

  item.qty = Math.max(0, Math.round((item.qty - qtyNum) * 1000) / 1000);
  const reasonLabel = WRITEOFF_REASONS[reason];
  const movementNote = `Spisaniya: ${reasonLabel}${noteTrim ? ' — ' + noteTrim : ''}`;

  addStockMovement(pool, {
    stockId: item.id, stockName: item.name, type: 'chiqim',
    qty: qtyNum, unit: item.unit, note: movementNote, userId
  });
  checkLowStockAlert(ctx.owner, item, userId, resolvedBranchId);
  logStaffAction(ctx.owner, { userId, role: ctx.role, action: 'sklad_spisaniya', note: `${item.name}: -${qtyNum} ${item.unit} (${reasonLabel})` });

  const lossAmount = Math.round(qtyNum * (item.price || 0) * 100) / 100;
  if (lossAmount > 0) {
    if (!ctx.owner.expenses) ctx.owner.expenses = [];
    ctx.owner.expenses.unshift({
      id: crypto.randomBytes(4).toString('hex'),
      amount: lossAmount,
      category: 'spisaniya',
      note: `${item.name} — ${qtyNum} ${item.unit} (${reasonLabel}${noteTrim ? ': ' + noteTrim : ''})`,
      createdAt: new Date().toISOString(),
      createdBy: userId,
      source: 'stock',
      stockId: item.id
    });
    if (ctx.owner.expenses.length > 500) ctx.owner.expenses.length = 500;
  }

  saveOwners(owners);
  return sendOk(res, { item, lossAmount });
});

authed('/api/stock-movements', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'sklad'])) {
    return sendFail(res, 'Bu bo\'limni ko\'rishga ruxsatingiz yo\'q');
  }

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveStockPool(ctx.owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  const movements = (pool.stockMovements || []).slice(0, 200);
  return sendOk(res, { movements });
});

authed('/api/stock-transfer', (payload, res, { userId }) => {
  const { stockId, branchId, qty } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi transfer qila oladi');
  const owner = ownerCtx.owner;

  if (!branchId) return sendFail(res, 'Qaysi filialga o\'tkazishni tanlang.');
  const branch = findBranch(owner, branchId);
  if (!branch) return sendFail(res, 'Bunday filial topilmadi.');

  const centralItem = findStockItem(owner, stockId);
  if (!centralItem) return sendFail(res, 'Markaziy skladda bunday mahsulot topilmadi.');

  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    return sendFail(res, 'Miqdorni to\'g\'ri kiriting.');
  }
  if (qtyNum > centralItem.qty) {
    return sendFail(res, `Markaziy skladda yetarli emas (bor: ${centralItem.qty} ${centralItem.unit}).`);
  }

  centralItem.qty = Math.round((centralItem.qty - qtyNum) * 1000) / 1000;
  addStockMovement(owner, {
    stockId: centralItem.id, stockName: centralItem.name, type: 'chiqim',
    qty: qtyNum, unit: centralItem.unit,
    note: `Filialga o'tkazildi: ${branch.name}`, userId
  });
  checkLowStockAlert(owner, centralItem, userId, null);

  if (!branch.stock) branch.stock = [];
  let branchItem = branch.stock.find(s => s.name.toLowerCase() === centralItem.name.toLowerCase() && s.unit === centralItem.unit);
  if (branchItem) {
    branchItem.qty = Math.round((branchItem.qty + qtyNum) * 1000) / 1000;
  } else {
    branchItem = {
      id: crypto.randomBytes(4).toString('hex'),
      name: centralItem.name,
      qty: qtyNum,
      unit: centralItem.unit,
      price: centralItem.price || 0,
      minQty: null,
      lowStockAlertSent: false,
      addedAt: new Date().toISOString()
    };
    branch.stock.push(branchItem);
  }
  addStockMovement(branch, {
    stockId: branchItem.id, stockName: branchItem.name, type: 'kirim',
    qty: qtyNum, unit: branchItem.unit,
    note: 'Markaziy skladdan transfer', userId
  });
  checkLowStockAlert(owner, branchItem, userId, branchId);

  saveOwners(owners);
  return sendOk(res, { centralItem, branchItem });
});

authed('/api/menu-set-recipe', (payload, res, { userId }) => {
  const { menuId, recipe } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId, { targetOwnerId: payload.targetOwnerId });
  if (!ctx) return denyAccess(res, owners, userId, 'Faqat oshxona egasi retsept belgilay oladi');
  const owner = ctx.owner;

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveMenuPool(owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');
  const stockPool = resolveStockPool(owner, branchId);

  const menuItem = (pool.menu || []).find(m => m.id === menuId);
  if (!menuItem) return sendFail(res, 'Taom topilmadi.');
  if (!Array.isArray(recipe)) return sendFail(res, 'Noto\'g\'ri retsept formati.');

  if (menuItem.directStockId && recipe.length) {
    return sendFail(res, 'Bu taom "to\'g\'ridan skladdan" turida — unga alohida retsept qo\'shib bo\'lmaydi.');
  }

  const cleanRecipe = [];
  for (const r of recipe) {
    const stockItem = findStockItem(stockPool, r.stockId);
    if (!stockItem) return sendFail(res, 'Retseptda mavjud bo\'lmagan sklad mahsuloti bor.');
    const qtyNum = Number(r.qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) return sendFail(res, 'Retsept miqdori musbat son bo\'lishi kerak.');
    cleanRecipe.push({ stockId: r.stockId, qty: qtyNum });
  }

  menuItem.recipe = cleanRecipe;
  saveOwners(owners);

  return sendOk(res, { menuItem });
});

authed('/api/audit-submit', (payload, res, { userId }) => {
  const { entries } = payload;

  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'sklad'])) {
    return sendFail(res, 'Bu amalga ruxsatingiz yo\'q');
  }
  if (!ownerCanUseFeature(ctx.owner, 'audit')) return sendFeatureBlocked(res, 'audit');
  if (!Array.isArray(entries) || !entries.length) {
    return sendFail(res, 'Audit uchun kamida bitta mahsulot kiriting.');
  }

  const branchId = ctx.role === 'egasi' ? (payload.branchId || null) : ctx.branchId;
  const pool = resolveStockPool(ctx.owner, branchId);
  if (!pool) return sendFail(res, 'Bunday filial topilmadi');

  const auditEntries = [];
  for (const e of entries) {
    const stockItem = findStockItem(pool, e.stockId);
    if (!stockItem) continue;
    const actualNum = Number(e.actualQty);
    if (!Number.isFinite(actualNum) || actualNum < 0) {
      return sendFail(res, `${stockItem.name} uchun haqiqiy qoldiqni to\'g\'ri kiriting.`);
    }
    const systemQty = stockItem.qty;
    const diff = Math.round((actualNum - systemQty) * 1000) / 1000;
    auditEntries.push({ stockId: stockItem.id, name: stockItem.name, unit: stockItem.unit, systemQty, actualQty: actualNum, diff });

    if (diff !== 0) {
      addStockMovement(pool, {
        stockId: stockItem.id, stockName: stockItem.name, type: 'audit_tuzatish',
        qty: diff, unit: stockItem.unit,
        note: diff > 0 ? 'Audit: ortiqcha topildi' : 'Audit: kamomad topildi',
        userId
      });
    }
    stockItem.qty = actualNum;
    checkLowStockAlert(ctx.owner, stockItem, userId, branchId);
  }

  if (!auditEntries.length) {
    return sendFail(res, 'Hech qanday mos mahsulot topilmadi.');
  }

  if (!pool.audits) pool.audits = [];
  const audit = {
    id: crypto.randomBytes(4).toString('hex'),
    date: new Date().toISOString().slice(0, 10),
    branchId,
    entries: auditEntries,
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
  pool.audits.unshift(audit);
  if (pool.audits.length > 60) pool.audits.length = 60;

  const kamomadCount = auditEntries.filter(e => e.diff < 0).length;
  const ortiqchaCount = auditEntries.filter(e => e.diff > 0).length;
  logStaffAction(ctx.owner, {
    userId, role: ctx.role, action: 'audit_topshirdi',
    note: `${auditEntries.length} mahsulot tekshirildi${kamomadCount ? `, ${kamomadCount} ta kamomad` : ''}${ortiqchaCount ? `, ${ortiqchaCount} ta ortiqcha` : ''}`,
    errorCount: kamomadCount
  });

  saveOwners(owners);
  return sendOk(res, { audit });
});


const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

function tzDateKey(input) {
  const d = (input instanceof Date) ? input : new Date(input);
  return new Date(d.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

function tzDayStartFromKey(dateKey) {
  return new Date(new Date(dateKey + 'T00:00:00.000Z').getTime() - TASHKENT_OFFSET_MS);
}

function tzDayStart(input) {
  return tzDayStartFromKey(tzDateKey(input));
}

function tzWeekStart(input) {
  const d = (input instanceof Date) ? input : new Date(input);
  const shifted = new Date(d.getTime() + TASHKENT_OFFSET_MS);
  const day = shifted.getUTCDay();
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const mondayKey = new Date(shifted.getTime() + diffToMonday * 86400000).toISOString().slice(0, 10);
  return tzDayStartFromKey(mondayKey);
}

function tzMonthStart(input) {
  const d = (input instanceof Date) ? input : new Date(input);
  const shifted = new Date(d.getTime() + TASHKENT_OFFSET_MS);
  const monthKey = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return tzDayStartFromKey(monthKey);
}

// branchId === undefined -> barcha joylashuvlar (markaziy + filiallar) birga.
// branchId === null -> faqat markaziy. branchId === '<id>' -> faqat shu filial.
function matchesBranchFilter(item, branchId) {
  if (branchId === undefined) return true;
  return (item.branchId || null) === (branchId || null);
}

function cashflowBucket(owner, fromDate, branchId) {
  const orders = (owner.orders || []).filter(o => new Date(o.createdAt) >= fromDate && matchesBranchFilter(o, branchId));
  const expenses = (owner.expenses || []).filter(e => new Date(e.createdAt) >= fromDate && matchesBranchFilter(e, branchId));

  const dostavkaOrders = orders.filter(o => o.orderType === 'dostavka' && o.paymentType === 'dostavka_orqali');
  const kassaOrders = orders.filter(o => !(o.orderType === 'dostavka' && o.paymentType === 'dostavka_orqali'));
  const kassaIncome = kassaOrders.reduce((sum, o) => sum + orderIncomeAmount(o), 0);
  const dostavkaIncome = dostavkaOrders.reduce((sum, o) => sum + orderIncomeAmount(o), 0);
  const income = kassaIncome + dostavkaIncome;
  const expense = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

  const paymentBreakdown = {};
  for (const key of Object.keys(PAYMENT_TYPES)) paymentBreakdown[key] = 0;
  for (const o of orders) {
    const pt = Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, o.paymentType) ? o.paymentType : 'naqd';
    paymentBreakdown[pt] = (paymentBreakdown[pt] || 0) + orderIncomeAmount(o);
  }

  const kassaBreakdown = {};
  for (const key of Object.keys(PAYMENT_TYPES)) kassaBreakdown[key] = 0;
  for (const o of kassaOrders) {
    const pt = Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, o.paymentType) ? o.paymentType : 'naqd';
    kassaBreakdown[pt] = (kassaBreakdown[pt] || 0) + orderIncomeAmount(o);
  }

  const byCategory = {};
  for (const key of Object.keys(EXPENSE_CATEGORIES)) byCategory[key] = 0;
  for (const e of expenses) {
    const cat = Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORIES, e.category) ? e.category : 'boshqa';
    byCategory[cat] = (byCategory[cat] || 0) + (e.amount || 0);
  }

  return {
    income, expense, net: income - expense, orderCount: orders.length, byCategory,
    kassaIncome, dostavkaIncome, dostavkaOrderCount: dostavkaOrders.length, paymentBreakdown, kassaBreakdown
  };
}

function computeCashflow(owner, branchId) {
  const now = new Date();
  const todayStart = tzDayStart(now);
  const weekStart = tzWeekStart(now);
  const monthStart = tzMonthStart(now);

  const orders = (owner.orders || []).filter(o => matchesBranchFilter(o, branchId));
  const expenses = (owner.expenses || []).filter(e => matchesBranchFilter(e, branchId));
  const dailySeries = [];

  for (let i = 13; i >= 0; i--) {
    const dayStart = new Date(todayStart.getTime() - i * 86400000);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const key = tzDateKey(dayStart);
    const dayIncome = orders.filter(o => { const t = new Date(o.createdAt); return t >= dayStart && t < dayEnd; }).reduce((s, o) => s + orderIncomeAmount(o), 0);
    const dayExpense = expenses.filter(e => { const t = new Date(e.createdAt); return t >= dayStart && t < dayEnd; }).reduce((s, e) => s + (e.amount || 0), 0);
    dailySeries.push({ date: key, income: dayIncome, expense: dayExpense, net: dayIncome - dayExpense });
  }

  return {
    today: cashflowBucket(owner, todayStart, branchId),
    week: cashflowBucket(owner, weekStart, branchId),
    month: cashflowBucket(owner, monthStart, branchId),
    dailySeries
  };
}

authed('/api/expense-add', (payload, res, { userId }) => {
  const { amount, note, category, branchId } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi xarajat kirita oladi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'expense-manage')) return sendFeatureBlocked(res, 'expense-manage');

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return sendFail(res, 'Summani to\'g\'ri kiriting.');
  }
  const categoryKey = Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORIES, category) ? category : 'boshqa';
  const noteStr = String(note || '').trim().slice(0, 200);
  let branchIdVal = null;
  if (branchId) {
    if (!findBranch(owner, branchId)) return sendFail(res, 'Bunday filial topilmadi.');
    branchIdVal = branchId;
  }

  if (!owner.expenses) owner.expenses = [];
  const expense = {
    id: crypto.randomBytes(4).toString('hex'),
    amount: amountNum,
    category: categoryKey,
    note: noteStr,
    branchId: branchIdVal,
    createdAt: new Date().toISOString(),
    createdBy: userId
  };
  owner.expenses.unshift(expense);
  if (owner.expenses.length > 500) owner.expenses.length = 500;
  saveOwners(owners);

  return sendOk(res, { expense });
});

authed('/api/expense-remove', (payload, res, { userId }) => {
  const { id } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'chira oladi');
  const owner = ownerCtx.owner;
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const before = (owner.expenses || []).length;
  owner.expenses = (owner.expenses || []).filter(e => e.id !== id);
  saveOwners(owners);

  return sendOk(res, { removed: before !== owner.expenses.length });
});

authed('/api/cashflow', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'cashflow')) return sendFeatureBlocked(res, 'cashflow');

  const branchId = Object.prototype.hasOwnProperty.call(payload, 'branchId') ? (payload.branchId || null) : undefined;
  const cashflow = computeCashflow(owner, branchId);
  const recentExpenses = (owner.expenses || []).filter(e => matchesBranchFilter(e, branchId)).slice(0, 30);

  return sendOk(res, { cashflow, expenses: recentExpenses, categories: EXPENSE_CATEGORIES, branches: owner.branches || [], centralBranchName: owner.centralBranchName || null });
});

authed('/api/dashboard-summary', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'dashboard')) return sendFeatureBlocked(res, 'dashboard');

  const branchId = Object.prototype.hasOwnProperty.call(payload, 'branchId') ? payload.branchId : undefined;

  const now = new Date();
  const todayStart = tzDayStart(now);
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);

  const today = cashflowBucket(owner, todayStart, branchId);

  const yesterdayOrders = (owner.orders || []).filter(o => {
    const d = new Date(o.createdAt);
    return d >= yesterdayStart && d < todayStart && matchesBranchFilter(o, branchId);
  });
  const yesterdayIncome = yesterdayOrders.reduce((s, o) => s + orderIncomeAmount(o), 0);
  const yesterdayExpense = (owner.expenses || []).filter(e => {
    const d = new Date(e.createdAt);
    return d >= yesterdayStart && d < todayStart && matchesBranchFilter(e, branchId);
  }).reduce((s, e) => s + (e.amount || 0), 0);

  const todayCourierDeliveries = (owner.orders || []).filter(o =>
    o.orderType === 'dostavka' && o.deliveredBy && new Date(o.deliveredAt || o.createdAt) >= todayStart && matchesBranchFilter(o, branchId)).length;
  const yesterdayCourierDeliveries = (owner.orders || []).filter(o => {
    if (o.orderType !== 'dostavka' || !o.deliveredBy) return false;
    const d = new Date(o.deliveredAt || o.createdAt);
    return d >= yesterdayStart && d < todayStart && matchesBranchFilter(o, branchId);
  }).length;

  const summary = {
    todaySales: today.income,
    yesterdaySales: yesterdayIncome,
    todayNetProfit: today.net,
    yesterdayNetProfit: yesterdayIncome - yesterdayExpense,
    todayOrderCount: today.orderCount,
    yesterdayOrderCount: yesterdayOrders.length,
    todayCourierDeliveries,
    yesterdayCourierDeliveries
  };

  return sendOk(res, { summary });
});

authed('/api/order-status-counts', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'dashboard')) return sendFeatureBlocked(res, 'dashboard');

  const branchId = Object.prototype.hasOwnProperty.call(payload, 'branchId') ? payload.branchId : undefined;

  const now = new Date();
  const todayStart = tzDayStart(now);
  const thresholdMs = ORDER_DELAY_THRESHOLD_MINUTES * 60 * 1000;

  const todaysOrders = (owner.orders || []).filter(o => new Date(o.createdAt) >= todayStart && matchesBranchFilter(o, branchId));

  let yangi = 0, tayyorlanmoqda = 0, tayyor = 0, kechikayotgan = 0;
  for (const o of todaysOrders) {
    if (o.status === 'bekor_qilindi') continue;
    if (o.status === 'tayyor') { tayyor += 1; continue; }
    const ageMs = now - new Date(o.createdAt);
    if (ageMs > thresholdMs) { kechikayotgan += 1; continue; }
    if (o.status === 'tayyorlanmoqda') tayyorlanmoqda += 1;
    else yangi += 1;
  }

  return sendOk(res, {
    counts: { yangi, tayyorlanmoqda, tayyor, kechikayotgan },
    delayThresholdMinutes: ORDER_DELAY_THRESHOLD_MINUTES
  });
});

authed('/api/dashboard-alerts', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'dashboard')) return sendFeatureBlocked(res, 'dashboard');

  const branchId = Object.prototype.hasOwnProperty.call(payload, 'branchId') ? payload.branchId : undefined;
  const alerts = [];

  const stockPools = branchId === undefined
    ? [owner, ...(owner.branches || [])]
    : (branchId === null ? [owner] : [findBranch(owner, branchId)].filter(Boolean));
  let lowStockCount = 0;
  for (const pool of stockPools) {
    for (const item of (pool.stock || [])) {
      if (item.minQty === null || item.minQty === undefined) continue;
      if (item.qty <= item.minQty) lowStockCount += 1;
    }
  }
  if (lowStockCount > 0) {
    alerts.push({
      type: 'low_stock', level: 'error', text: 'Tugayotgan mahsulotlar bor',
      count: lowStockCount, screen: 'ombor'
    });
  }

  const now = new Date();
  const todayStart = tzDayStart(now);
  const thresholdMs = ORDER_DELAY_THRESHOLD_MINUTES * 60 * 1000;
  const todaysOrders = (owner.orders || []).filter(o => new Date(o.createdAt) >= todayStart && matchesBranchFilter(o, branchId));
  let delayedCount = 0;
  for (const o of todaysOrders) {
    if (o.status === 'tayyor') continue;
    if ((now - new Date(o.createdAt)) > thresholdMs) delayedCount += 1;
  }
  if (delayedCount > 0) {
    alerts.push({
      type: 'delayed_orders', level: 'warning', text: 'Kechikayotgan buyurtmalar',
      count: delayedCount, screen: 'buyurtmalar_kechikkan'
    });
  }

  const todayDateKey = tzDateKey(now);
  const dailyReportClosed = (owner.zReports || []).some(z => z.date === todayDateKey && (branchId === undefined || (z.branchId || null) === (branchId || null)));
  if (!dailyReportClosed) {
    alerts.push({
      type: 'daily_report_open', level: 'info', text: 'Bugungi kun yakuni uchun hisob yopilmagan',
      count: null, screen: 'zreport'
    });
  }

  return sendOk(res, { alerts });
});

function resolvePeriodStart(period) {
  const now = new Date();
  if (period === 'week') return tzWeekStart(now);
  if (period === 'month') return tzMonthStart(now);
  if (period === 'all') return new Date(0);
  return tzDayStart(now);
}

authed('/api/branch-report', (payload, res, { userId }) => {
  const { period } = payload;

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  const fromDate = resolvePeriodStart(period);
  const orders = (owner.orders || []).filter(o => new Date(o.createdAt) >= fromDate);

  const buckets = new Map();
  buckets.set(null, { branchId: null, branchName: owner.centralBranchName || 'Markaziy', orderCount: 0, income: 0, kassaIncome: 0, dostavkaIncome: 0 });
  for (const b of (owner.branches || [])) {
    buckets.set(b.id, { branchId: b.id, branchName: b.name, orderCount: 0, income: 0, kassaIncome: 0, dostavkaIncome: 0 });
  }

  for (const o of orders) {
    const key = buckets.has(o.branchId || null) ? (o.branchId || null) : null;
    const bucket = buckets.get(key);
    bucket.orderCount += 1;
    bucket.income += orderIncomeAmount(o);
    if (o.orderType === 'dostavka' && o.paymentType === 'dostavka_orqali') bucket.dostavkaIncome += orderIncomeAmount(o);
    else bucket.kassaIncome += orderIncomeAmount(o);
  }

  const report = Array.from(buckets.values())
    .map(b => Object.assign({}, b, { avgCheck: b.orderCount ? Math.round(b.income / b.orderCount) : 0 }))
    .sort((a, b) => b.income - a.income);

  return sendOk(res, { report });
});

authed('/api/restricted-customers', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  const customers = [];
  for (const c of (owner.customers || [])) {
    const cancelledCount = customerCancelledDeliveryCount(owner, c.id);
    if (cancelledCount < CARD_ONLY_AFTER_CANCELLED_DELIVERIES) continue;
    const recentCancellations = (owner.orders || [])
      .filter(o => String(o.customerId) === String(c.id) && o.orderType === 'dostavka' && o.status === 'bekor_qilindi')
      .sort((a, b) => new Date(b.cancelledAt || b.createdAt) - new Date(a.cancelledAt || a.createdAt))
      .slice(0, 5)
      .map(o => ({ reason: o.cancelReason || null, cancelledAt: o.cancelledAt || o.createdAt, total: o.total || 0 }));
    customers.push({
      id: c.id,
      name: c.firstName || c.username || `ID: ${c.id}`,
      username: c.username || null,
      cancelledCount,
      restricted: customerIsCardOnlyRestricted(owner, c.id),
      recentCancellations
    });
  }
  customers.sort((a, b) => b.cancelledCount - a.cancelledCount);

  return sendOk(res, { customers });
});

authed('/api/owner-reviews', (payload, res, { userId }) => {
  const { targetOwnerId } = payload;

  const owners = loadOwners();
  let owner;
  if (targetOwnerId && isAdminId(userId)) {
    owner = findOwner(owners, targetOwnerId);
    if (!owner) return sendFail(res, 'Bunday oshxona topilmadi.');
  } else {
    owner = findOwner(owners, userId);
    if (!isOwnerAccessValid(owner)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga (yoki adminga) ko\'rinadi');
  }

  const rating = ownerAverageRating(owner);
  const reviews = ownerRatedOrders(owner)
    .sort((a, b) => new Date(b.customerRatedAt) - new Date(a.customerRatedAt))
    .slice(0, 200)
    .map(o => ({
      orderId: o.id,
      stars: o.customerRating,
      comment: o.customerComment || null,
      ratedAt: o.customerRatedAt,
      customerName: (findCustomer(owner, o.customerId) || {}).firstName || o.customerName || null
    }));

  return sendOk(res, { avgRating: rating.avg, ratingCount: rating.count, reviews });
});

authed('/api/toggle-customer-restriction', (payload, res, { userId }) => {
  const { customerId, action } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  if (!customerId) return sendFail(res, 'Mijoz tanlanmagan.');
  if (!Array.isArray(owner.cardOnlyOverrides)) owner.cardOnlyOverrides = [];

  if (action === 'clear') {
    if (!owner.cardOnlyOverrides.some(id => String(id) === String(customerId))) {
      owner.cardOnlyOverrides.push(String(customerId));
    }
  } else if (action === 'restore') {
    owner.cardOnlyOverrides = owner.cardOnlyOverrides.filter(id => String(id) !== String(customerId));
  } else {
    return sendFail(res, 'Noto\'g\'ri amal.');
  }

  saveOwners(owners);
  return sendOk(res, { restricted: customerIsCardOnlyRestricted(owner, customerId) });
});

function buildZReport(owner, dateKey, branchId) {
  const dayStart = tzDayStartFromKey(dateKey);
  const dayEnd = new Date(dayStart.getTime() + 86400000);

  const orders = (owner.orders || []).filter(o => {
    const t = new Date(o.createdAt);
    return t >= dayStart && t < dayEnd && matchesBranchFilter(o, branchId);
  });
  const expenses = (owner.expenses || []).filter(e => {
    const t = new Date(e.createdAt);
    return t >= dayStart && t < dayEnd && matchesBranchFilter(e, branchId);
  });

  const dostavkaOrders = orders.filter(o => o.orderType === 'dostavka' && o.paymentType === 'dostavka_orqali');
  const kassaOrders = orders.filter(o => !(o.orderType === 'dostavka' && o.paymentType === 'dostavka_orqali'));
  const kassaIncome = kassaOrders.reduce((s, o) => s + orderIncomeAmount(o), 0);
  const dostavkaIncome = dostavkaOrders.reduce((s, o) => s + orderIncomeAmount(o), 0);
  const income = kassaIncome + dostavkaIncome;

  const paymentBreakdown = {};
  for (const key of Object.keys(PAYMENT_TYPES)) paymentBreakdown[key] = 0;
  for (const o of orders) {
    const pt = Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, o.paymentType) ? o.paymentType : 'naqd';
    paymentBreakdown[pt] = (paymentBreakdown[pt] || 0) + orderIncomeAmount(o);
  }

  const kassaBreakdown = {};
  for (const key of Object.keys(PAYMENT_TYPES)) kassaBreakdown[key] = 0;
  for (const o of kassaOrders) {
    const pt = Object.prototype.hasOwnProperty.call(PAYMENT_TYPES, o.paymentType) ? o.paymentType : 'naqd';
    kassaBreakdown[pt] = (kassaBreakdown[pt] || 0) + orderIncomeAmount(o);
  }

  const expenseByCategory = {};
  for (const key of Object.keys(EXPENSE_CATEGORIES)) expenseByCategory[key] = 0;
  for (const e of expenses) {
    const cat = Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORIES, e.category) ? e.category : 'boshqa';
    expenseByCategory[cat] = (expenseByCategory[cat] || 0) + (e.amount || 0);
  }
  const expense = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  return {
    date: dateKey,
    income, kassaIncome, dostavkaIncome, orderCount: orders.length,
    paymentBreakdown, expense, expenseByCategory, net: income - expense, kassaBreakdown
  };
}

authed('/api/z-report-create', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'z-report')) return sendFeatureBlocked(res, 'z-report');

  const branchId = payload.branchId ? (findBranch(owner, payload.branchId) ? payload.branchId : null) : null;
  const dateKey = tzDateKey(new Date());
  const built = buildZReport(owner, dateKey, branchId);

  if (!owner.zReports) owner.zReports = [];
  const existing = owner.zReports.find(z => z.date === dateKey && (z.branchId || null) === (branchId || null));
  const report = Object.assign({
    id: existing ? existing.id : crypto.randomBytes(4).toString('hex'),
    branchId: branchId || null,
    createdAt: new Date().toISOString(),
    createdBy: userId
  }, built);

  if (existing) {
    Object.assign(existing, report);
  } else {
    owner.zReports.unshift(report);
  }
  if (owner.zReports.length > 90) owner.zReports.length = 90;
  saveOwners(owners);

  return sendOk(res, { report, wasUpdate: !!existing });
});

authed('/api/z-report-list', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  const branchId = Object.prototype.hasOwnProperty.call(payload, 'branchId') ? (payload.branchId || null) : undefined;
  const reports = (owner.zReports || [])
    .filter(z => matchesBranchFilter(z, branchId))
    .slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  return sendOk(res, { reports, branches: owner.branches || [], centralBranchName: owner.centralBranchName || null });
});

const UZ_WEEKDAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];

function computeTopItems(owner, fromDate, limit) {
  const orders = (owner.orders || []).filter(o => new Date(o.createdAt) >= fromDate);
  const byId = new Map();
  for (const o of orders) {
    for (const it of (o.items || [])) {
      const cur = byId.get(it.id) || { id: it.id, name: it.name, qty: 0, revenue: 0 };
      cur.qty += it.qty;
      cur.revenue += it.price * it.qty;
      byId.set(it.id, cur);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.qty - a.qty).slice(0, limit || 5);
}

function computePeakTimes(owner, fromDate) {
  const orders = (owner.orders || []).filter(o => new Date(o.createdAt) >= fromDate);
  const byHour = new Array(24).fill(0);
  const byDay = new Array(7).fill(0);
  for (const o of orders) {
    const d = new Date(o.createdAt);
    byHour[d.getHours()]++;
    byDay[d.getDay()]++;
  }
  const hours = byHour.map((count, hour) => ({ hour, count })).sort((a, b) => b.count - a.count);
  const days = byDay.map((count, day) => ({ day, dayLabel: UZ_WEEKDAYS[day], count })).sort((a, b) => b.count - a.count);
  return { byHour, byDay, topHours: hours.filter(h => h.count > 0).slice(0, 3), topDays: days.filter(d => d.count > 0).slice(0, 3) };
}

function computeStockForecast(owner, branchId) {
  const pool = resolveStockPool(owner, branchId || null);
  if (!pool) return [];
  const since = new Date(Date.now() - 7 * 86400000);
  const usageById = new Map();
  for (const m of (pool.stockMovements || [])) {
    if (m.type !== 'chiqim') continue;
    if (!m.note || !m.note.startsWith('Buyurtma:')) continue;
    if (new Date(m.createdAt) < since) continue;
    usageById.set(m.stockId, (usageById.get(m.stockId) || 0) + m.qty);
  }
  const forecast = [];
  for (const item of (pool.stock || [])) {
    const used7d = usageById.get(item.id) || 0;
    if (used7d <= 0) continue;
    const avgDaily = Math.round((used7d / 7) * 1000) / 1000;
    const predictedNeed = Math.round(avgDaily * 1000) / 1000;

    const daysLeft = avgDaily > 0 ? Math.round((item.qty / avgDaily) * 10) / 10 : null;
    forecast.push({
      stockId: item.id, name: item.name, unit: item.unit,
      currentQty: item.qty, avgDailyUsage: avgDaily, predictedNeed,
      shortage: item.qty < predictedNeed,
      daysLeft, urgent: daysLeft !== null && daysLeft <= 3
    });
  }
  forecast.sort((a, b) => {
    const aLeft = a.daysLeft === null ? Infinity : a.daysLeft;
    const bLeft = b.daysLeft === null ? Infinity : b.daysLeft;
    return aLeft - bLeft;
  });
  return forecast;
}

function callAnthropicApi(systemPrompt, userText) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) return reject(new Error('ANTHROPIC_API_KEY sozlanmagan'));
    const body = JSON.stringify({
      model: AI_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }]
    });
    const reqOptions = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const apiReq = https.request(reqOptions, apiRes => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = (parsed.content || []).map(c => c.text || '').join('\n').trim();
          if (!text) return reject(new Error('AI javob bo\'sh qaytdi'));
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    apiReq.on('error', reject);
    apiReq.write(body);
    apiReq.end();
  });
}

function ruleBasedAiAnswer(question, ctx) {
  const q = String(question || '').toLowerCase();

  if (/bugun/.test(q) && /foyda|savdo|kirim/.test(q)) {
    return `Bugungi kirim: ${fmtNum(ctx.cashflow.today.income)} so'm, xarajat: ${fmtNum(ctx.cashflow.today.expense)} so'm, sof foyda: ${fmtNum(ctx.cashflow.today.net)} so'm (${ctx.cashflow.today.orderCount} ta buyurtma).`;
  }
  if (/hafta/.test(q) && /foyda|savdo|kirim/.test(q)) {
    return `Shu hafta kirim: ${fmtNum(ctx.cashflow.week.income)} so'm, xarajat: ${fmtNum(ctx.cashflow.week.expense)} so'm, sof foyda: ${fmtNum(ctx.cashflow.week.net)} so'm (${ctx.cashflow.week.orderCount} ta buyurtma).`;
  }
  if (/oy/.test(q) && /foyda|savdo|kirim/.test(q)) {
    return `Shu oy kirim: ${fmtNum(ctx.cashflow.month.income)} so'm, xarajat: ${fmtNum(ctx.cashflow.month.expense)} so'm, sof foyda: ${fmtNum(ctx.cashflow.month.net)} so'm (${ctx.cashflow.month.orderCount} ta buyurtma).`;
  }
  if (/top|eng ko'p sotilgan|mashhur|qaysi taom/.test(q)) {
    if (!ctx.topItems.length) return 'Hozircha (so\'nggi 30 kunda) buyurtma tarixi yo\'q.';
    const list = ctx.topItems.slice(0, 3).map((it, i) => `${i + 1}. ${it.name} — ${it.qty} dona (${fmtNum(it.revenue)} so'm)`).join('\n');
    return `Eng ko'p sotilgan taomlar (so'nggi 30 kun):\n${list}`;
  }
  if (/pik|band vaqt|qaysi soat|eng gavjum/.test(q)) {
    if (!ctx.peak.topHours.length) return 'Hozircha buyurtma tarixi yo\'q.';
    const h = ctx.peak.topHours[0];
    return `Eng band soat: ${h.hour}:00 atrofida (${h.count} ta buyurtma, so'nggi 30 kun). Eng band kun: ${ctx.peak.topDays[0] ? ctx.peak.topDays[0].dayLabel : 'ma\'lumot yo\'q'}.`;
  }
  if (/kam qolgan|tugab qolayotgan|sklad|zaxira/.test(q)) {
    const low = (ctx.forecast || []).filter(f => f.shortage);
    if (!low.length) return 'Hozircha ertangi kunga yetarli zaxira bor ko\'rinadi (oxirgi 7 kunlik iste\'mol bo\'yicha).';
    const list = low.slice(0, 5).map(f => `• ${f.name}: bor ${fmtNum(f.currentQty)} ${f.unit}, kunlik o'rtacha sarf ${fmtNum(f.avgDailyUsage)} ${f.unit}`).join('\n');
    return `Ertaga yetishmasligi mumkin bo'lgan mahsulotlar:\n${list}`;
  }

  const topLine = ctx.topItems[0] ? `Eng ko'p sotilgan: ${ctx.topItems[0].name}.` : '';
  return `Aniq javob topa olmadim, lekin umumiy holat shunday: bugungi sof foyda ${fmtNum(ctx.cashflow.today.net)} so'm, shu hafta ${fmtNum(ctx.cashflow.week.net)} so'm. ${topLine} Aniqroq javob uchun "bugun foyda qancha", "eng ko'p sotilgan taom", "pik vaqt qachon" yoki "sklad kam qolganmi" kabi savol bering.`;
}

authed('/api/ai-analytics', (payload, res, { userId }) => {
  const { period, branchId } = payload;

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'ai-analytics')) return sendFeatureBlocked(res, 'ai-analytics');

  const fromDate = resolvePeriodStart(period || 'week');
  const topItems = computeTopItems(owner, fromDate, 8);
  const peak = computePeakTimes(owner, fromDate);
  const forecast = computeStockForecast(owner, branchId || null);

  return sendOk(res, {
    period: period || 'week',
    topItems,
    peakHours: peak.byHour,
    peakDays: peak.byDay,
    topHours: peak.topHours,
    topDays: peak.topDays,
    forecast
  });
});

authed('/api/daily-report-preview', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'z-report')) return sendFeatureBlocked(res, 'z-report');

  const yesterdayKey = aiDirDateKey(new Date(Date.now() - 86400000));
  return sendOk(res, {
    text: buildDailyReportText(owner, yesterdayKey),
    enabled: owner.dailyReportEnabled !== false,
    sentToday: owner.dailyReportLastSent === yesterdayKey,
    hour: AI_DIRECTOR_HOUR
  });
});

authed('/api/daily-report-send-now', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'z-report')) return sendFeatureBlocked(res, 'z-report');

  sendDailyReportDigest(owner, true).then(() => {
    saveOwners(owners);
    sendOk(res);
  }).catch(() => sendFail(res, 'Yuborishda xatolik yuz berdi.'));
});

authed('/api/daily-report-toggle', (payload, res, { userId }) => {
  const { enabled } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'z-report')) return sendFeatureBlocked(res, 'z-report');

  owner.dailyReportEnabled = !!enabled;
  saveOwners(owners);
  return sendOk(res, { enabled: owner.dailyReportEnabled });
});

authed('/api/ai-director-preview', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'ai-director')) return sendFeatureBlocked(res, 'ai-director');

  return sendOk(res, {
    text: buildAiDirectorText(owner),
    enabled: owner.aiDirectorEnabled !== false,
    sentToday: owner.aiDirectorLastSent === aiDirDateKey(new Date()),
    hour: AI_DIRECTOR_HOUR
  });
});

authed('/api/ai-director-send-now', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'ai-director')) return sendFeatureBlocked(res, 'ai-director');

  sendAiDirectorDigest(owner, true).then(() => {
    saveOwners(owners);
    sendOk(res);
  }).catch(() => sendFail(res, 'Yuborishda xatolik yuz berdi.'));
});

authed('/api/ai-director-toggle', (payload, res, { userId }) => {
  const { enabled } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'ai-director')) return sendFeatureBlocked(res, 'ai-director');

  owner.aiDirectorEnabled = !!enabled;
  saveOwners(owners);
  return sendOk(res, { enabled: owner.aiDirectorEnabled });
});

authed('/api/ai-director-weekly-preview', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'ai-director')) return sendFeatureBlocked(res, 'ai-director');

  return sendOk(res, {
    text: buildAiWeeklyDirectorText(owner),
    enabled: owner.aiWeeklyEnabled !== false,
    sentThisWeek: owner.aiWeeklyLastSent === aiDirWeekKey(new Date()),
    weekday: AI_DIRECTOR_WEEKLY_DAY,
    hour: AI_DIRECTOR_HOUR
  });
});

authed('/api/ai-director-weekly-send-now', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'ai-director')) return sendFeatureBlocked(res, 'ai-director');

  sendAiWeeklyDirectorDigest(owner, true).then(() => {
    saveOwners(owners);
    sendOk(res);
  }).catch(() => sendFail(res, 'Yuborishda xatolik yuz berdi.'));
});

authed('/api/ai-director-weekly-toggle', (payload, res, { userId }) => {
  const { enabled } = payload;

  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'ai-director')) return sendFeatureBlocked(res, 'ai-director');

  owner.aiWeeklyEnabled = !!enabled;
  saveOwners(owners);
  return sendOk(res, { enabled: owner.aiWeeklyEnabled });
});

authed('/api/ai-ask', async (payload, res, { userId }) => {
  const { question } = payload;

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'ai-analytics')) return sendFeatureBlocked(res, 'ai-analytics');

  const qTrim = String(question || '').trim();
  if (!qTrim) return sendFail(res, 'Savolingizni kiriting.');
  if (qTrim.length > 300) return sendFail(res, 'Savol juda uzun (300 belgigacha).');

  const monthAgo = new Date(Date.now() - 30 * 86400000);
  const ctx = {
    cashflow: computeCashflow(owner),
    topItems: computeTopItems(owner, monthAgo, 10),
    peak: computePeakTimes(owner, monthAgo),
    forecast: computeStockForecast(owner, null)
  };

  if (!ANTHROPIC_API_KEY) {
    return sendOk(res, { answer: ruleBasedAiAnswer(qTrim, ctx), source: 'qoida' });
  }

  const systemPrompt = 'Sen oshxona (restoran) egasiga o\'zbek tilida yordam beruvchi qisqa AI tahlilchisan. ' +
    'Faqat berilgan JSON ma\'lumotlar asosida javob ber, o\'ylab topma. 2-4 gaplik, aniq raqamlar bilan qisqa javob yoz.\n' +
    'Ma\'lumotlar (JSON):\n' + JSON.stringify(ctx);

  try {
    const answer = await callAnthropicApi(systemPrompt, qTrim);
    return sendOk(res, { answer, source: 'ai' });
  } catch (e) {
    return sendOk(res, { answer: ruleBasedAiAnswer(qTrim, ctx), source: 'qoida' });
  }
});

authed('/api/staff-activity-log', (payload, res, { userId }) => {
  const { staffId, limit } = payload;

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  const staffById = new Map((owner.staff || []).map(s => [String(s.id), s]));
  let log = owner.staffActionLog || [];
  if (staffId) log = log.filter(e => String(e.userId) === String(staffId));

  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const entries = log.slice(0, lim).map(e => {
    const isOwnerEntry = String(e.userId) === String(owner.id);
    const staff = staffById.get(String(e.userId));
    return Object.assign({}, e, {
      displayName: isOwnerEntry ? 'Egasi' : (staff ? staffDisplayName(staff) : `ID: ${e.userId}`),
      roleLabel: isOwnerEntry ? 'Egasi' : (STAFF_ROLES[e.role] || e.role)
    });
  });

  return sendOk(res, { entries, staff: publicStaffList(owner.staff) });
});

authed('/api/notification-error-log', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'notification-log')) return sendFeatureBlocked(res, 'notification-log');

  return sendOk(res, { entries: owner.notificationErrors || [] });
});

authed('/api/notification-error-log-clear', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'notification-log')) return sendFeatureBlocked(res, 'notification-log');

  owner.notificationErrors = [];
  saveOwners(owners);
  return sendOk(res);
});

authed('/api/notification-prefs-get', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  const prefs = {};
  for (const key of Object.keys(NOTIFICATION_CATEGORIES)) {
    prefs[key] = !isNotificationCategoryMuted(owner, key);
  }
  return sendOk(res, {
    prefs,
    categories: Object.entries(NOTIFICATION_CATEGORIES).map(([key, label]) => ({ key, label }))
  });
});

authed('/api/notification-prefs-save', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  const incoming = payload.prefs && typeof payload.prefs === 'object' ? payload.prefs : {};
  if (!owner.notificationPrefs) owner.notificationPrefs = {};
  for (const key of Object.keys(NOTIFICATION_CATEGORIES)) {
    if (key in incoming) owner.notificationPrefs[key] = !!incoming[key];
  }
  saveOwners(owners);

  const prefs = {};
  for (const key of Object.keys(NOTIFICATION_CATEGORIES)) {
    prefs[key] = !isNotificationCategoryMuted(owner, key);
  }
  return sendOk(res, { prefs });
});

authed('/api/owner-payment-card-get', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  return sendOk(res, { card: owner.customerPaymentCard || { cardNumber: '', cardHolder: '' } });
});

authed('/api/owner-payment-card-set', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;

  const cardNumber = String(payload.cardNumber || '').trim().slice(0, 40);
  const cardHolder = String(payload.cardHolder || '').trim().slice(0, 80);
  owner.customerPaymentCard = { cardNumber, cardHolder };
  saveOwners(owners);

  return sendOk(res, { card: owner.customerPaymentCard });
});

authed('/api/staff-performance-report', (payload, res, { userId }) => {
  const { period } = payload;

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Bu bo\'lim faqat oshxona egasiga ko\'rinadi');
  const owner = ownerCtx.owner;
  if (!ownerCanUseFeature(owner, 'staff-performance')) return sendFeatureBlocked(res, 'staff-performance');

  const fromDate = resolvePeriodStart(period || 'month');
  const log = (owner.staffActionLog || []).filter(e => new Date(e.createdAt) >= fromDate);

  const report = (owner.staff || []).map(staff => {
    const mine = log.filter(e => String(e.userId) === String(staff.id));
    const actionCount = mine.length;
    const errorCount = mine.reduce((sum, e) => sum + (e.errorCount || 0), 0);
    const lastActiveAt = mine.length ? mine.reduce((max, e) => e.createdAt > max ? e.createdAt : max, mine[0].createdAt) : null;
    return {
      id: staff.id,
      username: staff.username || null,
      fullName: staffDisplayName(staff),
      role: staff.role,
      roles: normalizeStaffRoles(staff),
      roleLabel: rolesLabel(normalizeStaffRoles(staff)),
      actionCount, errorCount, lastActiveAt,
      score: actionCount - errorCount * 2
    };
  });

  report.sort((a, b) => b.score - a.score);
  if (report.length && report[0].actionCount > 0) report[0].isTop = true;

  return sendOk(res, { report, period: period || 'month' });
});

authed('/api/my-profile', (payload, res, { userId }) => {
  if (isAdminId(userId)) return sendFail(res, 'Admin uchun profil mavjud emas');

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q yoki muddati tugagan');
  const owner = ownerCtx.owner;

  let tariffInfo = null;
  if (owner.tariffId) {
    const tariff = loadTariffs().find(t => t.id === owner.tariffId);
    if (tariff) tariffInfo = { id: tariff.id, name: tariff.name };
  }

  const profileOut = owner.profile ? Object.assign({}, owner.profile, { isSuperAdmin: userId === String(ADMIN_ID) }) : null;
  return sendOk(res, { profile: profileOut, tariff: tariffInfo });
});

authed('/api/super-admin-reset-reports', (payload, res, { userId }) => {
  if (userId !== String(ADMIN_ID)) {
    return sendFail(res, 'Bu amal faqat super adminga ruxsat etilgan.');
  }

  const owners = loadOwners();
  const owner = findOwner(owners, userId);
  if (!owner) return sendFail(res, 'Owner topilmadi.');

  const safetyFile = savePreRestoreSafetySnapshot(userId);

  owner.orders = [];
  owner.expenses = [];
  owner.zReports = [];
  saveOwners(owners);

  return sendOk(res, { safetyFile });
});

authed('/api/save-profile', (payload, res, { userId }) => {
  const { name, address, phone, workHours, logoUrl, brandColor } = payload;

  if (isAdminId(userId)) return sendFail(res, 'Admin uchun profil mavjud emas');

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q yoki muddati tugagan');
  const owner = ownerCtx.owner;

  const nameTrim = String(name || '').trim();
  const addressTrim = String(address || '').trim();
  const phoneTrim = String(phone || '').trim();
  const workHoursTrim = String(workHours || '').trim();
  const logoTrim = String(logoUrl || '').trim();
  const brandColorTrim = String(brandColor || '').trim();

  if (!nameTrim) return sendFail(res, 'Oshxona nomini kiriting.');
  if (!addressTrim) return sendFail(res, 'Manzilni kiriting.');
  if (!phoneTrim || !isPlausiblePhone(phoneTrim)) {
    return sendFail(res, 'Telefon raqamini O\'zbekiston formatida kiriting (masalan: +998901234567).');
  }
  // Ish vaqti noto'g'ri formatda kiritilsa, oldin jim tarzda standart
  // (10:00-03:00) vaqtga tushib qolar edi va owner buni sezmas edi.
  // Endi bunday holatda aniq xatolik qaytariladi.
  if (workHoursTrim && !parseWorkHoursRange(workHoursTrim)) {
    return sendFail(res, 'Ish vaqti formati noto\'g\'ri. Masalan: 09:00 - 23:00 (yoki "9:00 dan 23:00 gacha").');
  }
  if (logoTrim && !isValidImageValue(logoTrim)) {
    return sendFail(res, 'Logotip rasmi noto\'g\'ri yoki hajmi juda katta. Boshqa rasm tanlang.');
  }
  if (brandColorTrim && !/^#[0-9A-Fa-f]{6}$/.test(brandColorTrim)) {
    return sendFail(res, 'Brend rangi noto\'g\'ri formatda (masalan #1E4FD8).');
  }

  if (!ownerCanUseFeature(owner, 'restaurant-brand')) {
    const existingLogo = (owner.profile && owner.profile.logoUrl) || '';
    const existingBrandColor = (owner.profile && owner.profile.brandColor) || '';
    if (logoTrim !== existingLogo || brandColorTrim !== existingBrandColor) {
      return sendFeatureBlocked(res, 'restaurant-brand');
    }
  }

  const owners2 = loadOwners();
  const target = findOwner(owners2, userId);
  const wasCompleted = !!(target.profile && target.profile.completedAt);
  target.profile = {
    name: nameTrim,
    address: addressTrim,
    phone: phoneTrim,
    workHours: workHoursTrim || null,
    logoUrl: logoTrim || null,
    brandColor: brandColorTrim || null,
    completedAt: wasCompleted ? target.profile.completedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveOwners(owners2);

  return sendOk(res, { profile: target.profile });
});

authed('/api/feature-list', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  return sendOk(res, { groups: getFeatureCatalogGrouped() });
});

authed('/api/admin-payment-requisites-get', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  return sendOk(res, { requisites: loadPaymentRequisites() });
});

authed('/api/admin-payment-requisites-set', (payload, res, { userId }) => {
  const { cardNumber, cardHolder, clickNumber, paymeNumber } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'zgartira oladi');

  const updated = savePaymentRequisites({
    cardNumber: String(cardNumber || '').trim() || DEFAULT_PAYMENT_REQUISITES.cardNumber,
    cardHolder: String(cardHolder || '').trim() || DEFAULT_PAYMENT_REQUISITES.cardHolder,
    clickNumber: String(clickNumber || '').trim() || DEFAULT_PAYMENT_REQUISITES.clickNumber,
    paymeNumber: String(paymeNumber || '').trim() || DEFAULT_PAYMENT_REQUISITES.paymeNumber
  });

  return sendOk(res, { requisites: updated });
});

authed('/api/tariff-list', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  const owners = loadOwners();
  const tariffs = loadTariffs().slice().sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(t => ({ ...t, ownerCount: owners.filter(o => o.tariffId === t.id).length }));
  return sendOk(res, { tariffs });
});

authed('/api/tariff-add', (payload, res, { userId }) => {
  const { name, price, maxBranches } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin qo\'sha oladi');

  const nameTrim = String(name || '').trim();
  if (!nameTrim) return sendFail(res, 'Tarif nomini kiriting.');

  let priceVal = 0;
  if (price !== undefined && price !== null && String(price).trim() !== '') {
    priceVal = Number(price);
    if (!Number.isFinite(priceVal) || priceVal < 0) return sendFail(res, 'Narx 0 yoki musbat son bo\'lishi kerak.');
  }

  // Filiallar soni (ixtiyoriy) — bo'sh/0 qoldirilsa cheklanmagan.
  let maxBranchesVal = null;
  if (maxBranches !== undefined && maxBranches !== null && String(maxBranches).trim() !== '') {
    const v = parseInt(maxBranches, 10);
    if (!Number.isInteger(v) || v <= 0) {
      return sendFail(res, 'Filiallar soni musbat butun son bo\'lishi kerak (yoki cheklanmagan uchun bo\'sh qoldiring).');
    }
    maxBranchesVal = v;
  }

  const tariffs = loadTariffs();
  if (tariffs.some(t => t.name.toLowerCase() === nameTrim.toLowerCase())) {
    return sendFail(res, 'Shu nomdagi tarif allaqachon mavjud.');
  }
  const tariff = {
    id: crypto.randomBytes(4).toString('hex'),
    name: nameTrim,
    order: tariffs.length,
    price: priceVal,
    maxBranches: maxBranchesVal,
    reminderDays: 1,
    features: {},
    createdAt: new Date().toISOString()
  };
  tariffs.push(tariff);
  saveTariffs(tariffs);

  return sendOk(res, { tariff });
});

authed('/api/tariff-rename', (payload, res, { userId }) => {
  const { id, name, price, reminderDays, maxBranches } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'zgartira oladi');

  const nameTrim = String(name || '').trim();
  if (!nameTrim) return sendFail(res, 'Tarif nomini kiriting.');

  const tariffs = loadTariffs();
  const tariff = tariffs.find(t => t.id === id);
  if (!tariff) return sendFail(res, 'Tarif topilmadi.');
  if (tariffs.some(t => t.id !== id && t.name.toLowerCase() === nameTrim.toLowerCase())) {
    return sendFail(res, 'Shu nomdagi tarif allaqachon mavjud.');
  }
  if (price !== undefined && price !== null && String(price).trim() !== '') {
    const priceVal = Number(price);
    if (!Number.isFinite(priceVal) || priceVal < 0) return sendFail(res, 'Narx 0 yoki musbat son bo\'lishi kerak.');
    tariff.price = priceVal;
  }

  if (reminderDays !== undefined && reminderDays !== null && String(reminderDays).trim() !== '') {
    const reminderVal = parseInt(reminderDays, 10);
    if (!Number.isInteger(reminderVal) || reminderVal <= 0) {
      return sendFail(res, 'Eslatma kunlari musbat butun son bo\'lishi kerak.');
    }
    tariff.reminderDays = reminderVal;
  }
  // Filiallar soni — bo'sh string yuborilsa cheklovni OLIB TASHLAYDI
  // (cheklanmagan qiladi); maydon umuman yuborilmasa (undefined),
  // eski qiymat tegilmay qoladi.
  if (maxBranches !== undefined) {
    if (maxBranches === null || String(maxBranches).trim() === '') {
      tariff.maxBranches = null;
    } else {
      const v = parseInt(maxBranches, 10);
      if (!Number.isInteger(v) || v <= 0) {
        return sendFail(res, 'Filiallar soni musbat butun son bo\'lishi kerak (yoki cheklanmagan uchun bo\'sh qoldiring).');
      }
      tariff.maxBranches = v;
    }
  }
  tariff.name = nameTrim;
  saveTariffs(tariffs);

  return sendOk(res, { tariff });
});

authed('/api/tariff-remove', (payload, res, { userId }) => {
  const { id, force } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'chira oladi');

  const tariffs = loadTariffs();
  const idx = tariffs.findIndex(t => t.id === id);
  if (idx === -1) return sendFail(res, 'Tarif topilmadi.');

  const owners = loadOwners();
  const assignedOwners = owners.filter(o => o.tariffId === id);
  if (assignedOwners.length && !force) {
    return sendJSON(res, 200, {
      ok: false,
      reason: `Bu tarifga ${assignedOwners.length} ta do'kon egasi biriktirilgan. Avval ularni boshqa tarifga o'tkazing, yoki tasdiqlab, ularni tarifsiz qoldirib o'chiring.`,
      blockedCount: assignedOwners.length
    });
  }
  if (assignedOwners.length && force) {
    assignedOwners.forEach(o => { o.tariffId = null; });
    saveOwners(owners);
  }

  tariffs.splice(idx, 1);

  tariffs.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((t, i) => { t.order = i; });
  saveTariffs(tariffs);

  return sendOk(res);
});

authed('/api/tariff-set-features', (payload, res, { userId }) => {
  const { id, features } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin belgilay oladi');

  const tariffs = loadTariffs();
  const tariff = tariffs.find(t => t.id === id);
  if (!tariff) return sendFail(res, 'Tarif topilmadi.');

  const validIds = new Set(FEATURE_CATALOG.map(f => f.id));
  const cleaned = {};
  if (features && typeof features === 'object') {
    for (const fid of Object.keys(features)) {
      if (validIds.has(fid)) cleaned[fid] = !!features[fid];
    }
  }
  tariff.features = cleaned;
  saveTariffs(tariffs);

  return sendOk(res, { tariff });
});

authed('/api/subscription-plan-list', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  const tariffs = loadTariffs();
  const plans = Object.values(loadSubscriptionPlans())
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(p => {
      const tariff = p.tariffId ? tariffs.find(t => t.id === p.tariffId) : null;
      return { ...p, tariffLabel: tariff ? tariff.name : null };
    });
  return sendOk(res, { plans, tariffs: tariffs.map(t => ({ id: t.id, name: t.name })) });
});

authed('/api/subscription-plan-add', (payload, res, { userId }) => {
  const { label, days, price, discountNote, tariffId } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin qo\'sha oladi');

  const labelTrim = String(label || '').trim();
  if (!labelTrim) return sendFail(res, 'Reja nomini kiriting.');

  const daysVal = parseInt(days, 10);
  if (!Number.isInteger(daysVal) || daysVal <= 0) {
    return sendFail(res, 'Muddat (kun) musbat butun son bo\'lishi kerak.');
  }

  const priceVal = Number(price);
  if (!Number.isFinite(priceVal) || priceVal < 0) {
    return sendFail(res, 'Narx 0 yoki musbat son bo\'lishi kerak.');
  }

  let tariffIdVal = null;
  if (tariffId !== undefined && tariffId !== null && String(tariffId).trim() !== '') {
    const tariffs = loadTariffs();
    if (!tariffs.some(t => t.id === tariffId)) {
      return sendFail(res, 'Tanlangan tarif topilmadi.');
    }
    tariffIdVal = tariffId;
  }

  const plans = loadSubscriptionPlans();
  const id = crypto.randomBytes(4).toString('hex');
  const order = Object.keys(plans).length;
  plans[id] = {
    id,
    label: labelTrim,
    days: daysVal,
    price: priceVal,
    discountNote: discountNote ? String(discountNote).trim() || null : null,
    tariffId: tariffIdVal,
    order
  };
  saveSubscriptionPlans(plans);

  return sendOk(res, { plan: plans[id] });
});

authed('/api/subscription-plan-update', (payload, res, { userId }) => {
  const { id, label, days, price, discountNote, tariffId } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'zgartira oladi');

  const plans = loadSubscriptionPlans();
  const plan = plans[id];
  if (!plan) return sendFail(res, 'Reja topilmadi.');

  const labelTrim = String(label || '').trim();
  if (!labelTrim) return sendFail(res, 'Reja nomini kiriting.');

  const daysVal = parseInt(days, 10);
  if (!Number.isInteger(daysVal) || daysVal <= 0) {
    return sendFail(res, 'Muddat (kun) musbat butun son bo\'lishi kerak.');
  }

  const priceVal = Number(price);
  if (!Number.isFinite(priceVal) || priceVal < 0) {
    return sendFail(res, 'Narx 0 yoki musbat son bo\'lishi kerak.');
  }

  let tariffIdVal = null;
  if (tariffId !== undefined && tariffId !== null && String(tariffId).trim() !== '') {
    const tariffs = loadTariffs();
    if (!tariffs.some(t => t.id === tariffId)) {
      return sendFail(res, 'Tanlangan tarif topilmadi.');
    }
    tariffIdVal = tariffId;
  }

  plan.label = labelTrim;
  plan.days = daysVal;
  plan.price = priceVal;
  plan.discountNote = discountNote ? String(discountNote).trim() || null : null;
  plan.tariffId = tariffIdVal;
  saveSubscriptionPlans(plans);

  return sendOk(res, { plan });
});

authed('/api/subscription-plan-remove', (payload, res, { userId }) => {
  const { id } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'chira oladi');

  const plans = loadSubscriptionPlans();
  if (!plans[id]) return sendFail(res, 'Reja topilmadi.');

  delete plans[id];
  Object.values(plans).sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((p, i) => { p.order = i; });
  saveSubscriptionPlans(plans);

  return sendOk(res);
});

authed('/api/system-status', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  const owners = loadOwners();
  const activeOwners = owners.filter(isOwnerAccessValid);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let totalStaff = 0, totalOrders = 0, todayOrders = 0, totalNotifErrors = 0;
  owners.forEach(o => {
    totalStaff += (o.staff || []).length;
    const orders = o.orders || [];
    totalOrders += orders.length;
    todayOrders += orders.filter(ord => ord.createdAt && new Date(ord.createdAt) >= todayStart).length;
    totalNotifErrors += (o.notificationErrors || []).length;
  });

  function fileInfo(file) {
    try {
      const st = fs.statSync(file);
      return { exists: true, sizeKb: Math.round(st.size / 1024 * 10) / 10 };
    } catch (e) {
      return { exists: false, sizeKb: 0 };
    }
  }

  const mem = process.memoryUsage();

  return sendOk(res, {
    status: {
      uptimeSeconds: Math.floor(process.uptime()),
      serverStartedAt: SERVER_STARTED_AT,
      nodeVersion: process.version,
      memoryRssMb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      owners: { total: owners.length, active: activeOwners.length, expired: owners.length - activeOwners.length },
      totalStaff,
      totalOrders,
      todayOrders,
      notificationErrors: totalNotifErrors,
      webhook: webhookStats,
      botConfigured: !!BOT_TOKEN && BOT_TOKEN !== 'BOT_TOKEN_BU_YERGA',
      publicUrlConfigured: !!PUBLIC_URL,
      dataFiles: {
        owners: fileInfo(OWNERS_FILE),
        invites: fileInfo(INVITES_FILE),
        requests: fileInfo(REQUESTS_FILE),
        profiles: fileInfo(PROFILES_FILE)
      }
    }
  });
});

authed('/api/owners', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  const owners = pruneExpiredOwners().map(o => {
    const clean = Object.assign({}, o);
    delete clean.passwordHash;
    delete clean.sessionToken;
    delete clean.sessionExpiresAt;
    clean.hasLogin = !!(o.login && o.passwordHash);
    clean.staff = publicStaffList(o.staff);

    const rating = ownerAverageRating(o);
    clean.avgRating = rating.avg;
    clean.ratingCount = rating.count;
    return clean;
  });

  owners.sort((a, b) => {
    if (a.avgRating === null && b.avgRating === null) return 0;
    if (a.avgRating === null) return 1;
    if (b.avgRating === null) return -1;
    return b.avgRating - a.avgRating;
  });

  const payments = loadPayments();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const revenue = {
    totalLifetime: payments.reduce((s, p) => s + (Number(p.amount) || 0), 0),
    thisMonth: payments.filter(p => new Date(p.at).getTime() >= monthStart).reduce((s, p) => s + (Number(p.amount) || 0), 0),
    paymentCount: payments.length
  };
  return sendOk(res, { owners, revenue });
});

authed('/api/owner-set-tariff', (payload, res, { userId }) => {
  const { id, tariffId } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin belgilay oladi');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const owners = loadOwners();
  const owner = findOwner(owners, id);
  if (!owner) return sendFail(res, 'Bunday do\'kon egasi topilmadi');

  if (tariffId) {
    const tariffs = loadTariffs();
    if (!tariffs.some(t => t.id === tariffId)) {
      return sendFail(res, 'Bunday tarif topilmadi.');
    }
    owner.tariffId = tariffId;
  } else {
    owner.tariffId = null;
  }
  saveOwners(owners);

  return sendOk(res, { tariffId: owner.tariffId });
});

authed('/api/owner-set-expiry', async (payload, res, { userId }) => {
  const { id, action, days, date } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'zgartira oladi');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const owners = loadOwners();
  const owner = findOwner(owners, id);
  if (!owner) return sendFail(res, 'Bunday do\'kon egasi topilmadi');

  if (action === 'extend') {
    const n = parseInt(days, 10);
    if (!Number.isInteger(n) || n <= 0) {
      return sendFail(res, 'Kun soni musbat butun son bo\'lishi kerak.');
    }
    const currentMs = owner.subscriptionUntil ? new Date(owner.subscriptionUntil).getTime() : NaN;
    const base = Number.isFinite(currentMs) && currentMs > Date.now() ? currentMs : Date.now();
    const untilIso = new Date(base + n * 86400000).toISOString();
    owner.subscriptionUntil = untilIso;
    owner.expiresAt = untilIso;
    owner.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
    owner.graceUntil = null;
    owner.reminderSentAt = null;
    owner.blockedNotifiedAt = null;
    saveOwners(owners);
    return sendOk(res, { owner });
  }

  if (action === 'setDate') {
    const d = new Date(date);
    if (!date || isNaN(d.getTime())) {
      return sendFail(res, 'Sana noto\'g\'ri.');
    }

    d.setHours(23, 59, 59, 999);
    if (d.getTime() <= Date.now()) {
      owner.subscriptionUntil = d.toISOString();
      owner.expiresAt = d.toISOString();
      owner.subscriptionStatus = SUBSCRIPTION_STATUS.BLOCKED;
      owner.graceUntil = null;
      owner.blockedNotifiedAt = new Date().toISOString();
      saveOwners(owners);
      await sendMessage(ADMIN_ID,
        `⏰ <b>Obuna muddati qisqartirildi</b>\n${ownerLabel(owner)} (ID: <code>${owner.id}</code>) uchun Mini App'ga kirish admin tomonidan bloklandi.\nMa'lumotlari saqlanib qolyapti — qayta uzaytirsangiz, kirish tiklanadi.`);
      await sendMessage(owner.id,
        `⏰ Sizning obuna muddatingiz administrator tomonidan qisqartirildi, Mini App'ga kirish bloklandi.\nMa'lumotlaringiz saqlanib qolyapti. Davom ettirish uchun administrator bilan bog'laning.`);
      return sendOk(res, { owner, blocked: true });
    }
    owner.subscriptionUntil = d.toISOString();
    owner.expiresAt = d.toISOString();
    owner.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
    owner.graceUntil = null;
    owner.reminderSentAt = null;
    owner.blockedNotifiedAt = null;
    saveOwners(owners);
    return sendOk(res, { owner });
  }

  if (action === 'unlimited') {
    owner.subscriptionUntil = null;
    owner.expiresAt = null;
    owner.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
    owner.graceUntil = null;
    owner.reminderSentAt = null;
    owner.blockedNotifiedAt = null;
    saveOwners(owners);
    return sendOk(res, { owner });
  }

  if (action === 'cancelNow') {
    const nowIso = new Date().toISOString();
    owner.subscriptionUntil = nowIso;
    owner.expiresAt = nowIso;
    owner.subscriptionStatus = SUBSCRIPTION_STATUS.BLOCKED;
    owner.graceUntil = null;
    owner.blockedNotifiedAt = nowIso;
    saveOwners(owners);
    await sendMessage(ADMIN_ID,
      `⏰ <b>Obuna bekor qilindi</b>\n${ownerLabel(owner)} (ID: <code>${owner.id}</code>) uchun Mini App'ga kirish admin tomonidan bloklandi.\nMa'lumotlari saqlanib qolyapti — qayta uzaytirsangiz, kirish tiklanadi.`);
    await sendMessage(owner.id,
      `⏰ Sizning obunangiz administrator tomonidan bekor qilindi, Mini App'ga kirish bloklandi.\nMa'lumotlaringiz saqlanib qolyapti.`);
    return sendOk(res, { owner, blocked: true });
  }

  return sendFail(res, 'Noto\'g\'ri amal.');
});

authed('/api/set-owner-credentials', (payload, res, { userId }) => {
  const { id, login, password } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin belgilay oladi');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const owners = loadOwners();
  const owner = findOwner(owners, id);
  if (!owner) return sendFail(res, 'Bunday do\'kon egasi topilmadi');

  const loginNorm = normalizeLogin(login);
  if (!/^[a-z0-9_.]{3,32}$/.test(loginNorm)) {
    return sendFail(res, 'Login 3-32 belgi, faqat lotin harflari/raqam/._ bo\'lishi mumkin.');
  }
  const passwordStr = String(password || '');
  if (passwordStr.length < 6) {
    return sendFail(res, 'Parol kamida 6 belgidan iborat bo\'lishi kerak.');
  }
  const clash = owners.find(o => normalizeLogin(o.login) === loginNorm && String(o.id) !== String(owner.id));
  if (clash) {
    return sendFail(res, 'Bu login band, boshqasini tanlang.');
  }

  owner.login = loginNorm;
  owner.passwordHash = hashPassword(passwordStr);

  owner.sessionToken = null;
  owner.sessionExpiresAt = null;
  saveOwners(owners);

  return sendOk(res, { login: owner.login });
});

authed('/api/remove-owner-credentials', (payload, res, { userId }) => {
  const { id } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'chira oladi');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const owners = loadOwners();
  const owner = findOwner(owners, id);
  if (!owner) return sendFail(res, 'Bunday do\'kon egasi topilmadi');

  owner.login = null;
  owner.passwordHash = null;
  owner.sessionToken = null;
  owner.sessionExpiresAt = null;
  saveOwners(owners);

  return sendOk(res);
});

authed('/api/owner-confirm-password', (payload, res, { userId }) => {
  const { password } = payload;

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q yoki muddati tugagan');
  const owner = ownerCtx.owner;

  if (!owner.login || !owner.passwordHash) {

    return sendOk(res, { skipped: true });
  }
  if (!verifyPassword(password, owner.passwordHash)) {
    return sendFail(res, 'Parol noto\'g\'ri.');
  }
  return sendOk(res);
});

authed('/api/owner-change-password', (payload, res, { userId }) => {
  const { currentPassword, newPassword } = payload;

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q yoki muddati tugagan');
  const owner = ownerCtx.owner;

  if (!owner.login || !owner.passwordHash) {
    return sendFail(res, 'Sizga hali login/parol biriktirilmagan. Administrator bilan bog\'laning.');
  }
  if (!verifyPassword(currentPassword, owner.passwordHash)) {
    return sendFail(res, 'Joriy parol noto\'g\'ri.');
  }

  const newPasswordStr = String(newPassword || '');
  if (newPasswordStr.length < 6) {
    return sendFail(res, 'Yangi parol kamida 6 belgidan iborat bo\'lishi kerak.');
  }

  const owners2 = loadOwners();
  const target = findOwner(owners2, owner.id);
  if (!target) return sendFail(res, 'Bunday do\'kon egasi topilmadi');

  target.passwordHash = hashPassword(newPasswordStr);

  target.sessionToken = null;
  target.sessionExpiresAt = null;
  saveOwners(owners2);

  return sendOk(res);
});

authed('/api/owner-remove-password', (payload, res, { userId }) => {
  const { currentPassword } = payload;

  const owners = pruneExpiredOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q yoki muddati tugagan');
  const owner = ownerCtx.owner;

  if (!owner.login || !owner.passwordHash) {

    return sendOk(res, { alreadyRemoved: true });
  }
  if (!verifyPassword(currentPassword, owner.passwordHash)) {
    return sendFail(res, 'Joriy parol noto\'g\'ri.');
  }

  const owners2 = loadOwners();
  const target = findOwner(owners2, owner.id);
  if (!target) return sendFail(res, 'Bunday do\'kon egasi topilmadi');

  target.login = null;
  target.passwordHash = null;
  target.sessionToken = null;
  target.sessionExpiresAt = null;
  saveOwners(owners2);

  return sendOk(res);
});

// ===== Parol taxminidan himoya =====
// Bitta login uchun LOGIN_MAX_FAILS marta xato urinishdan keyin shu login LOGIN_LOCK_MS ga
// bloklanadi. Hisob xotirada turadi (server qayta ishga tushsa nollanadi) — bu yetarli:
// maqsad parolni avtomatik tanlashni amalda imkonsiz qilish.
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // login -> { count, firstAt, lockedUntil }

function loginLockedFor(key) {
  const r = loginFails.get(key);
  if (!r || !r.lockedUntil) return 0;
  const left = r.lockedUntil - Date.now();
  if (left <= 0) { loginFails.delete(key); return 0; }
  return left;
}
function noteLoginFail(key) {
  const now = Date.now();
  let r = loginFails.get(key);
  if (!r || now - r.firstAt > LOGIN_WINDOW_MS) r = { count: 0, firstAt: now, lockedUntil: 0 };
  r.count++;
  if (r.count >= LOGIN_MAX_FAILS) r.lockedUntil = now + LOGIN_LOCK_MS;
  loginFails.set(key, r);
  if (loginFails.size > 5000) {
    for (const [k, v] of loginFails) if (now - v.firstAt > LOGIN_WINDOW_MS && (!v.lockedUntil || v.lockedUntil < now)) loginFails.delete(k);
  }
}
function clearLoginFails(key) { loginFails.delete(key); }
function loginLockedReason(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  return `Juda ko'p noto'g'ri urinish. ${min} daqiqadan so'ng qayta urinib ko'ring yoki "Parolni unutdim" dan foydalaning.`;
}

// Xodim kirishi: login = Telegram ID. Sessiya xodim yozuvining o'zida saqlanadi va
// verifyAuth uni Telegram orqali kirgandek o'sha xodim ID si bilan tanitadi.
function staffLogin(telegramId, password, res) {
  const owners = loadOwners();
  const rec = findStaffRecord(owners, telegramId);
  if (!rec || !verifyStaffPassword(rec.staff, password)) {
    noteLoginFail(telegramId);
    const hint = rec && !rec.staff.passwordHash && !STAFF_DEFAULT_PASSWORD
      ? ' Hali shaxsiy parolingiz yo\'q — "Parolni unutdim" orqali botdan oling.'
      : '';
    return sendFail(res, 'Login yoki parol noto\'g\'ri.' + hint);
  }
  clearLoginFails(telegramId);
  if (!isOwnerAccessValid(rec.owner)) {
    return sendFail(res, 'Oshxona obunasi faol emas. Egasi bilan bog\'laning.');
  }
  const token = crypto.randomBytes(24).toString('hex');
  rec.staff.sessionToken = token;
  rec.staff.sessionExpiresAt = new Date(Date.now() + SESSION_TOKEN_TTL_MS).toISOString();
  saveOwners(owners);
  return sendOk(res, {
    sessionToken: `sess_${token}`,
    restaurantName: (rec.owner.profile && rec.owner.profile.name) || null
  });
}

route('/api/owner-login', (payload, res) => {
  const { login, password } = payload;
  const loginNorm = normalizeLogin(login);
  if (!loginNorm || !password) {
    return sendFail(res, 'Login va parolni kiriting.');
  }
  const lockedMs = loginLockedFor(loginNorm);
  if (lockedMs) return sendFail(res, loginLockedReason(lockedMs));

  const owners = pruneExpiredOwners();
  const owner = owners.find(o => normalizeLogin(o.login) === loginNorm);
  if (!owner && /^\d{5,15}$/.test(loginNorm)) {
    return staffLogin(loginNorm, password, res);
  }
  if (!owner || !owner.passwordHash || !verifyPassword(password, owner.passwordHash)) {
    noteLoginFail(loginNorm);
    return sendFail(res, 'Login yoki parol noto\'g\'ri.');
  }
  clearLoginFails(loginNorm);
  if (!isOwnerAccessValid(owner)) {
    return sendJSON(res, 200, subscriptionBlockedJSON(owners, owner.id, 'Obuna muddati tugagan. Administrator bilan bog\'laning.'));
  }

  const owners2 = loadOwners();
  const target = findOwner(owners2, owner.id);
  const token = crypto.randomBytes(24).toString('hex');
  target.sessionToken = token;
  target.sessionExpiresAt = new Date(Date.now() + SESSION_TOKEN_TTL_MS).toISOString();
  saveOwners(owners2);

  return sendOk(res, {
    sessionToken: `sess_${token}`,
    restaurantName: (target.profile && target.profile.name) || null
  });
});

route('/api/owner-logout', (payload, res) => {
  const { initData } = payload;
  if (typeof initData === 'string' && initData.startsWith('sess_')) {
    const token = initData.slice('sess_'.length);
    const owners = loadOwners();
    const owner = owners.find(o => o.sessionToken === token);
    if (owner) {
      owner.sessionToken = null;
      owner.sessionExpiresAt = null;
      saveOwners(owners);
    } else {
      for (const o of owners) {
        const staff = (o.staff || []).find(st => st.sessionToken === token);
        if (staff) {
          staff.sessionToken = null;
          staff.sessionExpiresAt = null;
          saveOwners(owners);
          break;
        }
      }
    }
  }
  return sendOk(res);
});

// ===== "Parolni unutdim": Telegram ID bo'yicha botdan yangi login/parol =====
// Saytda ID kiritilganda parol darhol o'zgarmaydi: egasiga botda tasdiqlash tugmasi boradi va
// yangi parol faqat o'sha Telegram akkaunt tugmani bosgandagina yaratiladi. Shu tufayli begona odam
// birovning ID sini kiritsa ham, parolni o'zgartira olmaydi va hech narsa bilmaydi.
const PW_RESET_TTL_MS = 15 * 60 * 1000;
const PW_RESET_COOLDOWN_MS = 2 * 60 * 1000;
const pwResetRequests = new Map(); // nonce -> { ownerId, expiresAt }
const pwResetLastAt = new Map(); // ownerId -> oxirgi so'rov vaqti

function generateReadablePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

route('/api/password-reset-request', async (payload, res) => {
  const telegramId = String(payload.telegramId || '').trim();
  if (!/^\d{5,15}$/.test(telegramId)) {
    return sendFail(res, 'Telegram ID faqat raqamlardan iborat bo\'ladi (masalan: 123456789).');
  }
  const genericOk = { message: 'Agar bu ID tizimda bo\'lsa, botdan tasdiqlash xabari yuborildi. Telegram\'ni oching.' };

  const now = Date.now();
  if (now - (pwResetLastAt.get(telegramId) || 0) < PW_RESET_COOLDOWN_MS) return sendOk(res, genericOk);
  pwResetLastAt.set(telegramId, now);
  for (const [nonce, r] of pwResetRequests) if (r.expiresAt < now) pwResetRequests.delete(nonce);

  const allOwners = loadOwners();
  const owner = findOwner(allOwners, telegramId);
  const kind = owner && owner.login ? 'owner' : (findStaffRecord(allOwners, telegramId) ? 'staff' : null);
  if (kind) {
    const nonce = crypto.randomBytes(12).toString('hex');
    pwResetRequests.set(nonce, { ownerId: telegramId, kind, expiresAt: now + PW_RESET_TTL_MS });
    await sendMessage(telegramId,
      '🔐 <b>Parolni tiklash so\'rovi</b>\n\nSaytda sizning Telegram ID raqamingiz bilan yangi parol so\'raldi.\n' +
      'Agar bu siz bo\'lsangiz, pastdagi tugmani bosing — yangi login va parol shu yerga yuboriladi.\n\n' +
      '<i>Siz so\'ramagan bo\'lsangiz, "Men so\'ramadim" ni bosing — parolingiz o\'zgarmaydi.</i>',
      { inline_keyboard: [
        [{ text: '🔑 Yangi login va parol olish', callback_data: `pwreset:${nonce}` }],
        [{ text: '❌ Men so\'ramadim', callback_data: `pwresetno:${nonce}` }]
      ] });
  }
  return sendOk(res, genericOk);
});

async function handlePasswordResetCallback(cq, data, chatId, messageId) {
  const declined = data.startsWith('pwresetno:');
  const nonce = data.slice(data.indexOf(':') + 1);
  const req = pwResetRequests.get(nonce);
  pwResetRequests.delete(nonce);
  if (!req || req.expiresAt < Date.now() || String(cq.from.id) !== req.ownerId) {
    await answerCallbackQuery(cq.id, 'Bu havola eskirgan. Saytdan qaytadan "Parolni unutdim" ni bosing.', true);
    return;
  }
  if (declined) {
    await answerCallbackQuery(cq.id, 'Bekor qilindi');
    await editMessageText(chatId, messageId, '✅ Parolni tiklash bekor qilindi. Parolingiz o\'zgarmadi.');
    return;
  }

  const owners = loadOwners();
  // Egasi: o'z logini. Xodim: login doim Telegram ID.
  let account = null, login = null;
  if (req.kind === 'staff') {
    const rec = findStaffRecord(owners, req.ownerId);
    if (rec) { account = rec.staff; login = String(rec.staff.id); }
  } else {
    const owner = findOwner(owners, req.ownerId);
    if (owner && owner.login) { account = owner; login = owner.login; }
  }
  if (!account) {
    await answerCallbackQuery(cq.id, 'Akkaunt topilmadi.', true);
    return;
  }
  const newPassword = generateReadablePassword();
  account.passwordHash = hashPassword(newPassword);
  account.sessionToken = null; // eski kirishlar yopiladi
  account.sessionExpiresAt = null;
  saveOwners(owners);

  await answerCallbackQuery(cq.id, 'Yangi parol yuborildi');
  await editMessageText(chatId, messageId,
    '🔑 <b>Yangi kirish ma\'lumotlari</b>\n\n' +
    `Login: <code>${escapeHtmlServer(login)}</code>\n` +
    `Parol: <code>${newPassword}</code>\n\n` +
    'Kirgandan keyin sozlamalardan parolni o\'zingizga qulayiga almashtiring. Bu xabarni hech kimga ko\'rsatmang.');
}

authed('/api/add-owner', async (payload, res, { userId }) => {
  const { input, days, price, paid } = payload;

  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin qo\'sha oladi');

  const resolved = await resolveUserInput(input);
  if (resolved.error) return sendFail(res, resolved.error);

  let expiresAt = null;
  if (days !== undefined && days !== null && days !== '') {
    const n = parseInt(days, 10);
    if (!Number.isInteger(n) || n <= 0) {
      return sendFail(res, 'Kun soni musbat butun son bo\'lishi kerak, yoki bo\'sh qoldiring (doimiy).');
    }
    expiresAt = new Date(Date.now() + n * 86400000).toISOString();
  }

  let priceVal = 0;
  if (price !== undefined && price !== null && price !== '') {
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) {
      return sendFail(res, 'Narx musbat son bo\'lishi kerak.');
    }
    priceVal = p;
  }

  const owners = loadOwners();
  if (isAdminId(resolved.id)) {
    return sendFail(res, 'Bu foydalanuvchi allaqachon administrator');
  }
  if (findOwner(owners, resolved.id)) {
    return sendFail(res, 'Bu foydalanuvchi ro\'yxatda allaqachon bor');
  }

  const newOwner = {
    id: resolved.id,
    username: resolved.username || null,
    addedAt: new Date().toISOString(),
    expiresAt,
    price: priceVal,
    paid: !!paid,
    paidAt: paid ? new Date().toISOString() : null,

    subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
    subscriptionUntil: expiresAt,
    graceUntil: null,
    trialGivenAt: null
  };
  owners.push(newOwner);
  saveOwners(owners);
  if (newOwner.paid) recordPayment(newOwner, priceVal);

  return sendOk(res, { owner: newOwner });
});

authed('/api/update-owner-billing', (payload, res, { userId }) => {
  const { id, price, paid } = payload;

  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'zgartira oladi');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  const owners = loadOwners();
  const owner = findOwner(owners, id);
  if (!owner) return sendFail(res, 'Bunday do\'kon egasi topilmadi');

  if (price !== undefined && price !== null && price !== '') {
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) {
      return sendFail(res, 'Narx musbat son bo\'lishi kerak.');
    }
    owner.price = p;
  }

  let justPaid = false;
  if (paid !== undefined && paid !== null) {
    const wasPaid = !!owner.paid;
    owner.paid = !!paid;
    if (owner.paid && !wasPaid) { owner.paidAt = new Date().toISOString(); justPaid = true; }
    if (!owner.paid) owner.paidAt = null;
  }

  saveOwners(owners);

  if (justPaid) {
    recordPayment(owner, owner.price);
  }
  return sendOk(res, { owner });
});

authed('/api/remove-owner', (payload, res, { userId }) => {
  const { id } = payload;

  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'chira oladi');
  if (!id) return sendFail(res, 'ID ko\'rsatilmagan');

  let owners = loadOwners();
  const before = owners.length;
  const target = findOwner(owners, id);

  if (target) moveOwnerToTrash(target, userId);
  owners = owners.filter(o => String(o.id) !== String(id));
  saveOwners(owners);

  return sendOk(res, { removed: before !== owners.length });
});

authed('/api/trash-list', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  const now = Date.now();
  const list = loadTrash().map(t => ({
    id: t.id,
    ownerId: t.ownerSnapshot.id,
    ownerLabel: ownerLabel(t.ownerSnapshot),
    restaurantName: (t.ownerSnapshot.profile && t.ownerSnapshot.profile.name) || null,
    trashedAt: t.trashedAt,
    autoPurgeAt: t.autoPurgeAt,
    daysLeft: Math.max(0, Math.ceil((new Date(t.autoPurgeAt).getTime() - now) / 86400000)),
    restoreStatus: t.restoreStatus
  })).sort((a, b) => new Date(a.autoPurgeAt) - new Date(b.autoPurgeAt));

  return sendOk(res, { trash: list });
});

authed('/api/trash-restore', (payload, res, { userId }) => {
  const { trashId } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin tiklay oladi');
  if (!trashId) return sendFail(res, 'ID ko\'rsatilmagan');

  const trash = loadTrash();
  const entry = findTrashEntry(trash, trashId);
  if (!entry) return sendFail(res, 'Bu yozuv Savatchada topilmadi.');

  const result = restoreOwnerFromTrash(entry);
  if (!result.ok) return sendFail(res, result.reason);

  saveTrash(trash.filter(t => t.id !== trashId));
  logTrashEvent('restored', entry.ownerSnapshot, { restoredBy: userId, via: 'admin_panel' });
  sendMessage(entry.ownerSnapshot.id,
    `✅ <b>Oshxonangiz tiklandi!</b>\nBarcha ma'lumotlaringiz (menyu, xodimlar, sozlamalar) saqlanib qolgan. Mini App tugmasi orqali oching.`)
    .catch(() => {});

  return sendOk(res);
});

authed('/api/trash-purge-now', (payload, res, { userId }) => {
  const { trashId } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin o\'chira oladi');
  if (!trashId) return sendFail(res, 'ID ko\'rsatilmagan');

  const trash = loadTrash();
  const entry = findTrashEntry(trash, trashId);
  if (!entry) return sendFail(res, 'Bu yozuv Savatchada topilmadi.');

  archiveOwnerOrders(entry.ownerSnapshot);
  logTrashEvent('purged', entry.ownerSnapshot, { reason: 'admin_qolda', purgedBy: userId });
  saveTrash(trash.filter(t => t.id !== trashId));

  return sendOk(res);
});

authed('/api/trash-log', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  const log = loadTrashLog().slice().sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 200);
  return sendOk(res, { log });
});

authed('/api/backup-export', (payload, res, { user, userId }) => {
  const owners0 = pruneExpiredOwners();
  const owner0 = findOwner(owners0, userId);
  if (!isOwnerAccessValid(owner0)) return sendFail(res, 'Zaxira faqat tasdiqlangan do\'kon egasiga ruxsat etilgan.');

  let snapshot;
  try {
    snapshot = buildBackupSnapshot(userId);
  } catch (e) {
    console.error('backup-export xatolik:', e.message);
    return sendFail(res, 'Zaxira tayyorlashda xatolik yuz berdi.');
  }

  const json = JSON.stringify(snapshot, null, 2);
  const filename = `zaxira_${new Date().toISOString().slice(0, 10)}.json`;

  const adminName = (user && (user.first_name || user.username)) || userId;
  const totalRecords = Object.values(snapshot.counts).reduce((a, b) => a + b, 0);
  allAdminIds().forEach(aid => {
    sendMessage(aid, `🔐 <b>DB zaxirasi yuklab olindi</b>\n👤 ${adminName} (ID: ${userId})\n🕒 ${new Date().toLocaleString('uz-UZ')}\n📦 Jami ${totalRecords} ta yozuv`)
      .catch(() => {});
  });

  return sendOk(res, {
    filename,
    mime: 'application/json;charset=utf-8',
    content: json,
    counts: snapshot.counts
  });
});

authed('/api/backup-import-preview', (payload, res, { userId }) => {
  const owners1 = pruneExpiredOwners();
  const owner1 = findOwner(owners1, userId);
  if (!isOwnerAccessValid(owner1)) return sendFail(res, 'Bazani tiklash faqat tasdiqlangan do\'kon egasiga ruxsat etilgan.');

  const rawContent = payload.content;
  if (!rawContent || typeof rawContent !== 'string') {
    return sendFail(res, 'Fayl tanlanmagan yoki bo\'sh.');
  }

  let snapshot;
  try {
    snapshot = JSON.parse(rawContent);
  } catch (e) {
    return sendFail(res, 'Bu fayl to\'g\'ri JSON zaxira fayli emas.');
  }

  if (!snapshot || typeof snapshot !== 'object' || !snapshot.files || typeof snapshot.files !== 'object') {
    return sendFail(res, 'Fayl formati noto\'g\'ri — bu Mini App zaxira fayli emasga o\'xshaydi.');
  }
  const knownKeys = new Set(BACKUP_FILE_DEFS.map(d => d.key));
  const fileKeys = Object.keys(snapshot.files).filter(k => knownKeys.has(k));
  if (fileKeys.length === 0) {
    return sendFail(res, 'Faylda tanish bo\'limlar topilmadi.');
  }

  const contentHash = crypto.createHash('sha256').update(rawContent).digest('hex');
  const token = crypto.randomBytes(16).toString('hex');
  pendingBackupRestores.set(token, { adminId: userId, contentHash, createdAt: Date.now(), snapshot });

  return sendOk(res, {
    confirmToken: token,
    version: snapshot.version || null,
    exportedAt: snapshot.exportedAt || null,
    counts: snapshot.counts || null,
    sections: fileKeys
  });
});

authed('/api/backup-import-confirm', (payload, res, { user, userId }) => {
  const owners2 = pruneExpiredOwners();
  const owner2 = findOwner(owners2, userId);
  if (!isOwnerAccessValid(owner2)) return sendFail(res, 'Bazani tiklash faqat tasdiqlangan do\'kon egasiga ruxsat etilgan.');

  const { confirmToken, confirmText, content } = payload;
  if ((confirmText || '').trim().toUpperCase() !== 'TASDIQLAYMAN') {
    return sendFail(res, 'Tasdiqlash uchun "TASDIQLAYMAN" so\'zini aniq kiriting.');
  }
  const pending = confirmToken && pendingBackupRestores.get(confirmToken);
  if (!pending) {
    return sendFail(res, 'Tasdiqlash muddati tugagan yoki noto\'g\'ri. Faylni qaytadan yuklang.');
  }
  if (String(pending.adminId) !== userId) {
    return sendFail(res, 'Bu tasdiqlash boshqa admin uchun yaratilgan.');
  }
  if (Date.now() - pending.createdAt > BACKUP_RESTORE_TOKEN_TTL_MS) {
    pendingBackupRestores.delete(confirmToken);
    return sendFail(res, 'Tasdiqlash muddati (10 daqiqa) tugagan. Faylni qaytadan yuklang.');
  }
  const contentHash = crypto.createHash('sha256').update(String(content || '')).digest('hex');
  if (contentHash !== pending.contentHash) {
    return sendFail(res, 'Fayl mazmuni preview qilingandan beri o\'zgargan. Qaytadan yuklang.');
  }

  pendingBackupRestores.delete(confirmToken);

  let safetyFile = null;
  let applied = [];
  try {
    safetyFile = savePreRestoreSafetySnapshot(userId);
    applied = applyBackupSnapshot(pending.snapshot);
  } catch (e) {
    console.error('backup-import-confirm xatolik:', e.message);
    return sendFail(res, 'Bazani tiklashda xatolik yuz berdi. Hech narsa o\'zgartirilmadi yoki qisman o\'zgargan bo\'lishi mumkin — pre_restore_backups papkasini tekshiring.');
  }

  const adminName = (user && (user.first_name || user.username)) || userId;
  allAdminIds().forEach(aid => {
    sendMessage(aid, `⚠️ <b>DB TIKLANDI (restore)</b>\n👤 ${adminName} (ID: ${userId})\n🕒 ${new Date().toLocaleString('uz-UZ')}\n📦 Almashtirilgan bo'limlar: ${applied.join(', ') || 'yo\'q'}\n💾 Tiklashdan oldingi holat saqlandi: ${safetyFile || 'saqlanmadi (xatolik)'}`)
      .catch(() => {});
  });

  return sendOk(res, { applied, safetyFile });
});

authed('/api/create-invite', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin havola yarata oladi');

  if (!BOT_USERNAME || BOT_USERNAME === 'BOT_USERNAME_BU_YERGA') {
    return sendFail(res, 'Serverda BOT_USERNAME sozlanmagan.');
  }

  const token = createInvite();
  const link = `https://t.me/${BOT_USERNAME}?start=inv_${token}`;
  return sendOk(res, { link });
});

authed('/api/subscription-status', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return sendFail(res, 'Faqat do\'kon egasi uchun.');
  const owner = ownerCtx.owner;

  const access = getOwnerSubscriptionAccess(owner);
  const requisites = loadPaymentRequisites();
  const plans = loadSubscriptionPlans();
  const tariffs = loadTariffs();
  const plansList = Object.values(plans)
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(p => {
      const tariff = p.tariffId ? tariffs.find(t => t.id === p.tariffId) : null;
      return { ...p, tariffLabel: tariff ? tariff.name : null };
    });

  return sendOk(res, {
    status: access.status,
    allowed: access.allowed,
    daysLeft: access.daysLeft,
    inGrace: access.inGrace,
    subscriptionUntil: owner.subscriptionUntil || null,
    requisites: { cardNumber: requisites.cardNumber, cardHolder: requisites.cardHolder },
    plans: plansList,
    pendingRequest: owner.subscriptionPaymentRequest || null
  });
});

authed('/api/subscription-history', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return sendFail(res, 'Faqat do\'kon egasi uchun.');
  const owner = ownerCtx.owner;

  const history = loadPayments()
    .filter(p => String(p.ownerId) === String(owner.id) && p.source === 'subscription')
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .map(p => ({ planLabel: p.planLabel, amount: p.amount, days: p.days, at: p.at }));

  return sendOk(res, { history });
});

authed('/api/subscription-select-plan', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ownerCtx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ownerCtx)) return sendFail(res, 'Faqat do\'kon egasi uchun.');
  const owner = ownerCtx.owner;

  const plan = loadSubscriptionPlans()[payload.planId];
  if (!plan) return sendFail(res, 'Tarif topilmadi.');

  const reqData = createSubscriptionPaymentRequest(owner, payload.planId);
  saveOwners(owners);

  sendMessage(owner.id,
    `✅ Siz <b>${escapeHtmlServer(plan.label)}</b> tarifini tanladingiz (${fmtNum(plan.price)} so'm).\n\n` +
    `Endi to'lov chekining (skrinshotning) RASMINI shu botga yuboring — administrator tekshirib ` +
    `tasdiqlagach, obunangiz avtomatik yangilanadi.`);

  return sendOk(res, { request: reqData, botUsername: BOT_USERNAME || null });
});

authed('/api/admin-pending-subscription-payments', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  const owners = loadOwners();
  const pending = owners
    .filter(o => o.subscriptionPaymentRequest && o.subscriptionPaymentRequest.status === 'kutilmoqda_tasdiq')
    .map(o => ({
      ownerId: o.id,
      ownerLabel: ownerLabel(o),
      restaurantName: (o.profile && o.profile.name) || null,
      request: o.subscriptionPaymentRequest
    }));

  return sendOk(res, { pending });
});

authed('/api/admin-subscription-decide', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin qaror qabul qila oladi');

  const owners = loadOwners();
  const owner = findOwner(owners, payload.ownerId);
  if (!owner) return sendFail(res, 'Oshxona topilmadi.');

  const action = payload.action === 'approve' ? 'approve' : (payload.action === 'reject' ? 'reject' : null);
  if (!action) return sendFail(res, 'Noto\'g\'ri amal.');

  const result = decideSubscriptionPayment(owner, action, userId, payload.reason);
  if (!result.ok) return sendJSON(res, 200, result);
  saveOwners(owners);

  return sendOk(res, { newUntil: result.newUntil || null });
});

function collectBroadcastRecipients(targetType) {
  const owners = loadOwners();
  const ids = new Set();
  if (targetType === 'owner' || targetType === 'all') {
    owners.forEach(o => ids.add(String(o.id)));
  }
  if (targetType === 'customer' || targetType === 'all') {
    owners.forEach(o => (o.customers || []).forEach(c => ids.add(String(c.id))));
  }
  if (targetType === 'staff' || targetType === 'all') {
    owners.forEach(o => (o.staff || []).forEach(s => ids.add(String(s.id))));
  }
  return Array.from(ids);
}

function isValidBroadcastImageUrl(value) {
  return !IMG_URL_RE.test(value) && isValidImageValue(value);
}
function isBase64ImageValue(value) {
  return !!value && /^data:image\/(png|jpe?g|webp);base64,/i.test(value);
}

function sendBroadcastToChat(chatId, text, photo, buttonText, buttonUrl) {
  const replyMarkup = (buttonText && buttonUrl) ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] } : null;
  const params = { chat_id: chatId, parse_mode: 'HTML' };
  if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup);
  const method = photo ? 'sendPhoto' : 'sendMessage';
  if (photo) { params.photo = photo; params.caption = text; }
  else { params.text = text; }
  return telegramApi(method, params).then(result => {
    if (!result || !result.ok) {
      const reason = (result && result.description) || 'noma\'lum xatolik';
      console.error(`[broadcast xato] chat_id=${chatId}: ${reason}`);
      return false;
    }
    return true;
  }).catch(err => {
    console.error(`[broadcast tarmoq xatosi] chat_id=${chatId}: ${(err && err.message) || err}`);
    return false;
  });
}

async function sendBroadcastPhotoUploadAndGetFileId(chatId, dataUrl, text, buttonText, buttonUrl) {
  const match = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return { ok: false, fileId: null };
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  const replyMarkup = (buttonText && buttonUrl) ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] } : null;
  const fields = { caption: text, parse_mode: 'HTML' };
  if (replyMarkup) fields.reply_markup = JSON.stringify(replyMarkup);
  try {
    const result = await telegramApiUploadPhoto(chatId, buffer, mimeType, fields);
    if (!result || !result.ok) {
      const reason = (result && result.description) || 'noma\'lum xatolik';
      console.error(`[broadcast rasm yuklash xatosi] chat_id=${chatId}: ${reason}`);
      return { ok: false, fileId: null };
    }
    const sizes = result.result && result.result.photo;
    const fileId = (Array.isArray(sizes) && sizes.length) ? sizes[sizes.length - 1].file_id : null;
    return { ok: true, fileId };
  } catch (err) {
    console.error(`[broadcast rasm yuklash tarmoq xatosi] chat_id=${chatId}: ${(err && err.message) || err}`);
    return { ok: false, fileId: null };
  }
}

async function sendBroadcastSequential(recipientIds, text, image, buttonText, buttonUrl) {
  let delivered = 0, failed = 0;
  let pendingUpload = isBase64ImageValue(image);
  let photo = pendingUpload ? null : (image || null);

  for (const chatId of recipientIds) {
    let ok;
    if (pendingUpload) {
      const uploadResult = await sendBroadcastPhotoUploadAndGetFileId(chatId, image, text, buttonText, buttonUrl);
      ok = uploadResult.ok;
      if (ok) {
        pendingUpload = false;
        photo = uploadResult.fileId;
      }
    } else {
      ok = await sendBroadcastToChat(chatId, text, photo, buttonText, buttonUrl);
    }
    if (ok) delivered++; else failed++;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return { delivered, failed };
}

authed('/api/broadcast-send', async (payload, res, { userId }) => {
  const { targetType, text, imageUrl, buttonText, buttonUrl } = payload;
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin yubora oladi');

  if (!['customer', 'owner', 'staff', 'all'].includes(targetType)) {
    return sendFail(res, 'Qabul qiluvchi turini tanlang.');
  }
  const textTrim = String(text || '').trim();
  if (!textTrim) return sendFail(res, 'Xabar matnini kiriting.');
  const imageTrim = String(imageUrl || '').trim();
  if (!isValidBroadcastImageUrl(imageTrim)) {
    return sendFail(res, 'Rasm uchun https:// havola kiriting yoki galereyadan tanlang.');
  }
  const buttonTextTrim = String(buttonText || '').trim();
  const buttonUrlTrim = String(buttonUrl || '').trim();
  if ((buttonTextTrim && !buttonUrlTrim) || (!buttonTextTrim && buttonUrlTrim)) {
    return sendFail(res, 'Tugma uchun ham matn, ham havola kerak (yoki ikkalasini ham bo\'sh qoldiring).');
  }
  if (buttonUrlTrim && !/^https?:\/\//i.test(buttonUrlTrim)) {
    return sendFail(res, 'Tugma havolasi http:// yoki https:// bilan boshlanishi kerak.');
  }

  const recipientIds = collectBroadcastRecipients(targetType);
  if (!recipientIds.length) {
    return sendFail(res, 'Bu toifada hozircha hech kim yo\'q.');
  }

  const { delivered, failed } = await sendBroadcastSequential(
    recipientIds, textTrim, imageTrim || null, buttonTextTrim || null, buttonUrlTrim || null
  );

  const isBase64Img = isBase64ImageValue(imageTrim);
  const broadcasts = loadBroadcasts();
  const record = {
    id: crypto.randomBytes(4).toString('hex'),
    targetType,
    text: textTrim,
    imageUrl: isBase64Img ? null : (imageTrim || null),
    hadImage: !!imageTrim,
    buttonText: buttonTextTrim || null,
    buttonUrl: buttonUrlTrim || null,
    totalTargets: recipientIds.length,
    deliveredCount: delivered,
    failedCount: failed,
    sentBy: userId,
    sentAt: new Date().toISOString()
  };
  broadcasts.unshift(record);
  if (broadcasts.length > 200) broadcasts.length = 200;
  saveBroadcasts(broadcasts);

  return sendOk(res, { result: record });
});

authed('/api/broadcast-history', (payload, res, { userId }) => {
  if (!isAdminId(userId)) return sendFail(res, 'Faqat admin ko\'ra oladi');

  return sendOk(res, { broadcasts: loadBroadcasts() });
});

// ==========================================================================
// CHEK (kvitansiya) CHOP ETISH
// --------------------------------------------------------------------------
// Server printerga to'g'ridan-to'g'ri ulanmaydi: u internetda, printer esa
// oshxonaning o'z tarmog'ida (yoki kassir qurilmasiga USB/Bluetooth orqali
// ulangan). Shuning uchun server faqat CHOP ETISHGA TAYYOR sahifa beradi,
// qurilmaning o'zi esa uni o'z printeriga yuboradi. Natijada printer WiFi,
// Bluetooth yoki USB orqali ulanganidan qat'i nazar — jarayon bir xil.
//
// Havola imzolanadi (HMAC), shuning uchun uni bilgan begona odam boshqa
// buyurtmani ko'ra olmaydi va imzo RECEIPT_TTL_MS dan keyin eskiradi.
// ==========================================================================
const RECEIPT_TTL_MS = 12 * 60 * 60 * 1000;
const RECEIPT_MODES = { oshxona: 'OSHXONA', mijoz: 'MIJOZ CHEKI', ikkala: 'MIJOZ + OSHXONA' };

function receiptSign(base) {
  return crypto.createHmac('sha256', BOT_TOKEN).update(base).digest('hex').slice(0, 32);
}
function receiptBase(ownerId, orderId, mode, exp) {
  return `o=${encodeURIComponent(ownerId)}&id=${encodeURIComponent(orderId)}&m=${mode}&e=${exp}`;
}
// Chek sahifasining nisbiy manzili. Frontend uni location.origin bilan birlashtiradi.
function buildReceiptPath(ownerId, orderId, mode) {
  const base = receiptBase(ownerId, orderId, mode, Date.now() + RECEIPT_TTL_MS);
  return `/chek?${base}&s=${receiptSign(base)}`;
}
function verifyReceiptParams(params) {
  const ownerId = params.get('o'), orderId = params.get('id');
  const mode = params.get('m'), exp = params.get('e'), sig = params.get('s') || '';
  if (!ownerId || !orderId || !RECEIPT_MODES[mode] || !/^\d+$/.test(exp || '')) return null;
  if (Date.now() > Number(exp)) return null;
  const expected = receiptSign(receiptBase(ownerId, orderId, mode, exp));
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { ownerId, orderId, mode };
}

// Printer sozlamalari: qog'oz eni, nusxalar soni, avtomatik chop etish va pastki matn.
function ensurePrinterSettings(owner) {
  const p = owner.printer || {};
  // v2: chek faqat TO'G'RIDAN-TO'G'RI printerga ketadi — drayver/chop etish oynasi ishlatilmaydi.
  // Eski sozlamalar bir marta ko'chiriladi: 'brauzer' -> 'agent' va avtomatik chop etish yoqiladi
  // (buyurtma oshxonaga yuborilishi bilan chek chiqadi). Keyin ega avtomatikni o'chirishi mumkin.
  const migrate = p.v !== 2;
  owner.printer = {
    v: 2,
    // 'agent' — kompyuterdagi print-agent dasturi, drayversiz USB yoki WiFi (IP:9100);
    // 'rawbt' — Android'dagi RawBT ilovasi orqali (telefonga ulangan printer uchun).
    mode: p.mode === 'rawbt' ? 'rawbt' : 'agent',
    agentToken: typeof p.agentToken === 'string' ? p.agentToken : null,
    width: p.width === 58 ? 58 : 80,
    copies: Math.min(3, Math.max(1, Number(p.copies) || 1)),
    auto: migrate ? true : !!p.auto,                       // oshxona cheki — buyurtma oshxonaga tushganda
    autoCustomer: p.autoCustomer === undefined ? true : !!p.autoCustomer, // mijoz cheki — buyurtma tayyor bo'lganda
    footer: typeof p.footer === 'string' ? p.footer : 'Rahmat! Yana kutamiz.',
    // Mijoz chekining tepasidagi brend rasmi (logotip + nom), bot ilovasida canvas orqali
    // 1-bitli rastrga aylantirilgan: { width: 58|80, w, h, data: base64, sig }
    header: isValidHeaderRaster(p.header) ? p.header : null
  };
  return owner.printer;
}

function isValidHeaderRaster(h) {
  return !!h && (h.width === 58 || h.width === 80) &&
    Number.isInteger(h.w) && h.w > 0 && h.w <= 576 && h.w % 8 === 0 &&
    Number.isInteger(h.h) && h.h > 0 && h.h <= 480 &&
    typeof h.data === 'string' && Buffer.from(h.data, 'base64').length === (h.w / 8) * h.h;
}

// Buyurtma joriy ro'yxatda yoki arxivda bo'lishi mumkin.
function findOrderAnywhere(owner, orderId) {
  const live = (owner.orders || []).find(o => String(o.id) === String(orderId));
  if (live) return live;
  const archived = loadArchivedOrders()
    .find(a => String(a.ownerId) === String(owner.id) && String(a.id) === String(orderId));
  return archived || null;
}

function receiptTimeLabel(iso) {
  const d = new Date(iso || Date.now());
  const tz = new Date(d.getTime() + 5 * 60 * 60 * 1000); // Toshkent vaqti
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(tz.getUTCDate())}.${p2(tz.getUTCMonth() + 1)}.${tz.getUTCFullYear()} ${p2(tz.getUTCHours())}:${p2(tz.getUTCMinutes())}`;
}

// Bitta chek nusxasining ichki qismi (nusxalar soniga qarab takrorlanadi).
function receiptBodyHtml(owner, order, mode) {
  const esc = escapeHtmlServer;
  const profile = owner.profile || {};
  const brand = profile.name || 'PULSAR';
  const branch = (owner.branches || []).find(b => String(b.id) === String(order.branchId));
  const forKitchen = mode === 'oshxona';

  const rows = (order.items || []).map(it => {
    const sum = fmtNum((it.price || 0) * (it.qty || 0));
    return `<tr><td class="q">${it.qty}×</td><td class="n">${esc(it.name)}</td>` +
      (forKitchen ? '' : `<td class="s">${sum}</td>`) + '</tr>';
  }).join('');

  const lines = [];
  if (order.comment) lines.push(['Izoh', esc(order.comment)]);
  if (order.orderType === 'dostavka') {
    if (order.addressNote) lines.push(['Manzil', esc(order.addressNote)]);
    if (order.extraPhone) lines.push(['Telefon', esc(order.extraPhone)]);
    else if (order.customerPhone) lines.push(['Telefon', esc(order.customerPhone)]);
    if (order.customerName) lines.push(['Mijoz', esc(order.customerName)]);
  }
  if (!forKitchen) {
    lines.push(["To'lov", PAYMENT_TYPES[order.paymentType] || esc(order.paymentType || '')]);
  }

  const money = !forKitchen ? `
    <div class="sep"></div>
    ${order.discountAmount ? `<div class="row"><span>Chegirma</span><span>−${fmtNum(order.discountAmount)}</span></div>` : ''}
    ${order.pointsUsed ? `<div class="row"><span>Bonus</span><span>−${fmtNum(order.pointsUsed)}</span></div>` : ''}
    <div class="row total"><span>JAMI</span><span>${fmtNum(order.total || 0)} so'm</span></div>
    ${order.pointsEarned ? `<div class="row small"><span>Bonus qo'shildi</span><span>+${fmtNum(order.pointsEarned)}</span></div>` : ''}` : '';

  return `
  <div class="chek">
    ${profile.logoUrl ? `<img class="logo" src="${esc(profile.logoUrl)}" alt="">` : ''}
    <div class="brand">${esc(brand)}</div>
    ${profile.address ? `<div class="sub">${esc(profile.address)}</div>` : ''}
    ${profile.phone ? `<div class="sub">${esc(profile.phone)}</div>` : ''}
    ${branch ? `<div class="sub">Filial: ${esc(branch.name)}</div>` : ''}
    <div class="sep"></div>
    <div class="mode">${RECEIPT_MODES[mode]}</div>
    <div class="no">№ ${order.orderNumber || '—'}</div>
    <div class="type">${esc(ORDER_TYPES[order.orderType] || order.orderType || '')}</div>
    <div class="sub">${receiptTimeLabel(order.createdAt)}</div>
    <div class="sep"></div>
    <table class="items">${rows}</table>
    ${money}
    ${lines.length ? '<div class="sep"></div>' + lines.map(([k, v]) => `<div class="row"><span>${k}</span><span class="v">${v}</span></div>`).join('') : ''}
    <div class="sep"></div>
    <div class="foot">${esc(owner.printer && owner.printer.footer || '')}</div>
    <div class="foot small">${esc(brand)}</div>
  </div>`;
}

// --------------------------------------------------------------------------
// ESC/POS: chek printerlari HTML emas, baytlar tilini tushunadi. Shu baytlarni
// Android'dagi RawBT ilovasi printerga (Bluetooth / WiFi / USB-OTG) uzatadi —
// kompyutersiz va chop etish oynasisiz.
// --------------------------------------------------------------------------
const ESC = 0x1B, GS = 0x1D;
const ESCPOS_CMD = {
  init: [ESC, 0x40],
  left: [ESC, 0x61, 0x00],
  center: [ESC, 0x61, 0x01],
  boldOn: [ESC, 0x45, 0x01],
  boldOff: [ESC, 0x45, 0x00],
  big: [GS, 0x21, 0x11],      // ikki baravar bo'y va en
  tall: [GS, 0x21, 0x01],     // ikki baravar bo'y
  normal: [GS, 0x21, 0x00],
  cut: [GS, 0x56, 0x42, 0x00]
};

// Printerlar lotin bo'lmagan belgilarni "krakozyabra" qilib chiqaradi,
// shuning uchun matnni oddiy ASCII ga keltiramiz.
function escposText(str) {
  return String(str == null ? '' : str)
    .replace(/[‘’ʻʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7E\n]/g, '');
}

// ESC/POS yozuvchi: matn, juftlik (chap-o'ng), uzun matnni bo'lish va rasm (GS v 0).
function escposWriter(W) {
  const chunks = [];
  const w = {
    raw: arr => chunks.push(Buffer.from(arr)),
    line: (text = '') => chunks.push(Buffer.from(escposText(text) + '\n', 'latin1')),
    rule: (ch = '-') => w.line(ch.repeat(W)),
    pair: (left, right, width = W) => {
      const l = escposText(left), r = escposText(right);
      w.line(l + ' '.repeat(Math.max(1, width - l.length - r.length)) + r);
    },
    wrap: (text, indent = 0, width = W) => {
      const words = escposText(text).split(/\s+/).filter(Boolean);
      let cur = '';
      words.forEach(word => {
        if ((cur + ' ' + word).trim().length > width - indent) { if (cur) w.line(' '.repeat(indent) + cur.trim()); cur = word; }
        else cur += ' ' + word;
      });
      if (cur.trim()) w.line(' '.repeat(indent) + cur.trim());
    },
    // 1-bitli rasm. Ba'zi printerlar bitta buyruqda katta rasmni qabul qilmaydi —
    // shuning uchun 96 qatorli bo'laklarga bo'lib yuboriladi.
    image: (raster) => {
      const bytesPerRow = raster.w / 8;
      const data = Buffer.from(raster.data, 'base64');
      for (let y = 0; y < raster.h; y += 96) {
        const rows = Math.min(96, raster.h - y);
        w.raw([GS, 0x76, 0x30, 0x00, bytesPerRow & 0xFF, bytesPerRow >> 8, rows & 0xFF, rows >> 8]);
        chunks.push(data.subarray(y * bytesPerRow, (y + rows) * bytesPerRow));
      }
    },
    done: () => Buffer.concat(chunks)
  };
  return w;
}

function receiptExtras(order) {
  const extra = [];
  if (order.orderType === 'dostavka') {
    if (order.addressNote) extra.push(['Manzil', order.addressNote]);
    if (order.extraPhone) extra.push(['Telefon', order.extraPhone]);
    else if (order.customerPhone) extra.push(['Telefon', order.customerPhone]);
    if (order.customerName) extra.push(['Mijoz', order.customerName]);
  }
  return extra;
}

// OSHXONA CHEKI — oshxona guruhiga ketadigan xabar kabi: yirik, narxsiz, tez o'qiladi.
function escposKitchenTicket(owner, order) {
  const printer = ensurePrinterSettings(owner);
  const W = printer.width === 58 ? 32 : 48;
  const w = escposWriter(W);
  const branch = (owner.branches || []).find(b => String(b.id) === String(order.branchId));

  w.raw(ESCPOS_CMD.init);
  w.raw(ESCPOS_CMD.center);
  w.raw(ESCPOS_CMD.boldOn);
  w.line('*** OSHXONA ***');
  w.raw(ESCPOS_CMD.big);
  w.line('N ' + (order.orderNumber || '-'));
  w.raw(ESCPOS_CMD.tall);
  w.line((ORDER_TYPES[order.orderType] || order.orderType || '').toUpperCase());
  w.raw(ESCPOS_CMD.normal);
  w.raw(ESCPOS_CMD.boldOff);
  w.line(receiptTimeLabel(order.createdAt) + (branch ? '  ' + branch.name : ''));
  w.rule('=');

  w.raw(ESCPOS_CMD.left);
  (order.items || []).forEach(it => {
    w.raw(ESCPOS_CMD.boldOn); w.raw(ESCPOS_CMD.tall);
    w.wrap(`${it.qty} x ${it.name}`);
    w.raw(ESCPOS_CMD.normal); w.raw(ESCPOS_CMD.boldOff);
  });

  if (order.comment) {
    w.rule('=');
    w.raw(ESCPOS_CMD.boldOn);
    w.line('IZOH:');
    w.wrap(order.comment, 2);
    w.raw(ESCPOS_CMD.boldOff);
  }
  const extra = receiptExtras(order);
  if (extra.length) {
    w.rule();
    extra.forEach(([k, v]) => { w.line(k + ':'); w.wrap(v, 2); });
  }
  w.rule('=');
  w.line(); w.line();
  w.raw(ESCPOS_CMD.cut);
  return w.done();
}

// MIJOZ CHEKI — brend sarlavhasi (rasm), narxlar jadvali, jami va to'lov.
function escposCustomerReceipt(owner, order) {
  const printer = ensurePrinterSettings(owner);
  const W = printer.width === 58 ? 32 : 48;
  const w = escposWriter(W);
  const profile = owner.profile || {};
  const branch = (owner.branches || []).find(b => String(b.id) === String(order.branchId));

  w.raw(ESCPOS_CMD.init);
  w.raw(ESCPOS_CMD.center);
  if (printer.header && printer.header.width === printer.width) {
    w.image(printer.header);
  } else {
    w.raw(ESCPOS_CMD.big); w.raw(ESCPOS_CMD.boldOn);
    w.line((profile.name || 'PULSAR').toUpperCase());
    w.raw(ESCPOS_CMD.normal); w.raw(ESCPOS_CMD.boldOff);
  }
  if (profile.address) w.wrap(profile.address);
  if (profile.phone) w.line('Tel: ' + profile.phone);
  if (branch) w.line('Filial: ' + branch.name);
  w.rule('=');

  w.raw(ESCPOS_CMD.boldOn);
  w.line('MIJOZ CHEKI');
  w.raw(ESCPOS_CMD.big);
  w.line('N ' + (order.orderNumber || '-'));
  w.raw(ESCPOS_CMD.normal); w.raw(ESCPOS_CMD.boldOff);
  w.line(`${(ORDER_TYPES[order.orderType] || order.orderType || '').toUpperCase()}  |  ${receiptTimeLabel(order.createdAt)}`);
  w.rule();

  // Jadval: nom qalin, ostida "miqdor x narx" va o'ngda summa
  w.raw(ESCPOS_CMD.left);
  (order.items || []).forEach(it => {
    const qty = it.qty || 0, price = it.price || 0;
    w.raw(ESCPOS_CMD.boldOn); w.wrap(it.name); w.raw(ESCPOS_CMD.boldOff);
    w.pair(`   ${qty} x ${fmtNum(price)}`, fmtNum(qty * price));
  });
  w.rule();

  const subtotal = order.subtotal || (order.items || []).reduce((sum, it) => sum + (it.price || 0) * (it.qty || 0), 0);
  if (order.discountAmount || order.pointsUsed) {
    w.pair('Oraliq jami', fmtNum(subtotal));
    if (order.discountAmount) w.pair('Chegirma' + (order.promoTitle ? ` (${order.promoTitle})` : ''), '-' + fmtNum(order.discountAmount));
    if (order.pointsUsed) w.pair('Bonus ballar', '-' + fmtNum(order.pointsUsed));
  }
  w.raw(ESCPOS_CMD.boldOn); w.raw(ESCPOS_CMD.tall);
  w.pair('JAMI', fmtNum(order.total || 0) + " so'm");
  w.raw(ESCPOS_CMD.normal); w.raw(ESCPOS_CMD.boldOff);
  w.rule('=');
  w.pair("To'lov turi", PAYMENT_TYPES[order.paymentType] || order.paymentType || '');
  if (order.pointsEarned) w.pair("Bonus qo'shildi", '+' + fmtNum(order.pointsEarned));

  const extra = receiptExtras(order);
  if (extra.length) {
    w.rule();
    extra.forEach(([k, v]) => w.pair(k, v));
  }

  w.rule();
  w.raw(ESCPOS_CMD.center);
  if (printer.footer) { w.raw(ESCPOS_CMD.boldOn); w.wrap(printer.footer); w.raw(ESCPOS_CMD.boldOff); }
  w.line('Yoqimli ishtaha!');
  w.raw(ESCPOS_CMD.left);
  w.line(); w.line(); w.line();
  w.raw(ESCPOS_CMD.cut);
  return w.done();
}

function escposReceipt(owner, order, mode) {
  return mode === 'mijoz' ? escposCustomerReceipt(owner, order) : escposKitchenTicket(owner, order);
}

// Nusxalar soniga qarab takrorlangan, RawBT uchun base64 ko'rinishidagi chek.
function escposBase64(owner, order, mode) {
  const printer = ensurePrinterSettings(owner);
  const one = escposReceipt(owner, order, mode);
  return Buffer.concat(Array.from({ length: printer.copies }, () => one)).toString('base64');
}

// Chek sahifasi (Android telefon + RawBT). Ochilishi bilan cheklar RawBT orqali printerga
// o'zi ketadi: 'ikkala' rejimida avval MIJOZ cheki, 3 soniyadan keyin OSHXONA cheki.
// Drayver/chop etish oynasi ishlatilmaydi. Pastdagi tugmalar — faqat avtomatik ishlamasa.
function rawbtIntentUrl(owner, order, mode) {
  return 'intent:base64,' + escposBase64(owner, order, mode) + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;';
}

function receiptPageHtml(owner, order, mode, auto) {
  const printer = ensurePrinterSettings(owner);
  const modes = mode === 'ikkala'
    ? [printer.autoCustomer ? 'mijoz' : null, printer.auto ? 'oshxona' : null].filter(Boolean)
    : [mode];
  if (!modes.length) modes.push('oshxona');
  const jobs = modes.map(m => ({ mode: m, url: rawbtIntentUrl(owner, order, m) }));
  const bodies = modes.map(m => receiptBodyHtml(owner, order, m)).join('<div class="cut"></div>');
  const paper = printer.width === 58 ? '58mm' : '80mm';
  const fs = printer.width === 58 ? 11 : 12;
  const labels = { mijoz: 'Mijoz cheki', oshxona: 'Oshxona cheki' };
  return `<!DOCTYPE html>
<html lang="uz"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chek № ${order.orderNumber || ''}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #EDEDED; color: #000;
    font-family: "Courier New", ui-monospace, monospace; font-size: ${fs}px; line-height: 1.35;
  }
  .status { font-family: system-ui, sans-serif; text-align: center; padding: 14px 16px; background: #E30613; color: #fff; font-weight: 700; font-size: 15px; }
  .chek { width: ${paper}; max-width: 100%; margin: 12px auto 0; background: #fff; padding: 4mm 3mm; }
  .logo { display: block; width: 18mm; height: 18mm; object-fit: contain; margin: 0 auto 2mm; }
  .brand { text-align: center; font-size: ${fs + 6}px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .sub { text-align: center; font-size: ${fs - 1}px; }
  .mode { text-align: center; font-weight: 700; letter-spacing: .2em; }
  .no { text-align: center; font-size: ${fs + 14}px; font-weight: 700; line-height: 1.1; }
  .type { text-align: center; font-size: ${fs + 2}px; font-weight: 700; text-transform: uppercase; }
  .sep { border-top: 1px dashed #000; margin: 2mm 0; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items td { vertical-align: top; padding: 1mm 0; }
  td.q { width: 9mm; font-weight: 700; font-size: ${fs + 2}px; }
  td.n { font-weight: 700; font-size: ${fs + 2}px; word-break: break-word; }
  td.s { text-align: right; white-space: nowrap; font-size: ${fs}px; }
  .row { display: flex; justify-content: space-between; gap: 3mm; }
  .row .v { text-align: right; word-break: break-word; }
  .row.total { font-size: ${fs + 5}px; font-weight: 700; }
  .row.small, .foot.small { font-size: ${fs - 1}px; }
  .foot { text-align: center; }
  .cut { height: 12px; }
  .tools { text-align: center; padding: 6mm 4mm 10mm; font-family: system-ui, sans-serif; }
  .tools a.btn {
    display: inline-block; font-size: 15px; font-weight: 700; padding: 14px 22px; margin: 4px;
    border-radius: 12px; background: #fff; color: #E30613; border: 2px solid #E30613; text-decoration: none;
  }
  .tools p { color: #555; font-size: 12px; margin: 8px 0 0; }
</style>
</head><body>
<div class="status" id="status">🖨 Chek printerga yuborilmoqda...</div>
${bodies}
<div class="tools">
  ${jobs.map((j, i) => `<a class="btn" href="${j.url}">${i + 1}. ${labels[j.mode]}</a>`).join('')}
  <p>Chek chiqmasa, shu tugmalarni tartib bilan bosing.<br>Printer RawBT ilovasiga ulangan bo'lishi kerak.</p>
</div>
<script>
  (function () {
    var jobs = ${JSON.stringify(jobs.map(j => j.url))};
    var auto = ${auto ? 'true' : 'false'};
    var PAUSE = 3000;          // mijoz chekidan keyin oshxona chekigacha
    var i = 0, lastAt = 0;
    var status = document.getElementById('status');
    function next() {
      if (i >= jobs.length) { status.textContent = '✅ Cheklar printerga yuborildi'; return; }
      // RawBT chop etish uchun o'z oynasini ochib-yopadi. Keyingi chekni sahifa yana
      // ko'ringanda va mijoz chekidan kamida 3 soniya o'tgach yuboramiz — ko'rinmas
      // sahifadan Android ilovani ochib bo'lmaydi.
      if (i > 0 && (Date.now() - lastAt < PAUSE || document.visibilityState !== 'visible')) {
        setTimeout(next, 250);
        return;
      }
      lastAt = Date.now();
      window.location.href = jobs[i++];
      setTimeout(next, 250);
    }
    if (auto) window.addEventListener('load', function () { setTimeout(next, 300); });
    else status.textContent = 'Chekni chiqarish uchun pastdagi tugmani bosing';
  })();
</script>
</body></html>`;
}
// --------------------------------------------------------------------------
// PRINT AGENT — printer ulangan kompyuterda ishlaydigan kichik dastur
// (print-agent/agent.js). U har 2 soniyada serverdan navbatdagi cheklarni
// so'raydi va ESC/POS baytlarini printerga DRAYVERSIZ yozadi (USB yoki
// WiFi IP:9100). Ulanishni agentning o'zi boshlagani uchun routerda port
// ochish shart emas.
//
// Navbat xotirada saqlanadi: diskka har 2 soniyada yozish owners.json'ni
// ortiqcha yuklardi. Server qayta ishga tushsa, hali chiqmagan cheklar
// yo'qoladi — shuning uchun ham eski cheklar PRINT_JOB_TTL_MS dan keyin
// bosilmaydi (oshxonaga 10 daqiqa kechikkan chek kerak emas).
// --------------------------------------------------------------------------
const PRINT_JOB_TTL_MS = 10 * 60 * 1000;
const PRINT_QUEUE_MAX = 50;
const printQueues = new Map();   // ownerId -> [{ id, orderNumber, mode, data, createdAt }]
const agentLastSeen = new Map(); // ownerId -> ISO vaqt

const AGENT_ONLINE_MS = 30 * 1000;

function isAgentOnline(owner) {
  const seen = agentLastSeen.get(String(owner.id));
  return !!seen && Date.now() - new Date(seen).getTime() < AGENT_ONLINE_MS;
}

// Chek agentga ketadimi? RawBT (Android telefon) tanlanmagan bo'lsa — doim ha:
// chek hech qachon drayver yoki chop etish oynasi orqali chiqarilmaydi.
function usesAgent(owner) {
  return ensurePrinterSettings(owner).mode !== 'rawbt';
}

function publicPrinter(owner) {
  const { agentToken, header, ...rest } = ensurePrinterSettings(owner);
  rest.hasAgentToken = !!agentToken;
  rest.headerSig = header ? header.sig || null : null;
  rest.headerWidth = header ? header.width : null;
  rest.agentLastSeen = agentLastSeen.get(String(owner.id)) || null;
  rest.agentOnline = isAgentOnline(owner);
  return rest;
}

// delayMs — chek shuncha vaqtdan keyin agentga beriladi (availableAt). Shu tufayli
// mijoz cheki doim birinchi, oshxona cheki keyin chiqadi — agent qayta ulansa ham.
function enqueuePrintJob(owner, order, mode, delayMs = 0) {
  const key = String(owner.id);
  const queue = (printQueues.get(key) || []).filter(j => Date.now() - j.createdAt < PRINT_JOB_TTL_MS);
  queue.push({
    id: crypto.randomBytes(6).toString('hex'),
    orderNumber: order.orderNumber || null,
    mode,
    data: escposBase64(owner, order, mode),
    createdAt: Date.now(),
    availableAt: Date.now() + delayMs
  });
  while (queue.length > PRINT_QUEUE_MAX) queue.shift();
  printQueues.set(key, queue);
}

function willAutoPrint(owner) {
  const printer = ensurePrinterSettings(owner);
  return usesAgent(owner) && (printer.auto || printer.autoCustomer);
}

// Buyurtma oshxonaga yuborilganda: avval MIJOZ cheki (brend, narxlar), keyin OSHXONA cheki.
// Tugma bosish shart emas. Server oshxona chekini biroz keyinroq beradi (tartib kafolati),
// aniq 3 soniyalik pauzani esa agent mijoz cheki CHIQQAN paytdan sanaydi.
const KITCHEN_AFTER_CUSTOMER_MS = 1000;
function autoPrintKitchenTicket(owner, order) {
  if (!usesAgent(owner)) return;
  const printer = ensurePrinterSettings(owner);
  let delay = 0;
  if (printer.autoCustomer) {
    enqueuePrintJob(owner, order, 'mijoz');
    delay = KITCHEN_AFTER_CUSTOMER_MS;
  }
  if (printer.auto) enqueuePrintJob(owner, order, 'oshxona', delay);
}

function findOwnerByAgentToken(owners, token) {
  if (typeof token !== 'string' || token.length !== 48) return null;
  const given = Buffer.from(token);
  return owners.find(o => {
    const t = o.printer && o.printer.agentToken;
    if (typeof t !== 'string' || t.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(t), given);
  }) || null;
}

// Egasi uchun: agent tokenini ko'rish yoki yangilash (eskisi darhol ishlamay qoladi).
authed('/api/print-agent-token', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ctx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ko\'ra oladi');
  const printer = ensurePrinterSettings(ctx.owner);
  if (payload.regenerate || !printer.agentToken) {
    printer.agentToken = crypto.randomBytes(24).toString('hex');
    saveOwners(owners);
  }
  return sendOk(res, { token: printer.agentToken, printer: publicPrinter(ctx.owner) });
});

// Agent uchun: navbatdagi cheklar. Token Telegram initData o'rnini bosadi.
route('/api/print-agent/poll', (payload, res) => {
  const owner = findOwnerByAgentToken(loadOwners(), payload.token);
  if (!owner) return sendFail(res, 'Agent tokeni noto\'g\'ri yoki yangilangan');
  const key = String(owner.id);
  agentLastSeen.set(key, new Date().toISOString());
  const queue = (printQueues.get(key) || []).filter(j => Date.now() - j.createdAt < PRINT_JOB_TTL_MS);
  printQueues.set(key, queue);
  return sendOk(res, {
    shop: (owner.profile && owner.profile.name) || null,
    jobs: queue
      .filter(j => !j.availableAt || j.availableAt <= Date.now())
      .map(j => ({ id: j.id, orderNumber: j.orderNumber, mode: j.mode, data: j.data }))
  });
});

// ----- Kompyuterni 6 xonali kod bilan ulash (nusxalashsiz) -----
// Agent ishga tushganda serverdan kod oladi va uni ekranga chiqaradi. Ega botda shu
// kodni yozadi — server agentga token beradi. Kodni faqat kompyuter qarshisidagi
// odam ko'radi; agent tokenni faqat o'zi yaratgan maxfiy "secret" bilan oladi.
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_PENDING = 500;
const pairRequests = new Map();  // kod -> { secretHash, createdAt, token, shop }
const pairAttempts = new Map();  // egasi ID -> { count, firstAt }

function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function cleanupPairRequests() {
  const now = Date.now();
  for (const [code, r] of pairRequests) if (now - r.createdAt > PAIR_TTL_MS) pairRequests.delete(code);
}

route('/api/print-agent/pair-start', (payload, res) => {
  const secret = String(payload.secret || '');
  if (!/^[0-9a-f]{32,64}$/.test(secret)) return sendFail(res, 'Noto\'g\'ri so\'rov');
  cleanupPairRequests();
  if (pairRequests.size >= PAIR_MAX_PENDING) return sendFail(res, 'Hozir so\'rovlar juda ko\'p, birozdan so\'ng urinib ko\'ring');
  let code;
  do { code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (pairRequests.has(code));
  pairRequests.set(code, { secretHash: sha256Hex(secret), createdAt: Date.now(), token: null, shop: null });
  return sendOk(res, { code, expiresInSec: PAIR_TTL_MS / 1000 });
});

route('/api/print-agent/pair-poll', (payload, res) => {
  const hash = sha256Hex(payload.secret || '');
  cleanupPairRequests();
  for (const [code, r] of pairRequests) {
    if (r.secretHash !== hash) continue;
    if (!r.token) return sendOk(res, { pending: true });
    pairRequests.delete(code);
    return sendOk(res, { token: r.token, shop: r.shop });
  }
  return sendFail(res, 'Kod muddati tugagan');
});

authed('/api/print-agent-pair', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ctx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi ulay oladi');

  const now = Date.now();
  let att = pairAttempts.get(userId);
  if (!att || now - att.firstAt > PAIR_TTL_MS) att = { count: 0, firstAt: now };
  if (att.count >= 10) return sendFail(res, 'Juda ko\'p noto\'g\'ri urinish. 10 daqiqadan so\'ng qayta urinib ko\'ring.');

  const code = String(payload.code || '').replace(/\D/g, '');
  if (code.length !== 6) return sendFail(res, 'Kompyuterdagi oynada chiqqan 6 xonali kodni yozing.');
  cleanupPairRequests();
  const r = pairRequests.get(code);
  if (!r || r.token) {
    att.count++;
    pairAttempts.set(userId, att);
    return sendFail(res, 'Bunday kod topilmadi yoki muddati tugagan. Kompyuterdagi oynadagi kodni tekshiring.');
  }
  pairAttempts.delete(userId);

  const printer = ensurePrinterSettings(ctx.owner);
  if (!printer.agentToken) printer.agentToken = crypto.randomBytes(24).toString('hex');
  printer.mode = 'agent';
  saveOwners(owners);
  r.token = printer.agentToken;
  r.shop = (ctx.owner.profile && ctx.owner.profile.name) || null;
  return sendOk(res, { printer: publicPrinter(ctx.owner) });
});

// Agent chop etgan cheklarni tasdiqlaydi — ular navbatdan o'chiriladi.
route('/api/print-agent/ack', (payload, res) => {
  const owner = findOwnerByAgentToken(loadOwners(), payload.token);
  if (!owner) return sendFail(res, 'Agent tokeni noto\'g\'ri yoki yangilangan');
  const done = new Set(Array.isArray(payload.ids) ? payload.ids.map(String) : []);
  const key = String(owner.id);
  printQueues.set(key, (printQueues.get(key) || []).filter(j => !done.has(j.id)));
  return sendOk(res);
});

// Chek havolasi: kassir/oshpaz/egasi buyurtma uchun imzolangan manzil oladi.
authed('/api/order-receipt-link', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'kassir', 'oshpaz'])) {
    return sendFail(res, 'Chek chiqarishga ruxsatingiz yo\'q');
  }
  const order = findOrderAnywhere(ctx.owner, payload.orderId);
  if (!order) return sendFail(res, 'Buyurtma topilmadi');

  const mode = RECEIPT_MODES[payload.mode] ? payload.mode : 'oshxona';
  if (usesAgent(ctx.owner)) {
    if (mode === 'ikkala') {
      enqueuePrintJob(ctx.owner, order, 'mijoz');
      enqueuePrintJob(ctx.owner, order, 'oshxona', KITCHEN_AFTER_CUSTOMER_MS);
    } else {
      enqueuePrintJob(ctx.owner, order, mode);
    }
    return sendOk(res, { queued: true, agentOnline: isAgentOnline(ctx.owner), printer: publicPrinter(ctx.owner) });
  }
  return sendOk(res, {
    path: buildReceiptPath(ctx.owner.id, order.id, mode),
    printer: publicPrinter(ctx.owner)
  });
});

authed('/api/printer-settings-get', (payload, res, { userId }) => {
  const owners = pruneExpiredOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!ctx) return denyAccess(res, owners, userId, 'Ruxsatingiz yo\'q');
  if (!ctxHasAnyRole(ctx, ['egasi', 'kassir', 'oshpaz'])) return sendFail(res, 'Ruxsatingiz yo\'q');
  return sendOk(res, { printer: publicPrinter(ctx.owner), canEdit: isOwnerRole(ctx) });
});

// Mijoz chekining brend sarlavhasi (logotip + nom), ilovada 1-bitli rastrga aylantirilgan.
authed('/api/printer-header-save', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ctx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');
  const header = {
    width: Number(payload.width) === 58 ? 58 : 80,
    w: Number(payload.w),
    h: Number(payload.h),
    data: String(payload.data || ''),
    sig: String(payload.sig || '').slice(0, 64)
  };
  if (!isValidHeaderRaster(header)) return sendFail(res, 'Rasm formati noto\'g\'ri');
  const printer = ensurePrinterSettings(ctx.owner);
  printer.header = header;
  saveOwners(owners);
  return sendOk(res, { printer: publicPrinter(ctx.owner) });
});

authed('/api/printer-settings-save', (payload, res, { userId }) => {
  const owners = loadOwners();
  const ctx = resolveOwnerContext(owners, userId);
  if (!isOwnerRole(ctx)) return denyAccess(res, owners, userId, 'Faqat oshxona egasi o\'zgartira oladi');

  const printer = ensurePrinterSettings(ctx.owner);
  if (payload.mode !== undefined) printer.mode = payload.mode === 'rawbt' ? 'rawbt' : 'agent';
  if (payload.width !== undefined) printer.width = Number(payload.width) === 58 ? 58 : 80;
  if (payload.copies !== undefined) printer.copies = Math.min(3, Math.max(1, Number(payload.copies) || 1));
  if (payload.auto !== undefined) printer.auto = !!payload.auto;
  if (payload.autoCustomer !== undefined) printer.autoCustomer = !!payload.autoCustomer;
  if (payload.footer !== undefined) printer.footer = String(payload.footer).slice(0, 120);
  saveOwners(owners);

  return sendOk(res, { printer: publicPrinter(ctx.owner) });
});

function handleRequest(req, res) {
  const acceptEnc = String(req.headers['accept-encoding'] || '');
  res.acceptsGzip = /\bgzip\b/.test(acceptEnc);

  // Saqlangan rasmlar: nomi mazmunining hash'i, shuning uchun abadiy keshlanadi.
  if (req.method === 'GET' && req.url.startsWith('/img/')) {
    const name = req.url.slice(5).split('?')[0];
    const m = /^[a-f0-9]{32}\.(png|jpg|webp)$/.exec(name);
    if (!m) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    fs.readFile(path.join(IMAGES_DIR, name), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': IMG_TYPES[m[1]], 'Content-Length': data.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(data);
    });
    return;
  }

  // Chek sahifasi — brauzer (telefon/kompyuter) uni o'z printeriga yuboradi.
  if (req.method === 'GET' && req.url.split('?')[0] === '/chek') {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const info = verifyReceiptParams(params);
    const send = (code, text) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif;padding:24px;text-align:center">${text}</body>`);
    };
    if (!info) return send(403, 'Chek havolasi yaroqsiz yoki muddati tugagan. Ilovadan qaytadan oching.');

    const owner = findOwner(loadOwners(), info.ownerId);
    const order = owner ? findOrderAnywhere(owner, info.orderId) : null;
    if (!order) return send(404, 'Buyurtma topilmadi.');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(receiptPageHtml(owner, order, info.mode, params.get('avto') !== '0'));
    return;
  }

  if (req.method === 'POST' && API_ROUTES.has(req.url)) {
    const handler = API_ROUTES.get(req.url);
    readBody(req, (err, payload) => {
      if (err) return sendJSON(res, 400, { ok: false, reason: bodyErrorReason(err) });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return sendJSON(res, 400, { ok: false, reason: "noto'g'ri so'rov" });
      Promise.resolve()
        .then(() => handler(payload, res))
        .catch(e => {
          console.error(`API xatosi [${req.url}]:`, e);
          if (!res.headersSent) sendJSON(res, 500, { ok: false, reason: 'Serverda kutilmagan xatolik. Qaytadan urinib ko\'ring.' });
        });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    if (WEBHOOK_SECRET) {
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (got !== WEBHOOK_SECRET) {
        res.writeHead(401); res.end(); return;
      }
    }
    readBody(req, async (err, update) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      if (err) return;
      webhookStats.received++;
      webhookStats.lastAt = new Date().toISOString();
      try { await handleTelegramUpdate(update); } catch (e) { webhookStats.errors++; console.error('Webhook xatosi:', e); }
    });
    return;
  }

  const urlPathOnly = req.url.split('?')[0];
  let filePath = (urlPathOnly === '/' || urlPathOnly === '') ? '/index.html' : urlPathOnly;
  filePath = path.join(__dirname, 'public', path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404');
    }
    const ext = path.extname(filePath);
    const packed = COMPRESSIBLE_EXT.has(ext) ? packStatic(filePath, data) : null;
    const type = ext === '.html' ? 'text/html'
      : ext === '.js' ? 'application/javascript'
      : ext === '.css' ? 'text/css'
      : ext === '.json' ? 'application/json'
      : ext === '.svg' ? 'image/svg+xml'
      : ext === '.png' ? 'image/png'
      : 'text/plain';

    // index.html har doim "yangi" bo'lishi kerak (Mini App ochilganda eng
    // so'nggi versiyani ko'rsatsin), shuning uchun uni umuman cache
    // qilmaymiz. app.js/style.css esa "?v=N" bilan versiyalanadi (public/
    // index.html'da), shu sababli xavfsiz — ularni uzoq muddat cache qilish
    // mumkin: versiya raqami o'zgarganda URL ham o'zgaradi, WebView avtomatik
    // yangisini oladi. Bu har ochilishda serverdan qayta yuklab olishni
    // kamaytiradi va serverga tushayotgan yukni pasaytiradi.
    const cacheControl = ext === '.html'
      ? 'no-cache, no-store, must-revalidate'
      : (ext === '.js' || ext === '.css')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';

    const headers = { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': cacheControl };
    let out = data;
    if (packed) {
      headers['Vary'] = 'Accept-Encoding';
      if (/\bbr\b/.test(acceptEnc)) { headers['Content-Encoding'] = 'br'; out = packed.br; }
      else if (res.acceptsGzip) { headers['Content-Encoding'] = 'gzip'; out = packed.gz; }
    }
    headers['Content-Length'] = out.length;
    res.writeHead(200, headers);
    res.end(out);
  });
}

// app.js (~500 KB) va style.css har so'rovda qayta siqilmasligi uchun siqilgan
// nusxalar xotirada turadi (fayl o'zgarsa — yangilanadi).
const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.css', '.json', '.svg']);
const staticPackCache = new Map();
function packStatic(filePath, data) {
  const hit = staticPackCache.get(filePath);
  if (hit && hit.raw.equals(data)) return hit;
  const packed = {
    raw: data,
    gz: zlib.gzipSync(data, { level: 9 }),
    br: zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } })
  };
  staticPackCache.set(filePath, packed);
  return packed;
}

const DEFAULT_TARIFF_FEATURE_IDS = FEATURE_CATALOG.map(f => f.id);

function buildTariffFeatures(onIds) {
  const onSet = new Set(onIds);
  const features = {};
  DEFAULT_TARIFF_FEATURE_IDS.forEach(id => { features[id] = onSet.has(id); });
  return features;
}

// Agar hali birorta tarif yaratilmagan bo'lsa (masalan birinchi marta
// ishga tushirilganda, yoki DATA_DIR boshqa joyga — masalan Railway
// volume'ga — ko'rsatilgani sababli avvalgi tariffs.json fayli
// ko'rinmayotgan bo'lsa), standart 4 ta tarifni avtomatik yaratib
// qo'yadi. Admin keyinchalik Tariflar bo'limidan istagancha o'zgartira
// oladi — bu faqat BIR MARTALIK boshlang'ich holat.
function seedDefaultTariffsIfEmpty() {
  console.log(`[tarif-seed] DATA_DIR=${DATA_DIR}, tariffs fayli=${TARIFFS_FILE}`);
  const existing = loadTariffs();
  console.log(`[tarif-seed] Mavjud tariflar soni: ${existing.length}`);
  if (existing.length) {
    console.log('[tarif-seed] Allaqachon tarif mavjud, o\'tkazib yuborildi.');
    return;
  }

  const CORE = ['cashier-panel', 'staff-invite', 'shift-toggle',
    'menu-manage', 'category-manage', 'orders-manage', 'delivery-group', 'kitchen-group',
    'stock-manage', 'expense-manage', 'cashflow', 'customer-menu',
    'customer-account', 'support-chat', 'restaurant-brand', 'system-status', 'notification-log',
    'dashboard'];
  const STANDARD_ADDS = ['staff-roles', 'branch-manage', 'combo-manage', 'promo-manage', 'banner-manage', 'bonus-settings', 'z-report', 'ai-analytics'];
  const BUSINESS_ADDS = ['staff-performance', 'ai-waiter', 'audit'];
  const PREMIUM_ADDS = ['ai-director'];

  const now = new Date().toISOString();
  const defs = [
    { name: 'Starter', price: 299000, maxBranches: null, branchManage: false, on: [...CORE] },
    { name: 'Standard', price: 549000, maxBranches: 3, branchManage: true, on: [...CORE, ...STANDARD_ADDS] },
    { name: 'Business', price: 680000, maxBranches: 10, branchManage: true, on: [...CORE, ...STANDARD_ADDS, ...BUSINESS_ADDS] },
    { name: 'Premium', price: 1300000, maxBranches: null, branchManage: true, on: [...CORE, ...STANDARD_ADDS, ...BUSINESS_ADDS, ...PREMIUM_ADDS] }
  ];

  const tariffs = defs.map((d, i) => {
    const features = buildTariffFeatures(d.on);
    features['branch-manage'] = d.branchManage;
    return {
      id: crypto.randomBytes(4).toString('hex'),
      name: d.name,
      order: i,
      price: d.price,
      maxBranches: d.maxBranches,
      reminderDays: 1,
      features,
      createdAt: now
    };
  });
  saveTariffs(tariffs);
  console.log(`Standart tariflar avtomatik yaratildi: ${tariffs.map(t => t.name).join(', ')}`);
}

function ensureAdminIsOwner() {
  if (!ADMIN_ID || ADMIN_ID === 'ADMIN_TELEGRAM_ID_BU_YERGA') return;
  const owners = loadOwners();
  const idStr = String(ADMIN_ID);
  let owner = findOwner(owners, idStr);
  if (!owner) {
    owner = {
      id: idStr,
      username: null,
      addedAt: new Date().toISOString(),
      expiresAt: null,
      price: 0,
      paid: true,
      paidAt: new Date().toISOString(),
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionUntil: null, // null = muddatsiz, cheklovsiz kirish
      graceUntil: null,
      trialGivenAt: null,
      tariffId: null // tarif yo'q = barcha funksiyalar ochiq (ownerCanUseFeature)
    };
    owners.push(owner);
    saveOwners(owners);
    console.log(`ADMIN_ID (${idStr}) owner sifatida avtomatik ro'yxatga olindi (cheklovsiz kirish).`);
  } else if (owner.subscriptionStatus !== SUBSCRIPTION_STATUS.ACTIVE || owner.subscriptionUntil) {
    // Avval boshqa holatda bo'lsa ham (masalan pending_trial yoki muddati
    // tugagan), ADMIN_ID doim cheklovsiz faol owner bo'lib qolishi kerak.
    owner.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
    owner.subscriptionUntil = null;
    owner.graceUntil = null;
    owner.blockedNotifiedAt = null;
    saveOwners(owners);
  }
  seedAdminLoginOnce();
}

// Bosh admin (ADMIN_ID egasi) uchun sayt/ilovadan kirish login-paroli. Faqat bir marta o'rnatiladi —
// keyin parol o'zgartirilsa yoki "Parolni unutdim" orqali tiklansa, qayta ishga tushganda ustiga yozilmaydi.
// Qiymatlarni ADMIN_LOGIN / ADMIN_PASSWORD muhit o'zgaruvchilari bilan almashtirish mumkin.
function seedAdminLoginOnce() {
  const owners = loadOwners();
  const owner = findOwner(owners, String(ADMIN_ID));
  if (!owner || owner.adminLoginSeeded) return;
  const login = normalizeLogin(process.env.ADMIN_LOGIN || 'admin');
  const takenByOther = owners.some(o => String(o.id) !== String(ADMIN_ID) && normalizeLogin(o.login) === login);
  if (takenByOther) {
    console.error(`[admin login] "${login}" logini boshqa egasida band — bosh admin logini o'rnatilmadi.`);
    return;
  }
  // Parol kodda yozilmaydi: ADMIN_PASSWORD (kamida 8 belgi) berilgan bo'lsa o'sha, aks holda
  // tasodifiy parol yaratiladi va egasining o'ziga Telegram bot orqali yuboriladi.
  const envPassword = String(process.env.ADMIN_PASSWORD || '');
  const password = envPassword.length >= 8 ? envPassword : generateReadablePassword();
  owner.login = login;
  owner.passwordHash = hashPassword(password);
  owner.sessionToken = null;
  owner.sessionExpiresAt = null;
  owner.adminLoginSeeded = true;
  saveOwners(owners);
  console.log(`Bosh admin uchun "${login}" logini o'rnatildi.`);
  if (password !== envPassword) {
    sendCredentialsToOwner(owner.id, login, password, 'Saytga kirish uchun login va parolingiz tayyor.')
      .catch(e => console.error('Admin parolini botga yuborib bo\'lmadi:', e.message));
  }
}

// Ilgari kodda ochiq yozilgan standart parollar. Ular hali ishlatilayotgan bo'lsa, server
// ishga tushganda almashtiriladi va yangi parol egasining o'ziga botda yuboriladi.
const KNOWN_WEAK_PASSWORDS = ['toshkenthotdog'];

async function sendCredentialsToOwner(ownerId, login, password, intro) {
  const sent = await sendMessage(ownerId,
    `🔐 <b>${escapeHtmlServer(intro)}</b>\n\n` +
    `Login: <code>${escapeHtmlServer(login)}</code>\n` +
    `Parol: <code>${escapeHtmlServer(password)}</code>\n\n` +
    '<i>Parolni ilovada (Profil → Parolni o\'zgartirish) o\'zingizga qulayiga almashtirishingiz mumkin. ' +
    'Bu xabarni hech kimga ko\'rsatmang.</i>');
  // sendMessage xato tashlamaydi — natijani o'zimiz tekshiramiz
  if (!sent || !sent.ok) throw new Error((sent && sent.description) || 'Telegram javob bermadi');
}

async function rotateWeakOwnerPasswords() {
  const owners = loadOwners();
  const rotated = [];
  for (const owner of owners) {
    if (!owner.login || !owner.passwordHash) continue;
    if (!KNOWN_WEAK_PASSWORDS.some(pw => verifyPassword(pw, owner.passwordHash))) continue;
    const password = generateReadablePassword();
    owner.passwordHash = hashPassword(password);
    owner.sessionToken = null;
    owner.sessionExpiresAt = null;
    rotated.push({ id: owner.id, login: owner.login, password });
  }
  if (!rotated.length) return;
  saveOwners(owners);
  for (const r of rotated) {
    console.log(`[xavfsizlik] "${r.login}" loginining standart paroli almashtirildi, yangisi egasiga botda yuborildi.`);
    try {
      await sendCredentialsToOwner(r.id, r.login, r.password,
        'Xavfsizlik: eski standart parol o\'chirildi. Yangi parolingiz:');
    } catch (e) {
      console.error(`[xavfsizlik] "${r.login}" uchun yangi parolni yuborib bo'lmadi — "Parolni unutdim" orqali tiklansin:`, e.message);
    }
  }
}

server.listen(PORT, async () => {
  console.log(`Server ${PORT}-portda ishga tushdi`);

  // Birinchi foydalanuvchi siqish uchun kutmasligi uchun — oldindan siqib qo'yamiz.
  setImmediate(() => ['index.html', 'app.js', 'style.css'].forEach(f => {
    const file = path.join(__dirname, 'public', f);
    try { packStatic(file, fs.readFileSync(file)); } catch (e) {}
  }));

  reloadAdminsCache();
  console.log(`Qo'shimcha adminlar soni: ${EXTRA_ADMIN_IDS.size}`);

  try {
    const cmdResult = await telegramApi('setMyCommands', { commands: JSON.stringify([
      { command: 'sklad', description: "Sklad: ostatka, retsept, audit" },
      { command: 'myid', description: "Telegram ID raqamimni ko'rsat" }
    ]) });
    if (!cmdResult || !cmdResult.ok) console.error('setMyCommands xato:', cmdResult && cmdResult.description);
  } catch (e) {
    console.error('Bot buyruqlarini o\'rnatishda xatolik:', e.message);
  }

  try {
    ensureAdminIsOwner();
  } catch (e) {
    console.error('ADMIN_ID ni owner qilishda xatolik:', e.message);
  }

  rotateWeakOwnerPasswords().catch(e => console.error('Standart parollarni almashtirishda xatolik:', e.message));

  try {
    seedDefaultTariffsIfEmpty();
  } catch (e) {
    console.error('Standart tariflarni yaratishda xatolik:', e.message);
  }

  checkOwnerExpirations().catch(e => console.error('Muddat tekshirishda xatolik:', e.message));
  setInterval(() => {
    checkOwnerExpirations().catch(e => console.error('Muddat tekshirishda xatolik:', e.message));
  }, EXPIRY_CHECK_INTERVAL_MS);

  checkTrashAutoPurge().catch(e => console.error('Savatchani tozalashda xatolik:', e.message));
  setInterval(() => {
    checkTrashAutoPurge().catch(e => console.error('Savatchani tozalashda xatolik:', e.message));
  }, EXPIRY_CHECK_INTERVAL_MS);

  if (PUBLIC_URL) {
    try {
      const params = { url: `${PUBLIC_URL.replace(/\/$/, '')}/webhook` };
      if (WEBHOOK_SECRET) params.secret_token = WEBHOOK_SECRET;
      const result = await telegramApi('setWebhook', params);
      console.log('Telegram webhook o\'rnatildi:', result.ok ? 'muvaffaqiyatli' : JSON.stringify(result));
    } catch (e) {
      console.error('Webhook o\'rnatishda xatolik:', e.message);
    }
  } else {
    console.log('Eslatma: PUBLIC_URL sozlanmagan — webhook avtomatik o\'rnatilmadi. README\'dagi qo\'lda sozlash bo\'limiga qarang.');
  }
});
