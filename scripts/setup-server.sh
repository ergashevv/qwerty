#!/bin/bash
# Kinova Bot — yangi VPS sozlash skripti
# Ishlatish: bash scripts/setup-server.sh
set -e

echo "=== 1. Tizim yangilash ==="
sudo apt update && sudo apt upgrade -y

echo "=== 2. Node.js 20 o'rnatish ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo "=== 3. PM2 o'rnatish ==="
sudo npm install -g pm2

echo "=== 4. PostgreSQL 16 o'rnatish ==="
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql

echo "=== 5. PostgreSQL user va DB yaratish ==="
read -s -p "kinovabot uchun parol kiriting: " DB_PASS
echo

sudo -u postgres psql <<SQL
CREATE USER kinovabot WITH PASSWORD '${DB_PASS}';
CREATE DATABASE kinovadb OWNER kinovabot;
GRANT ALL PRIVILEGES ON DATABASE kinovadb TO kinovabot;
SQL

echo "=== 6. PM2 startup sozlash ==="
pm2 startup | tail -1 | bash

echo ""
echo "✅ Server sozlash tugadi!"
echo ""
echo "Keyingi qadamlar:"
echo "  1. git clone <repo> ~/qwerty"
echo "  2. cd ~/qwerty && npm install --production"
echo "  3. .env faylini yarating (DATABASE_URL=postgresql://kinovabot:PAROL@localhost:5432/kinovadb)"
echo "  4. npm run build"
echo "  5. pm2 start dist/bot.js --name kinova-bot"
echo "  6. pm2 save"
