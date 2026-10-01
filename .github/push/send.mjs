// Уведомления медкарты: запускается GitHub по расписанию раз в 5 минут.
// Расшифровывает data.enc паролем из секретов и присылает на телефон напоминания,
// время которых наступило за последний час и которые ещё не отправлялись.
// В журнал GitHub (он публичный) пишутся только числа — без названий лекарств и событий.
import fs from 'fs';
import crypto from 'crypto';
import webpush from 'web-push';

const { MEDKARTA_PASSWORD: pass, VAPID_PRIVATE_KEY: priv, VAPID_PUBLIC_KEY: pub, PUSH_SUBSCRIPTIONS: subsRaw, TEST, DRY } = process.env;
const STATE = '.push-state/sent.json';
const TZ = 5 * 3600e3; // Ташкент, UTC+5 без перехода на летнее время
const WINDOW = 60 * 60e3; // опоздавший запуск всё равно пришлёт напоминание, если прошло меньше часа

if (!pass || !priv || !pub || !subsRaw) { console.log('Уведомления не настроены: нет секретов MEDKARTA_PASSWORD, VAPID_PRIVATE_KEY или PUSH_SUBSCRIPTIONS'); process.exit(0); }
let subs;
try { subs = JSON.parse(subsRaw); if (!Array.isArray(subs)) subs = [subs]; } catch (e) { console.log('PUSH_SUBSCRIPTIONS — не JSON'); process.exit(1); }

// --- данные ---
const env = JSON.parse(fs.readFileSync('data.enc', 'utf8'));
const key = crypto.pbkdf2Sync(pass, Buffer.from(env.salt, 'base64'), env.iter, 32, 'sha256');
const ct = Buffer.from(env.ct, 'base64'), dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
dec.setAuthTag(ct.subarray(ct.length - 16));
let D;
try { D = JSON.parse(Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]).toString()); } catch (e) { console.log('Неверный пароль в MEDKARTA_PASSWORD'); process.exit(1); }

// --- время ---
const now = Date.now();
const pad = n => String(n).padStart(2, '0');
const isoOf = ms => { const d = new Date(ms + TZ); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const at = (iso, hm) => Date.parse(`${iso}T${hm}:00Z`) - TZ; // местное время → UTC ms
const addDays = (iso, n) => isoOf(Date.parse(iso + 'T12:00:00Z') - TZ + n * 864e5);
const fd = s => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const today = isoOf(now), yesterday = addDays(today, -1);
const FOLLOW = [10, 20]; // контрольные «ты приняла?» — минуты после времени приёма
const NAME = D.profile?.display_name || '';

// --- что напомнить ---
const DONE = new Set(['completed', 'stopped', 'unknown_duration']);
const list = [];
for (const day of [yesterday, today]) {
  const byTime = {};
  for (const m of D.medications || []) {
    if (DONE.has(m.status) || !m.start || m.start > day || (m.end && m.end < day)) continue;
    for (const tm of m.schedule?.times || []) (byTime[tm] ||= []).push(m);
  }
  for (const [tm, ms] of Object.entries(byTime)) {
    const names = ms.map(m => m.name).join(', '), base = `med|${day}|${tm}`;
    list.push({
      key: base, group: base, ts: at(day, tm), url: './',
      title: ms.length > 1 ? `💊 Пора принять лекарства, ${tm}` : `💊 Пора принять: ${ms[0].name}`,
      body: ms.map(m => [ms.length > 1 ? m.name : '', m.dose, m.schedule?.text].filter(Boolean).join(' · ')).join('\n'),
    });
    // Контрольные напоминания: через FOLLOW минут после времени приёма
    FOLLOW.forEach((min, i) => list.push({
      key: `${base}|+${min}`, group: base, ts: at(day, tm) + min * 60e3, url: './',
      title: i === 0 ? `${NAME ? NAME + ', ты' : 'Ты'} приняла ${names}?` : `Точно приняла? 🐱 ${names}`,
      body: i === 0 ? 'Если да — отметь «Принято» в медкарте 🐾' : `Время приёма было ${tm}. Котик волнуется 🐾`,
    }));
  }
  for (const m of D.medications || []) if (!DONE.has(m.status) && m.end && addDays(m.end, -3) === day)
    list.push({ key: `end|${m.id}`, ts: at(day, '10:00'), url: './', title: `Курс «${m.name}» заканчивается ${fd(m.end)}`, body: 'Решить с врачом, продолжать ли.' });
  for (const e of D.events || []) {
    if (e.status !== 'planned' || !e.date) continue;
    if (addDays(e.date, -1) === day) list.push({ key: `ev1|${e.id}`, ts: at(day, '19:00'), url: './', title: `📅 Завтра${e.time ? ' в ' + e.time : ''}: ${e.title}`, body: e.notes || 'Не забудьте взять документы.' });
    if (e.time && e.date === day) list.push({ key: `ev2|${e.id}`, ts: at(day, e.time) - 2 * 3600e3, url: './', title: `📅 Через 2 часа: ${e.title}`, body: `${e.time}${e.notes ? ' · ' + e.notes : ''}` });
  }
  for (const t of D.tasks || []) {
    if (t.status !== 'open' || !t.due) continue;
    if (addDays(t.due, -7) === day) list.push({ key: `task7|${t.id}`, ts: at(day, '10:00'), url: './', title: `Через неделю срок: ${t.title}`, body: t.reason || '' });
    if (t.due === day) list.push({ key: `task0|${t.id}`, ts: at(day, '10:00'), url: './', title: `Сегодня срок: ${t.title}`, body: t.reason || '' });
  }
}

let sent = {};
try { sent = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { }
let due = list.filter(x => x.ts <= now && x.ts > now - WINDOW && !sent[x.key]);
// Если запуск опоздал и наступило сразу несколько ступеней одного приёма — шлём одну (самую раннюю), остальные считаем отправленными
const seenGroup = new Set();
due = due.sort((a, b) => a.ts - b.ts).filter(x => { if (!x.group) return true; if (seenGroup.has(x.group)) { sent[x.key] = now; return false; } seenGroup.add(x.group); return true; });
if (TEST === 'true') due = [{ key: `test|${now}`, ts: now, url: './', title: 'Медкарта 🐾', body: 'Мур! Уведомления работают. Котик будет напоминать о лекарствах.' }, ...due];
if (DRY) { for (const x of list.sort((a, b) => a.ts - b.ts)) console.log(new Date(x.ts + TZ).toISOString().slice(0, 16), x.title, '|', x.body.replace(/\n/g, ' / ')); console.log('к отправке сейчас:', due.length); process.exit(0); }

// --- отправка ---
webpush.setVapidDetails('https://frostx04.github.io/Mk/', pub, priv);
let ok = 0, gone = 0, fail = 0;
for (const x of due) {
  const payload = JSON.stringify({ title: x.title, body: x.body, tag: x.key, url: x.url });
  for (const s of subs) {
    try { await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' }); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone++; else { fail++; console.log('ошибка отправки, код', e.statusCode || e.code || '?'); } }
  }
  sent[x.key] = now;
}
// старые отметки чистим
for (const [k, t] of Object.entries(sent)) if (now - t > 3 * 864e5) delete sent[k];
fs.mkdirSync('.push-state', { recursive: true });
fs.writeFileSync(STATE, JSON.stringify(sent));
console.log(`Напоминаний: ${due.length}, доставлено: ${ok}${gone ? `, устаревших подписок: ${gone} — включите уведомления заново и обновите PUSH_SUBSCRIPTIONS` : ''}${fail ? `, ошибок: ${fail}` : ''}`);
if (gone && !ok) process.exit(1);
