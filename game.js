'use strict';
// ============================================================================
//  Движок «Дурак» — авторитетная логика. Без сети, без DOM.
//  Режимы: подкидной ('podkidnoy') и переводной ('perevodnoy'). 2–6 игроков.
//  Вся случайность — через инъекцию rng, чтобы игры были воспроизводимы в тестах.
// ============================================================================

const SUITS = ['S', 'C', 'H', 'D'];
const GLYPH = { S: '♠', C: '♣', H: '♥', D: '♦' };
const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
const RLABEL = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'В',12:'Д',13:'К',14:'Т' };
// младший ранг для размера колоды: 24 → 9..Т, 36 → 6..Т, 52 → 2..Т
const DECK_LOW = { 24: 9, 36: 6, 52: 2 };
const HAND_SIZE = 6;

const cardId = c => c.s + c.r;

function ranksFor(deckSize) {
  const low = DECK_LOW[deckSize] || 6;
  const r = [];
  for (let v = low; v <= 14; v++) r.push(v);
  return r;
}
function makeDeck(deckSize) {
  const d = [];
  for (const s of SUITS) for (const r of ranksFor(deckSize)) d.push({ s, r });
  return d;
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- создание игры ----------------------------------------------------------
function createGame({ numPlayers, variant = 'podkidnoy', deck: deckSize = 36, cheat = false, throwMode = 'all', allowDraw = true, players = null, rng = Math.random }) {
  numPlayers = Math.max(2, Math.min(6, numPlayers | 0));
  if (!DECK_LOW[deckSize]) deckSize = 36;
  const deck = shuffle(makeDeck(deckSize), rng);
  const trumpCard = deck[0];               // низ колоды — открытый козырь, берётся последним
  const trump = trumpCard.s;
  const ps = [];
  for (let i = 0; i < numPlayers; i++) {
    ps.push({
      seat: i,
      name: (players && players[i] && players[i].name) || `Игрок ${i + 1}`,
      isBot: !!(players && players[i] && players[i].isBot),
      hand: [],
      out: false,
    });
  }
  // раздача с конца колоды (pop), по 6 карт (если колода мала — сколько есть)
  for (let k = 0; k < HAND_SIZE; k++)
    for (const p of ps) { if (deck.length) p.hand.push(deck.pop()); }

  const st = {
    variant, numPlayers, deckSize, cheat: !!cheat, throwMode: throwMode === 'sosedi' ? 'sosedi' : 'all', allowDraw: allowDraw !== false, firstOut: null, trump, trumpCard,
    deck,
    players: ps,
    table: [],              // [{a, d|null}]
    attacker: 0, defender: 1,
    taking: false,
    passed: [],             // места, «спасовавшие» в текущем окне подкидывания
    defenderStart: 0,
    discardCount: 0,
    livelock: 0,           // серия взятий без прогресса при пустой колоде — детектор ничьей
    phase: 'attack',        // attack | over
    result: null,           // {loser} | {draw:true}
    log: [],
  };
  for (const p of ps) sortHand(st, p);
  st.attacker = firstAttacker(st, rng);
  st.defender = nextAlive(st, st.attacker);
  st.defenderStart = st.players[st.defender].hand.length;
  return st;
}

function firstAttacker(st, rng) {
  let best = null, who = 0;
  for (const p of st.players)
    for (const c of p.hand)
      if (c.s === st.trump && (best === null || c.r < best)) { best = c.r; who = p.seat; }
  if (best === null) who = Math.floor(rng() * st.numPlayers); // козырей нет ни у кого
  return who;
}

// ---- утилиты ----------------------------------------------------------------
const isTrump = (st, c) => c.s === st.trump;
function beats(st, def, atk) {
  if (def.s === atk.s) return def.r > atk.r;
  if (isTrump(st, def) && !isTrump(st, atk)) return true;
  return false;
}
function sortHand(st, p) {
  p.hand.sort((a, b) =>
    (isTrump(st, a) - isTrump(st, b)) || (a.r - b.r) || (SUITS.indexOf(a.s) - SUITS.indexOf(b.s)));
}
const aliveCount = st => st.players.filter(p => !p.out).length;
function nextAlive(st, seat) {
  for (let i = 1; i <= st.numPlayers; i++) {
    const s = (seat + i) % st.numPlayers;
    if (!st.players[s].out) return s;
  }
  return seat;
}
const undefended = st => st.table.find(p => p.d === null) || null;
const tableRanks = st => {
  const s = new Set();
  for (const p of st.table) { s.add(p.a.r); if (p.d) s.add(p.d.r); }
  return s;
};
const maxAttacks = st => Math.min(6, st.defenderStart);

function prevAlive(st, seat) {
  for (let i = 1; i <= st.numPlayers; i++) {
    const s = (seat - i + st.numPlayers) % st.numPlayers;
    if (!st.players[s].out) return s;
  }
  return seat;
}
// подкидывать могут: 'all' — все кроме защитника; 'sosedi' — только два соседа защитника
function throwers(st) {
  const list = [];
  if (st.throwMode === 'sosedi') {
    const prev = prevAlive(st, st.defender), next = nextAlive(st, st.defender);
    for (const s of [prev, next])
      if (s !== st.defender && !st.players[s].out && !list.includes(s)) list.push(s);
    return list;
  }
  let s = st.attacker;
  for (let i = 0; i < st.numPlayers; i++) {
    if (s !== st.defender && !st.players[s].out) list.push(s);
    s = (s + 1) % st.numPlayers;
  }
  return list;
}
function canThrowRank(st, seat, r) {
  if (st.table.length === 0) return false;
  if (st.table.length >= maxAttacks(st)) return false;
  return tableRanks(st).has(r);
}
function handHasThrow(st, seat) {
  if (!canThrowRank(st, seat, 6)) { /* быстрый выход по лимиту */ }
  if (st.table.length >= maxAttacks(st)) return false;
  const ranks = tableRanks(st);
  return st.players[seat].hand.some(c => ranks.has(c.r));
}

// перевод возможен, если ни одна карта ещё не побита и все атаки одного достоинства
function canTransfer(st, seat) {
  if (st.variant !== 'perevodnoy') return false;
  if (seat !== st.defender) return false;
  if (st.table.length === 0) return false;
  if (st.table.some(p => p.d !== null)) return false;      // уже начал биться
  const r = st.table[0].a.r;
  if (st.table.some(p => p.a.r !== r)) return false;        // разные достоинства
  const target = nextAlive(st, st.defender);
  if (target === st.attacker) return false;                 // некому переводить (2 игрока по кругу)
  // у цели должно быть карт не меньше, чем станет атак после перевода
  if (st.players[target].hand.length < st.table.length + 1) return false;
  return st.players[seat].hand.some(c => c.r === r);
}
function transferCards(st, seat) {
  if (!canTransfer(st, seat)) return [];
  const r = st.table[0].a.r;
  return st.players[seat].hand.filter(c => c.r === r);
}

// ---- чей ход / что законно ---------------------------------------------------
// turnSeat: чьё действие ожидается (для UI и ботов)
function turnSeat(st) {
  if (st.phase === 'over') return -1;
  if (st.taking) return firstOpenThrower(st);
  if (undefended(st)) return st.defender;
  if (st.table.length === 0) return st.attacker;
  return firstOpenThrower(st);          // окно подкидывания (реинфорс)
}
// первый по очереди подкидывающий, который ещё не спасовал и может действовать
function firstOpenThrower(st) {
  for (const s of throwers(st)) {
    if (st.passed.includes(s)) continue;
    return s;
  }
  return -1; // все спасовали
}

function legalFor(st, seat) {
  const out = { playable: [], canTake: false, canPass: false, transfer: [], status: '' };
  if (st.phase === 'over' || st.players[seat] && st.players[seat].out) return out;
  const turn = turnSeat(st);

  if (st.taking) {
    if (seat === st.defender) { out.status = 'Вы берёте карты'; return out; }
    if (seat === turn) {
      const ranks = tableRanks(st);
      if (st.table.length < maxAttacks(st))
        out.playable = st.cheat ? st.players[seat].hand.map(cardId)
          : st.players[seat].hand.filter(c => ranks.has(c.r)).map(cardId);
      out.canPass = true;
      out.status = 'Соперник берёт — можно подкинуть';
    } else out.status = 'Ждём подкидывание';
    return out;
  }

  const ud = undefended(st);
  if (ud) {
    if (seat === st.defender) {
      out.playable = st.cheat ? st.players[seat].hand.map(cardId)
        : st.players[seat].hand.filter(c => beats(st, c, ud.a)).map(cardId);
      out.transfer = transferCards(st, seat).map(cardId);
      out.canTake = true;
      out.status = st.cheat ? 'Защищайтесь (можно схитрить)' : 'Защищайтесь';
    } else out.status = 'Ходит защищающийся';
    return out;
  }

  if (st.table.length === 0) {
    if (seat === st.attacker) { out.playable = st.players[seat].hand.map(cardId); out.status = 'Атакуйте'; }
    else out.status = 'Ходит атакующий';
    return out;
  }

  // окно подкидывания
  if (seat === turn) {
    const ranks = tableRanks(st);
    if (st.table.length < maxAttacks(st))
      out.playable = st.cheat ? st.players[seat].hand.map(cardId)
        : st.players[seat].hand.filter(c => ranks.has(c.r)).map(cardId);
    out.canPass = true;
    out.status = seat === st.attacker ? 'Подкиньте или «Бито»' : 'Подкиньте или «Пас»';
  } else out.status = 'Ждём подкидывание';
  return out;
}

// ---- применение действий -----------------------------------------------------
// action: {kind:'attack'|'defend'|'transfer'|'take'|'pass', card?:'S6'}
function applyAction(st, seat, action) {
  if (st.phase === 'over') return err('Игра окончена');
  const turn = turnSeat(st);
  const findCard = id => st.players[seat].hand.find(c => cardId(c) === id);
  const events = [];

  switch (action.kind) {
    case 'attack': {
      if (st.taking) {
        // подкидывание при взятии
        if (seat !== turn) return err('Не ваш ход');
        const c = findCard(action.card);
        if (!c) return err('Нет такой карты');
        if (st.table.length >= maxAttacks(st)) return err('Стол заполнен');
        const legal = tableRanks(st).has(c.r);
        if (!legal && !st.cheat) return err('Нельзя подкинуть эту карту');
        place(st, seat, c, !legal); st.passed = []; events.push(ev('throw', seat, c));
        return ok(st, events);
      }
      if (undefended(st)) return err('Сначала должен ответить защищающийся');
      if (st.table.length === 0) {
        if (seat !== st.attacker) return err('Атакует другой игрок');
        const c = findCard(action.card);
        if (!c) return err('Нет такой карты');
        place(st, seat, c); events.push(ev('attack', seat, c));
        return ok(st, events);
      }
      // реинфорс
      if (seat !== turn) return err('Не ваш ход для подкидывания');
      const c = findCard(action.card);
      if (!c) return err('Нет такой карты');
      if (st.table.length >= maxAttacks(st)) return err('Стол заполнен');
      const legal = tableRanks(st).has(c.r);
      if (!legal && !st.cheat) return err('Нельзя подкинуть эту карту');
      place(st, seat, c, !legal); st.passed = []; events.push(ev('throw', seat, c));
      return ok(st, events);
    }

    case 'defend': {
      if (seat !== st.defender) return err('Защищается другой игрок');
      const ud = undefended(st);
      if (!ud) return err('Нечего бить');
      const c = findCard(action.card);
      if (!c) return err('Нет такой карты');
      const legal = beats(st, c, ud.a);
      if (!legal && !st.cheat) return err('Эта карта не бьёт');
      ud.d = c; ud.byD = seat; if (!legal) ud.cheatD = seat;
      st.players[seat].hand = st.players[seat].hand.filter(x => x !== c);
      events.push(ev('defend', seat, c));
      if (!undefended(st)) st.passed = [];
      return ok(st, events);
    }

    case 'transfer': {
      if (!canTransfer(st, seat)) return err('Перевод невозможен');
      const c = findCard(action.card);
      if (!c || c.r !== st.table[0].a.r) return err('Перевести можно картой того же достоинства');
      place(st, seat, c);                 // добавляется как атака
      events.push(ev('transfer', seat, c));
      // сдвигаем роли: бывший защитник становится атакующим, следующий — защитником
      const oldDef = st.defender;
      st.attacker = oldDef;
      st.defender = nextAlive(st, oldDef);
      st.defenderStart = st.players[st.defender].hand.length;
      st.passed = [];
      return ok(st, events);
    }

    case 'take': {
      if (seat !== st.defender) return err('Берёт защищающийся');
      if (!undefended(st) && st.table.length === 0) return err('Нечего брать');
      st.taking = true; st.passed = [];
      events.push(ev('take-begin', seat));
      return ok(st, events);
    }

    case 'pass': {
      // «Бито» (атакующий) или «Пас» (подкидывающий); закрывает окно
      if (st.taking) {
        if (seat === st.defender) return err('Вы берёте');
        if (!st.passed.includes(seat)) st.passed.push(seat);
        events.push(ev('pass', seat));
        maybeResolveWindow(st, events);
        return ok(st, events);
      }
      if (undefended(st)) return err('Пас недоступен: есть непокрытая карта');
      if (st.table.length === 0) return err('Пас недоступен: стол пуст');
      if (!st.passed.includes(seat)) st.passed.push(seat);
      events.push(ev('pass', seat));
      maybeResolveWindow(st, events);
      return ok(st, events);
    }

    case 'catch': {
      if (!st.cheat) return err('Ловить можно только в режиме «с шулерами»');
      const i = action.i | 0, which = action.which === 'd' ? 'd' : 'a';
      const pair = st.table[i];
      if (!pair) return err('Нет такой карты');
      const card = which === 'd' ? pair.d : pair.a;
      if (!card) return err('Нет карты');
      const flag = which === 'd' ? pair.cheatD : pair.cheatA;
      if (flag === seat) return err('Это ваша карта');
      if (flag !== undefined) {           // поймал шулера → шулер забирает стол
        events.push(ev('caught', flag));
        clearCheatFlags(st); penaltyTake(st, flag, events);
      } else {                            // ложное обвинение → обвинитель забирает стол
        events.push(ev('falseCatch', seat));
        clearCheatFlags(st); penaltyTake(st, seat, events);
      }
      return ok(st, events);
    }

    default: return err('Неизвестное действие');
  }
}

// забирает весь стол «штрафник» (пойманный шулер или ложный обвинитель)
function penaltyTake(st, loser, events) {
  const lp = st.players[loser];
  for (const p of st.table) { lp.hand.push(p.a); if (p.d) lp.hand.push(p.d); }
  sortHand(st, lp);
  st.table = [];
  replenish(st, st.attacker);
  st.attacker = nextAlive(st, loser);
  st.defender = nextAlive(st, st.attacker);
  st.defenderStart = st.players[st.defender].hand.length;
  st.taking = false; st.passed = [];
  if (st.deck.length === 0) st.livelock++; else st.livelock = 0;
  checkEnd(st, events);
}

function place(st, seat, c, cheated) {
  st.players[seat].hand = st.players[seat].hand.filter(x => x !== c);
  const pair = { a: c, d: null, byA: seat };
  if (cheated) pair.cheatA = seat;
  st.table.push(pair);
}
function clearCheatFlags(st) {
  for (const p of st.table) { delete p.cheatA; delete p.cheatD; }
}

// авто-пас тех, кто не может/не хочет подкидывать, и разрешение окна
function maybeResolveWindow(st, events) {
  // авто-пас подкидывающих без легальных карт
  for (const s of throwers(st)) {
    if (!st.passed.includes(s) && !handHasThrow(st, s)) st.passed.push(s);
  }
  const allPassed = throwers(st).every(s => st.passed.includes(s));
  if (!allPassed) return;

  if (st.taking) finalizeTake(st, events);
  else finalizeBeaten(st, events);
}

function finalizeBeaten(st, events) {
  // всё побито → в отбой
  st.discardCount += st.table.reduce((n, p) => n + 1 + (p.d ? 1 : 0), 0);
  st.table = [];
  const oldAtt = st.attacker, oldDef = st.defender;
  replenish(st, oldAtt);
  events.push(ev('bito', oldDef));
  // защитник становится следующим атакующим
  st.attacker = st.players[oldDef].out ? nextAlive(st, oldDef) : oldDef;
  st.defender = nextAlive(st, st.attacker);
  st.defenderStart = st.players[st.defender].hand.length;
  st.taking = false; st.passed = [];
  st.livelock = 0;               // «бито» = прогресс
  checkEnd(st, events);
}

function finalizeTake(st, events) {
  const def = st.players[st.defender];
  for (const p of st.table) { def.hand.push(p.a); if (p.d) def.hand.push(p.d); }
  sortHand(st, def);
  st.table = [];
  const oldAtt = st.attacker, oldDef = st.defender;
  replenish(st, oldAtt);
  events.push(ev('take', oldDef));
  // защитник взял → пропускает ход: атакующим становится следующий за защитником
  st.attacker = nextAlive(st, oldDef);
  st.defender = nextAlive(st, st.attacker);
  st.defenderStart = st.players[st.defender].hand.length;
  st.taking = false; st.passed = [];
  if (st.deck.length === 0) st.livelock++; else st.livelock = 0;
  checkEnd(st, events);
}

// добор карт: атакующий, далее по кругу, защитник последним
function replenish(st, attackerSeat) {
  const order = [];
  let s = attackerSeat;
  for (let i = 0; i < st.numPlayers; i++) {
    if (s !== st.defender) order.push(s);
    s = (s + 1) % st.numPlayers;
  }
  order.push(st.defender);
  for (const seat of order) {
    const p = st.players[seat];
    while (p.hand.length < HAND_SIZE && st.deck.length) p.hand.push(st.deck.pop());
    sortHand(st, p);
  }
}

function checkEnd(st, events) {
  // выбывает тот, у кого нет карт и колода пуста
  if (st.deck.length === 0) {
    for (const p of st.players)
      if (!p.out && p.hand.length === 0) { p.out = true; st.livelock = 0; if (st.firstOut === null) st.firstOut = p.seat; events.push(ev('out', p.seat)); }
  }
  const alive = st.players.filter(p => !p.out);
  if (alive.length <= 1) {
    st.phase = 'over';
    if (alive.length === 1) st.result = { loser: alive[0].seat, winner: st.firstOut };
    else st.result = st.allowDraw ? { draw: true } : { loser: st.defender, winner: st.firstOut };
    events.push(ev('over'));
    return;
  }
  // ливлок: пустая колода + длинная серия взятий без «бито» и без выбывших → ничья
  if (st.deck.length === 0 && st.livelock >= 3 * st.numPlayers) {
    st.phase = 'over';
    st.result = { draw: true };
    events.push(ev('over'));
    return;
  }
  // если после выбывания текущий атакующий/защитник вышел — пересчёт ролей
  if (st.players[st.attacker].out) st.attacker = nextAlive(st, st.attacker);
  if (st.players[st.defender].out || st.defender === st.attacker)
    st.defender = nextAlive(st, st.attacker);
  st.defenderStart = st.players[st.defender].hand.length;
}

// ---- бот --------------------------------------------------------------------
function botAction(st, seat) {
  const hand = st.players[seat].hand;
  const R = Math.random;
  const lowFirst = arr => [...arr].sort((a,b)=>((isTrump(st,a)?a.r+100:a.r)-(isTrump(st,b)?b.r+100:b.r)));

  // ловля шулера (в любой свой ход)
  if (st.cheat) {
    for (let i = 0; i < st.table.length; i++) {
      const p = st.table[i];
      if (p.cheatA !== undefined && p.cheatA !== seat && R() < 0.55) return { kind:'catch', i, which:'a' };
      if (p.cheatD !== undefined && p.cheatD !== seat && R() < 0.55) return { kind:'catch', i, which:'d' };
    }
  }

  const ud = undefended(st);

  // защита
  if (ud && seat === st.defender && !st.taking) {
    const beatsList = hand.filter(c => beats(st, c, ud.a));
    const tr = transferCards(st, seat);
    if (tr.length) {
      const cheapNonTrump = beatsList.filter(c => !isTrump(st, c));
      if (cheapNonTrump.length === 0) return { kind:'transfer', card: cardId([...tr].sort((a,b)=>a.r-b.r)[0]) };
    }
    if (beatsList.length) {
      const c = beatsList.sort((a,b)=>(isTrump(st,a)-isTrump(st,b))||(a.r-b.r))[0];
      return { kind:'defend', card: cardId(c) };
    }
    if (st.cheat && R() < 0.35) return { kind:'defend', card: cardId(lowFirst(hand)[0]) }; // схитрить
    return { kind:'take' };
  }

  // атака (стол пуст)
  if (!ud && !st.taking && st.table.length === 0 && seat === st.attacker) {
    return { kind:'attack', card: cardId(lowFirst(hand)[0]) };
  }

  // окно подкидывания / взятие
  if (!ud && (st.table.length > 0 || st.taking) && st.table.length < maxAttacks(st)) {
    const ranks = tableRanks(st);
    const legalThrow = hand.filter(c => ranks.has(c.r) && !isTrump(st,c) && c.r <= 10).sort((a,b)=>a.r-b.r);
    if (legalThrow.length) return { kind:'attack', card: cardId(legalThrow[0]) };
    if (st.cheat && R() < 0.12) {
      const low = hand.filter(c => !isTrump(st,c) && c.r <= 9).sort((a,b)=>a.r-b.r)[0];
      if (low) return { kind:'attack', card: cardId(low) };
    }
  }

  const L = legalFor(st, seat);
  if (L.canPass) return { kind:'pass' };
  if (L.canTake) return { kind:'take' };
  return { kind:'pass' };
}

// ---- сериализация вида для места seat ---------------------------------------
function viewFor(st, seat) {
  const turn = turnSeat(st);
  return {
    you: seat,
    variant: st.variant,
    numPlayers: st.numPlayers,
    deckSize: st.deckSize,
    cheat: !!st.cheat,
    trump: st.trump, trumpGlyph: GLYPH[st.trump],
    trumpCard: st.deck.length ? st.trumpCard : null,
    deckCount: st.deck.length,
    discardCount: st.discardCount,
    turnSeat: turn,
    taking: st.taking,
    attacker: st.attacker, defender: st.defender,
    players: st.players.map(p => ({
      seat: p.seat, name: p.name, isBot: p.isBot, out: p.out,
      handCount: p.hand.length,
      isAttacker: p.seat === st.attacker, isDefender: p.seat === st.defender,
    })),
    hand: st.players[seat] ? st.players[seat].hand.map(c => ({ id: cardId(c), s: c.s, r: c.r, glyph: GLYPH[c.s], label: RLABEL[c.r] })) : [],
    table: st.table.map(p => ({
      a: { id: cardId(p.a), s: p.a.s, r: p.a.r, glyph: GLYPH[p.a.s], label: RLABEL[p.a.r], by: p.byA },
      d: p.d ? { id: cardId(p.d), s: p.d.s, r: p.d.r, glyph: GLYPH[p.d.s], label: RLABEL[p.d.r], by: p.byD } : null,
    })),
    legal: legalFor(st, seat),
    over: st.phase === 'over' ? st.result : null,
  };
}

// ---- вспомогательные обёртки результата -------------------------------------
function ok(st, events) { return { ok: true, state: st, events }; }
function err(msg) { return { ok: false, error: msg }; }
function ev(type, seat, card) { return { type, seat, card: card ? cardId(card) : undefined }; }

// подсчёт всех карт (для тестов на сохранность колоды)
function totalCards(st) {
  let n = st.deck.length + st.discardCount;
  for (const p of st.players) n += p.hand.length;
  for (const t of st.table) n += 1 + (t.d ? 1 : 0);
  return n;
}

module.exports = {
  SUITS, GLYPH, RANKS, RLABEL, HAND_SIZE, cardId,
  createGame, applyAction, botAction, legalFor, viewFor, turnSeat,
  totalCards, isTrump, beats,
};
