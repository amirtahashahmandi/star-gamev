# Starsia Game v1.6
Cloudflare Workers + Durable Object + Telegram WebApp + Telegram Stars.
Includes:
- Crash with Dual Bet (Bet A & Bet B) + optional Crash Shield (15% fee, 50% refund if crashed < 1.15x)
- Balanced crash multiplier curve with natural low multipliers, frequent mid multipliers, and occasional high peaks
- Live Crash players list showing both cashout multiplier and total won stars (+X.XX ⭐)
- Clear non-frosted glass UI with smooth animated motion
- Arena with animated winner wheel/spinner & bonus budget pool
- Win Streak & Daily/Live Missions funded from house rake/tax pool
- Direct user support messages forwarded to Admin in Telegram bot
- Withdrawal with optional TON address fallback & Admin approval choice (Stars vs TON)
- Zero initial balance (0) for all new users
- Admin bulk coin adjustment (add to all / subtract from all users)
Secrets required in Cloudflare: BOT_TOKEN, ADMIN_ID, BOT_USERNAME, WEBHOOK_SECRET.
After deploy, open https://YOUR-WORKER-URL/setup/WEBHOOK_SECRET once.
