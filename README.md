# Дурак онлайн

Онлайн-«Дурак» на Node.js + WebSocket. Один процесс: авторитетный игровой движок,
WS-сервер и раздача веб-клиента.

- **2–6 игроков** (размер стола выбирается в лобби)
- **Оба режима:** подкидной и переводной
- **Приватные комнаты по коду** и **быстрый матчмейкинг** (автостарт, добор ботами)
- Пустые места и отключившихся игроков временно ведут боты — партия не зависает
- Реконнект по сохранённому `id` (localStorage) — можно вернуться в идущую партию

## Структура

```
durak-online/
├── game.js            # чистый движок правил (без сети/DOM) — вся логика и колода
├── server.js          # WebSocket-сервер + лобби/комнаты/матчмейкинг + HTTP-статика
├── public/index.html  # веб-клиент (лобби + игровой стол)
├── package.json
└── README.md
```

Движок **авторитетный**: все карты и ходы живут на сервере, клиент получает только
свой «вид» (свою руку + количество карт соперников). Читерство через клиент невозможно.

## Локальный запуск

```bash
npm install
npm start           # PORT=8080 по умолчанию
# открыть http://localhost:8080
```

Переменные окружения: `PORT` (порт HTTP+WS, по умолчанию 8080).

## Деплой на VPS (systemd + nginx + WSS)

Клиент подключается к WebSocket по тому же origin, что и страница
(`wss://…` при HTTPS). Достаточно обычного reverse-proxy с апгрейдом соединения.

### 1. Код и зависимости

```bash
mkdir -p /opt/durak && cd /opt/durak
# скопировать сюда game.js, server.js, public/, package.json
npm install --omit=dev
```

### 2. systemd-сервис `/etc/systemd/system/durak.service`

```ini
[Unit]
Description=Durak online
After=network.target

[Service]
WorkingDirectory=/opt/durak
Environment=PORT=8090
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now durak
systemctl status durak
```

### 3. nginx (домен + Let's Encrypt + апгрейд WebSocket)

```nginx
server {
    server_name durak.example.com;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # апгрейд до WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;                    # долгие WS-сессии
    }
    # listen 443 ssl; + сертификаты добавит certbot
}
```

```bash
certbot --nginx -d durak.example.com
```

Всё — открываем `https://durak.example.com`. Страница сама поднимет `wss://` к тому же хосту.

### Заметки под твою инфраструктуру
- Ставится рядом с остальными Node-приложениями на любом из VPS (Hetzner «Боты»
  138.199.215.54, DagChat 193.233.221.167 и т.п.) — процесс лёгкий, состояние в памяти,
  БД не нужна.
- Если несколько сервисов за одним nginx — просто отдельный `server{}`-блок и свой порт в `PORT`.
- Масштабирование: сейчас комнаты хранятся в памяти одного процесса. Для нескольких
  инстансов за балансировщиком нужен «липкий» роутинг по комнате или вынос состояния
  во внешний стор (Redis) — по желанию, на старте не требуется.

## Протокол (кратко)

Клиент → сервер: `hello{id}`, `create{name,config}`, `join{code,name}`,
`quick{name,config}`, `setConfig`, `addBot`, `removeBot{seat}`, `start`,
`action{action}`, `rematch`, `leave`.

Сервер → клиент: `welcome{id}`, `lobby{room}`, `state{view}`, `error{msg}`,
`left`, `ended`.

`config = { variant: "podkidnoy"|"perevodnoy", maxPlayers: 2..6 }`
`action = { kind: "attack"|"defend"|"transfer"|"take"|"pass", card?: "S6" }`

## Тонкости правил (реализовано)

- Козырь — нижняя карта колоды, берётся последней.
- Подкидывание: до 6 карт на столе и не больше числа карт защитника на начало отбоя;
  подкидывают все, кроме защитника.
- Перевод (переводной): только пока ни одна карта не побита, все атаки одного
  достоинства, у цели хватает карт.
- Добор: атакующий, далее по кругу, защитник — последним.
- Взял — пропускает ход; отбился — становится следующим атакующим.
- Выбывает оставшийся без карт при пустой колоде; последний с картами — «дурак».
- Защита от вечного цикла в редком безкозырном эндшпиле — авто-ничья.

## Сайт: играть + скачать приложения

- Игра открывается сразу на главной: `https://durak05.ru/`
- Страница загрузок: `https://durak05.ru/download.html` (кнопки «Играть», «Windows», «Android»).
  В меню игры (Профиль → «Скачать») есть кнопка на эту страницу.
- Положи собранные файлы в `public/downloads/`:
  - `durak-setup.exe` — из проекта durak-desktop (GitHub Actions)
  - `durak.apk` — из проекта durak-android (GitHub Actions)

## Авто-деплой на durak05.ru (push → сразу на домене)

Чтобы каждый пуш в Git сам обновлял игру на сервере:

**Один раз на сервере** (вместо zip — через git, чтобы работал `git pull`):
```bash
cd /opt
git clone <адрес-репозитория> durak-online
cd durak-online
bash deploy.sh            # поднимет systemd + nginx + сертификат на durak05.ru
```

**Один раз в GitHub** → Settings → Secrets and variables → Actions → New secret:
- `DEPLOY_HOST` — IP или durak05.ru
- `DEPLOY_USER` — root (или твой пользователь)
- `DEPLOY_KEY`  — приватный SSH-ключ, чей публичный лежит в `~/.ssh/authorized_keys` на сервере
- `DEPLOY_PORT` — 22 (если нестандартный)

После этого: любой **push** → вкладка **Actions** → workflow **Deploy to durak05.ru** сам
зайдёт на сервер, сделает `git pull`, `npm install` и перезапустит сервис. Сайт
`https://durak05.ru` обновится автоматически. Ручной запуск — **Run workflow**.

Android/десктоп пересобирать не нужно — они открывают сайт, обновление видят сразу.
