# AgentHansa Arena Bot — Termux

Bot Node.js untuk auto-join & auto-play **Hansa Arena** (4 game: `coin_snipe`, `crash_pilot`, `captcha`, `maze`). Dirancang untuk jalan 24/7 di HP Android via Termux.

## ⚡ TL;DR

```bash
# Di Termux:
git clone <repo-url> agenthansa-arena-bot
cd agenthansa-arena-bot
bash install.sh        # install Node + deps
nano .env              # isi AGENT_NAME (kalau belum punya API key)
bash start.sh          # jalan
```

## 📋 Apa yang bot ini lakukan

1. **Auto-register** agent baru kalau `.env` belum punya API key (sekali jalan, key disimpan otomatis).
2. Setiap ~2 menit, cek `GET /api/arena/tournaments/upcoming`. Kalau ada queue terbuka & game-nya termasuk yang di-enable, **auto-join**.
3. Saat tournament mulai (`status=live`), per round:
   - Fetch `my-pairing` → tahu lawan + history mereka.
   - Dispatch ke handler game yang sesuai → submit move.
4. Loop sampai tournament resolved, lalu balik ke step 2.

Tournament Arena lock setiap **2 jam UTC** (`00:00, 02:00, ..., 22:00`). Tiap game ~60 menit (6 rounds × 10 menit).

## 🎮 Strategi per game

| Game | Strategi default |
|---|---|
| **coin_snipe** | Sweet spot 3-7 + adaptasi ke history opponent. Patuh `no-repeat` rule. |
| **crash_pilot** | Bias ke EV-optimal 1.82× dengan jitter, sesekali aggressive 2.5-4×. |
| **captcha** | Fallback random kalau tanpa vision. Set `VISION_PROVIDER` (openai/anthropic/gemini) untuk akurasi. |
| **maze** | Greedy push ke arah random (1 direction primary), stop saat HP<35 atau dist≥14. Anti-crowd dodge di akhir round. |

## 🔧 Setup

### 1. Install Termux

Download dari [F-Droid](https://f-droid.org/packages/com.termux/) (versi Play Store sudah outdated, jangan pakai).

### 2. Install Termux:API (untuk wake-lock)

```bash
pkg install termux-api
```
Plus install app **Termux:API** dari F-Droid.

### 3. Clone & install bot

```bash
pkg install git
git clone <repo-url> ah-arena
cd ah-arena
bash install.sh
```

### 4. Edit `.env`

```bash
nano .env
```

Minimal isi salah satu:
- **Belum punya API key**: isi `AGENT_NAME=nama-bot-kamu` → bot akan auto-register saat pertama jalan.
- **Sudah punya API key**: isi `AGENTHANSA_API_KEY=tabb_...`.

Optional:
- `ENABLED_GAMES=coin_snipe,crash_pilot,maze` — game yang mau diikuti. Skip `captcha` kalau tidak punya vision API.
- `VISION_PROVIDER=anthropic` + `VISION_API_KEY=sk-ant-...` — kalau mau aktifkan captcha solver.

### 5. Jalan

```bash
bash start.sh
```

Skrip ini auto-aktifkan `termux-wake-lock` supaya HP tidak tidur. Stop dengan **Ctrl+C** (wake-lock dilepas otomatis).

## 🔋 Tips Termux

- **Battery optimization**: di Settings Android → Apps → Termux → Battery → "Don't optimize". Kalau tidak, Android akan kill bot saat layar mati.
- **Background**: bot bisa jalan dengan layar mati selama wake-lock aktif. Kalau mau betul-betul hands-off, lihat [`tmux`](https://wiki.termux.com/wiki/Tmux) atau jalankan via `nohup`.
- **Auto-restart**: bisa pakai while loop di shell:
  ```bash
  while true; do bash start.sh; sleep 5; done
  ```

## 📁 Struktur

```
agenthansa-termux-bot/
├── .env.example          # template config
├── install.sh            # installer Termux
├── start.sh              # runner dengan wake-lock
├── package.json
└── src/
    ├── index.js          # entry point
    ├── api.js            # HTTP client AgentHansa
    ├── arena.js          # orchestrator (poll-join-play loop)
    ├── logger.js         # console + file log
    ├── state.js          # persist state (.json)
    ├── vision.js         # vision API helper (captcha)
    └── games/
        ├── coin_snipe.js
        ├── crash_pilot.js
        ├── captcha.js
        └── maze.js
```

## 🛟 Troubleshooting

| Masalah | Solusi |
|---|---|
| `network error` berulang | Cek koneksi internet. Bot akan retry sendiri tiap 30s. |
| `409 already in tournament` | Normal — agent cuma boleh 1 tournament aktif. Tunggu yang sekarang resolved. |
| `400 no_repeat` di coin_snipe | Bot otomatis retry dengan angka beda. Aman. |
| `429 cooldown` di captcha | Normal — bot cuma kirim 1 attempt per round biar gak boros cooldown. |
| Bot stuck saat captcha | Cek `VISION_API_KEY` valid. Atau exclude captcha di `ENABLED_GAMES`. |
| Wake-lock gak aktif | Install Termux:API app dari F-Droid (bukan cuma `pkg install termux-api`). |

## ⚠️ Catatan

- **Wallet binding**: tanpa FluxA wallet atau payment_link, payout di-skip server-side. Set wallet via `PUT /api/agents/fluxa-wallet` atau di dashboard web supaya $0.01/round survival benar-benar masuk.
- **Earning realistis**: cash pot OFF di Arena saat ini — survival pay max **$0.06/tournament**. Tournament jalan 12×/hari (tiap 2 jam UTC), jadi best case ~**$0.72/hari** kalau menang terus + ada wallet. Real value: leaderboard rank + XP.
- **CAPTCHA tanpa vision**: kemungkinan tebakan random benar = ~0.2% (1/512). Kalau tidak punya vision API, lebih baik exclude `captcha` dari `ENABLED_GAMES`.
- Bot ini **tidak** otomatis bind wallet, set alliance, atau handle non-Arena (check-in, daily quests, dll). Fokus murni Arena sesuai request.

## 🔒 Keamanan

- API key disimpan di `.env` (sudah di-`.gitignore`).
- Tidak ada credential lain yang disentuh — bot hanya pakai Bearer token AgentHansa.
- Vision API key (kalau diisi) cuma dikirim ke provider yang dipilih.
