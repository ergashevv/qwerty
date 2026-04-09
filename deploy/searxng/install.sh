#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p config data

if [[ ! -f config/settings.yml ]]; then
  if ! command -v openssl >/dev/null; then
    echo "openssl kerak (secret_key uchun)."
    exit 1
  fi
  SECRET="$(openssl rand -hex 32)"
  cat > config/settings.yml << EOF
# Avtomatik yaratilgan. limiter: redis talab qiladi — ichki localhost uchun o'chiq.
use_default_settings: true

server:
  secret_key: "${SECRET}"
  limiter: false
  image_proxy: true

# Kinova \`format=json\` — yo'q bo'lsa SearXNG 403 qaytaradi
search:
  formats:
    - html
    - json
EOF
  chmod 600 config/settings.yml
  echo "✅ config/settings.yml yaratildi"
fi

# Eski konfigda JSON o'chiq bo'lsa 403 — bir marta qo'shamiz
if [[ -f config/settings.yml ]] && ! grep -qE '^\s*-\s*json\s*$' config/settings.yml; then
  cat >> config/settings.yml << 'EOF'

search:
  formats:
    - html
    - json
EOF
  echo "✅ search.formats: json qo'shildi (403 tuzatish)"
fi

if ! command -v docker >/dev/null; then
  echo "Docker yo'q. Ubuntu: curl -fsSL https://get.docker.com | sudo sh"
  echo "Keyin: sudo usermod -aG docker \$USER && newgrp docker"
  exit 1
fi

docker compose up -d
docker compose restart searxng 2>/dev/null || true
echo ""
echo "SearXNG tinglayapti: http://127.0.0.1:8080"
echo "Kinova ~/qwerty/.env ga qo'shing:"
echo "  SEARXNG_URL=http://127.0.0.1:8080"
echo "Keyin: cd ~/qwerty && pm2 restart kinova-bot"
echo ""
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:8080/search?q=cinematest&format=json" | head -c 50 | grep -q .; then
    echo "✅ JSON API javob berdi"
    exit 0
  fi
  sleep 2
done
echo "⚠️  Konteyner ishga tushdi, lekin API hali tayyor emas bo'lishi mumkin. 10-20 soniyadan keyin yuqoridagi curl ni qo'lda tekshiring."
