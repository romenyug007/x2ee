import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGame, applyAction, timeoutTurn, actor, loanInfo, legalActions } from './avtomonopolist-engine.js';

const cards = JSON.parse(fs.readFileSync(new URL('./avtomonopolist-cards.json', import.meta.url)));
const mk = (n = 3) => createGame({ names: ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, n), seed: 11, cards });
const car = (s, id, repaired = true, defect = null) => ({ id, repaired, defect, sellAsRepaired: false });
const run = (s, a) => { const r = applyAction(s, a); assert.ok(r.ok, r.error); return r.state; };
const fails = (s, a) => { const r = applyAction(s, a); assert.equal(r.ok, false); return r.error; };

// игрок p просит amount, игрок q соглашается
function lend(s, p, q, amount) {
  s = run(s, { type: 'loan_request', player: p, amount });
  assert.equal(s.phase, 'loan');
  return run(s, { type: 'loan_accept', player: q, amount: undefined });
}

test('запрос займа: первый согласившийся сразу даёт деньги, игра продолжается', () => {
  let s = mk(3); const b = s.current, l1 = (b + 1) % 3, l2 = (b + 2) % 3;
  s = run(s, { type: 'loan_request', player: b, amount: 1000 });
  assert.equal(actor(s), b); assert.equal(s.phase, 'loan');
  assert.ok(loanInfo(s, l1).canAccept); assert.equal(loanInfo(s, b).canAccept, false);
  s = run(s, { type: 'loan_accept', player: l1 });
  assert.equal(s.phase, 'move'); assert.equal(s.current, b);
  assert.equal(s.players[b].cash, 2500); assert.equal(s.players[l1].cash, 500);
  assert.equal(s.loans.length, 1);
  assert.match(fails(s, { type: 'loan_accept', player: l2 }), /Нет запроса/); // второй уже опоздал
});

test('нельзя дать в долг самому себе и больше, чем есть', () => {
  let s = mk(3); const b = s.current;
  s = run(s, { type: 'loan_request', player: b, amount: 1000 });
  assert.match(fails(s, { type: 'loan_accept', player: b }), /самому себе|не ваш ход/);
  s.players[(b + 1) % 3].cash = 999;
  assert.match(fails(s, { type: 'loan_accept', player: (b + 1) % 3 }), /Не хватает/);
});

test('просить нельзя, если ни у кого нет такой суммы; чужой не может просить', () => {
  const s = mk(2); const b = s.current;
  assert.match(fails(s, { type: 'loan_request', player: b, amount: 5000 }), /Ни у кого/);
  assert.equal(applyAction(s, { type: 'loan_request', player: (b + 1) % 2, amount: 100 }).ok, false);
});

test('отмена запроса и таймер 15 с (timeoutTurn) возвращают игру в прежнюю фазу', () => {
  let s = mk(3); const b = s.current;
  s = run(s, { type: 'loan_request', player: b, amount: 500 });
  const c = run(s, { type: 'loan_cancel', player: b });
  assert.equal(c.phase, 'move'); assert.equal(c.loanReq, null);
  const t = timeoutTurn(s).state; // таймер для фазы займа = отмена, дальше обычный таймаут хода
  assert.equal(t.loans.length, 0); assert.notEqual(t.current, b);
});

test('займ можно взять и посреди хода (в фазе действия)', () => {
  let s = mk(2); const b = s.current;
  s = run(s, { type: 'move', steps: 1, player: b });
  assert.equal(s.phase, 'act');
  s = run(s, { type: 'loan_request', player: b, amount: 300 });
  s = run(s, { type: 'loan_accept', player: (b + 1) % 2 });
  assert.equal(s.phase, 'act'); assert.equal(s.players[b].cash, 1800);
});

test('проценты: +10% за каждый полный круг игры', () => {
  for (const rounds of [0, 1, 2, 3, 4]) {
    let s = mk(2); const b = s.current, l = (b + 1) % 2;
    s = lend(s, b, l, 1000);
    s.round += rounds;
    const info = loanInfo(s, b).repayable[0];
    assert.equal(info.due, 1000 + 100 * rounds);
    const lc = s.players[l].cash, bc = s.players[b].cash;
    s = run(s, { type: 'repay_loan', player: b, loanId: info.loanId });
    assert.equal(s.players[l].cash - lc, 1000 + 100 * rounds);
    assert.equal(bc - s.players[b].cash, 1000 + 100 * rounds);
    assert.equal(s.loans.length, 0);
  }
});

test('круг игры считается, когда ход переходит с последнего места на первое', () => {
  let s = mk(3); assert.equal(s.round, 1);
  for (let i = 0; i < 3; i++) s = timeoutTurn(s).state; // три хода = полный круг
  assert.equal(s.round, 2);
});

test('вернуть долг может только должник и только когда хватает денег', () => {
  let s = mk(2); const b = s.current, l = (b + 1) % 2;
  s = lend(s, b, l, 1000); s.round += 2;
  s.players[b].cash = 1000;
  const id = s.loans[0].id;
  assert.match(fails(s, { type: 'repay_loan', player: b, loanId: id }), /Не хватает/);
  assert.equal(applyAction(s, { type: 'repay_loan', player: l, loanId: id }).ok, false);
});

test('проценты: 10% за каждый из первых 4 кругов, с 5-го круга по 20%', () => {
  for (const [rounds, pct] of [[4, 40], [5, 60], [6, 80]]) {
    let s = mk(2); const b = s.current, l = (b + 1) % 2;
    s = lend(s, b, l, 1000);
    s.round += rounds;
    assert.equal(loanInfo(s, b).repayable[0].due, 1000 + 10 * pct);
  }
});

test('нет подходящей машины, но есть деньги — на 6-м круге платит ×2 от займа', () => {
  let s = mk(2); const b = s.current, l = (b + 1) % 2;
  s = lend(s, b, l, 1000);
  s.players[b].cash = 5000; s.players[b].cars = [];
  const lc = s.players[l].cash;
  s = toBorrowerTurn(s, b, l, 6);
  assert.equal(s.loans.length, 0); assert.equal(s.players[b].eliminated, false);
  assert.ok(s.players[l].cash - lc >= 2000);
});

test('5-й круг: красное предупреждение, ничего не забирают', () => {
  let s = mk(2); const b = s.current, l = (b + 1) % 2;
  s = lend(s, b, l, 1000); s.players[b].cash = 100;
  const bc = s.players[b].cars.length;
  const r = (s = toBorrowerTurn(s, b, l, 5), s);
  assert.equal(r.loans.length, 1); assert.equal(r.players[b].cars.length, bc); assert.equal(r.players[b].eliminated, false);
  assert.equal(loanInfo(r, b).repayable[0].roundsLeft, 0);
});

test('пример: долг 1800, машина 2200 с ремонтом 600 (нетто 1600) не подходит, берётся другая 4000 с ремонтом 500', () => {
  let s = mk(2); const b = s.current, l = (b + 1) % 2;
  s = lend(s, b, l, 1000);                                  // на 6-м круге долг 1800
  s.players[b].cash = 100;
  s.players[b].cars = [car(s, 'vedro-3', false, { kind: 'repair', name: 'x', repair: { cost: 600 } }), car(s, 'vedro-18', false, { kind: 'repair', name: 'y', repair: { cost: 500 } })];
  s = toBorrowerTurn(s, b, l, 6);
  assert.ok(s.players[l].cars.some((c) => c.id === 'vedro-18'));
  assert.ok(s.players[b].cars.some((c) => c.id === 'vedro-3'));
});

// довести игру до начала хода должника на заданном «круге долга» (elapsed = сколько кругов прошло с займа)
function toBorrowerTurn(s, b, l, elapsed) {
  const start = s.loans[0] ? s.loans[0].startRound : s.round;
  s.current = l; s.phase = 'move'; s.round = start + elapsed - (b === 0 ? 1 : 0);
  return timeoutTurn(s).state;
}

test('5-й круг: нет денег на ×2 — игрок ещё в игре; на 6-м круге отдаёт машину, ближайшую по цене (округление вверх)', () => {
  let s = mk(2); const b = s.current, l = (b + 1) % 2;
  s = lend(s, b, l, 1500);                                    // на 6-м круге долг 2700
  s.players[b].cash = 100;
  s.players[b].cars = [car(s, 'vedro-1', true), car(s, 'bitye-1', true), car(s, 'vedro-18', true)]; // 2400, 3000, 4000
  s = toBorrowerTurn(s, b, l, 5);
  assert.equal(s.players[b].eliminated, false); assert.equal(s.loans.length, 1);
  s = toBorrowerTurn(s, b, l, 6);
  assert.equal(s.loans.length, 0); assert.equal(s.players[b].eliminated, false);
  assert.ok(s.players[l].cars.some((c) => c.id === 'bitye-1'));          // ровно 3000 — ближайшая, не меньше долга
  assert.ok(!s.players[b].cars.some((c) => c.id === 'bitye-1'));
});

test('взыскание: если все машины дешевле долга — автоматический проигрыш; ремонт учитывается в оценке', () => {
  let s = mk(2); const b = s.current, l = (b + 1) % 2;
  s = lend(s, b, l, 1500);                                    // на 6-м круге долг 2700
  s.players[b].cash = 100;
  s.players[b].cars = [car(s, 'vedro-1', true)];              // 2400 < 3000
  s = toBorrowerTurn(s, b, l, 6);
  assert.equal(s.players[b].eliminated, true); assert.equal(s.phase, 'over'); assert.equal(s.winner, l);
  // неотремонтированная «Битьё»: 6000 − ремонт (средняя цена 600) = 5400 ≥ 3000 — подходит
  let r = mk(2); const b2 = r.current, l2 = (b2 + 1) % 2;
  r = lend(r, b2, l2, 1500); r.players[b2].cash = 100;
  r.players[b2].cars = [car(r, 'bitye-4', false)];
  r = toBorrowerTurn(r, b2, l2, 6);
  assert.ok(r.players[l2].cars.some((c) => c.id === 'bitye-4'));
});

test('победа невозможна с невозвращённым долгом; после возврата — победа', () => {
  let s = mk(2); const b = s.current, l = (b + 1) % 2;
  s = lend(s, b, l, 1000);
  s.players[b].cash = 31000;
  // любое действие с победным капиталом, но с долгом — игра не заканчивается
  s = run(s, { type: 'move', steps: 1, player: b });
  assert.notEqual(s.phase, 'over'); assert.equal(s.winner, null);
  s = run(s, { type: 'repay_loan', player: b, loanId: s.loans[0].id });
  assert.equal(s.winner, b); assert.equal(s.phase, 'over');
});

test('выбывший игрок пропускается в ходах и аукционах', () => {
  let s = mk(3); const b = s.current, l = (b + 1) % 3, o = (b + 2) % 3;
  s = lend(s, b, l, 500);
  s.players[b].cash = 0; s.players[b].cars = [];
  let guard = 0;
  while (!s.players[b].eliminated && s.phase !== 'over' && guard++ < 300) { s.players[b].cash = 0; s = timeoutTurn(s).state; }
  assert.equal(s.players[b].eliminated, true);
  assert.notEqual(s.phase, 'over'); // остались двое
  for (let i = 0; i < 6; i++) { s = timeoutTurn(s).state; assert.notEqual(s.current, b); }
});
