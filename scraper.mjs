// Забирает график отключений ДТЭК (Одесса) для одной очереди и сохраняет в schedule.json
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = 'https://www.dtek-oem.com.ua/ua/shutdowns';
const QUEUE = process.env.QUEUE || '2.2';
const OUT = 'schedule.json';

const kyivDate = (ts) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date(ts * 1000));

const browser = await chromium.launch();
const context = await browser.newContext({
  locale: 'uk-UA',
  timezoneId: 'Europe/Kyiv',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
});
const page = await context.newPage();

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Страница содержит глобальный объект DisconSchedule с графиками всех очередей
  await page.waitForFunction(
    () => typeof DisconSchedule !== 'undefined' && DisconSchedule.fact,
    null,
    { timeout: 45000 }
  );
  const ds = await page.evaluate(() => JSON.parse(JSON.stringify(DisconSchedule)));

  // Все очереди: queues["2.2"].days["2026-11-10"] = [24 значения]
  const collected = {};
  for (const [ts, groups] of Object.entries(ds.fact?.data ?? {})) {
    const date = kyivDate(Number(ts));
    for (const [groupKey, hours] of Object.entries(groups)) {
      const m = groupKey.match(/(\d+(?:\.\d+)?)$/);
      if (!m) continue;
      const q = m[1];
      collected[q] ??= { days: {} };
      collected[q].days[date] = Array.from({ length: 24 }, (_, i) => hours[String(i + 1)] ?? 'yes');
    }
  }
  const queues = Object.fromEntries(
    Object.entries(collected).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
  );
  if (!queues[QUEUE]) throw new Error(`Очередь ${QUEUE} не найдена в fact.data`);

  // days/queue на верхнем уровне оставлены для совместимости со старой версией приложения
  const result = {
    queue: QUEUE,
    source_update: ds.fact?.update ?? null,
    days: queues[QUEUE].days,
    queues,
  };

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const same =
    prev &&
    JSON.stringify(prev.queues) === JSON.stringify(queues) &&
    prev.source_update === result.source_update;
  if (!same) {
    fs.writeFileSync(OUT, JSON.stringify({ ...result, updated: new Date().toISOString() }, null, 2));
    console.log('schedule.json обновлён');
  } else {
    console.log('Без изменений');
  }
} catch (e) {
  console.error('Ошибка:', e.message);
  fs.writeFileSync('debug.html', await page.content());
  await page.screenshot({ path: 'debug.png' });
  process.exitCode = 1;
} finally {
  await browser.close();
}
