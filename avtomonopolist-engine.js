// Автомонополист — движок правил (чистый JS, без зависимостей, работает в Node и в браузере).
// Все суммы в евро. Состояние сериализуется в JSON; applyAction возвращает новое состояние.
// Этап 1: основной цикл игры. Пока НЕ реализованы: совместная покупка и долги между игроками.

export const BOARD = [
  'skupka',        // 0 — старт
  'vedro', 'avtoservis', 'gonka_plus1', 'avtopodbor', 'bitye',
  'skupka', 'premium', 'avtoservis', 'gonka_reroll', 'prokat', 'retro',
];
export const MOVE_COST = [null, 0, 0, 300, 600, 1000, 3000, 10000]; // индекс = число шагов
export const START_CASH = 1500;
export const RACE_POT = 1000;
export const MOVE_SECONDS = 30;      // выбор числа шагов
export const ACT_SECONDS = 60;       // решение: что купить / активировать / гонка
export const AUCTION_SECONDS = 30;   // новый отсчёт после каждой ставки
export const RACE_JOIN_SECONDS = 30; // окно присоединения к гонке
export const RACE_ROLL_SECONDS = 15; // каждый участник гонки сам бросает куб; не бросил — бросается автоматически
export const LOAN_SECONDS = 15;      // окно ответа на запрос займа (не входит в 30 с хода)
export const LOAN_RATE_LATE = 0.2;  // с 5-го круга проценты начисляются по 20% за круг
export const LOAN_RATE = 0.1;        // +10% от суммы за каждый полный круг игры
export const LOAN_DEADLINE_ROUNDS = 5; // через 5 кругов — принудительный возврат ×2
export const DEFECT_COPIES = 2; // колоды дефектов бесконечные, состав кратен оригиналу
const RENT = { vedro: 500, bitye: 500, premium: 1000, retro: 1000 };
const TAXI = { vedro: 100, bitye: 100, premium: 200, retro: 200 };
const CELL_DECK = { vedro: 'vedro', bitye: 'bitye', premium: 'premium', retro: 'retro' };

class Illegal extends Error {}
const fail = (m) => { throw new Error(m); };

// ---------- ГСЧ (mulberry32, состояние хранится в state.rng) ----------
function rnd(s) {
  s.rng = (s.rng + 0x6D2B79F5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const die = (s) => (s.forcedRolls && s.forcedRolls.length ? s.forcedRolls.shift() : 1 + Math.floor(rnd(s) * 6));
function shuffle(s, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd(s) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- создание игры ----------
export function createGame({ names, goal = 30000, seed = 1, cards, forcedRolls }) {
  if (names.length < 2 || names.length > 6) fail('Игроков должно быть от 2 до 6');
  if (![30000, 50000, 100000].includes(goal)) fail('Цель: 30000, 50000 или 100000');
  const s = {
    rng: seed >>> 0, goal, turn: 1, current: 0, phase: 'move', winner: null,
    round: 1, loans: [], nextLoanId: 1, loanReq: null, loanReturn: null,
    players: names.map((name, id) => ({ id, name, cash: START_CASH, pos: 0, cars: [], eliminated: false })),
    catalog: {}, decks: { vedro: [], bitye: [], premium: [], retro: [] },
    defectTemplate: cards.defects, defectDecks: { vedro: [], premium: [] },
    pending: null, auction: null, race: null, repairRoll: null, log: [],
  };
  if (forcedRolls) s.forcedRolls = [...forcedRolls];
  for (const c of cards.cars) { s.catalog[c.id] = c; s.decks[c.deck].push(c.id); }
  for (const k of Object.keys(s.decks)) shuffle(s, s.decks[k]);
  refillDefects(s, 'vedro'); refillDefects(s, 'premium');
  // стартовая машина «Ведро» и дефект (только ремонтируемый, без обмена)
  for (const p of s.players) {
    const cardId = s.decks.vedro.shift();
    const d = takeDefect(s, 'vedro', (x) => x.kind === 'repair');
    p.cars.push({ id: cardId, repaired: false, defect: d, sellAsRepaired: false });
  }
  // первый ход — у кого больше на кубе, при равенстве перебрасывают лидеры
  let cand = s.players.map((p) => p.id);
  while (cand.length > 1) {
    const r = cand.map((id) => [id, die(s)]);
    const max = Math.max(...r.map((x) => x[1]));
    cand = r.filter((x) => x[1] === max).map((x) => x[0]);
  }
  s.current = cand[0];
  s.playerCount = names.length;
  ev(s, { type: 'game_start', first: s.current });
  return s;
}

function toBottom(s, car) { // проданные машины и снятые дефекты возвращаются в низ колоды
  const c = s.catalog[car.id];
  s.decks[c.deck].push(car.id);
  if (car.defect && s.defectDecks[c.deck]) s.defectDecks[c.deck].push(car.defect);
}
function ev(s, e) { s.log.push(e); return e; }
function refillDefects(s, deck) {
  const arr = [];
  for (let c = 0; c < DEFECT_COPIES; c++) arr.push(...s.defectTemplate[deck].map((d) => ({ ...d })));
  s.defectDecks[deck] = shuffle(s, arr);
}
function takeDefect(s, deck, filter = () => true) {
  if (!s.defectDecks[deck].some(filter)) refillDefects(s, deck);
  const i = s.defectDecks[deck].findIndex(filter);
  if (i < 0) fail('Нет подходящего дефекта');
  return s.defectDecks[deck].splice(i, 1)[0];
}

// выдать игроку машину; для «Ведра» и «Премиума» тянется дефект с мгновенным эффектом
function giveCar(s, p, cardId, depth = 0) {
  const card = s.catalog[cardId];
  const car = { id: cardId, repaired: false, defect: null, sellAsRepaired: false };
  if (card.deck === 'vedro' || card.deck === 'premium') {
    let d = takeDefect(s, card.deck, depth >= 2 ? (x) => x.kind !== 'swap' : () => true);
    if (d.kind === 'swap' && s.decks.vedro.length < 1) d = takeDefect(s, card.deck, (x) => x.kind === 'repair');
    if (d.kind === 'swap') {
      ev(s, { type: 'swap', player: p.id, from: cardId });
      for (let i = 0; i < 2 && s.decks.vedro.length; i++) giveCar(s, p, s.decks.vedro.shift(), depth + 1);
      s.decks[card.deck].push(cardId); s.defectDecks[card.deck].push(d);
      return;
    }
    car.defect = d;
    if (d.kind === 'buyer') car.sellAsRepaired = true;
  }
  p.cars.push(car);
  ev(s, { type: 'car_gained', player: p.id, cardId, defect: car.defect ? car.defect.name : null, defectCost: car.defect && car.defect.repair ? car.defect.repair.cost : null, defectText: car.defect ? (car.defect.text || null) : null });
}

// ---------- вспомогательное ----------
const cur = (s) => s.players[s.current];
const cellOf = (s, p) => BOARD[p.pos];
const owned = (p, id) => p.cars.find((c) => c.id === id) || fail('У игрока нет такой машины');
const isUnrepairable = (c) => c.defect && ['unrepairable', 'buyer', 'swap_pay'].includes(c.defect.kind);

function repairCost(s, car) {
  const card = s.catalog[car.id];
  if (car.repaired || isUnrepairable(car)) return null;
  if (card.deck === 'retro') return card.repair.cost;
  if (card.deck === 'bitye') {
    const r = s.repairRoll;
    if (r == null) return null;
    return card.repair[r <= 2 ? 'die_1_2' : r <= 4 ? 'die_3_4' : 'die_5_6'];
  }
  return car.defect.repair.cost;
}
function sellPrice(s, car) {
  const card = s.catalog[car.id];
  if (car.repaired || car.sellAsRepaired || (car.defect && car.defect.kind === 'buyer')) return card.sell;
  if (car.defect && car.defect.kind === 'unrepairable') return card.auction_start;
  return null;
}
const alive = (s) => s.players.filter((p) => !p.eliminated);
const hasDebt = (s, p) => s.loans.some((l) => l.borrower === p.id);
function carValue(s, car) { // оценка машины при взыскании долга: цена продажи, за вычетом ремонта, если он нужен
  const k = s.catalog[car.id];
  if (car.repaired || car.sellAsRepaired || (car.defect && car.defect.kind === 'buyer')) return k.sell;
  if (car.defect && car.defect.kind === 'unrepairable') return k.auction_start;
  const rep = k.deck === 'retro' ? k.repair.cost : k.deck === 'bitye' ? k.repair.die_3_4 : (car.defect && car.defect.repair ? car.defect.repair.cost : 0);
  return k.sell - rep;
}
const loanInterest = (s, l) => { // 10% за каждый из первых 4 кругов, дальше 20% за круг
  const e = Math.max(0, s.round - l.startRound);
  return Math.round(l.principal * (LOAN_RATE * Math.min(e, 4) + LOAN_RATE_LATE * Math.max(0, e - 4)));
};
const loanDue = (s, l) => l.principal + loanInterest(s, l);

function eliminate(s, p, lenderId) {
  const lender = s.players[lenderId];
  if (lender && !lender.eliminated) lender.cash += p.cash;
  p.cars.forEach((c) => toBottom(s, c)); p.cash = 0; p.cars = []; p.eliminated = true; p.pos = -1;
  s.loans = s.loans.filter((l) => l.borrower !== p.id && l.lender !== p.id);
  ev(s, { type: 'eliminated', player: p.id, reason: 'loan_default', lender: lenderId });
}
// в начале хода должника: 5-й круг — красное предупреждение; 6-й круг — забирают машину,
// не дешевле долга с процентами (с учётом ремонта); нет подходящей — платит ×2 от займа; нет денег — проигрыш
function settleLoans(s, p) {
  for (const l of s.loans.filter((x) => x.borrower === p.id)) {
    const el = s.round - l.startRound;
    if (el < LOAN_DEADLINE_ROUNDS) continue;
    const due = loanDue(s, l);
    if (el === LOAN_DEADLINE_ROUNDS) { ev(s, { type: 'loan_warning', borrower: p.id, lender: l.lender, due }); continue; }
    const cand = p.cars.map((c) => ({ c, v: carValue(s, c) })).filter((x) => x.v >= due).sort((a, b) => a.v - b.v)[0];
    if (cand) {
      p.cars = p.cars.filter((c) => c !== cand.c); s.players[l.lender].cars.push(cand.c);
      s.loans = s.loans.filter((x) => x !== l);
      ev(s, { type: 'loan_seized', borrower: p.id, lender: l.lender, cardId: cand.c.id, value: cand.v, due });
      continue;
    }
    const pay = l.principal * 2;
    if (p.cash >= pay) {
      p.cash -= pay; s.players[l.lender].cash += pay;
      s.loans = s.loans.filter((x) => x !== l);
      ev(s, { type: 'loan_forced', borrower: p.id, lender: l.lender, amount: pay });
    } else { eliminate(s, p, l.lender); return true; }
  }
  return false;
}
function nextTurn(s) {
  s.pending = s.auction = s.race = s.repairRoll = s.loanReq = s.loanReturn = null;
  const n = s.players.length;
  for (let g = 0; g < 4 * n; g++) {
    s.current = (s.current + 1) % n;
    if (s.current === 0) s.round += 1;
    const p = cur(s);
    if (p.eliminated) continue;
    s.turn += 1; s.phase = 'move';
    if (settleLoans(s, p)) continue;
    break;
  }
  const a = alive(s);
  if (a.length === 1 && s.winner == null) { s.winner = a[0].id; s.phase = 'over'; ev(s, { type: 'win', player: a[0].id, reason: 'last_player' }); }
}
function checkWinner(s) {
  if (s.winner != null) return;
  const w = s.players.find((p) => !p.eliminated && p.cash >= s.goal && !hasDebt(s, p));
  if (w) { s.winner = w.id; s.phase = 'over'; ev(s, { type: 'win', player: w.id }); }
}
function destination(s, p, steps) {
  const cap = (s.playerCount || s.players.length) <= 4 ? 1 : 2;
  const full = (i) => s.players.filter((q) => q.id !== p.id && q.pos === i).length >= cap;
  let pos = p.pos, n = 0;
  for (let g = 0; n < steps && g < 200; g++) {
    pos = (pos + 1) % BOARD.length;
    if (pos === p.pos || full(pos)) continue;
    n++;
  }
  if (n < steps) fail('Нет свободной клетки');
  return pos;
}

// ---------- кто сейчас должен ходить ----------
export function actor(s) {
  if (s.phase === 'loan') return s.loanReq.borrower;
  if (s.phase === 'race_roll') return s.race.queue[0]; // бросает по очереди сам участник
  if (s.phase === 'auction') return null;   // открытые торги: могут все
  if (s.phase === 'race_join') return null; // открытое окно: могут все
  if (s.phase === 'over') return null;
  return s.current;
}

// ---------- действия ----------
export function applyAction(state, action) {
  if (state.phase === 'over') return { ok: false, error: 'Игра закончена' };
  const s = structuredClone(state);
  s.log = [];
  try {
    const p = s.players[action.player], tp = action.type;
    if (tp === 'auction_close' || tp === 'race_close') {
      if (s.phase !== (tp === 'auction_close' ? 'auction' : 'race_join')) fail('Неверная фаза');
    } else {
      if (!p || p.eliminated) fail('Игрок выбыл');
      if (tp === 'loan_accept') { if (s.phase !== 'loan') fail('Нет запроса займа'); }
      else if (['bid', 'auction_pass', 'race_join', 'race_skip'].includes(tp) && ['auction', 'race_join'].includes(s.phase)) { /* открытые фазы */ }
      else if (action.player !== actor(s)) fail('Сейчас не ваш ход');
    }
    if (LOAN_ACTIONS[action.type]) LOAN_ACTIONS[action.type](s, p, action);
    else HANDLERS[s.phase] ? HANDLERS[s.phase](s, p, action) : fail('Неверная фаза');
    checkWinner(s);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, state: s, events: s.log };
}

const LOAN_PHASES = ['move', 'act', 'buy', 'repair', 'race_setup'];
const LOAN_ACTIONS = {
  // машины без шанса на ремонт («Есть покупатель», неремонтируемый «Премиум») можно продать в любой момент своего хода
  sell_now(s, p, a) {
    if (!['move', 'act'].includes(s.phase)) fail('Сейчас нельзя продавать');
    if (!a.carIds || !a.carIds.length) fail('Выберите машины');
    let total = 0;
    for (const id of new Set(a.carIds)) {
      const car = owned(p, id);
      if (!car.defect || !['unrepairable', 'buyer'].includes(car.defect.kind)) fail('Эту машину можно продать только на «Скупке»');
      total += sellPrice(s, car);
    }
    for (const id of new Set(a.carIds)) toBottom(s, owned(p, id));
    p.cars = p.cars.filter((c) => !a.carIds.includes(c.id));
    p.cash += total;
    ev(s, { type: 'sold', player: p.id, carIds: a.carIds, total, now: true });
  },
  loan_request(s, p, a) {
    if (!LOAN_PHASES.includes(s.phase)) fail('Сейчас нельзя просить в долг');
    if (!Number.isInteger(a.amount) || a.amount < 1) fail('Неверная сумма');
    if (!alive(s).some((x) => x.id !== p.id && x.cash >= a.amount)) fail('Ни у кого нет такой суммы');
    s.loanReturn = s.phase; s.phase = 'loan';
    s.loanReq = { borrower: p.id, amount: a.amount };
    ev(s, { type: 'loan_request', borrower: p.id, amount: a.amount, seconds: LOAN_SECONDS });
  },
  loan_accept(s, p) {
    const R = s.loanReq;
    if (p.id === R.borrower) fail('Нельзя дать в долг самому себе');
    if (p.cash < R.amount) fail('Не хватает денег');
    p.cash -= R.amount; s.players[R.borrower].cash += R.amount;
    s.loans.push({ id: s.nextLoanId++, lender: p.id, borrower: R.borrower, principal: R.amount, startRound: s.round });
    ev(s, { type: 'loan_given', lender: p.id, borrower: R.borrower, amount: R.amount });
    s.phase = s.loanReturn; s.loanReq = s.loanReturn = null; // первый согласившийся — игра сразу продолжается
  },
  loan_cancel(s, p) {
    if (s.phase !== 'loan') fail('Нет запроса займа');
    ev(s, { type: 'loan_cancelled', borrower: p.id });
    s.phase = s.loanReturn; s.loanReq = s.loanReturn = null;
  },
  repay_loan(s, p, a) {
    if (!['move', 'act'].includes(s.phase)) fail('Сейчас нельзя вернуть долг');
    const l = s.loans.find((x) => x.id === a.loanId && x.borrower === p.id) || fail('Нет такого долга');
    const due = loanDue(s, l);
    if (p.cash < due) fail('Не хватает денег');
    p.cash -= due; s.players[l.lender].cash += due;
    s.loans = s.loans.filter((x) => x !== l);
    ev(s, { type: 'loan_repaid', borrower: p.id, lender: l.lender, amount: due });
  },
};

const HANDLERS = {
  move(s, p, a) {
    if (a.type !== 'move') fail('Сначала нужно передвинуть фишку');
    const n = a.steps;
    if (!Number.isInteger(n) || n < 1 || n > 7) fail('Шагов должно быть от 1 до 7');
    const cost = MOVE_COST[n];
    if (p.cash < cost) fail('Не хватает денег на ход');
    const to = destination(s, p, n);
    p.cash -= cost; p.pos = to; s.phase = 'act';
    ev(s, { type: 'moved', player: p.id, steps: n, cost, to, cell: BOARD[to] });
  },

  act(s, p, a) {
    const cell = cellOf(s, p);
    switch (a.type) {
      case 'taxi': {
        const car = owned(p, a.carId);
        const d = die(s), income = TAXI[s.catalog[car.id].deck] * d;
        p.cash += income;
        ev(s, { type: 'taxi', player: p.id, carId: car.id, die: d, income });
        return nextTurn(s);
      }
      case 'pass': {
        if (legal(s).some((x) => x.type !== 'pass')) fail('Есть доступные действия');
        return nextTurn(s);
      }
      case 'buy_start': {
        const deck = cell === 'avtopodbor' ? a.deck : CELL_DECK[cell];
        if (!deck || !s.decks[deck]) fail('Здесь нельзя купить машину');
        if (!s.decks[deck].length) fail('Колода закончилась');
        s.pending = { cardId: s.decks[deck][0], deck };
        s.phase = 'buy';
        return ev(s, { type: 'revealed', player: p.id, cardId: s.pending.cardId });
      }
      case 'autoservice': {
        if (cell !== 'avtoservis') fail('Это не автосервис');
        s.repairRoll = p.cars.some((c) => !c.repaired && s.catalog[c.id].deck === 'bitye') ? die(s) : null;
        s.phase = 'repair';
        return ev(s, { type: 'repair_roll', player: p.id, die: s.repairRoll });
      }
      case 'sell': {
        if (cell !== 'skupka') fail('Это не скупка');
        if (!a.carIds || !a.carIds.length) fail('Выберите машины');
        let total = 0;
        for (const id of new Set(a.carIds)) {
          const car = owned(p, id), price = sellPrice(s, car);
          if (price == null) fail('Эту машину нельзя продать');
          total += price;
        }
        p.cars.filter((c) => a.carIds.includes(c.id)).forEach((c) => toBottom(s, c));
        p.cars = p.cars.filter((c) => !a.carIds.includes(c.id));
        p.cash += total;
        ev(s, { type: 'sold', player: p.id, carIds: a.carIds, total });
        return nextTurn(s);
      }
      case 'rent': {
        if (cell !== 'prokat') fail('Это не прокат');
        const cars = p.cars.filter((c) => c.repaired);
        if (!cars.length) fail('Нет отремонтированных машин');
        const total = cars.reduce((t, c) => t + RENT[s.catalog[c.id].deck], 0);
        p.cash += total;
        ev(s, { type: 'rent', player: p.id, total });
        return nextTurn(s);
      }
      case 'race_start': {
        if (!cell.startsWith('gonka')) fail('Это не гонка');
        if (!p.cars.length) fail('Для гонки нужна машина');
        s.race = { organizer: p.id, pot: RACE_POT, stake: 0, participants: [p.id], joinQueue: [], rolls: null };
        s.phase = 'race_setup';
        return ev(s, { type: 'race_started', organizer: p.id, pot: RACE_POT });
      }
      case 'swap_pay': {
        const car = owned(p, a.carId);
        if (!car.defect || car.defect.kind !== 'swap_pay') fail('У машины нет такого дефекта');
        if (!s.decks[a.deck] || !s.decks[a.deck].length) fail('Колода пуста');
        const price = (id) => { const c = s.catalog[id]; return c.deck === 'retro' ? c.auction_start * 2 : c.buy; };
        const newId = s.decks[a.deck][0];
        const diff = Math.max(0, price(newId) - price(car.id));
        if (p.cash < diff) fail('Не хватает денег на доплату');
        p.cash -= diff;
        s.decks[a.deck].shift();
        toBottom(s, car); p.cars = p.cars.filter((c) => c !== car);
        ev(s, { type: 'swap_pay', player: p.id, from: car.id, to: newId, diff });
        giveCar(s, p, newId);
        return nextTurn(s);
      }
      default: fail('Это действие сейчас недоступно');
    }
  },

  buy(s, p, a) {
    const { cardId, deck } = s.pending, card = s.catalog[cardId];
    if (a.type === 'buy_direct') {
      if (deck === 'retro') fail('«Ретро» покупается только на аукционе');
      if (p.cash < card.buy) fail('Не хватает денег');
      p.cash -= card.buy;
      s.decks[deck].shift();
      ev(s, { type: 'bought', player: p.id, cardId, price: card.buy });
      giveCar(s, p, cardId);
      return nextTurn(s);
    }
    if (a.type === 'auction_start') {
      if (!Number.isInteger(a.amount) || a.amount < card.auction_start) fail('Ставка ниже стартовой');
      if (a.amount > p.cash) fail('Не хватает денег');
      s.auction = { cardId, deck, bid: a.amount, bidder: p.id, starter: p.id, passed: [] };
      s.phase = 'auction';
      return ev(s, { type: 'auction_started', player: p.id, cardId, bid: a.amount });
    }
    if (a.type === 'decline') {
      s.decks[deck].push(s.decks[deck].shift());
      ev(s, { type: 'discarded', player: p.id, cardId });
      return nextTurn(s);
    }
    fail('Купите, объявите аукцион или откажитесь');
  },

  auction(s, p, a) { // открытые торги: ставить может любой; после каждой ставки новый отсчёт; можно отказаться
    const A = s.auction;
    const allOut = () => alive(s).filter((q) => q.id !== A.bidder).every((q) => A.passed.includes(q.id));
    const finish = () => {
      const w = s.players[A.bidder];
      w.cash -= A.bid;
      s.decks[A.deck].shift();
      ev(s, { type: 'auction_won', player: w.id, cardId: A.cardId, price: A.bid });
      giveCar(s, w, A.cardId);
      nextTurn(s);
    };
    if (a.type === 'bid') {
      if (A.passed.includes(p.id)) fail('Вы отказались от торгов');
      if (p.id === A.bidder) fail('Ваша ставка уже лучшая');
      if (!Number.isInteger(a.amount) || a.amount <= A.bid) fail('Ставка должна быть выше текущей');
      if (a.amount > p.cash) fail('Не хватает денег');
      A.bid = a.amount; A.bidder = p.id;
      ev(s, { type: 'bid', player: p.id, amount: a.amount, seconds: AUCTION_SECONDS });
      if (allOut()) finish(); // все остальные уже отказались
      return;
    }
    if (a.type === 'auction_pass') {
      if (p.id === A.bidder) fail('Вы лидируете в торгах');
      if (!A.passed.includes(p.id)) A.passed.push(p.id);
      ev(s, { type: 'auction_pass', player: p.id });
      if (allOut()) finish();
      return;
    }
    if (a.type === 'auction_close') return finish();
    fail('Сделайте ставку или откажитесь');
  },

  loan() { fail('Ждём ответа на запрос займа'); },

  repair(s, p, a) {
    if (a.type !== 'repair') fail('Выберите машины для ремонта');
    let total = 0;
    const ids = [...new Set(a.carIds || [])];
    for (const id of ids) {
      const c = repairCost(s, owned(p, id));
      if (c == null) fail('Эту машину сейчас нельзя отремонтировать');
      total += c;
    }
    if (total > p.cash) fail('Не хватает денег');
    p.cash -= total;
    for (const id of ids) { const car = owned(p, id); if (car.defect) s.defectDecks[s.catalog[car.id].deck].push(car.defect); car.repaired = true; car.defect = null; car.sellAsRepaired = false; }
    ev(s, { type: 'repaired', player: p.id, carIds: ids, total });
    nextTurn(s);
  },

  race_setup(s, p, a) {
    const R = s.race;
    if (a.type === 'race_open') R.stake = 0;
    else if (a.type === 'race_challenge') {
      const q = s.players[a.target];
      if (!q || q.id === p.id || q.eliminated) fail('Неверный соперник');
      if (!q.cars.length) fail('У соперника нет машины');
      if (!Number.isInteger(a.stake) || a.stake < 100 || a.stake % 100) fail('Взнос кратен 100 €');
      if (a.stake > Math.floor(q.cash / 2)) fail('Не больше половины денег соперника');
      if (p.cash < a.stake) fail('Не хватает денег');
      p.cash -= a.stake; q.cash -= a.stake; // вызванный отказаться не может
      R.stake = a.stake; R.pot += 2 * a.stake; R.participants.push(q.id);
      ev(s, { type: 'race_challenge', organizer: p.id, target: q.id, stake: a.stake, seconds: RACE_JOIN_SECONDS });
    } else fail('Вызовите соперника или откройте гонку');
    R.skipped = []; s.phase = 'race_join';
    if (!raceEligible(s).length) raceRoll(s);
  },

  race_join(s, p, a) { // 30 с окно: присоединиться может любой игрок с машиной и деньгами
    const R = s.race;
    if (a.type === 'race_close') return raceRoll(s);
    if (!raceEligible(s).includes(p.id)) fail('Вы не можете участвовать');
    if (a.type === 'race_join') {
      p.cash -= R.stake; R.pot += R.stake; R.participants.push(p.id);
      ev(s, { type: 'race_join', player: p.id });
    } else if (a.type === 'race_skip') R.skipped.push(p.id);
    else fail('Присоединитесь или откажитесь');
    if (!raceEligible(s).length) raceRoll(s);
  },

  race_roll(s, p, a) {
    const R = s.race;
    if (a.type !== 'race_roll') fail('Бросьте кубик');
    const d = die(s);
    R.rolls[p.id] = d;
    ev(s, { type: 'race_roll', player: p.id, die: d, tie: R.round > 1 });
    R.queue.shift();
    if (!R.queue.length) raceAfterRolls(s);
  },

  race_reroll(s, p, a) {
    const R = s.race;
    if (a.type === 'race_reroll') {
      const d = die(s);
      ev(s, { type: 'race_reroll', player: p.id, die: d, first: R.rolls[p.id] });
      R.rolls[p.id] = Math.max(R.rolls[p.id], d);
    } else if (a.type !== 'race_keep') fail('Перебросить или оставить');
    raceResolve(s);
  },
};

export function raceEligible(s) {
  const R = s.race;
  return s.players.filter((q) => !q.eliminated && !R.participants.includes(q.id) && !R.skipped.includes(q.id) &&
    q.cars.length && q.cash >= R.stake).map((q) => q.id);
}
function raceRoll(s) {
  const R = s.race, org = s.players[R.organizer];
  if (R.participants.length === 1) { // соперников нет — организатор забирает фонд
    org.cash += R.pot;
    ev(s, { type: 'race_won', player: org.id, pot: R.pot, rolls: null });
    return nextTurn(s);
  }
  R.rolls = {}; R.queue = [...R.participants]; R.round = 1; R.tied = null;
  s.phase = 'race_roll'; // участники бросают по очереди: организатор, вызванный, вступившие
}
function raceAfterRolls(s) {
  const R = s.race, org = s.players[R.organizer];
  if (R.round === 1) {
    ev(s, { type: 'race_rolls', rolls: { ...R.rolls }, order: [...R.participants] });
    const cell = BOARD[org.pos];
    if (cell === 'gonka_plus1') { R.rolls[org.id] += 1; ev(s, { type: 'race_plus1', player: org.id }); }
    else if (cell === 'gonka_reroll' && R.rolls[org.id] < 6) { s.phase = 'race_reroll'; return; }
  }
  raceResolve(s);
}
function raceResolve(s) {
  const R = s.race, group = R.tied || R.participants;
  const max = Math.max(...group.map((id) => R.rolls[id]));
  const lead = group.filter((id) => R.rolls[id] === max);
  if (lead.length > 1) { // одинаковые числа — лидеры бросают заново
    R.round += 1; R.tied = lead; R.queue = [...lead]; s.phase = 'race_roll';
    return ev(s, { type: 'race_tie', players: lead });
  }
  const w = s.players[lead[0]];
  w.cash += R.pot;
  ev(s, { type: 'race_won', player: w.id, pot: R.pot, rolls: R.rolls });
  nextTurn(s);
}

// ---------- доступные действия (для интерфейса и ботов) ----------
function legal(s) {
  const p = actor(s) == null ? null : s.players[actor(s)], out = [];
  if (s.phase === 'move') {
    for (let n = 1; n <= 7; n++) {
      try { destination(s, p, n); } catch { continue; }
      if (p.cash >= MOVE_COST[n]) out.push({ type: 'move', steps: n, cost: MOVE_COST[n] });
    }
  } else if (s.phase === 'act') {
    const cell = cellOf(s, p);
    for (const c of p.cars) out.push({ type: 'taxi', carId: c.id });
    if (CELL_DECK[cell] && s.decks[CELL_DECK[cell]].length) out.push({ type: 'buy_start' });
    if (cell === 'avtopodbor') for (const d of Object.keys(s.decks)) if (s.decks[d].length) out.push({ type: 'buy_start', deck: d });
    if (cell === 'avtoservis' && p.cars.some((c) => !c.repaired && !isUnrepairable(c))) out.push({ type: 'autoservice' });
    if (cell === 'skupka') {
      const ids = p.cars.filter((c) => sellPrice(s, c) != null).map((c) => c.id);
      if (ids.length) out.push({ type: 'sell', carIds: ids, quotes: Object.fromEntries(ids.map((id) => [id, sellPrice(s, owned(p, id))])) });
    }
    if (cell === 'prokat' && p.cars.some((c) => c.repaired)) out.push({ type: 'rent' });
    if (cell.startsWith('gonka') && p.cars.length) out.push({ type: 'race_start' });
    for (const c of p.cars) if (c.defect && c.defect.kind === 'swap_pay') out.push({ type: 'swap_pay', carId: c.id });
    if (!p.cars.length && out.every((x) => x.type === 'taxi')) out.push({ type: 'pass' });
    if (!out.length) out.push({ type: 'pass' });
  } else if (s.phase === 'buy') {
    const card = s.catalog[s.pending.cardId];
    if (s.pending.deck !== 'retro' && p.cash >= card.buy) out.push({ type: 'buy_direct', price: card.buy });
    if (p.cash >= card.auction_start) out.push({ type: 'auction_start', min: card.auction_start });
    out.push({ type: 'decline' });
  } else if (s.phase === 'auction') {
    out.push({ type: 'auction_pass' });
    out.push({ type: 'bid', min: s.auction.bid + 1 }, { type: 'auction_close' });
  } else if (s.phase === 'repair') {
    out.push({ type: 'repair', carIds: p.cars.filter((c) => repairCost(s, c) != null).map((c) => c.id), roll: s.repairRoll });
  } else if (s.phase === 'race_setup') {
    out.push({ type: 'race_open' }, { type: 'race_challenge' });
  } else if (s.phase === 'race_join') {
    out.push({ type: 'race_join' }, { type: 'race_skip' }, { type: 'race_close' });
  } else if (s.phase === 'race_reroll') {
    out.push({ type: 'race_reroll' }, { type: 'race_keep' });
  } else if (s.phase === 'race_roll') {
    out.push({ type: 'race_roll' });
  } else if (s.phase === 'loan') {
    out.push({ type: 'loan_cancel' });
  }
  return out;
}
export function legalActions(state) {
  return state.phase === 'over' ? [] : legal(state).map((a) => ({ ...a, player: actor(state) }));
}

// займы: что может сделать игрок прямо сейчас (для интерфейса)
export function loanInfo(s, playerId) {
  const p = s.players[playerId];
  if (!p || p.eliminated || s.phase === 'over') return { canRequest: false, canAccept: false, repayable: [] };
  const canRequest = playerId === s.current && LOAN_PHASES.includes(s.phase) &&
    alive(s).some((x) => x.id !== playerId && x.cash > 0);
  const canAccept = s.phase === 'loan' && playerId !== s.loanReq.borrower && p.cash >= s.loanReq.amount;
  const repayable = playerId === s.current && ['move', 'act'].includes(s.phase)
    ? s.loans.filter((l) => l.borrower === playerId).map((l) => ({
        loanId: l.id, lender: l.lender, principal: l.principal, due: loanDue(s, l),
        roundsLeft: Math.max(0, LOAN_DEADLINE_ROUNDS - (s.round - l.startRound)) }))
    : [];
  return { canRequest, canAccept, repayable };
}

export function repairCosts(s, playerId) { // цена ремонта по каждой машине игрока
  const out = {};
  for (const c of s.players[playerId].cars) { const x = repairCost(s, c); if (x != null) out[c.id] = x; }
  return out;
}

// ---------- таймеры ----------
// Ход: 30 с на выбор шагов, потом 60 с на решение (покупка/ремонт/гонка...).
// Аукцион: 15 с после каждой ставки. Окно гонки: 30 с. Займ: 15 с (вне таймера хода).
// timeoutStep — один шаг «по умолчанию»: на старте хода это 1 шаг вперёд; затем такси.
export function timeoutStep(s) {
  const who = actor(s);
  if (s.phase === 'act' && !s.players[s.current].cars.length) { const c = structuredClone(s); c.log = []; nextTurn(c); return { ok: true, state: c }; }
  const p = who == null ? null : s.players[who];
  const a = {
    loan: { type: 'loan_cancel' }, move: { type: 'move', steps: 1 },
    act: p && p.cars.length ? { type: 'taxi', carId: [...p.cars].sort((x, y) => s.catalog[y.id].sell - s.catalog[x.id].sell)[0].id } : null, // такси на самой дорогой машине
    buy: { type: 'decline' }, auction: { type: 'auction_close' }, repair: { type: 'repair', carIds: [] },
    race_setup: { type: 'race_open' }, race_join: { type: 'race_close' }, race_roll: { type: 'race_roll' }, race_reroll: { type: 'race_keep' },
  }[s.phase];
  return applyAction(s, { ...a, player: who });
}
// доиграть ход до конца за игрока по умолчанию (истекла минута на решение)
export function timeoutTurn(state) {
  let s = state;
  const startTurn = s.turn;
  for (let guard = 0; guard < 30 && s.phase !== 'over' && s.turn === startTurn; guard++) {
    const r = timeoutStep(s);
    if (!r.ok) return r;
    s = r.state;
  }
  return { ok: true, state: s };
}

// публичное состояние для клиентов: без порядка карт в колодах
export function publicView(s) {
  const v = structuredClone(s);
  v.deckCounts = Object.fromEntries(Object.entries(s.decks).map(([k, d]) => [k, d.length]));
  v.decks = undefined; v.defectDecks = undefined; v.defectTemplate = undefined; v.rng = undefined; v.forcedRolls = undefined;
  return v;
}
