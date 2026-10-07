'use strict';
// ============================================================================
//  Онлайн-сервер «Дурак» — WebSocket + раздача статики.
//  Лобби: приватные комнаты по коду и быстрый матчмейкинг. 2–6 игроков.
//  Режимы: подкидной / переводной. Пустые места добиваются ботами.
//  Зависимости: ws  (npm i)
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./game.js');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const BOT_STEP_MS = 750;         // пауза между ходами ботов
const QUICK_COUNTDOWN_MS = 12000;// автостарт быстрой игры

// ---- HTTP: отдаём клиента ----------------------------------------------------
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url.split('?')[0]) || '/');
  if (url === '/') url = '/index.html';
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- состояние сервера -------------------------------------------------------
const rooms = new Map();     // code -> room
const clients = new Map();   // clientId -> { ws, roomCode, seat }

// ---- счёт игроков (баланс денег), сохраняется в accounts.json --------------
const ACC_FILE = path.join(__dirname, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')); } catch { accounts = {}; }
let accDirty = false;
function getAcc(id) {
  if (!accounts[id]) { accounts[id] = { money: 100000, wins: 0, games: 0 }; accDirty = true; }
  return accounts[id];
}
function saveAccounts() {
  if (!accDirty) return; accDirty = false;
  try { fs.writeFileSync(ACC_FILE, JSON.stringify(accounts)); } catch (e) { /* не критично */ }
}
setInterval(saveAccounts, 10000);

const rnd = n => Math.floor(Math.random() * n);
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = Array.from({length:4},()=>A[rnd(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ---- утилиты отправки --------------------------------------------------------
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function err(ws, msg) { send(ws, { t: 'error', msg }); }

// ---- модель комнаты ----------------------------------------------------------
function newRoom({ hostId, config, isPublic, password }) {
  const code = genCode();
  const room = {
    code, config: normConfig(config), hostId, isPublic: !!isPublic,
    password: password ? String(password).slice(0, 8) : '',
    phase: 'lobby', seats: [], game: null, botTimer: null, countdown: null,
  };
  rooms.set(code, room);
  return room;
}
function normConfig(c) {
  c = c || {};
  const variant = c.variant === 'perevodnoy' ? 'perevodnoy' : 'podkidnoy';
  let maxPlayers = c.maxPlayers | 0; if (maxPlayers < 2) maxPlayers = 2; if (maxPlayers > 6) maxPlayers = 6;
  let deck = c.deck | 0; if (![24, 36, 52].includes(deck)) deck = 36;
  // косметические поля (пока не влияют на движок, идут в отображение): bet, speed, modes
  const bet = Math.max(0, c.bet | 0);
  const speed = c.speed === 'fast' ? 'fast' : 'normal';
  const modes = Array.isArray(c.modes) ? c.modes.slice(0, 8) : [];
  return { variant, maxPlayers, deck, bet, speed, modes };
}
function seatOf(room, clientId) { return room.seats.findIndex(s => s && s.id === clientId); }
function humanCount(room) { return room.seats.filter(s => s && !s.isBot).length; }

const BACK_IDS = ['green', 'blue', 'red', 'gzhel', 'gold', 'ornament'];
function addSeat(room, { id, name, isBot, ws, back, avatar }) {
  if (room.seats.length >= room.config.maxPlayers) return -1;
  const seat = room.seats.length;
  room.seats.push({
    id, name: name || `Игрок ${seat + 1}`, isBot: !!isBot, ws: ws || null, connected: !isBot,
    back: back || (isBot ? BACK_IDS[Math.floor(Math.random() * BACK_IDS.length)] : 'green'),
    avatar: avatar || '',
  });
  return seat;
}
// карта аватаров по местам → всем в комнате (отдельно от игрового состояния)
function broadcastAvatars(room) {
  const map = {};
  for (let i = 0; i < room.seats.length; i++) { const s = room.seats[i]; if (s && s.avatar) map[i] = s.avatar; }
  for (const s of room.seats) if (s && !s.isBot && s.ws) send(s.ws, { t: 'avatars', avatars: map });
}

function lobbyView(room, forId) {
  return {
    t: 'lobby',
    room: {
      code: room.code, phase: room.phase, config: room.config, isPublic: room.isPublic,
      hasPassword: !!room.password,
      host: room.hostId,
      you: forId,
      countdown: room.countdown ? Math.max(0, Math.round((room.countdown.at - Date.now()) / 1000)) : null,
      players: room.seats.map(s => ({ seat: room.seats.indexOf(s), name: s.name, isBot: s.isBot, connected: s.connected })),
      canStart: room.seats.length >= 2,
    },
  };
}
function broadcastLobby(room) {
  for (const s of room.seats) if (s && !s.isBot && s.ws) send(s.ws, lobbyView(room, s.id));
}

// ---- запуск и ведение партии -------------------------------------------------
function startGame(room, { fillBots }) {
  if (room.phase === 'playing') return;
  if (fillBots) {
    while (room.seats.length < room.config.maxPlayers)
      addSeat(room, { id: 'bot_' + genId(), name: botName(room), isBot: true });
  }
  if (room.seats.length < 2) return err(room.seats[0] && room.seats[0].ws, 'Нужно минимум 2 участника');
  if (room.countdown) { clearTimeout(room.countdown.timer); room.countdown = null; }

  const players = room.seats.map(s => ({ name: s.name, isBot: s.isBot }));
  room.game = G.createGame({
    numPlayers: room.seats.length, variant: room.config.variant, deck: room.config.deck,
    cheat: room.config.modes.includes('sh'),
    throwMode: room.config.modes.includes('sosedi') ? 'sosedi' : 'all',
    allowDraw: !room.config.modes.includes('classic'),
    players,
  });
  room.phase = 'playing'; room.settled = false;
  room.isPublic = false; // больше не набираем через матчмейкинг
  broadcastState(room);
  broadcastAvatars(room);
  pumpBots(room);
}

const BOT_NAMES = ['Ботагоз','Арсен','Тимур','Рустам','Мага','Заур','Алан','Ислам'];
function botName(room) {
  const used = new Set(room.seats.map(s => s.name));
  return BOT_NAMES.find(n => !used.has(n)) || ('Бот ' + (room.seats.length + 1));
}

function seatDrivenByBot(room, seat) {
  const s = room.seats[seat];
  return !s || s.isBot || !s.connected; // отключившегося игрока временно ведёт бот
}

function broadcastState(room) {
  if (!room.game) return;
  for (let seat = 0; seat < room.seats.length; seat++) {
    const s = room.seats[seat];
    if (s && !s.isBot && s.ws && s.connected) {
      const v = G.viewFor(room.game, seat);
      for (const p of v.players) p.back = (room.seats[p.seat] && room.seats[p.seat].back) || 'green';
      send(s.ws, { t: 'state', view: v });
    }
  }
}
function sendAccount(id, ws) {
  const a = getAcc(id);
  send(ws, { t: 'account', money: a.money, wins: a.wins, games: a.games });
}
// рассылка «Поймал!/Мимо!» по событиям движка
function broadcastFlash(room, events) {
  if (!events) return;
  for (const e of events) {
    let kind = null;
    if (e.type === 'caught') kind = 'caught';
    else if (e.type === 'falseCatch') kind = 'false';
    if (!kind) continue;
    for (const s of room.seats) if (s && !s.isBot && s.ws) send(s.ws, { t: 'flash', kind, seat: e.seat });
  }
}
// расчёт ставок по окончании партии (один раз)
function settleGame(room) {
  if (!room.game || room.game.phase !== 'over' || room.settled) return;
  room.settled = true;
  const res = room.game.result || {};
  const bet = room.config.bet | 0;
  for (let seat = 0; seat < room.seats.length; seat++) {
    const s = room.seats[seat];
    if (!s || s.isBot) continue;
    const a = getAcc(s.id); a.games++;
    if (!res.draw && bet > 0) {
      if (res.loser === seat) a.money -= bet;
      else if (res.winner === seat) { a.money += bet; a.wins++; }
    }
    accDirty = true;
    if (s.ws) sendAccount(s.id, s.ws);
  }
  saveAccounts();
}

function pumpBots(room) {
  if (room.botTimer) return;
  const step = () => {
    room.botTimer = null;
    if (!room.game || room.game.phase === 'over') return;
    const turn = G.turnSeat(room.game);
    if (turn < 0) return;
    if (!seatDrivenByBot(room, turn)) return;         // ждём живого игрока
    const action = G.botAction(room.game, turn);
    const res = G.applyAction(room.game, turn, action);
    if (res.ok) {
      room.game = res.state; broadcastState(room); broadcastFlash(room, res.events);
      if (room.game.phase === 'over') settleGame(room);
    }
    if (room.game.phase !== 'over') { room.botTimer = setTimeout(step, BOT_STEP_MS); }
  };
  // первый шаг с паузой, только если сейчас ходит бот
  const turn = G.turnSeat(room.game);
  if (turn >= 0 && seatDrivenByBot(room, turn)) room.botTimer = setTimeout(step, BOT_STEP_MS);
}

function handleAction(room, seat, action) {
  if (!room.game || room.game.phase === 'over') return;
  const turn = G.turnSeat(room.game);
  if (action.kind !== 'catch' && turn !== seat) { // ловить шулера можно вне очереди
    return { ok: false, error: 'Сейчас не ваш ход' };
  }
  const res = G.applyAction(room.game, seat, action);
  if (res.ok) {
    room.game = res.state; broadcastState(room); broadcastFlash(room, res.events);
    if (room.game.phase === 'over') settleGame(room);
    pumpBots(room);
  }
  return res;
}

// ---- матчмейкинг -------------------------------------------------------------
function findPublicRoom(config) {
  config = normConfig(config);
  for (const room of rooms.values()) {
    if (room.isPublic && room.phase === 'lobby'
      && room.config.variant === config.variant
      && room.config.maxPlayers === config.maxPlayers
      && room.seats.length < room.config.maxPlayers) return room;
  }
  return null;
}
function armQuickCountdown(room) {
  if (room.countdown) return;
  const at = Date.now() + QUICK_COUNTDOWN_MS;
  const timer = setTimeout(() => { room.countdown = null; startGame(room, { fillBots: true }); }, QUICK_COUNTDOWN_MS);
  room.countdown = { at, timer };
  broadcastLobby(room);
}

// ---- жизненный цикл клиента --------------------------------------------------
function detach(clientId) {
  const c = clients.get(clientId);
  if (!c) return;
  const room = rooms.get(c.roomCode);
  if (room) {
    const seat = seatOf(room, clientId);
    if (seat >= 0) {
      if (room.phase === 'playing') {
        // в игре — помечаем отключённым, ход ведёт бот; сессию сохраняем для реконнекта
        room.seats[seat].connected = false;
        room.seats[seat].ws = null;
        pumpBots(room);
        return;
      }
      // в лобби — убираем место
      room.seats.splice(seat, 1);
      if (room.seats.length === 0 || room.hostId === clientId) {
        const nextHost = room.seats.find(s => !s.isBot);
        if (!nextHost) { closeRoom(room); }
        else { room.hostId = nextHost.id; broadcastLobby(room); }
      } else broadcastLobby(room);
    }
  }
  clients.delete(clientId);
}
function closeRoom(room) {
  if (room.botTimer) clearTimeout(room.botTimer);
  if (room.countdown) clearTimeout(room.countdown.timer);
  for (const s of room.seats) if (s && !s.isBot && s.ws) send(s.ws, { t: 'ended' });
  rooms.delete(room.code);
}

// ---- WebSocket ---------------------------------------------------------------
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.clientId = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    const T = m.t;

    if (T === 'hello') {
      // восстановление сессии или новый клиент
      let id = m.id && clients.has(m.id) ? m.id : (m.id || genId());
      ws.clientId = id;
      const existing = clients.get(id);
      if (existing) { existing.ws = ws; } else clients.set(id, { ws, roomCode: null, seat: -1 });
      send(ws, { t: 'welcome', id });
      sendAccount(id, ws);
      // реконнект в активную комнату
      const c = clients.get(id);
      const room = c.roomCode && rooms.get(c.roomCode);
      if (room) {
        const seat = seatOf(room, id);
        if (seat >= 0 && room.seats[seat]) {
          room.seats[seat].connected = true; room.seats[seat].ws = ws;
          if (room.phase === 'playing' && room.game) send(ws, { t: 'state', view: G.viewFor(room.game, seat) });
          else send(ws, lobbyView(room, id));
        }
      }
      return;
    }

    const id = ws.clientId;
    if (!id) return err(ws, 'Нет сессии');
    const c = clients.get(id) || (clients.set(id, { ws, roomCode: null, seat: -1 }), clients.get(id));

    if (T === 'list') {
      // список игр в лобби для вкладок «Открытые» / «Приватные»
      const open = [], priv = [];
      for (const room of rooms.values()) {
        if (room.phase !== 'lobby') continue;
        if (room.seats.length >= room.config.maxPlayers) continue;
        const item = {
          code: room.code, players: room.seats.length, max: room.config.maxPlayers,
          variant: room.config.variant, deck: room.config.deck, bet: room.config.bet,
          modes: room.config.modes, hasPassword: !!room.password,
        };
        if (room.password) priv.push(item); else if (room.isPublic) open.push(item);
      }
      send(ws, { t: 'games', open, private: priv });
      return;
    }

    if (T === 'create') {
      leaveCurrent(id);
      // open:true — открытая игра (в списке «Открытые»); иначе приватная (пароль)
      const isOpen = m.open !== false && !m.password;
      const room = newRoom({ hostId: id, config: m.config, isPublic: isOpen, password: m.password });
      const seat = addSeat(room, { id, name: m.name, ws, back: c.back, avatar: c.avatar });
      c.roomCode = room.code; c.seat = seat;
      broadcastLobby(room);
      return;
    }

    if (T === 'join') {
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return err(ws, 'Комната не найдена');
      if (room.phase !== 'lobby') return err(ws, 'Игра уже идёт');
      if (room.seats.length >= room.config.maxPlayers) return err(ws, 'Комната заполнена');
      if (room.password && String(m.password || '') !== room.password) return err(ws, 'Неверный пароль');
      leaveCurrent(id);
      const seat = addSeat(room, { id, name: m.name, ws, back: c.back, avatar: c.avatar });
      c.roomCode = room.code; c.seat = seat;
      broadcastLobby(room);
      return;
    }

    if (T === 'quick') {
      leaveCurrent(id);
      let room = findPublicRoom(m.config);
      if (!room) { room = newRoom({ hostId: id, config: m.config, isPublic: true }); }
      const seat = addSeat(room, { id, name: m.name, ws, back: c.back, avatar: c.avatar });
      c.roomCode = room.code; c.seat = seat;
      armQuickCountdown(room);
      broadcastLobby(room);
      if (room.seats.length >= room.config.maxPlayers) startGame(room, { fillBots: false });
      return;
    }

    // всё дальнейшее — в контексте комнаты
    const room = rooms.get(c.roomCode);
    if (!room) return;
    const seat = seatOf(room, id);

    if (T === 'setConfig') {
      if (room.hostId !== id || room.phase !== 'lobby') return;
      room.config = normConfig(m.config);
      // обрежем лишние места, если maxPlayers уменьшили
      while (room.seats.length > room.config.maxPlayers) {
        const rem = room.seats.pop();
        if (rem && !rem.isBot) err(rem.ws, 'Место убрано: уменьшен размер стола');
      }
      broadcastLobby(room);
      return;
    }
    if (T === 'addBot') {
      if (room.hostId !== id || room.phase !== 'lobby') return;
      if (room.seats.length >= room.config.maxPlayers) return err(ws, 'Стол заполнен');
      addSeat(room, { id: 'bot_' + genId(), name: botName(room), isBot: true });
      broadcastLobby(room);
      return;
    }
    if (T === 'removeBot') {
      if (room.hostId !== id || room.phase !== 'lobby') return;
      const i = m.seat | 0;
      if (room.seats[i] && room.seats[i].isBot) { room.seats.splice(i, 1); broadcastLobby(room); }
      return;
    }
    if (T === 'start') {
      if (room.hostId !== id || room.phase !== 'lobby') return;
      startGame(room, { fillBots: false });
      return;
    }
    if (T === 'action') {
      if (seat < 0) return;
      const res = handleAction(room, seat, m.action);
      if (!res || !res.ok) err(ws, (res && res.error) || 'Недопустимый ход');
      return;
    }
    if (T === 'rematch') {
      if (room.phase !== 'playing' || !room.game || room.game.phase !== 'over') return;
      if (room.hostId !== id) return;
      // убрать «отключённых» ботозаменённых? оставим как есть, перезапустим с теми же местами
      room.phase = 'lobby'; room.game = null;
      // ботов оставляем, живых — тоже; сразу стартуем
      startGame(room, { fillBots: false });
      return;
    }
    if (T === 'chat') {
      if (seat < 0) return;
      const text = String(m.text || '').slice(0, 200).trim();
      if (!text) return;
      const now = Date.now();
      if (ws._lastChat && now - ws._lastChat < 400) return; // анти-флуд
      ws._lastChat = now;
      const name = room.seats[seat] ? room.seats[seat].name : 'Игрок';
      for (const s of room.seats) if (s && !s.isBot && s.ws) send(s.ws, { t: 'chat', seat, from: name, text });
      return;
    }

    if (T === 'skin') {
      const back = BACK_IDS.includes(m.back) ? m.back : 'green';
      c.back = back;
      if (typeof m.avatar === 'string' && m.avatar.length < 40000) c.avatar = m.avatar;
      if (seat >= 0 && room.seats[seat]) { room.seats[seat].back = back; if (c.avatar != null) room.seats[seat].avatar = c.avatar; }
      if (room.phase === 'playing') { broadcastState(room); broadcastAvatars(room); } else broadcastLobby(room);
      return;
    }

    if (T === 'emoji') {
      if (seat < 0) return;
      const e = String(m.e || '').slice(0, 8);
      if (!e) return;
      for (const s of room.seats) if (s && !s.isBot && s.ws) send(s.ws, { t: 'emoji', seat, e });
      return;
    }

    if (T === 'leave') { leaveCurrent(id); send(ws, { t: 'left' }); return; }
  });

  ws.on('close', () => { if (ws.clientId) detach(ws.clientId); });
  ws.on('error', () => {});
});

function leaveCurrent(id) {
  const c = clients.get(id);
  if (!c || !c.roomCode) return;
  const room = rooms.get(c.roomCode);
  c2:{ if (!room) break c2;
    const seat = seatOf(room, id);
    if (seat >= 0) {
      if (room.phase === 'lobby') {
        room.seats.splice(seat, 1);
        if (room.hostId === id) {
          const nh = room.seats.find(s => !s.isBot);
          if (!nh) closeRoom(room); else { room.hostId = nh.id; broadcastLobby(room); }
        } else broadcastLobby(room);
      } else {
        room.seats[seat].connected = false; room.seats[seat].ws = null; pumpBots(room);
      }
    }
  }
  c.roomCode = null; c.seat = -1;
}

// heartbeat — отключаем мёртвые сокеты
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 30000);

// периодическая уборка пустых/мёртвых комнат
setInterval(() => {
  for (const room of rooms.values()) {
    const humans = humanCount(room);
    if (room.phase === 'lobby' && humans === 0) closeRoom(room);
    if (room.phase === 'playing' && humans === 0) closeRoom(room); // все ушли — закрыть
  }
}, 60000);

server.listen(PORT, () => console.log(`Дурак-сервер слушает :${PORT}`));
