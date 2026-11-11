scraper.mjsation/json' } });
  if (!res.ok) throw new Error(`Миколаїв: ${path} → HTTP ${res.status}`);
  return res.json();
}

/** Дата графика по полю from: «2026-11-11 00:00:00» без зоны — это уже киевская дата. */
function mkDate(from) {
  const s = String(from ?? '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d)) throw new Error(`Миколаїв: незрозуміла дата "${s}"`);
  return kyivDate(d);
}

async function scrapeMykolaiv() {
  // type 3 — черги ГПВ (1.1 … 6.2); type 1/2 — аварійні ГАВ/СГАВ, их не берём
  const [queueList, timeSeries, active] = await Promise.all([
    getJson('/api/outage-queue/by-type/3'),
    getJson('/api/schedule/time-series'),
    getJson('/api/v2/schedule/active'),
  ]);

  const queueName = new Map(queueList.map((q) => [q.id, q.name]));
  // номер получасового слота 0..47 по id интервала времени
  const slotOf = new Map(
    timeSeries.map((t) => {
      const [h, m] = t.start.split(':').map(Number);
      return [t.id, h * 2 + (m >= 30 ? 1 : 0)];
    })
  );

  // state[date][queue] = 48 слотов: 'on' | 'off' | 'maybe'
  const state = {};
  let latest = null;
  for (const item of active) {
    const date = mkDate(item.from);
    if (item.updated_at && (!latest || item.updated_at > latest)) latest = item.updated_at;
    for (const s of item.series ?? []) {
      const q = queueName.get(s.outage_queue_id);
      const slot = slotOf.get(s.time_series_id);
      if (!q || slot === undefined) continue;
      state[date] ??= {};
      state[date][q] ??= Array(48).fill('on');
      const cur = state[date][q][slot];
      // как на сайте: SURE_OFF/OFF важнее, чем PROBABLY_OFF
      if (s.type === 'SURE_OFF' || s.type === 'OFF') state[date][q][slot] = 'off';
      else if (s.type === 'PROBABLY_OFF' && cur === 'on') state[date][q][slot] = 'maybe';
    }
  }

  // Пустой ответ = отключений не применяется: сегодня свет есть у всех (так же показывает сайт)
  const today = kyivDate(new Date());
  state[today] ??= {};

  // Пара получасов → значение часа в формате ДТЕК
  const hourValue = (a, b) => {
    if (a === 'off' && b === 'off') return 'no';
    if (a === 'off') return 'first'; // нет света в первой половине (вторая — есть или «можливо»)
    if (b === 'off') return 'second';
    if (a === 'maybe' && b === 'maybe') return 'maybe';
    if (a === 'maybe') return 'mfirst';
    if (b === 'maybe') return 'msecond';
    return 'yes';
  };

  const queues = {};
  for (const name of queueName.values()) {
    queues[name] = { days: {} };
    for (const [date, byQueue] of Object.entries(state).sort()) {
      const slots = byQueue[name] ?? Array(48).fill('on');
      queues[name].days[date] = Array.from({ length: 24 }, (_, h) => hourValue(slots[h * 2], slots[h * 2 + 1]));
    }
  }
  const upd = latest ? new Date(latest) : null;
  const source_update =
    upd && !isNaN(upd)
      ? new Intl.DateTimeFormat('uk-UA', {
          timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
        }).format(upd).replace(',', '')
      : null;
  return { source_update, queues: sortQueues(queues) };
}

// ---------- Сборка ----------
let prev = null;
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}

// Ошибка одной области не ломает другую: для неё остаются прошлые данные
const results = await Promise.allSettled([scrapeOdesa(), scrapeMykolaiv()]);
const names = ['odesa', 'mykolaiv'];
const regions = {};
let failed = false;
results.forEach((r, i) => {
  if (r.status === 'fulfilled') {
    regions[names[i]] = r.value;
  } else {
    failed = true;
    console.error(`Помилка (${names[i]}):`, r.reason?.message ?? r.reason);
    const old = prev?.regions?.[names[i]] ?? (names[i] === 'odesa' && prev?.queues ? { source_update: prev.source_update, queues: prev.queues } : null);
    if (old) regions[names[i]] = old;
  }
});

if (!regions.odesa?.queues?.[QUEUE]) {
  console.error(`Черга ${QUEUE} (Одеса) не знайдена — файл не змінено`);
  process.exit(1);
}

const result = {
  queue: QUEUE,
  source_update: regions.odesa.source_update,
  days: regions.odesa.queues[QUEUE].days,
  queues: regions.odesa.queues,
  regions,
};

const same = prev && JSON.stringify(prev.regions) === JSON.stringify(regions);
if (!same) {
  fs.writeFileSync(OUT, JSON.stringify({ ...result, updated: new Date().toISOString() }, null, 2));
  console.log('schedule.json оновлено');
} else {
  console.log('Без змін');
}
if (failed) process.exitCode = 1; // чтобы в Actions было видно, что одна из областей не загрузилась
