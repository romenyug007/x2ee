import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGame, applyAction, legalActions, timeoutTurn, timeoutStep, repairCosts, actor, publicView, BOARD, MOVE_COST } from './avtomonopolist-engine.js';

const cards = JSON.parse(fs.readFileSync(new URL('./avtomonopolist-cards.json', import.meta.url)));
const mk = (n = 3, extra = {}) => createGame({ names: ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, n), seed: 7, cards, ...extra });
// ok: выполнить действие; если началась очередь бросков гонки — каждый участник бросает по очереди
const ok = (s, a) => {
  const r = applyAction(s, { player: actor(s), ...a }); assert.ok(r.ok, r.error);
  let st = r.state;
  while (st.phase === 'race_roll') { const q = applyAction(st, { type: 'race_roll', player: st.race.queue[0] }); assert.ok(q.ok, q.error); st = q.state; }
  return st;
};
const bad = (s, a) => { const r = applyAction(s, { player: actor(s), ...a }); assert.equal(r.ok, false); return r.error; };
// поставить текущего игрока на клетку заданного типа и перевести в фазу действия
function at(s, cell, idx = 0) { s = structuredClone(s); const i = BOARD.indexOf(cell) + idx; s.players[s.current].pos = BOARD.indexOf(cell, idx ? BOARD.indexOf(cell) + 1 : 0); s.phase = 'act'; return s; }
const car = (s, id, repaired = true, defect = null) => ({ id, repaired, defect, sellAsRepaired: false });

test('старт: 1500 €, у каждого одна машина «Ведро» с ремонтируемым дефектом', () => {
  const s = mk(4);
  for (const p of s.players) {
    assert.equal(p.cash, 1500); assert.equal(p.cars.length, 1);
    assert.equal(s.catalog[p.cars[0].id].deck, 'vedro'); assert.equal(p.cars[0].defect.kind, 'repair');
  }
  assert.equal(s.phase, 'move');
});

test('цена хода: 1–2 шага бесплатно, 3 — 300, 7 — 10000, 8 нельзя', () => {
  let s = mk(2);
  const p0 = s.current;
  s = ok(s, { type: 'move', steps: 3 });
  assert.equal(s.players[p0].cash, 1500 - 300);
  s = timeoutTurn(s).state;
  s = mk(2);
  assert.match(bad(s, { type: 'move', steps: 8 }), /1 до 7/);
  assert.match(bad(s, { type: 'move', steps: 0 }), /1 до 7/);
  s.players[s.current].cash = 5000;
  assert.match(bad(s, { type: 'move', steps: 7 }), /Не хватает/);
  assert.deepEqual(MOVE_COST.slice(1), [0, 0, 300, 600, 1000, 3000, 10000]);
});

test('занятые клетки пропускаются (2–4 игрока: одна фишка блокирует)', () => {
  let s = mk(3);
  const a = s.current, b = (a + 1) % 3;
  s.players[b].pos = 1; // «Ведра»
  s = ok(s, { type: 'move', steps: 1 });
  assert.equal(s.players[a].pos, 2); // перескочил занятую клетку 1
});

test('5–6 игроков: на клетке могут стоять двое, третий пропускает', () => {
  let s = mk(5);
  const a = s.current;
  s.players[(a + 1) % 5].pos = 1; s.players[(a + 2) % 5].pos = 1;
  s = ok(s, { type: 'move', steps: 1 });
  assert.equal(s.players[a].pos, 2);
  let s2 = mk(5); const a2 = s2.current;
  s2.players[(a2 + 1) % 5].pos = 1;
  s2 = ok(s2, { type: 'move', steps: 1 });
  assert.equal(s2.players[a2].pos, 1); // второй может встать
});

test('прямая покупка «Ведра» списывает цену и выдаёт дефект', () => {
  let s = at(mk(2), 'vedro');
  const p = s.current, top = s.catalog[s.decks.vedro[0]];
  s = ok(s, { type: 'buy_start' });
  assert.equal(s.phase, 'buy');
  const before = s.players[p].cash;
  s = ok(s, { type: 'buy_direct' });
  assert.equal(before - s.players[p].cash, top.buy);
  assert.ok(s.players[p].cars.length >= 2);
});

test('«Ретро» нельзя купить напрямую, только аукцион', () => {
  let s = at(mk(2), 'retro');
  s = ok(s, { type: 'buy_start' });
  assert.match(bad(s, { type: 'buy_direct' }), /аукцион/);
});

test('аукцион: открытые торги, любой может перебить, по таймеру побеждает последняя ставка', () => {
  let s = at(mk(3), 'premium');
  const starter = s.current, id = s.decks.premium[0], card = s.catalog[id];
  s.players.forEach((p) => (p.cash = 5000));
  s = ok(s, { type: 'buy_start' });
  assert.match(bad(s, { type: 'auction_start', amount: card.auction_start - 1 }), /ниже/);
  s = ok(s, { type: 'auction_start', amount: card.auction_start });
  assert.equal(s.phase, 'auction'); assert.equal(actor(s), null);
  const b = (starter + 2) % 3, a2 = (starter + 1) % 3;
  s = ok(s, { type: 'bid', player: b, amount: card.auction_start + 100 });
  assert.match(bad(s, { type: 'bid', player: b, amount: card.auction_start + 200 }), /уже лучшая/);
  assert.match(bad(s, { type: 'bid', player: a2, amount: card.auction_start + 100 }), /выше/);
  s = ok(s, { type: 'bid', player: starter, amount: card.auction_start + 150 });
  s = ok(s, { type: 'auction_close' });
  assert.equal(s.players[starter].cash, 5000 - card.auction_start - 150);
  assert.ok(s.players[starter].cars.some((c) => c.id === id));
  assert.equal(s.phase, 'move'); assert.notEqual(s.current, starter);
});

test('аукцион: ставок нет — победитель стартовой ставки платит и получает машину', () => {
  let s = at(mk(3), 'premium');
  const starter = s.current, id = s.decks.premium[0], card = s.catalog[id];
  s.players.forEach((p) => (p.cash = 5000));
  s = ok(s, { type: 'buy_start' });
  s = ok(s, { type: 'auction_start', amount: card.auction_start });
  s = ok(s, { type: 'auction_close' });
  assert.equal(s.players[starter].cash, 5000 - card.auction_start);
  assert.ok(s.players[starter].cars.some((c) => c.id === id));
});

test('отказ от карты: карта в сброс, ход переходит', () => {
  let s = at(mk(2), 'bitye'); const p = s.current, n = s.decks.bitye.length;
  const top = s.decks.bitye[0];
  s = ok(s, { type: 'buy_start' }); s = ok(s, { type: 'decline' });
  assert.equal(s.decks.bitye.length, n); assert.equal(s.decks.bitye.at(-1), top); assert.notEqual(s.current, p);
});

test('колода машин закончилась — купить нельзя', () => {
  let s = at(mk(2), 'bitye'); s.decks.bitye = [];
  assert.match(bad(s, { type: 'buy_start' }), /закончилась/);
});

test('автосервис: Битьё — куб 1–2 / 3–4 / 5–6 выбирает цену', () => {
  for (const [roll, tier] of [[1, 'die_1_2'], [2, 'die_1_2'], [3, 'die_3_4'], [4, 'die_3_4'], [5, 'die_5_6'], [6, 'die_5_6']]) {
    let s = at(mk(2), 'avtoservis'); s.players[s.current].cars = [car(s, 'bitye-4', false)];
    s.players[s.current].cash = 5000; s.forcedRolls = [roll];
    const p = s.current;
    s = ok(s, { type: 'autoservice' });
    assert.equal(s.repairRoll, roll);
    s = ok(s, { type: 'repair', carIds: ['bitye-4'] });
    assert.equal(5000 - s.players[p].cash, s.catalog['bitye-4'].repair[tier]);
    assert.ok(s.players[p].cars[0].repaired);
  }
});

test('автосервис: один куб на все «Битьё», ремонт можно отложить', () => {
  let s = at(mk(2), 'avtoservis'); const p = s.current;
  s.players[p].cars = [car(s, 'bitye-4', false), car(s, 'bitye-15', false)];
  s.players[p].cash = 5000; s.forcedRolls = [3];
  s = ok(s, { type: 'autoservice' });
  s = ok(s, { type: 'repair', carIds: ['bitye-4'] });
  assert.equal(5000 - s.players[p].cash, 600); // «Эрка», вторая цена (3–4)
});

test('автосервис: «Ведро» чинится по цене дефекта, «Ретро» по реставрации', () => {
  let s = at(mk(2), 'avtoservis'); const p = s.current;
  const defect = { kind: 'repair', name: 'Ремонт электрики', repair: { cost: 400 } };
  s.players[p].cars = [car(s, 'vedro-1', false, defect), car(s, 'retro-1', false)];
  s.players[p].cash = 5000;
  s = ok(s, { type: 'autoservice' });
  s = ok(s, { type: 'repair', carIds: ['vedro-1', 'retro-1'] });
  assert.equal(5000 - s.players[p].cash, 400 + 3000);
  assert.ok(s.players[p].cars.every((c) => c.repaired && c.defect === null));
});

test('скупка: продажа отремонтированной по зелёной цене; неремонтируемый «Премиум» — по аукционной', () => {
  let s = at(mk(2), 'skupka'); const p = s.current;
  const bad1 = { kind: 'unrepairable', name: 'Распил' };
  s.players[p].cars = [car(s, 'vedro-1', true), car(s, 'premium-3', false, bad1), car(s, 'vedro-2', false, { kind: 'repair', repair: { cost: 300 } })];
  const cash = s.players[p].cash;
  assert.match(bad(s, { type: 'sell', carIds: ['vedro-2'] }), /нельзя продать/);
  s = ok(s, { type: 'sell', carIds: ['vedro-1', 'premium-3'] });
  assert.equal(s.players[p].cash - cash, s.catalog['vedro-1'].sell + s.catalog['premium-3'].auction_start);
  assert.equal(s.players[p].cars.length, 1);
});

test('прокат: 500 € за Ведро/Битьё, 1000 € за Премиум/Ретро, только отремонтированные', () => {
  let s = at(mk(2), 'prokat'); const p = s.current, c = s.players[p].cash;
  s.players[p].cars = [car(s, 'vedro-1', true), car(s, 'bitye-1', true), car(s, 'premium-1', true), car(s, 'retro-1', true), car(s, 'vedro-2', false)];
  s = ok(s, { type: 'rent' });
  assert.equal(s.players[p].cash - c, 500 + 500 + 1000 + 1000);
  let s2 = at(mk(2), 'prokat'); s2.players[s2.current].cars = [car(s2, 'vedro-2', false)];
  assert.match(bad(s2, { type: 'rent' }), /Нет отремонтированных/);
});

test('такси: Ведро/Битьё 100×куб, Премиум/Ретро 200×куб, любая машина', () => {
  let s = at(mk(2), 'ретро'.length ? 'vedro' : 'vedro'); const p = s.current;
  s.players[p].cars = [car(s, 'vedro-1', false), car(s, 'premium-1', false)];
  const c = s.players[p].cash; s.forcedRolls = [4];
  const t1 = ok(s, { type: 'taxi', carId: 'vedro-1' });
  assert.equal(t1.players[p].cash - c, 400);
  s.forcedRolls = [4];
  const t2 = ok(s, { type: 'taxi', carId: 'premium-1' });
  assert.equal(t2.players[p].cash - c, 800);
});

test('гонка: открытая, никто не вступил — организатор забирает 1000 €', () => {
  let s = at(mk(3), 'gonka_plus1'); const p = s.current, c = s.players[p].cash;
  s.players.forEach((q) => { if (q.id !== p) q.cars = []; });
  s = ok(s, { type: 'race_start' });
  s = ok(s, { type: 'race_open' });
  assert.equal(s.players[p].cash - c, 1000); assert.equal(s.phase, 'move');
});

test('гонка: вызов — оба платят, взнос кратен 100 и не больше половины денег соперника', () => {
  let s = at(mk(3), 'gonka_plus1'); const p = s.current, t = (p + 1) % 3, u = (p + 2) % 3;
  s.players.forEach((q) => (q.cash = 2000));
  s = ok(s, { type: 'race_start' });
  assert.match(bad(s, { type: 'race_challenge', target: t, stake: 1100 }), /половины/);
  assert.match(bad(s, { type: 'race_challenge', target: t, stake: 150 }), /кратен/);
  assert.match(bad(s, { type: 'race_challenge', target: t, stake: 0 }), /кратен/);
  s.forcedRolls = [2, 5, 3];
  s = ok(s, { type: 'race_challenge', target: t, stake: 500 });
  assert.equal(s.phase, 'race_join'); assert.equal(actor(s), null);
  s = ok(s, { type: 'race_skip', player: u });   // третий отказался — окно закрылось досрочно
  assert.equal(s.players[t].cash, 2000 - 500 + 2000); // 2+1=3 < 5, победил вызванный
  assert.equal(s.players[p].cash, 2000 - 500);
});

test('гонка: 30 с окно — любой игрок может присоединиться, фонд растёт', () => {
  let s = at(mk(3), 'gonka_plus1'); const p = s.current, t = (p + 1) % 3, u = (p + 2) % 3;
  s.players.forEach((q) => (q.cash = 3000));
  s = ok(s, { type: 'race_start' });
  s = ok(s, { type: 'race_challenge', target: t, stake: 300 });
  s = ok(s, { type: 'race_join', player: u });  // все участвуют — гонка стартует сразу
  assert.equal(s.phase, 'move');
  assert.equal(s.players[p].cash + s.players[t].cash + s.players[u].cash, 9000 + 1000);
});

test('гонка: окно по таймеру (race_close) запускает заезд', () => {
  let s = at(mk(3), 'gonka_plus1'); const p = s.current, t = (p + 1) % 3;
  s.players.forEach((q) => (q.cash = 3000));
  s = ok(s, { type: 'race_start' });
  s = ok(s, { type: 'race_challenge', target: t, stake: 100 });
  assert.equal(s.phase, 'race_join');
  s = ok(s, { type: 'race_close' });
  assert.equal(s.phase, 'move');
});

test('гонка «+1»: организатор получает +1 автоматически', () => {
  let s = at(mk(2), 'gonka_plus1'); const p = s.current, o = (p + 1) % 2;
  s.players.forEach((q) => (q.cash = 2000));
  s = ok(s, { type: 'race_start' });
  s.forcedRolls = [3, 3, 1];
  s = ok(s, { type: 'race_challenge', target: o, stake: 100 });
  // 3+1=4 против 3 → победил организатор
  assert.equal(s.players[p].cash, 2000 - 100 + 1200);
});

test('гонка с перебросом: при <6 можно перебросить, берётся максимум', () => {
  let s = at(mk(2), 'gonka_reroll'); const p = s.current, o = (p + 1) % 2;
  s.players.forEach((q) => (q.cash = 2000));
  s = ok(s, { type: 'race_start' });
  s.forcedRolls = [1, 4, 3];            // организатор 1, соперник 4, переброс 3
  s = ok(s, { type: 'race_challenge', target: o, stake: 100 });
  assert.equal(s.phase, 'race_reroll');
  s = ok(s, { type: 'race_reroll' });
  assert.equal(s.players[o].cash, 2000 - 100 + 1200); // max(1,3)=3 < 4
  // 5 и затем 1 → остаётся 5
  let s2 = at(mk(2), 'gonka_reroll'); const p2 = s2.current, o2 = (p2 + 1) % 2;
  s2.players.forEach((q) => (q.cash = 2000));
  s2 = ok(s2, { type: 'race_start' }); s2.forcedRolls = [5, 4, 1];
  s2 = ok(s2, { type: 'race_challenge', target: o2, stake: 100 });
  s2 = ok(s2, { type: 'race_reroll' });
  assert.equal(s2.players[p2].cash, 2000 - 100 + 1200);
  // выпала 6 — решения о перебросе нет
  let s3 = at(mk(2), 'gonka_reroll'); const p3 = s3.current, o3 = (p3 + 1) % 2;
  s3.players.forEach((q) => (q.cash = 2000));
  s3 = ok(s3, { type: 'race_start' }); s3.forcedRolls = [6, 2];
  s3 = ok(s3, { type: 'race_challenge', target: o3, stake: 100 });
  assert.equal(s3.phase, 'move'); assert.equal(s3.players[p3].cash, 2000 - 100 + 1200);
});

test('победа: накоплена цель — игра заканчивается', () => {
  let s = at(mk(2), 'prokat'); const p = s.current;
  s.players[p].cash = 29800; s.players[p].cars = [car(s, 'premium-1', true)];
  s = ok(s, { type: 'rent' });
  assert.equal(s.winner, p); assert.equal(s.phase, 'over');
  assert.equal(applyAction(s, { type: 'move', steps: 1, player: 0 }).ok, false);
});

test('таймер: фишка на 1 клетку вперёд и такси', () => {
  let s = mk(2); const p = s.current;
  s.forcedRolls = [3];
  const r = timeoutTurn(s); assert.ok(r.ok);
  const q = r.state;
  assert.equal(q.players[p].pos, 1); assert.equal(q.players[p].cash, 1500 + 100 * 3);
  assert.notEqual(q.current, p);
});

test('таймер: без машин — просто передвижение и пропуск', () => {
  let s = mk(2); const p = s.current; s.players[p].cars = [];
  const q = timeoutTurn(s).state;
  assert.equal(q.players[p].pos, 1); assert.equal(q.players[p].cash, 1500); assert.notEqual(q.current, p);
});

test('защита: чужой ход и неверные действия отклоняются', () => {
  const s = mk(3); const other = (s.current + 1) % 3;
  assert.equal(applyAction(s, { type: 'move', steps: 1, player: other }).ok, false);
  const t = ok(s, { type: 'move', steps: 1 });
  assert.equal(applyAction(t, { type: 'rent', player: t.current }).ok, false);
});

test('партии ботов (по 4 игрока) доходят до победителя без ошибок', () => {
  const rate = { vedro: 1, bitye: 1, premium: 2, retro: 2 };
  for (let seed = 1; seed <= 6; seed++) {
    let s = createGame({ names: ['A', 'B', 'C', 'D'], seed, cards, goal: 30000 });
    let steps = 0;
    const try_ = (a) => { const r = applyAction(s, a); if (r.ok) s = r.state; return r.ok; };
    while (s.phase !== 'over' && steps++ < 8000) {
      const who = actor(s), acts = legalActions(s), pick = (t) => acts.find((a) => a.type === t);
      let done = false;
      if (s.phase === 'move') done = try_({ player: who, type: 'move', steps: 1 + (steps % 2) });
      else if (s.phase === 'act') {
        for (const t of ['sell', 'rent', 'autoservice', 'buy_start']) {
          const a = pick(t); if (a && try_({ ...a, player: who })) { done = true; break; }
        }
        if (!done) {
          const taxis = acts.filter((a) => a.type === 'taxi').sort((x, y) => rate[s.catalog[y.carId].deck] - rate[s.catalog[x.carId].deck]);
          done = taxis.length ? try_({ ...taxis[0], player: who }) : try_({ player: who, type: 'pass' });
        }
      } else if (s.phase === 'buy') {
        const d = pick('buy_direct'), au = pick('auction_start');
        done = (d && s.players[who].cash - d.price >= 300 && try_({ type: 'buy_direct', player: who })) ||
               (au && s.players[who].cash - au.min >= 300 && try_({ type: 'auction_start', amount: au.min, player: who })) ||
               try_({ type: 'decline', player: who });
      } else if (s.phase === 'auction') done = try_({ type: 'auction_close' });
      else if (s.phase === 'repair') {
        const ids = pick('repair').carIds;
        done = try_({ type: 'repair', carIds: ids, player: who });
        for (const id of ids) { if (done) break; done = try_({ type: 'repair', carIds: [id], player: who }); }
        done = done || try_({ type: 'repair', carIds: [], player: who });
      } else {
        const t = { race_setup: 'race_open', race_join: 'race_close', race_reroll: 'race_keep' }[s.phase];
        done = try_({ type: t, player: who });
      }
      assert.ok(done, `бот застрял в фазе ${s.phase}`);
    }
    assert.equal(s.phase, 'over', `партия seed=${seed} не закончилась за 8000 действий`);
    assert.ok(s.players[s.winner].cash >= 30000);
  }
});

test('publicView прячет порядок колод', () => {
  const v = publicView(mk(2));
  assert.equal(v.decks, undefined); assert.equal(v.deckCounts.vedro > 0, true);
});

test('проданная машина и снятый дефект возвращаются в низ колод', () => {
  let s = at(mk(2), 'skupka'); const p = s.current;
  s.players[p].cars = [car(s, 'vedro-1', true)];
  const n = s.decks.vedro.length;
  s = ok(s, { type: 'sell', carIds: ['vedro-1'] });
  assert.equal(s.decks.vedro.length, n + 1); assert.equal(s.decks.vedro.at(-1), 'vedro-1');
  let r = at(mk(2), 'avtoservis'); const q = r.current;
  const d = { kind: 'repair', name: 'x', deck: 'vedro', repair: { cost: 300 } };
  r.players[q].cars = [car(r, 'vedro-1', false, d)]; r.players[q].cash = 2000;
  const m = r.defectDecks.vedro.length;
  r = ok(r, { type: 'autoservice' }); r = ok(r, { type: 'repair', carIds: ['vedro-1'] });
  assert.equal(r.defectDecks.vedro.length, m + 1); assert.equal(r.defectDecks.vedro.at(-1).name, 'x');
});

test('repairCosts: цена каждой машины; «Битьё» — по кубу', () => {
  let s = at(mk(2), 'avtoservis'); const p = s.current;
  const d = { kind: 'repair', name: 'x', deck: 'vedro', repair: { cost: 400 } };
  s.players[p].cars = [car(s, 'vedro-1', false, d), car(s, 'bitye-4', false)]; s.forcedRolls = [5];
  s = ok(s, { type: 'autoservice' });
  assert.deepEqual(repairCosts(s, p), { 'vedro-1': 400, 'bitye-4': 1000 });
});

test('таймеры: шаг по умолчанию — 1 клетка, затем такси', () => {
  let s = mk(2); const p = s.current;
  s = timeoutStep(s).state; assert.equal(s.phase, 'act'); assert.equal(s.players[p].pos, 1);
  s.forcedRolls = [2]; s = timeoutTurn(s).state;
  assert.notEqual(s.current, p);
});

test('«Есть покупатель» / неремонтируемые машины продаются в любой момент хода', () => {
  let s = mk(2); const p = s.current;
  s.players[p].cars = [car(s, 'vedro-1', false, { kind: 'buyer', name: 'Есть покупатель' }), car(s, 'premium-3', false, { kind: 'unrepairable', name: 'Распил' }), car(s, 'vedro-2', false, { kind: 'repair', name: 'x', repair: { cost: 300 } })];
  const c = s.players[p].cash;
  assert.match(bad(s, { type: 'sell_now', carIds: ['vedro-2'] }), /Скупке/);
  s = ok(s, { type: 'sell_now', carIds: ['vedro-1', 'premium-3'] });
  assert.equal(s.phase, 'move'); assert.equal(s.current, p);
  assert.equal(s.players[p].cash - c, s.catalog['vedro-1'].sell + s.catalog['premium-3'].auction_start);
});

test('скупка отдаёт цены по каждой машине; порядок кубов гонки известен', () => {
  let s = at(mk(2), 'skupka'); const p = s.current;
  s.players[p].cars = [car(s, 'vedro-1', true)];
  assert.equal(legalActions(s).find((a) => a.type === 'sell').quotes['vedro-1'], s.catalog['vedro-1'].sell);
  let r = at(mk(3), 'gonka_plus1'); const o = r.current, t = (o + 1) % 3, w = (o + 2) % 3;
  r.players.forEach((x) => (x.cash = 3000)); r = ok(r, { type: 'race_start' });
  r = ok(r, { type: 'race_challenge', target: t, stake: 100 });
  r = applyAction(r, { type: 'race_join', player: w }).state; // последний допустимый вступил — начинаются броски
  assert.equal(r.phase, 'race_roll'); assert.deepEqual(r.race.queue, [o, t, w]); // порядок: организатор, вызванный, вступивший
  assert.equal(applyAction(r, { type: 'race_roll', player: t }).ok, false); // бросает только тот, чья очередь
});

test('таймер: автоматическое такси на самой дорогой машине', () => {
  let s = mk(2); const p = s.current;
  s.players[p].cars = [car(s, 'vedro-1', false), car(s, 'retro-1', false), car(s, 'bitye-1', false)];
  s.forcedRolls = [2];
  const q = timeoutTurn(s).state;
  assert.equal(q.players[p].cash, 1500 + 200 * 2); // «Ретро» — самая дорогая
});

test('гонка: каждый бросает сам по очереди; не бросил — бросок делается автоматически', () => {
  let s = at(mk(2), 'gonka_plus1'); const o = s.current, t = (o + 1) % 2;
  s.players.forEach((x) => (x.cash = 2000)); s = ok(s, { type: 'race_start' });
  s.forcedRolls = [2, 4];
  let r = applyAction(s, { type: 'race_challenge', player: o, target: t, stake: 100 }); assert.ok(r.ok, r.error); s = r.state;
  assert.equal(s.phase, 'race_roll'); assert.equal(actor(s), o);
  r = applyAction(s, { type: 'race_roll', player: o }); assert.ok(r.ok); s = r.state;
  assert.equal(r.events[0].type, 'race_roll'); assert.equal(actor(s), t); // теперь бросает вызванный
  s = timeoutStep(s).state;                  // 15 с вышли — автоматический бросок
  assert.notEqual(s.phase, 'race_roll'); assert.ok(s.log.some((e) => e.type === 'race_roll' && e.player === t));
});

test('гонка: одинаковые числа — перебрасывают только лидеры', () => {
  let s = at(mk(3), 'gonka_reroll'); const o = s.current, t = (o + 1) % 3, w = (o + 2) % 3;
  s.players.forEach((x) => (x.cash = 3000)); s = ok(s, { type: 'race_start' });
  let r = applyAction(s, { type: 'race_challenge', player: o, target: t, stake: 100 }); s = r.state;
  s = applyAction(s, { type: 'race_join', player: w }).state;
  s.forcedRolls = [6, 6, 2, 1, 5];  // организатор 6, вызванный 6, вступивший 2 → ничья 6:6; перебросок: 1 и 5
  for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'race_roll', player: s.race.queue[0] }).state;
  assert.equal(s.phase, 'race_roll'); assert.deepEqual(s.race.queue, [o, t]); assert.equal(s.race.round, 2);
  const c = s.players[t].cash;
  for (let i = 0; i < 2; i++) s = applyAction(s, { type: 'race_roll', player: s.race.queue[0] }).state;
  assert.equal(s.players[t].cash - c, 1000 + 300); // выиграл вызванный (5 против 1), фонд 1000 + 3×100
});

test('аукцион: отказ от торгов — когда отказались все, побеждает лидер сразу', () => {
  let s = at(mk(3), 'premium'); const p = s.current, t = (p + 1) % 3, w = (p + 2) % 3;
  s.players.forEach((x) => (x.cash = 5000));
  const id = s.decks.premium[0], card = s.catalog[id];
  s = ok(s, { type: 'buy_start' }); s = ok(s, { type: 'auction_start', amount: card.auction_start });
  assert.match(bad(s, { type: 'auction_pass', player: p }), /лидируете/);
  s = ok(s, { type: 'auction_pass', player: t });
  assert.equal(s.phase, 'auction');
  s = ok(s, { type: 'auction_pass', player: w });
  assert.equal(s.phase, 'move'); assert.notEqual(s.current, p);
  assert.equal(s.players[p].cash, 5000 - card.auction_start); assert.ok(s.players[p].cars.some((c) => c.id === id));
});

test('аукцион: отказавшийся не может ставить; последний оставшийся выигрывает после ставки', () => {
  let s = at(mk(3), 'premium'); const p = s.current, t = (p + 1) % 3, w = (p + 2) % 3;
  s.players.forEach((x) => (x.cash = 5000));
  const card = s.catalog[s.decks.premium[0]];
  s = ok(s, { type: 'buy_start' }); s = ok(s, { type: 'auction_start', amount: card.auction_start });
  s = ok(s, { type: 'auction_pass', player: t });
  assert.match(bad(s, { type: 'bid', player: t, amount: card.auction_start + 10 }), /отказались/);
  s = ok(s, { type: 'bid', player: w, amount: card.auction_start + 10 }); // теперь все, кроме лидера w, отказались? нет — p ещё в торгах
  assert.equal(s.phase, 'auction');
  s = ok(s, { type: 'auction_pass', player: p });
  assert.equal(s.phase, 'move'); assert.equal(s.players[w].cash, 5000 - card.auction_start - 10);
});

test('цель 100 000 € разрешена, другие значения нет', () => {
  assert.equal(createGame({ names: ['A', 'B'], goal: 100000, cards }).goal, 100000);
  assert.throws(() => createGame({ names: ['A', 'B'], goal: 70000, cards }));
});
