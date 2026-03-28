# Server Setup — Kinova Bot

## VPS Ma'lumotlari
- **Provider**: OVH
- **IP**: `57.131.46.71`
- **OS**: Ubuntu 24.04
- **User**: `ubuntu`
- **Loyiha papkasi**: `~/qwerty`

## O'rnatilgan dasturlar
- **Node.js** 20.x (NodeSource repo orqali)
- **PM2** — process manager (`npm i -g pm2`)
- **PostgreSQL 16** — lokal DB (VPS da)
- **postgresql-client-17** — Neon dan dump olish uchun (bir marta ishlatildi)

## PostgreSQL konfiguratsiyasi
- **Database**: `kinovadb`
- **User**: `kinovabot`
- **Password**: `.env` da `DATABASE_URL` da
- **Connection**: `localhost:5432` (faqat lokal, tashqaridan yopiq)

```sql
-- Yaratish buyruqlari (setup-server.sh da ham bor)
CREATE USER kinovabot WITH PASSWORD 'parol';
CREATE DATABASE kinovadb OWNER kinovabot;
GRANT ALL PRIVILEGES ON DATABASE kinovadb TO kinovabot;
```

## Deploy jarayoni
GitHub Actions → SSH → VPS:
1. `git pull origin main`
2. `npm install --production`
3. `npm run build`
4. `pm2 restart kinova-bot`

**`.env` fayli VPS da qo'lda joylashtirilgan** — git da saqlanmaydi.

## PM2 buyruqlari
```bash
pm2 status                        # holatni ko'rish
pm2 logs kinova-bot --lines 50    # loglarni ko'rish
pm2 restart kinova-bot            # restart
pm2 stop kinova-bot               # to'xtatish
pm2 save                          # reboot da avtomatik ishga tushish
pm2 startup                       # sistemaga qo'shish
```

## Neon dan lokal PostgreSQL ga migratsiya (2026-03-29)
Avval Neon (serverless Postgres) ishlatilgan. Quyidagi sabablarga ko'ra VPS lokal PostgreSQL ga o'tildi:
- Neon ga ulanish ba'zi tarmoqlarda timeout beradi
- Lokal DB 50–150ms ga tezroq (localhost)
- Neon free tier cheklovlari (0.5 GB, 100 CU-hrs)

### Migratsiya qadamlari:
```bash
# 1. PostgreSQL o'rnatish
sudo apt update && sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql

# 2. DB va user yaratish
sudo -u postgres psql
# CREATE USER kinovabot WITH PASSWORD '...';
# CREATE DATABASE kinovadb OWNER kinovabot;
# GRANT ALL PRIVILEGES ON DATABASE kinovadb TO kinovabot;
# \q

# 3. postgresql-client-17 o'rnatish (Neon PG17 da)
sudo sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo tee /etc/apt/trusted.gpg.d/pgdg.asc > /dev/null
sudo apt update && sudo apt install -y postgresql-client-17

# 4. Neon dan dump olish
PGCONNECT_TIMEOUT=15 /usr/lib/postgresql/17/bin/pg_dump \
  "postgresql://neondb_owner:...@ep-...-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require" \
  --no-owner --no-acl -f /tmp/neon_backup.sql

# 5. Local DB ga import
psql -U kinovabot -d kinovadb -h localhost -f /tmp/neon_backup.sql

# 6. .env yangilash
sed -i 's|DATABASE_URL=.*|DATABASE_URL=postgresql://kinovabot:parol@localhost:5432/kinovadb|' .env
pm2 restart kinova-bot
```

## Nathan (developer) ulanishi
Nathan VPS PostgreSQL ga **SSH tunnel** orqali ulanadi:

```bash
# Nathan MacBook da (terminal ochiq tursin)
ssh -L 5433:localhost:5432 ubuntu@57.131.46.71 -N

# Nathan ning .env
DATABASE_URL=postgresql://kinovabot:KinovaBot2026!@localhost:5433/kinovadb
```

Nathan ning SSH public keyini `~/.ssh/authorized_keys` ga qo'shish kerak.

## DB Backup
```bash
# Qo'lda backup
scripts/backup-db.sh

# Avtomatik (cron — har kuni soat 03:00 da)
crontab -e
# 0 3 * * * /home/ubuntu/qwerty/scripts/backup-db.sh
```

## Yangi serverga ko'chirish
1. `scripts/setup-server.sh` ni yangi serverda ishga tushiring
2. Eski serverdan dump oling: `pg_dump -U kinovabot kinovadb > backup.sql`
3. Yangi serverga import qiling
4. `.env` faylini ko'chiring
5. GitHub Actions `deploy.yml` da IP ni yangilang
