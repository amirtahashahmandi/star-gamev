// Starsia on Cloudflare Workers + Durable Object (free plan).
const DAY = 24 * 3600 * 1000;
const GROWTH = 0.09, BET_MS = 7000, CRASHED_MS = 4000;
const LEVELS = [0, 50, 150, 400, 900, 1800, 3500, 7000, 14000, 30000];
const ARENA_TIERS = [10, 50, 200], FEE = 0.05, ARENA_WAIT = 20000;
const WHEEL = [{ v: 1, w: 12 }, { v: 2, w: 42 }, { v: 4, w: 36 }, { v: 8, w: 7 }, { v: 10, w: 3 }];
const SHIELD_RATE = 0.15, SHIELD_MAX_MULT = 1.45, SHIELD_REFUND = 0.50;
const STREAK_MILESTONE = 3, STREAK_REWARD = 1.5;

const levelOf = xp => { let l = 0; LEVELS.forEach((t, i) => { if (xp >= t) l = i + 1; }); return l; };
const r2 = n => Math.round(n * 100) / 100;
const JSONH = { 'content-type': 'application/json' };
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: JSONH });

async function validateInitData(init, token) {
  if (!token || !init) return null;
  const p = new URLSearchParams(init);
  const hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(token));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k2, enc.encode(str));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/tg/') || url.pathname.startsWith('/setup/')) {
      return env.GAME.get(env.GAME.idFromName('main')).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

export class Game {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.ready = state.blockConcurrencyWhile(() => this.load());
  }
  async load() {
    const s = this.state.storage;
    this.meta = (await s.get('meta')) || {
      settings: { minMult: 1.0, maxMult: 50, edge: 0.05, greed: 0.58, queue: [], startCoins: 0 },
      promoPool: 25,
      history: [],
      crash: null,
      arenas: null,
      withdrawals: []
    };
    if (this.meta.settings.startCoins === undefined) this.meta.settings.startCoins = 0;
    if (this.meta.settings.greed === undefined) this.meta.settings.greed = 0.58;
    if (typeof this.meta.promoPool !== 'number' || !isFinite(this.meta.promoPool)) this.meta.promoPool = 25;
    if (!Array.isArray(this.meta.withdrawals)) this.meta.withdrawals = [];
    if (!this.meta.crash) this.meta.crash = { phase: 'bet', id: 1, betEnd: Date.now() + BET_MS, startAt: 0, crashAt: 0, endAt: 0, bets: {} };
    if (!this.meta.arenas) {
      this.meta.arenas = {};
      ARENA_TIERS.forEach(t => this.meta.arenas[t] = { entry: t, players: [], endAt: 0, last: null });
    }
    this.users = {};
    const all = await s.list({ prefix: 'u:' });
    for (const [k, v] of all) {
      const u = v;
      if (!Array.isArray(u.txs)) u.txs = [];
      if (!Array.isArray(u.gameLogs)) u.gameLogs = [];
      if (!u.refBy) u.refBy = '';
      if (!u.refCount) u.refCount = 0;
      if (!u.refEarned) u.refEarned = 0;
      if (!u.streak) u.streak = 0;
      if (!u.bestStreak) u.bestStreak = 0;
      if (!u.missions) u.missions = { dayKey: '', crash2x: 0, arenaPlays: 0, claimedCrash2x: false, claimedArena: false };
      this.users[k.slice(2)] = u;
    }
    this.dU = new Set(); this.dM = false;
  }
  touch(u) { this.dU.add(u.id); }
  saveMeta() { this.dM = true; }
  async flush() {
    const e = {};
    for (const id of this.dU) e['u:' + id] = this.users[id];
    if (this.dM) e.meta = this.meta;
    this.dU.clear(); this.dM = false;
    const keys = Object.keys(e);
    for (let i = 0; i < keys.length; i += 100) {
      const part = {};
      keys.slice(i, i + 100).forEach(k => part[k] = e[k]);
      await this.state.storage.put(part);
    }
  }

  dayKey(ts = Date.now()) {
    return new Date(ts).toISOString().slice(0, 10);
  }
  ensureMissions(u) {
    const dk = this.dayKey();
    if (!u.missions || u.missions.dayKey !== dk) {
      u.missions = { dayKey: dk, crash2x: 0, arenaPlays: 0, claimedCrash2x: false, claimedArena: false };
      this.touch(u);
    }
  }
  fundPromoPool(amount) {
    const add = r2(Math.max(0, amount));
    if (add > 0) {
      this.meta.promoPool = r2((this.meta.promoPool || 0) + add);
      this.saveMeta();
    }
  }
  payoutFromPool(u, requestedAmount, note) {
    const want = r2(Math.max(0, requestedAmount));
    if (want <= 0) return 0;
    const available = r2(Math.max(0, this.meta.promoPool || 0));
    const granted = r2(Math.min(want, available));
    if (granted <= 0) return 0;
    this.meta.promoPool = r2(available - granted);
    u.coins = r2(u.coins + granted);
    u.won = r2(u.won + granted);
    this.addTx(u, 'deposit', granted, note + (granted < want ? ' (سهمیه بودجه بونوس)' : ''));
    this.touch(u);
    this.saveMeta();
    return granted;
  }

  addTx(u, type, amount, note, status = 'completed') {
    if (!Array.isArray(u.txs)) u.txs = [];
    u.txs.unshift({
      id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type, amount: r2(amount), note, status, at: Date.now()
    });
    u.txs = u.txs.slice(0, 60);
    this.touch(u);
  }
  addGameLog(u, game, detail, delta) {
    if (!Array.isArray(u.gameLogs)) u.gameLogs = [];
    u.gameLogs.unshift({
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      game, detail, delta: r2(delta), at: Date.now()
    });
    u.gameLogs = u.gameLogs.slice(0, 60);
    this.touch(u);
  }
  rewardReferrer(user, baseAmount, pct, reason) {
    if (!user || !user.refBy) return;
    const inviter = this.users[user.refBy];
    if (!inviter || inviter.id === user.id) return;
    const bonus = r2(baseAmount * pct);
    if (bonus <= 0) return;
    inviter.coins = r2(inviter.coins + bonus);
    inviter.refEarned = r2((inviter.refEarned || 0) + bonus);
    this.addTx(inviter, 'deposit', bonus, `${reason} (${user.name})`);
    this.touch(inviter);
  }
  findUserByQuery(q) {
    const clean = String(q || '').trim().replace(/^@/, '').toLowerCase();
    if (!clean) return null;
    if (this.users[clean]) return this.users[clean];
    for (const u of Object.values(this.users)) {
      if (u.id === clean) return u;
      if (u.username && u.username.toLowerCase() === clean) return u;
    }
    return null;
  }

  getUser(tg, refParam = '') {
    const id = String(tg.id);
    let u = this.users[id];
    const isNew = !u;
    if (!u) {
      const startCoins = r2(Math.max(0, Number(this.meta.settings.startCoins ?? 0)));
      u = this.users[id] = {
        id, coins: startCoins, xp: 0, wagered: 0, won: 0, wins: 0,
        games: 0, bestMult: 0, lastWheel: 0, lastTag: 0, banned: false, created: Date.now(),
        name: '', username: '', photo: '', txs: [], gameLogs: [],
        refBy: '', refCount: 0, refEarned: 0, streak: 0, bestStreak: 0,
        missions: { dayKey: this.dayKey(), crash2x: 0, arenaPlays: 0, claimedCrash2x: false, claimedArena: false }
      };
      if (startCoins > 0) {
        this.addTx(u, 'deposit', startCoins, 'موجودی اولیه Starsia');
      }
      this.touch(u);
    }
    this.ensureMissions(u);
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || id;
    const uname = tg.username || '';
    if (u.name !== name || u.username !== uname || (tg.photo_url && u.photo !== tg.photo_url)) {
      u.name = name; u.username = uname; u.photo = tg.photo_url || u.photo || '';
      this.touch(u);
    }
    if (isNew && refParam) {
      const cleanRef = String(refParam).replace(/^ref_/, '').trim();
      if (cleanRef && cleanRef !== id && this.users[cleanRef] && !u.refBy) {
        u.refBy = cleanRef;
        this.users[cleanRef].refCount = (this.users[cleanRef].refCount || 0) + 1;
        this.touch(this.users[cleanRef]);
        this.touch(u);
      }
    }
    return u;
  }
  pub(u) {
    this.ensureMissions(u);
    return {
      id: u.id, name: u.name, username: u.username, photo: u.photo,
      coins: r2(u.coins), xp: u.xp, level: levelOf(u.xp),
      wagered: r2(u.wagered), won: r2(u.won), wins: u.wins, games: u.games, bestMult: u.bestMult,
      streak: u.streak || 0, bestStreak: u.bestStreak || 0,
      missions: u.missions,
      promoPool: r2(this.meta.promoPool || 0),
      wheelIn: Math.max(0, u.lastWheel + DAY - Date.now()),
      tagIn: Math.max(0, u.lastTag + DAY - Date.now()),
      isAdmin: u.id === String(this.env.ADMIN_ID),
      refCount: u.refCount || 0,
      refEarned: r2(u.refEarned || 0),
      txs: (u.txs || []).slice(0, 30),
      gameLogs: (u.gameLogs || []).slice(0, 30),
      withdrawals: this.meta.withdrawals.filter(w => w.uid === u.id).slice(0, 20)
    };
  }
  addXp(u, a) { u.xp += Math.max(1, Math.floor(a)); }
  async tg(method, body) {
    if (!this.env.BOT_TOKEN) return null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
        method: 'POST', headers: JSONH, body: JSON.stringify(body)
      });
      return (await r.json()).result;
    } catch { return null; }
  }

  nextCrashPoint() {
    const s = this.meta.settings;
    if (s.queue.length) { const v = s.queue.shift(); this.saveMeta(); return v; }
    const greed = Math.max(0, Math.min(1, Number(s.greed ?? 0.58)));
    const edge = Math.max(0.01, Math.min(0.35, Number(s.edge ?? 0.05)));
    const r = Math.random();
    let m;
    if (r < greed * 0.36) {
      m = 1.7 + Math.pow(Math.random(), 1.45) * 4.2;
    } else if (r < greed * 0.44) {
      m = 6.0 + Math.pow(Math.random(), 2.2) * 18.0;
    } else {
      const base = Math.max(0.0001, 1 - Math.random());
      m = (1 - edge) / base;
    }
    m = Math.min(Math.max(m, Number(s.minMult) || 1), Number(s.maxMult) || 50);
    return Math.max(1, r2(m));
  }

  recordWinStreak(u) {
    u.streak = (u.streak || 0) + 1;
    u.bestStreak = Math.max(u.bestStreak || 0, u.streak);
    if (u.streak > 0 && u.streak % STREAK_MILESTONE === 0) {
      const reward = this.payoutFromPool(u, STREAK_REWARD, `جایزه برد متوالی (${u.streak} برد پیاپی)`);
      if (reward > 0) {
        this.addXp(u, 8);
        this.addGameLog(u, 'streak', `زنجیره ${u.streak} برد متوالی`, reward);
      }
    }
    this.touch(u);
  }
  resetStreak(u) {
    if (u.streak) {
      u.streak = 0;
      this.touch(u);
    }
  }

  settleCrashSlot(u, slot, mult, slotLabel) {
    slot.cashed = r2(mult);
    const win = r2(slot.amount * mult);
    const profit = r2(win - slot.amount);
    u.coins = r2(u.coins + win);
    u.won = r2(u.won + win);
    u.wins += 1;
    u.bestMult = Math.max(u.bestMult, slot.cashed);
    this.ensureMissions(u);
    if (slot.cashed >= 2.0 && u.missions.crash2x < 3) {
      u.missions.crash2x += 1;
    }
    this.recordWinStreak(u);
    this.addXp(u, slot.amount * 0.45 + 2);
    this.addGameLog(u, 'crash', `برد ${slotLabel} در ضریب ${slot.cashed}x (شرط ${slot.amount})`, profit);
    this.addTx(u, 'deposit', win, `برد کرش (${slotLabel}) در ضریب ${slot.cashed}x`);
    this.touch(u);
  }

  settleCrashLossSlot(u, slot, crashAt, slotLabel) {
    slot.lost = true;
    const shieldFee = r2(slot.shieldFee || 0);
    let refund = 0;
    if (slot.shield && crashAt < SHIELD_MAX_MULT) {
      refund = r2(slot.amount * SHIELD_REFUND);
      u.coins = r2(u.coins + refund);
      this.addTx(u, 'deposit', refund, `بازگشت ۵۰٪ شرط با سپر ضد انفجار (انفجار در ${crashAt}x)`);
    }
    this.resetStreak(u);
    const netDelta = r2(-(slot.amount + shieldFee) + refund);
    this.addGameLog(u, 'crash', `انفجار در ${crashAt}x (${slotLabel}, شرط ${slot.amount}${slot.shield ? ' + سپر' : ''})`, netDelta);
    this.touch(u);
  }

  crashMult(now) { const c = this.meta.crash; return Math.exp(GROWTH * Math.max(0, now - c.startAt) / 1000); }

  advance() {
    const now = Date.now(), c = this.meta.crash;
    for (let i = 0; i < 6; i++) {
      if (c.phase === 'bet' && now >= c.betEnd) {
        if (!Object.keys(c.bets).length && now - c.betEnd > 15000) {
          c.betEnd = now + BET_MS; this.saveMeta(); break;
        }
        c.crashAt = this.nextCrashPoint();
        c.phase = 'run';
        c.startAt = Math.max(c.betEnd, now - 60000);
        this.saveMeta(); continue;
      }
      if (c.phase === 'run') {
        const t = c.startAt + Math.log(c.crashAt) / GROWTH * 1000;
        if (now >= t) {
          for (const [uid, entry] of Object.entries(c.bets)) {
            const u = this.users[uid];
            for (const key of ['a', 'b']) {
              const slot = entry[key];
              if (!slot) continue;
              const label = key === 'a' ? 'شرط ۱' : 'شرط ۲';
              if (!slot.cashed && slot.auto && slot.auto <= c.crashAt) {
                if (u) this.settleCrashSlot(u, slot, slot.auto, label);
              } else if (!slot.cashed && !slot.lost) {
                if (u) this.settleCrashLossSlot(u, slot, c.crashAt, label);
                else slot.lost = true;
              }
            }
          }
          this.meta.history.unshift(c.crashAt);
          this.meta.history = this.meta.history.slice(0, 30);
          c.phase = 'crashed'; c.endAt = t;
          this.saveMeta(); continue;
        }
        const m = this.crashMult(now);
        for (const [uid, entry] of Object.entries(c.bets)) {
          const u = this.users[uid];
          if (!u) continue;
          for (const key of ['a', 'b']) {
            const slot = entry[key];
            if (!slot) continue;
            const label = key === 'a' ? 'شرط ۱' : 'شرط ۲';
            if (!slot.cashed && !slot.lost && slot.auto && m >= slot.auto && slot.auto <= c.crashAt) {
              this.settleCrashSlot(u, slot, slot.auto, label);
              this.saveMeta();
            }
          }
        }
        break;
      }
      if (c.phase === 'crashed' && now >= c.endAt + CRASHED_MS) {
        c.id++; c.phase = 'bet';
        c.betEnd = Math.max(c.endAt + CRASHED_MS + BET_MS, now + (now - c.endAt > 60000 ? BET_MS : 0));
        c.bets = {};
        this.saveMeta(); continue;
      }
      break;
    }

    for (const a of Object.values(this.meta.arenas)) {
      if (a.players.length >= 2 && !a.endAt) {
        a.endAt = now + ARENA_WAIT;
        this.saveMeta();
      }
      if (a.endAt && now >= a.endAt) {
        const totalPool = r2(a.entry * a.players.length);
        const houseCut = r2(totalPool * FEE);
        this.fundPromoPool(houseCut * 0.25);
        const prize = r2(totalPool * (1 - FEE));
        const winIdx = Math.floor(Math.random() * a.players.length);
        const w = a.players[winIdx];
        const wu = this.users[w.id];
        if (wu) {
          wu.coins = r2(wu.coins + prize);
          wu.won = r2(wu.won + prize);
          wu.wins++;
          this.recordWinStreak(wu);
          this.addXp(wu, a.entry);
          this.addGameLog(wu, 'arena', `برنده آرنا ${a.entry} (${a.players.length} نفر)`, r2(prize - a.entry));
          this.addTx(wu, 'deposit', prize, `جایزه آرنا ${a.entry} استارز`);
          this.touch(wu);
        }
        a.players.forEach(p => {
          const pu = this.users[p.id];
          if (!pu) return;
          pu.games++;
          this.addXp(pu, a.entry * 0.3);
          if (p.id !== w.id) {
            this.resetStreak(pu);
            this.addGameLog(pu, 'arena', `باخت در آرنا ${a.entry} (برنده: ${w.name})`, -a.entry);
          }
          this.touch(pu);
        });
        a.last = {
          winner: w.name, winnerId: w.id, winnerIdx: winIdx,
          prize, pool: totalPool, playersCount: a.players.length,
          players: a.players.map(p => ({ id: p.id, name: p.name })),
          at: now
        };
        a.players = []; a.endAt = 0;
        this.saveMeta();
      }
    }
  }

  async fetch(req) {
    await this.ready;
    const url = new URL(req.url);
    if (url.pathname.startsWith('/setup/')) return this.setup(url);
    if (url.pathname.startsWith('/tg/')) return this.webhook(req, url);
    let out;
    try { out = await this.api(req, url); } catch (e) { console.error(e); out = json(500, { error: 'server error' }); }
    await this.flush();
    return out;
  }
  async setup(url) {
    if (url.pathname !== '/setup/' + this.env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    const r1 = await this.tg('setWebhook', {
      url: `${url.origin}/tg/${this.env.WEBHOOK_SECRET}`,
      allowed_updates: ['message', 'pre_checkout_query']
    });
    const r2_ = await this.tg('setChatMenuButton', {
      menu_button: { type: 'web_app', text: '⭐ Starsia', web_app: { url: url.origin } }
    });
    return new Response(`webhook: ${JSON.stringify(r1)}\nmenu: ${JSON.stringify(r2_)}\nURL: ${url.origin}`);
  }
  async webhook(req, url) {
    if (url.pathname !== '/tg/' + this.env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    const up = await req.json().catch(() => ({}));

    if (up.pre_checkout_query) {
      await this.tg('answerPreCheckoutQuery', {
        pre_checkout_query_id: up.pre_checkout_query.id,
        ok: true
      });
      return new Response('ok');
    }

    const m = up.message;
    if (m && m.successful_payment) {
      const sp = m.successful_payment;
      const uid = String(m.from.id);
      const stars = Number(sp.total_amount || 0);
      if (stars >= 5) {
        const u = this.getUser(m.from);
        u.coins = r2(u.coins + stars);
        this.addTx(u, 'deposit', stars, `شارژ مستقیم با استارز (${stars} ⭐)`);
        this.rewardReferrer(u, stars, 0.08, 'پاداش ۸٪ واریز زیرمجموعه');
        this.touch(u);
        await this.tg('sendMessage', {
          chat_id: uid,
          text: `✅ پرداخت ${stars} استارز با موفقیت انجام شد!\nموجودی جدید شما در Starsia: ${u.coins} ⭐`
        });
        if (this.env.ADMIN_ID) {
          await this.tg('sendMessage', {
            chat_id: String(this.env.ADMIN_ID),
            text: `⭐ واریز جدید استارز:\nکاربر: ${u.name} (${u.id})\nمقدار: ${stars} استارز`
          });
        }
      }
      await this.flush();
      return new Response('ok');
    }

    if (m && m.text) {
      const id = String(m.from.id), [cmd, ...a] = m.text.split(/\s+/), origin = url.origin;
      const isAdminMsg = id === String(this.env.ADMIN_ID);

      if (cmd === '/start') {
        const startParam = a[0] || '';
        this.getUser(m.from, startParam);
        const appUrl = startParam ? `${origin}/?ref=${encodeURIComponent(startParam)}` : origin;
        await this.tg('sendMessage', {
          chat_id: id,
          text: '⭐ به Starsia خوش آمدید!\nبرای ورود به بازی، دعوت دوستان و شارژ استارز روی دکمه زیر بزنید:\n\n💬 برای ارسال پیام به پشتیبانی، کافیست همین‌جا در ربات پیام خود را بنویسید تا مستقیم برای ادمین ارسال شود.',
          reply_markup: { inline_keyboard: [[{ text: '🚀 ورود به Starsia', web_app: { url: appUrl } }]] }
        });
      } else if (isAdminMsg) {
        if (cmd === '/give' || cmd === '/take') {
          const t = this.findUserByQuery(a[0]), n = Number(a[1]);
          if (t && n > 0) {
            const delta = cmd === '/give' ? n : -n;
            t.coins = Math.max(0, r2(t.coins + delta));
            this.addTx(t, delta >= 0 ? 'admin_add' : 'admin_sub', delta, 'تغییر موجودی توسط ادمین (بات)');
            this.touch(t);
            await this.tg('sendMessage', { chat_id: id, text: `${t.name}: ${t.coins} ⭐` });
          }
        } else if (cmd === '/next') {
          this.meta.settings.queue.push(...a.map(Number).filter(n => n >= 1).map(r2));
          this.saveMeta();
          await this.tg('sendMessage', { chat_id: id, text: 'صف: ' + this.meta.settings.queue.join(', ') });
        } else if (cmd === '/clearnext') {
          this.meta.settings.queue = [];
          this.saveMeta();
          await this.tg('sendMessage', { chat_id: id, text: 'صف خالی شد.' });
        } else if (cmd === '/reply') {
          const targetId = String(a[0] || '').trim();
          const replyText = m.text.replace(/^\/reply\s+\S+\s*/i, '').trim();
          if (targetId && replyText) {
            await this.tg('sendMessage', {
              chat_id: targetId,
              text: `💬 پاسخ پشتیبانی Starsia:\n${replyText}`
            });
            await this.tg('sendMessage', { chat_id: id, text: `✅ پاسخ برای کاربر ${targetId} ارسال شد.` });
          } else {
            await this.tg('sendMessage', { chat_id: id, text: 'فرمت صحیح: /reply USER_ID متن پاسخ' });
          }
        } else if (m.reply_to_message) {
          const origText = m.reply_to_message.text || '';
          const match = origText.match(/آیدی:\s*(\d+)/) || origText.match(/\((\d+)\)/);
          if (match && match[1]) {
            await this.tg('sendMessage', {
              chat_id: match[1],
              text: `💬 پاسخ پشتیبانی Starsia:\n${m.text}`
            });
            await this.tg('sendMessage', { chat_id: id, text: `✅ پاسخ برای کاربر ${match[1]} ارسال شد.` });
          }
        }
      } else {
        const u = this.getUser(m.from);
        if (this.env.ADMIN_ID) {
          const unameStr = u.username ? `@${u.username}` : 'ندارد';
          await this.tg('sendMessage', {
            chat_id: String(this.env.ADMIN_ID),
            text: `📩 پیام جدید پشتیبانی:\nنام: ${u.name}\nیوزرنیم: ${unameStr}\nآیدی: ${u.id}\nموجودی: ${u.coins} ⭐\n\nمتن پیام:\n${m.text}\n\n💡 برای پاسخ دادن، روی همین پیام Reply کنید یا بنویسید:\n/reply ${u.id} متن شما`
          });
        }
        await this.tg('sendMessage', {
          chat_id: id,
          text: '✅ پیام شما به پشتیبانی ارسال شد. به زودی پاسخ داده می‌شود.'
        });
      }
    }
    await this.flush();
    return new Response('ok');
  }

  async api(req, url) {
    const initStr = req.headers.get('x-init-data') || '';
    let tgUser = await validateInitData(initStr, this.env.BOT_TOKEN);
    if (!tgUser && this.env.DEV === '1' && req.headers.get('x-dev-user')) {
      tgUser = { id: req.headers.get('x-dev-user'), first_name: 'Dev ' + req.headers.get('x-dev-user') };
    }
    if (!tgUser) return json(401, { error: 'unauthorized' });

    let startParam = req.headers.get('x-ref') || '';
    if (!startParam && initStr) {
      startParam = new URLSearchParams(initStr).get('start_param') || '';
    }
    const u = this.getUser(tgUser, startParam);
    if (u.banned) return json(401, { error: 'banned' });
    this.advance();
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const key = `${req.method} ${url.pathname}`, isAdmin = u.id === String(this.env.ADMIN_ID);
    const S = this.meta.settings, c = this.meta.crash, now = Date.now();
    const bad = (m) => json(400, { error: m });
    if (key.includes('/api/admin/') && !isAdmin) return json(403, { error: 'forbidden' });

    switch (key) {
      case 'GET /api/me':
        return json(200, { user: this.pub(u), botUsername: this.env.BOT_USERNAME || '' });

      case 'GET /api/state': {
        const playersList = [];
        for (const [id, entry] of Object.entries(c.bets)) {
          const pName = this.users[id]?.name || id;
          if (entry.a) {
            playersList.push({
              name: `${pName} #1${entry.a.shield ? ' 🛡️' : ''}`,
              amount: entry.a.amount,
              cashed: entry.a.cashed || null
            });
          }
          if (entry.b) {
            playersList.push({
              name: `${pName} #2${entry.b.shield ? ' 🛡️' : ''}`,
              amount: entry.b.amount,
              cashed: entry.b.cashed || null
            });
          }
        }
        const out = {
          user: this.pub(u),
          crash: {
            phase: c.phase, id: c.id, betLeft: Math.max(0, c.betEnd - now),
            mult: c.phase === 'run' ? r2(this.crashMult(now)) : (c.phase === 'crashed' ? c.crashAt : 1),
            crashAt: c.phase === 'crashed' ? c.crashAt : null,
            runningMs: c.phase === 'run' ? now - c.startAt : 0,
            growth: GROWTH,
            history: this.meta.history.slice(0, 15),
            players: playersList.slice(0, 40),
            my: c.bets[u.id] || null
          },
          arenas: Object.values(this.meta.arenas).map(a => ({
            entry: a.entry,
            players: a.players.map(p => ({ id: p.id, name: p.name, photo: this.users[p.id]?.photo || '' })),
            left: a.endAt ? Math.max(0, a.endAt - now) : null,
            joined: a.players.some(p => p.id === u.id),
            last: a.last
          }))
        };
        if (isAdmin) out.crash.adminNext = S.queue.slice(0, 5);
        return json(200, out);
      }

      case 'POST /api/crash/bet': {
        const slotKey = body.slot === 'b' ? 'b' : 'a';
        const amt = Math.floor(Number(body.amount));
        const useShield = !!body.shield;
        if (c.phase !== 'bet') return bad('ثبت شرط بسته است');
        if (!(amt >= 1 && amt <= 100000)) return bad('مبلغ شرط نامعتبر است');
        const shieldFee = useShield ? r2(amt * SHIELD_RATE) : 0;
        const totalCost = r2(amt + shieldFee);
        if (totalCost > u.coins) return bad('موجودی استارز برای شرط و سپر کافی نیست');

        const entry = c.bets[u.id] || { a: null, b: null };
        if (entry[slotKey]) return bad('این پنل شرط در این دور قبلاً ثبت شده است');

        u.coins = r2(u.coins - totalCost);
        u.wagered = r2(u.wagered + amt);
        u.games++;
        if (shieldFee > 0) this.fundPromoPool(shieldFee * 0.45);
        this.addXp(u, amt * 0.2 + 1);
        this.addTx(u, 'admin_sub', -totalCost, `شرط ${slotKey === 'a' ? '۱' : '۲'} کرش دور #${c.id}${useShield ? ` (+سپر ${shieldFee} ⭐)` : ''}`);
        this.rewardReferrer(u, amt, 0.005, 'پاداش ۰.۵٪ بازی کرش زیرمجموعه');

        entry[slotKey] = {
          amount: amt,
          shield: useShield,
          shieldFee,
          auto: Number(body.auto) > 1 ? r2(Number(body.auto)) : 0
        };
        c.bets[u.id] = entry;
        this.touch(u);
        this.saveMeta();
        return json(200, { ok: true });
      }

      case 'POST /api/crash/cashout': {
        const slotKey = body.slot === 'b' ? 'b' : 'a';
        const entry = c.bets[u.id];
        const slot = entry && entry[slotKey];
        if (!slot || slot.cashed || slot.lost || c.phase !== 'run') return bad('امکان برداشت نیست');
        const m = this.crashMult(now);
        if (m >= c.crashAt) return bad('منفجر شد');
        this.settleCrashSlot(u, slot, m, slotKey === 'a' ? 'شرط ۱' : 'شرط ۲');
        this.saveMeta();
        return json(200, { ok: true, mult: slot.cashed });
      }

      case 'POST /api/mission/claim': {
        this.ensureMissions(u);
        const mid = String(body.mission || '');
        if (mid === 'crash2x') {
          if (u.missions.claimedCrash2x) return bad('قبلاً دریافت شده است');
          if (u.missions.crash2x < 3) return bad('هنوز ماموریت ۳ برد بالای ۲x کامل نشده');
          const paid = this.payoutFromPool(u, 1.5, 'جایزه ماموریت روزانه: ۳ برد بالای 2x در کرش');
          if (paid <= 0) return bad('بودجه بونوس امروز تمام شده؛ فردا یا بعد از بازی‌های بیشتر تلاش کنید');
          u.missions.claimedCrash2x = true;
          this.touch(u);
          return json(200, { ok: true, reward: paid });
        }
        if (mid === 'arena') {
          if (u.missions.claimedArena) return bad('قبلاً دریافت شده است');
          if (u.missions.arenaPlays < 2) return bad('هنوز ۲ دور آرنا بازی نکرده‌اید');
          const paid = this.payoutFromPool(u, 1.5, 'جایزه ماموریت روزانه: ۲ شرکت در آرنا');
          if (paid <= 0) return bad('بودجه بونوس امروز تمام شده؛ فردا یا بعد از بازی‌های بیشتر تلاش کنید');
          u.missions.claimedArena = true;
          this.touch(u);
          return json(200, { ok: true, reward: paid });
        }
        return bad('ماموریت نامعتبر');
      }

      case 'POST /api/arena/join': {
        const a = this.meta.arenas[Number(body.entry)];
        if (!a) return bad('نامعتبر');
        if (a.players.some(p => p.id === u.id)) return bad('قبلاً وارد شده‌اید');
        if (a.endAt && a.endAt - now < 1200) return bad('دور در حال پایان است');
        if (u.coins < a.entry) return bad('موجودی استارز کافی نیست');
        this.ensureMissions(u);
        u.coins = r2(u.coins - a.entry);
        u.wagered = r2(u.wagered + a.entry);
        if (u.missions.arenaPlays < 2) u.missions.arenaPlays += 1;
        a.players.push({ id: u.id, name: u.name });
        this.addTx(u, 'admin_sub', -a.entry, `ورودی آرنا ${a.entry} استارز`);
        this.rewardReferrer(u, a.entry, 0.005, 'پاداش ۰.۵٪ بازی آرنا زیرمجموعه');
        this.touch(u);
        this.saveMeta();
        return json(200, { ok: true });
      }

      case 'POST /api/stars/invoice': {
        const stars = Math.floor(Number(body.stars));
        if (!stars || stars < 5 || stars > 50000) return bad('حداقل واریز استارز ۵ عدد است');
        if (!this.env.BOT_TOKEN) return bad('توکن بات تنظیم نشده است');
        const link = await this.tg('createInvoiceLink', {
          title: `شارژ ${stars} استارز در Starsia`,
          description: `افزایش ${stars} استارز به حساب کاربری ${u.name}`,
          payload: JSON.stringify({ uid: u.id, stars }),
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: `${stars} Stars`, amount: stars }]
        });
        if (!link) return bad('خطا در ساخت فاکتور استارز');
        return json(200, { ok: true, invoiceLink: link });
      }

      case 'POST /api/withdraw': {
        const amount = Number(body.amount);
        const tonAddress = String(body.tonAddress || '').trim();
        if (!isFinite(amount) || amount < 50) return bad('حداقل مبلغ برداشت ۵۰ استارز است');
        if (u.coins < amount) return bad('موجودی کافی نیست');
        const tax = r2(amount * 0.10);
        this.fundPromoPool(tax * 0.20);
        const net = r2(amount - tax);
        u.coins = r2(u.coins - amount);
        const reqId = 'wd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const item = {
          id: reqId, uid: u.id, name: u.name, username: u.username || '',
          tonAddress,
          gross: r2(amount), tax, net, status: 'pending', method: '', created: now
        };
        this.meta.withdrawals.unshift(item);
        this.meta.withdrawals = this.meta.withdrawals.slice(0, 200);
        this.addTx(
          u, 'withdraw', -amount,
          `درخواست برداشت ${amount} ⭐ (۱۰٪ مالیات: ${tax} ⭐، خالص: ${net} ⭐)${tonAddress ? ` • آدرس TON: ${tonAddress}` : ''}`,
          'pending'
        );
        this.touch(u);
        this.saveMeta();
        if (this.env.ADMIN_ID) {
          await this.tg('sendMessage', {
            chat_id: String(this.env.ADMIN_ID),
            text: `💸 درخواست برداشت جدید:\nکاربر: ${u.name} (${u.id})\nمبلغ درخواستی: ${amount} ⭐\nمالیات ۱۰٪: ${tax} ⭐\nقابل پرداخت خالص: ${net} ⭐\nآدرس TON: ${tonAddress || 'وارد نشده'}`
          });
        }
        return json(200, { ok: true, withdrawal: item });
      }

      case 'POST /api/wheel': {
        if (now < u.lastWheel + DAY) return bad('هنوز زمان چرخش نرسیده');
        let r = Math.random() * 100, v = 2;
        for (const s of WHEEL) { if ((r -= s.w) < 0) { v = s.v; break; } }
        const paid = this.payoutFromPool(u, v, `جایزه گردونه روزانه (${v} ⭐)`);
        if (paid <= 0) return bad('بودجه جایزه روزانه فعلاً تکمیل شده است');
        u.lastWheel = now;
        this.addXp(u, 5);
        this.addGameLog(u, 'wheel', `جایزه گردونه روزانه`, paid);
        this.touch(u);
        return json(200, { prize: paid, segments: WHEEL.map(s => s.v) });
      }

      case 'POST /api/tag': {
        if (now < u.lastTag + DAY) return bad('جایزه‌ی امروز گرفته شده');
        const bu = this.env.BOT_USERNAME;
        if (!bu) return bad('BOT_USERNAME تنظیم نشده');
        let name = u.name;
        const ch = await this.tg('getChat', { chat_id: u.id });
        if (ch) name = [ch.first_name, ch.last_name].filter(Boolean).join(' ');
        if (!name.toLowerCase().includes(bu.toLowerCase())) return bad(`@${bu} را در اسم پروفایل‌تان بگذارید`);
        const paid = this.payoutFromPool(u, 3, 'جایزه اسم ربات در پروفایل');
        if (paid <= 0) return bad('بودجه جایزه فعلاً تکمیل شده است');
        u.lastTag = now;
        this.addGameLog(u, 'tag', 'جایزه اسم ربات در پروفایل', paid);
        this.touch(u);
        return json(200, { ok: true, prize: paid });
      }

      case 'GET /api/leaderboard': {
        const us = Object.values(this.users);
        const top = k => [...us].sort((a, b) => b[k] - a[k]).slice(0, 20)
          .map(x => ({ name: x.name, photo: x.photo, level: levelOf(x.xp), value: r2(x[k]) }));
        return json(200, { circulation: top('wagered'), winners: top('won'), rich: top('coins') });
      }

      case 'GET /api/admin/users':
        return json(200, {
          users: Object.values(this.users).sort((a, b) => b.created - a.created).slice(0, 200).map(x => ({
            id: x.id, name: x.name, username: x.username, coins: r2(x.coins),
            refCount: x.refCount || 0, refEarned: r2(x.refEarned || 0),
            streak: x.streak || 0, bestStreak: x.bestStreak || 0,
            banned: x.banned, txs: (x.txs || []).slice(0, 20), gameLogs: (x.gameLogs || []).slice(0, 20)
          })),
          withdrawals: this.meta.withdrawals.slice(0, 100),
          promoPool: r2(this.meta.promoPool || 0),
          settings: S
        });

      case 'POST /api/admin/coins': {
        const t = this.findUserByQuery(body.id), amt = Number(body.amount);
        if (!t || !isFinite(amt)) return bad('کاربر (آیدی یا یوزرنیم) یا مقدار نامعتبر است');
        t.coins = Math.max(0, r2(t.coins + amt));
        this.addTx(t, amt >= 0 ? 'admin_add' : 'admin_sub', amt, 'شارژ / کسر دستی توسط ادمین');
        this.touch(t);
        await this.tg('sendMessage', {
          chat_id: t.id,
          text: `${amt >= 0 ? '➕' : '➖'} ${Math.abs(amt)} استارز ${amt >= 0 ? 'به حساب شما اضافه' : 'از حساب شما کم'} شد.\nموجودی فعلی: ${t.coins} ⭐`
        });
        return json(200, { ok: true, coins: t.coins });
      }

      case 'POST /api/admin/withdraw': {
        const wid = String(body.id || ''), act = body.action;
        const payoutMethod = body.method === 'ton' ? 'ton' : 'stars';
        const idx = this.meta.withdrawals.findIndex(w => w.id === wid);
        if (idx === -1) return bad('درخواست یافت نشد');
        const w = this.meta.withdrawals[idx];
        if (w.status !== 'pending') return bad('قبلاً بررسی شده است');
        const targetUser = this.users[w.uid];
        if (act === 'approve') {
          const methodLabel = payoutMethod === 'ton' ? 'TON' : 'استارز (Stars)';
          w.status = 'approved';
          w.method = payoutMethod;
          w.decidedAt = now;
          if (targetUser) {
            const tx = (targetUser.txs || []).find(t => t.status === 'pending' && t.type === 'withdraw' && Math.abs(t.amount) === w.gross);
            if (tx) {
              tx.status = 'approved';
              tx.note = `${tx.note} • واریز با ${methodLabel}`;
            }
            this.touch(targetUser);
            await this.tg('sendMessage', {
              chat_id: targetUser.id,
              text: `✅ برداشت ${w.gross} استارز شما (خالص ${w.net} ⭐ پس از ۱۰٪ مالیات) تایید و به صورت ${methodLabel} واریز شد.${payoutMethod === 'ton' && w.tonAddress ? `\nآدرس TON: ${w.tonAddress}` : ''}`
            });
          }
        } else if (act === 'reject') {
          w.status = 'rejected';
          w.decidedAt = now;
          if (targetUser) {
            targetUser.coins = r2(targetUser.coins + w.gross);
            this.addTx(targetUser, 'deposit', w.gross, `بازگشت وجه برداشت ردشده (${w.gross} ⭐)`);
            this.touch(targetUser);
            await this.tg('sendMessage', {
              chat_id: targetUser.id,
              text: `❌ درخواست برداشت ${w.gross} استارز شما رد شد و مبلغ به موجودی بازگشت.`
            });
          }
        } else return bad('عملیات نامعتبر');
        this.saveMeta();
        return json(200, { ok: true });
      }

      case 'POST /api/admin/ban': {
        const t = this.findUserByQuery(body.id);
        if (!t) return bad('کاربر یافت نشد');
        t.banned = !!body.banned;
        this.touch(t);
        return json(200, { ok: true });
      }

      case 'POST /api/admin/queue':
        S.queue = (body.queue || []).map(Number).filter(n => n >= 1 && n <= 1000).map(r2).slice(0, 50);
        this.saveMeta();
        return json(200, { ok: true, queue: S.queue });

      case 'POST /api/admin/settings':
        if (body.minMult >= 1) S.minMult = Number(body.minMult);
        if (body.maxMult >= 1.1) S.maxMult = Number(body.maxMult);
        if (body.edge >= 0 && body.edge < 0.5) S.edge = Number(body.edge);
        if (body.greed >= 0 && body.greed <= 1) S.greed = Number(body.greed);
        if (body.startCoins >= 0) S.startCoins = Number(body.startCoins);
        if (body.promoPool !== undefined && Number(body.promoPool) >= 0) this.meta.promoPool = r2(Number(body.promoPool));
        this.saveMeta();
        return json(200, { ok: true, settings: S, promoPool: this.meta.promoPool });
    }
    return json(404, { error: 'not found' });
  }
}
