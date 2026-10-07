#!/usr/bin/env bash
# ============================================================================
#  Дурак — деплой онлайн-сервера одной командой.
#  Кладёшь этот файл и durak-online.zip в одну папку на VPS, правишь 2 строки
#  ниже (ДОМЕН и ПОРТ), запускаешь под root:  bash deploy.sh
# ============================================================================
set -euo pipefail

# ─── домен и порт можно передать в команде:  DOMAIN=... PORT=... bash deploy.sh
#     либо оставить значения по умолчанию ниже ────────────────────────────────
DOMAIN="${DOMAIN:-durak05.ru}"   # субдомен: A-запись должна вести на этот сервер
PORT="${PORT:-8095}"                           # свободный порт для игры
# ────────────────────────────────────────────────────────────────────────────

APP_DIR="/opt/durak-online"
ZIP="durak-online.zip"

echo "==> 0/6 проверки"
[ "$(id -u)" = "0" ] || { echo "Запусти под root (sudo bash deploy.sh)"; exit 1; }
command -v node >/dev/null || { echo "Не найден node. Поставь Node.js 18+ и повтори."; exit 1; }
NODE_BIN="$(command -v node)"
command -v unzip >/dev/null || { echo "Ставлю unzip…"; apt-get update -y && apt-get install -y unzip; }

echo "==> 1/6 распаковка в $APP_DIR"
mkdir -p "$APP_DIR"
if [ -f "$ZIP" ]; then
  # архив распаковывается в папку durak-online/ — переносим содержимое в APP_DIR
  tmp="$(mktemp -d)"; unzip -oq "$ZIP" -d "$tmp"
  src="$tmp/durak-online"; [ -d "$src" ] || src="$tmp"
  cp -r "$src/." "$APP_DIR/"; rm -rf "$tmp"
elif [ -f "$APP_DIR/server.js" ]; then
  echo "    zip нет, но $APP_DIR/server.js уже на месте — использую его"
else
  echo "Нет ни $ZIP рядом, ни $APP_DIR/server.js. Залей durak-online.zip сюда."; exit 1
fi

echo "==> 2/6 зависимости (ws)"
cd "$APP_DIR"
npm install --omit=dev

echo "==> 3/6 systemd-сервис durak"
id www-data >/dev/null 2>&1 && RUN_USER="www-data" || RUN_USER="root"
cat >/etc/systemd/system/durak.service <<EOF
[Unit]
Description=Durak online
After=network.target

[Service]
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=2
User=$RUN_USER

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now durak
sleep 1
systemctl --no-pager --lines=3 status durak || true
echo "    health: $(curl -s "localhost:$PORT/health" || echo '(нет ответа)')"

echo "==> 4/6 nginx"
command -v nginx >/dev/null || { echo "Ставлю nginx…"; apt-get install -y nginx; }
cat >/etc/nginx/sites-available/durak.conf <<EOF
server {
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/durak.conf /etc/nginx/sites-enabled/durak.conf
nginx -t
systemctl reload nginx

echo "==> 5/6 сертификат Let's Encrypt (wss://)"
if command -v certbot >/dev/null; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || \
    echo "    certbot не завершился — запусти вручную: certbot --nginx -d $DOMAIN"
else
  echo "    certbot не установлен. Поставь: apt install -y certbot python3-certbot-nginx"
  echo "    затем: certbot --nginx -d $DOMAIN"
fi

echo "==> 6/6 готово"
echo "    Открой: https://$DOMAIN"
echo "    Логи:   journalctl -u durak -f"
echo "    Рестарт: systemctl restart durak"
