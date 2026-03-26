#!/usr/bin/env bash
# macOS: Reels uchun yt-dlp (yt-dlp_macos) + ffmpeg (evermeet static, brew talab qilmaydi).

set -euo pipefail

BIN_DIR="${HOME}/bin"
mkdir -p "$BIN_DIR"

YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
echo "→ yt-dlp_macos yuklanmoqda → $BIN_DIR/yt-dlp"
curl -fsSL "$YTDLP_URL" -o "$BIN_DIR/yt-dlp"
chmod +x "$BIN_DIR/yt-dlp"
xattr -cr "$BIN_DIR/yt-dlp" 2>/dev/null || true

if ! file "$BIN_DIR/yt-dlp" | grep -q "Mach-O"; then
  echo "Xato: kutilgan Mach-O binary emas."
  exit 1
fi

echo "→ yt-dlp:"
"$BIN_DIR/yt-dlp" --version

if ! command -v ffmpeg >/dev/null 2>&1 && [[ ! -x "$BIN_DIR/ffmpeg" ]]; then
  echo ""
  echo "→ ffmpeg yuklanmoqda (evermeet static) → $BIN_DIR/ffmpeg"
  TMPZIP="$(mktemp /tmp/ffmpeg-evermeet-XXXXXX.zip)"
  # API: https://evermeet.cx/ffmpeg/ — curl uchun -fJL tavsiya etiladi
  curl -fSL "https://evermeet.cx/ffmpeg/getrelease/zip" -o "$TMPZIP"
  unzip -o "$TMPZIP" -d "$BIN_DIR"
  rm -f "$TMPZIP"
  chmod +x "$BIN_DIR/ffmpeg"
  xattr -cr "$BIN_DIR/ffmpeg" 2>/dev/null || true
fi

export PATH="$BIN_DIR:$PATH"
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Xato: ffmpeg baribir topilmadi."
  exit 1
fi

echo "→ ffmpeg: $(command -v ffmpeg)"
ffmpeg -version | head -1

echo ""
echo "Tayyor. PATH da ~/bin bo‘lsin (~/.zshrc):"
echo '  export PATH="$HOME/bin:$PATH"'
