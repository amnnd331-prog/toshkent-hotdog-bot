#!/usr/bin/env node
// ==========================================================================
// PULSAR print agent — chek printeri ulangan KOMPYUTERDA ishlaydi.
//
// Har POLL_MS da serverdan navbatdagi cheklarni so'raydi va ESC/POS
// baytlarini printerga DRAYVERSIZ yozadi:
//   • USB  — Windows USB printer qurilmasiga to'g'ridan-to'g'ri (\\?\USB#...)
//   • WiFi/LAN — printerning IP manziliga, 9100-port (tcp://192.168.1.50:9100)
//
// Tashqi kutubxona kerak emas — faqat Node.js 18+.
//
// Buyruqlar:
//   node agent.js           — ishga tushirish (doimiy ishlaydi)
//   node agent.js --list    — kompyuterdagi USB printerlarni ko'rsatish
//   node agent.js --test    — printerga sinov cheki chiqarish
// ==========================================================================
'use strict';

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const readline = require('readline');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const USB_PRINT_GUID = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}';
// Chek printerlari ishlab chiqaruvchilarining USB VID raqamlari (avto-tanlash uchun)
const POS_VENDOR_IDS = ['0483', '0416', '0FE6', '1FC9', '28E9', '1504', '0DD4', '20D1', '6868', '154F', '0525', '1659'];

function log(...args) {
  const t = new Date().toLocaleTimeString('uz-UZ', { hour12: false });
  console.log(`[${t}]`, ...args);
}

function normalizeConfig(cfg) {
  cfg.server = String(cfg.server || '').replace(/\/+$/, '');
  cfg.printer = cfg.printer || 'auto';
  cfg.pollMs = Math.max(1000, Number(cfg.pollMs) || 2000);
  return cfg;
}

// Birinchi ishga tushishda (config.json yo'q): bot manzilini (masalan
// https://....up.railway.app) yoki botdagi "Qo'lda sozlash" matnini so'raydi.
function setupInteractive() {
  console.log('');
  console.log('==============================================================');
  console.log('  Birinchi sozlash');
  console.log('  Bot saytining manzilini yozing va Enter bosing, masalan:');
  console.log('    https://toshkent-hotdog-bot-production.up.railway.app');
  console.log('==============================================================');
  console.log('');
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin });
    let text = '';
    rl.on('line', line => {
      const url = line.trim().match(/^https?:\/\/[^\s"']+$/);
      if (url && !text) {
        const cfg = { server: url[0].replace(/\/+$/, ''), printer: 'auto', pollMs: 2000 };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        rl.close();
        return resolve(normalizeConfig(cfg));
      }
      text += line + '\n';
      const start = text.indexOf('{'), end = text.lastIndexOf('}');
      if (start < 0 || end < start) return;
      try {
        const cfg = JSON.parse(text.slice(start, end + 1));
        if (!cfg.server || !cfg.token) throw new Error('server yoki token yo\'q');
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        console.log('Saqlandi: config.json');
        rl.close();
        resolve(normalizeConfig(cfg));
      } catch (e) {
        if (end > start) { console.log(`Matn noto'g'ri (${e.message}). Botdan qaytadan nusxa olib joylang.`); text = ''; }
      }
    });
  });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return normalizeConfig(cfg);
}

// ---------- USB qurilmaga yozuvchi yordamchi (Windows) ----------
// Node.js'ning fs.openSync() Windows USB printer qurilmasini ocha olmaydi
// (libuv qurilma uchun mos bo'lmagan bayroqlar bilan CreateFile chaqiradi).
// Shuning uchun bitta doimiy PowerShell jarayoni ishga tushiriladi: u Windows
// API'ning CreateFile/WriteFile funksiyalarini to'g'ridan-to'g'ri chaqiradi.
// C# kodi faqat bir marta kompilyatsiya qilinadi, keyin har bir chek bir
// qator buyruq orqali yuboriladi: "W|<qurilma>|<base64>" yoki "P|<qurilma>".
const PS_HELPER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class UsbRaw {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern SafeFileHandle CreateFile(string n, uint a, uint s, IntPtr sec, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool WriteFile(SafeFileHandle h, byte[] b, uint l, out uint w, IntPtr o);
}
"@
[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $p = $line.Split('|', 3)
    $h = [UsbRaw]::CreateFile($p[1], 0x40000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
    if ($h.IsInvalid) { throw ('open ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    try {
      if ($p[0] -eq 'W') {
        $b = [Convert]::FromBase64String($p[2]); $w = 0
        if (-not [UsbRaw]::WriteFile($h, $b, [uint32]$b.Length, [ref]$w, [IntPtr]::Zero)) {
          throw ('write ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
      }
    } finally { $h.Close() }
    [Console]::Out.WriteLine('OK')
  } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message) }
}
`;

const WIN32_HINTS = {
  2: 'printer uzilgan yoki o\'chiq',
  5: 'printerni boshqa dastur band qilgan',
  31: 'printer javob bermayapti (qog\'oz yoki qopqoqni tekshiring)',
  1167: 'printer uzilgan'
};

class UsbWriter {
  constructor() { this.proc = null; this.ready = null; this.waiting = []; this.buf = ''; }

  start() {
    if (this.ready) return this.ready;
    const encoded = Buffer.from(PS_HELPER, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    this.ready = new Promise((resolve, reject) => {
      this.onReady = resolve;
      this.proc.on('error', reject);
    });
    this.proc.stdout.on('data', d => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === 'READY') { this.onReady(); continue; }
        const next = this.waiting.shift();
        if (next) next(line);
      }
    });
    this.proc.on('exit', () => {
      // Yordamchi to'xtasa — kutib turganlarga xato qaytaramiz, keyingi chaqiruvda qayta ishga tushadi
      this.waiting.splice(0).forEach(fn => fn('ERR yordamchi jarayon to\'xtadi'));
      this.proc = null; this.ready = null;
    });
    return this.ready;
  }

  async send(cmd, devicePath, b64 = '') {
    await this.start();
    const line = await new Promise(resolve => {
      this.waiting.push(resolve);
      this.proc.stdin.write(`${cmd}|${devicePath}|${b64}\n`);
    });
    if (line === 'OK') return;
    const code = Number((line.match(/(\d+)\s*$/) || [])[1]);
    throw new Error(WIN32_HINTS[code] ? `${WIN32_HINTS[code]} (Windows xato ${code})` : line.replace(/^ERR\s*/, ''));
  }

  stop() { if (this.proc) this.proc.stdin.end(); }
}
const usb = new UsbWriter();

// ---------- USB printerlarni topish (Windows) ----------
function listUsbPrinterKeys() {
  if (process.platform !== 'win32') return [];
  let out = '';
  try {
    out = execFileSync('reg', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses\\${USB_PRINT_GUID}`], { encoding: 'utf8' });
  } catch (e) {
    return [];
  }
  return out.split(/\r?\n/)
    .map(l => l.trim())
    .map(l => l.split('\\').pop())
    .filter(k => k.startsWith('##?#USB#'))
    .map(k => {
      const devicePath = '\\\\?\\' + k.slice(4);
      const vid = (k.match(/VID_([0-9A-F]{4})/i) || [])[1] || '';
      const pid = (k.match(/PID_([0-9A-F]{4})/i) || [])[1] || '';
      return { path: devicePath, vid: vid.toUpperCase(), pid: pid.toUpperCase() };
    });
}

// Registrda eski (uzilgan) qurilmalar ham qoladi — ochib ko'rib, haqiqatan ulanganini aniqlaymiz.
async function listUsbPrinters() {
  const list = listUsbPrinterKeys();
  for (const p of list) {
    try { await usb.send('P', p.path); p.connected = true; } catch (e) { p.connected = false; p.error = e.message; }
  }
  return list;
}

async function resolvePrinter(setting) {
  if (setting && setting !== 'auto') return setting;
  const connected = (await listUsbPrinters()).filter(p => p.connected);
  const pos = connected.find(p => POS_VENDOR_IDS.includes(p.vid));
  const chosen = pos || (connected.length === 1 ? connected[0] : null);
  if (!chosen) {
    throw new Error(connected.length
      ? `Bir nechta USB printer bor — config.json'da "printer" ni aniq yozing (node agent.js --list).`
      : `Ulangan USB chek printeri topilmadi. Kabelni va printer yoqilganini tekshiring.`);
  }
  return 'usb:' + chosen.path;
}

// ---------- Printerga yozish ----------
function writeUsb(devicePath, buf) {
  if (process.platform !== 'win32') {
    // Linux/macOS: printer odatda /dev/usb/lp0 kabi oddiy fayl sifatida ochiladi
    return fs.promises.writeFile(devicePath, buf);
  }
  return usb.send('W', devicePath, buf.toString('base64'));
}

function writeTcp(target, buf) {
  const m = target.match(/^tcp:\/\/([^:/]+)(?::(\d+))?/);
  if (!m) return Promise.reject(new Error(`Noto'g'ri manzil: ${target}`));
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: m[1], port: Number(m[2] || 9100) });
    sock.setTimeout(8000, () => sock.destroy(new Error('Printer javob bermadi (8 s)')));
    sock.on('error', reject);
    sock.on('connect', () => sock.end(buf, resolve));
  });
}

async function print(target, buf) {
  if (target.startsWith('tcp://')) return writeTcp(target, buf);
  const devicePath = target.startsWith('usb:') ? target.slice(4) : target;
  return writeUsb(devicePath, buf);
}

// ---------- Sinov cheki ----------
function testReceipt() {
  const ESC = 0x1B, GS = 0x1D;
  const parts = [];
  const cmd = (...b) => parts.push(Buffer.from(b));
  const line = (t = '') => parts.push(Buffer.from(t + '\n', 'ascii'));
  cmd(ESC, 0x40); cmd(ESC, 0x61, 1);
  cmd(GS, 0x21, 0x11, ESC, 0x45, 1); line('SINOV'); cmd(GS, 0x21, 0);
  line('PRINT AGENT'); cmd(ESC, 0x45, 0);
  line(new Date().toLocaleString('uz-UZ', { hour12: false }));
  line('--------------------------------');
  line("Agent printerga ulandi."); line('Chek drayversiz chiqdi.');
  line(''); line(''); line('');
  cmd(GS, 0x56, 0x42, 0);
  return Buffer.concat(parts);
}

// ---------- Kod bilan ulash (nusxalashsiz) ----------
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  return res.json();
}

// Serverdan 6 xonali kod oladi, ekranga chiqaradi va ega botda kiritguncha kutadi.
// Token faqat shu agent yaratgan maxfiy "secret" bilan beriladi.
async function pairWithCode(cfg) {
  while (true) {
    const secret = crypto.randomBytes(24).toString('hex');
    let start;
    try { start = await postJson(cfg.server + '/api/print-agent/pair-start', { secret }); }
    catch (e) { log(`Serverga ulanib bo'lmadi: ${e.message}. 10 soniyadan keyin qayta urinaman...`); await new Promise(r => setTimeout(r, 10000)); continue; }
    if (!start || typeof start !== 'object' || !('ok' in start)) {
      // Server hali "kod bilan ulash"ni bilmaydigan eski versiyada — yangilanishini kutamiz
      log('Server hali yangilanmagan (kod bilan ulash yo\'q). 30 soniyadan keyin qayta urinaman...');
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    if (!start.ok) throw new Error(start.reason || 'Server kod bermadi');

    const code = `${start.code.slice(0, 3)} ${start.code.slice(3)}`;
    console.log('');
    console.log('==============================================================');
    console.log('  KOMPYUTERNI ULASH KODI:');
    console.log('');
    console.log(`              >>>   ${code}   <<<`);
    console.log('');
    console.log('  Botda: Profil -> Printer va chek -> shu kodni yozing');
    console.log('  va "Ulash" ni bosing. Kod 10 daqiqa amal qiladi.');
    console.log('==============================================================');
    console.log('');

    const deadline = Date.now() + (start.expiresInSec || 600) * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      let res;
      try { res = await postJson(cfg.server + '/api/print-agent/pair-poll', { secret }); } catch (e) { continue; }
      if (res.ok && res.token) {
        cfg.token = res.token;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ server: cfg.server, token: cfg.token, printer: cfg.printer, pollMs: cfg.pollMs }, null, 2));
        log(`Kompyuter ulandi: ${res.shop || 'do\'kon'}`);
        return cfg;
      }
      if (!res.ok) break; // kod eskirdi — yangisini olamiz
    }
    log('Kod muddati tugadi, yangi kod olinmoqda...');
  }
}

// ---------- Asosiy sikl ----------
async function api(cfg, url, body) {
  const res = await fetch(cfg.server + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ token: cfg.token }, body)),
    signal: AbortSignal.timeout(15000)
  });
  return res.json();
}

async function run() {
  let cfg = loadConfig() || await setupInteractive();
  if (!cfg.server) {
    console.error('config.json da "server" (bot sayti manzili) yozilishi shart.');
    process.exit(1);
  }
  if (!cfg.token) cfg = await pairWithCode(cfg);
  let target = await resolvePrinter(cfg.printer);
  log(`Printer: ${target}`);
  log(`Server:  ${cfg.server}`);

  const printed = new Set();   // shu seansda chiqarilganlar — ikki marta chiqmasligi uchun
  let failures = 0, lastShop = null;

  while (true) {
    try {
      const res = await api(cfg, '/api/print-agent/poll');
      if (!res.ok && /token/i.test(res.reason || '')) {
        log('Token eskirgan — kompyuterni qayta ulash kerak.');
        delete cfg.token;
        cfg = await pairWithCode(cfg);
        continue;
      }
      if (!res.ok) throw new Error(res.reason || 'Server rad etdi');
      if (res.shop && res.shop !== lastShop) { log(`Ulandi: ${res.shop}`); lastShop = res.shop; }
      if (failures) { log('Aloqa tiklandi.'); failures = 0; }

      const done = [];
      for (const job of res.jobs || []) {
        if (printed.has(job.id)) { done.push(job.id); continue; }
        try {
          await print(target, Buffer.from(job.data, 'base64'));
          printed.add(job.id);
          done.push(job.id);
          log(`Chek chiqdi: № ${job.orderNumber || '?'} (${job.mode})`);
        } catch (e) {
          log(`Printerga yozib bo'lmadi: ${e.message}`);
          // USB kabel qayta ulanganda qurilma manzili o'zgarishi mumkin — qaytadan qidiramiz
          if (cfg.printer === 'auto') { try { target = await resolvePrinter('auto'); } catch (_) {} }
          break;
        }
      }
      if (printed.size > 500) printed.clear();
      if (done.length) await api(cfg, '/api/print-agent/ack', { ids: done });
    } catch (e) {
      failures++;
      if (failures === 1 || failures % 30 === 0) log(`Server bilan aloqa yo'q: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, failures ? Math.min(30000, cfg.pollMs * failures) : cfg.pollMs));
  }
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--list') {
    const list = await listUsbPrinters();
    if (!list.length) console.log('USB printer topilmadi.');
    list.forEach(p => console.log(
      `${p.connected ? '✔ ulangan ' : '✘ uzilgan  '} VID_${p.vid} PID_${p.pid}${p.error ? '  (' + p.error + ')' : ''}\n` +
      `   "printer": "usb:${p.path.replace(/\\/g, '\\\\')}"`));
    usb.stop();
    return;
  }
  if (arg === '--test') {
    const cfg = loadConfig() || { printer: 'auto' };
    const target = await resolvePrinter(cfg.printer);
    await print(target, testReceipt());
    log(`Sinov cheki yuborildi → ${target}`);
    usb.stop();
    return;
  }
  await run();
})().catch(e => { console.error('Xato:', e.message); usb.stop(); process.exit(1); });
