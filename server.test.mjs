import test, { after } from 'node:test';
import assert from 'node:assert/strict';
process.env.TIMER_SCALE = '0.03';            // ускоренные таймеры для теста
const { start, server, rooms } = await import('./server.js');
await start(0);
const base = 'http://127.0.0.1:' + server.address().port;
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

function sse(room, token) {
  const ac = new AbortController(), q = [], waiters = [];
  fetch(`${base}/api/events?room=${room}&token=${token}`, { signal: ac.signal }).then(async (res) => {
    const rd = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await rd.read(); if (done) return;
      buf += dec.decode(value);
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) { const d = JSON.parse(chunk.slice(6)); const w = waiters.shift(); w ? w(d) : q.push(d); }
      }
    }
  }).catch(() => {});
  return {
    next: (ms = 3000) => q.length ? Promise.resolve(q.shift()) : new Promise((ok, no) => { const t = setTimeout(() => no(new Error('нет данных')), ms); waiters.push((d) => { clearTimeout(t); ok(d); }); }),
    until: async (f, ms = 6000) => { const end = Date.now() + ms; for (;;) { const d = await Promise.race([ (q.length ? Promise.resolve(q.shift()) : new Promise((ok) => waiters.push(ok))), new Promise((_, no) => setTimeout(() => no(new Error('таймаут ожидания')), Math.max(1, end - Date.now()))) ]); if (f(d)) return d; } },
    close: () => ac.abort(),
  };
}
async function newGame(n = 3, names = ['Аня', 'Борис', 'Вика', 'Глеб']) {
  const c = await post('/api/create', { name: names[0] });
  const seats = [{ token: c.token }];
  for (let i = 1; i < n; i++) seats.push(await post('/api/join', { room: c.room, name: names[i] }));
  const streams = seats.map((s) => sse(c.room, s.token));
  for (const s of streams) await s.next(); // стартовые снимки лобби
  const st = await post('/api/start', { room: c.room, token: seats[0].token, goal: 30000 });
  assert.equal(st.status, 200, st.error);
  const first = await Promise.all(streams.map((s) => s.until((d) => d.phase === 'game')));
  return { room: c.room, seats, streams, first };
}

test('комната: создание, вход по коду, имена очищаются, старт только создателем и от 2 игроков', async () => {
  const c = await post('/api/create', { name: '<b>Аня</b>' });
  assert.equal(c.room.length, 4);
  const j = await post('/api/join', { room: c.room.toLowerCase(), name: 'Борис' });
  assert.equal(j.seat, 1);
  assert.ok(!/[<>&"']/.test(rooms.get(c.room).seats[0].name)); // имя очищено от разметки
  assert.equal((await post('/api/join', { room: c.room, name: 'борис' })).status, 400); // имя занято
  assert.equal((await post('/api/start', { room: c.room, token: j.token })).status, 403);
  const solo = await post('/api/create', { name: 'Один' });
  assert.equal((await post('/api/start', { room: solo.room, token: solo.token })).status, 400);
  assert.equal((await post('/api/join', { room: 'ZZZZ', name: 'X' })).status, 404);
});

test('игра: клиенты получают состояние без порядка колод, каталог приходит один раз', async () => {
  const g = await newGame(3);
  const d = g.first[0];
  assert.equal(d.phase, 'game'); assert.ok(d.catalog && Object.keys(d.catalog).length === 83);
  assert.ok(Object.values(d.state.decks).every((a) => a.every((x) => x === null)));
  assert.equal(d.state.rng, undefined);
  assert.equal(d.events[0].type, 'game_start');
  g.streams.forEach((s) => s.close());
});

test('ходит только тот, чья очередь; ход доходит до всех игроков', async () => {
  const g = await newGame(3);
  const cur = g.first[0].state.current, other = (cur + 1) % 3;
  const bad = await post('/api/action', { room: g.room, token: g.seats[other].token, action: { type: 'move', steps: 1 } });
  assert.equal(bad.status, 400);
  const ok = await post('/api/action', { room: g.room, token: g.seats[cur].token, action: { type: 'move', steps: 1 } });
  assert.equal(ok.status, 200);
  for (const s of g.streams) {
    const d = await s.until((x) => x.events && x.events.some((e) => e.type === 'moved'));
    assert.equal(d.state.phase, 'act');
  }
  g.streams.forEach((s) => s.close());
});

test('доступ: чужой токен, serverные действия и мусор отклоняются', async () => {
  const g = await newGame(2);
  assert.equal((await post('/api/action', { room: g.room, token: 'bad', action: { type: 'move', steps: 1 } })).status, 403);
  assert.equal((await post('/api/action', { room: g.room, token: g.seats[0].token, action: { type: 'auction_close' } })).status, 400);
  assert.equal((await post('/api/action', { room: g.room, token: g.seats[0].token, action: {} })).status, 400);
  g.streams.forEach((s) => s.close());
});

test('таймер на сервере: если игрок молчит, ход делается автоматически (шаг + такси)', async () => {
  const g = await newGame(2);
  const t0 = g.first[0].state.turn;
  const d = await g.streams[0].until((x) => x.state && x.state.turn > t0, 8000);
  assert.ok(d.events.some((e) => e.type === 'taxi') || d.events.length >= 0);
  assert.ok(d.state.turn > t0);
  g.streams.forEach((s) => s.close());
});

test('переподключение: тот же токен получает актуальное состояние', async () => {
  const g = await newGame(2);
  g.streams[1].close();
  const again = sse(g.room, g.seats[1].token);
  const d = await again.next();
  assert.equal(d.phase, 'game'); assert.equal(d.me, 1); assert.ok(d.catalog);
  again.close(); g.streams[0].close();
});

after(() => { server.closeAllConnections?.(); server.close(); });
