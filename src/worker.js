// Tonia on Cloudflare Workers + Durable Object (100% TON Economy v2.6 + Support Photo Forwarding)
const DAY = 24 * 3600 * 1000;
const GROWTH = 0.09, BET_MS = 7000, CRASHED_MS = 4000;
const LEVELS = [0, 0.5, 1.5, 4, 9, 18, 35, 70, 140, 300];
const FEE = 0.05, ARENA_WAIT = 20000;

const MIN_BET = 0.01;
const MAX_BET = 50;

const WHEEL = [
  { v: 0.01, w: 99 },
  { v: 0.1, w: 1 },
  { v: 0.02, w: 0 }
];

const SHIELD_RATE = 0.15, SHIELD_MAX_MULT = 1.15, SHIELD_REFUND = 0.50;
const STREAK_MILESTONE = 3, STREAK_REWARD = 0.015;

const DEFAULT_TON_DEPOSIT_ADDR = 'EQBmLDcxBiP21Vn4Jet3Th-DWyNl8JVmsbdAi8FvxHT38aiu';
const DEFAULT_TON_DEPOSIT_MEMO = '398101056984149';

function defaultMissionsConfig() {
  return [
    {
      id: 'ref_3',
      type: 'referral',
      title: 'دعوت ۳ عضو جدید',
      desc: '۳ دوست را با لینک دعوت وارد ربات کنید',
      target: 3,
      reward: 0.01,
      minStreak: 0,
      enabled: true
    },
    {
      id: 'ref_5',
      type: 'referral',
      title: 'دعوت ۵ عضو جدید',
      desc: '۵ دوست را با لینک دعوت وارد ربات کنید',
      target: 5,
      reward: 0.04,
      minStreak: 0,
      enabled: true
    },
    {
      id: 'ref_9',
      type: 'referral',
      title: 'دعوت ۹ عضو جدید',
      desc: '۹ دوست را با لینک دعوت وارد ربات کنید',
      target: 9,
      reward: 0.09,
      minStreak: 0,
      enabled: true
    },
    {
      id: 'crash_streak_4x',
      type: 'crash_streak_4x',
      title: '۵ برد متوالی ضریب بالای 4x (شرط ≥ 0.1 TON)',
      desc: '۵ برد پیاپی در کرش با ضریب بالای 4x و حداقل شرط 0.1 TON',
      target: 5,
      minStake: 0.1,
      minMult: 4.0,
      reward: 0.1,
      minStreak: 0,
      enabled: true
    },
    {
      id: 'arena_7_streak_3',
      type: 'arena_streak',
      title: '۷ بار ورود به آرنا + حداقل ۳ برد متوالی',
      desc: '۷ بار در آرنا شرکت کنید و حداقل ۳ برد متوالی داشته باشید',
      target: 7,
      minStreak: 3,
      reward: 0.05,
      enabled: true
    }
  ];
}

const levelOf = xp => { let l = 0; LEVELS.forEach((t, i) => { if (xp >= t) l = i + 1; }); return l; };
const r4 = n => Math.round(Number(n || 0) * 10000) / 10000;
const fmtTon = n => {
  const v = r4(n);
  return Number(v.toFixed(4)).toString();
};
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

function textCommentToBocBase64(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const dataLen = 4 + bytes.length;
  if (dataLen > 127) throw new Error('Comment too long');
  const cellBytes = new Uint8Array(2 + dataLen);
  cellBytes[0] = 0x00;
  cellBytes[1] = dataLen * 2;
  cellBytes.set(bytes, 6);

  const boc = new Uint8Array(10 + cellBytes.length);
  boc[0] = 0xb5; boc[1] = 0xee; boc[2] = 0x9c; boc[3] = 0x72;
  boc[4] = 0x01;
  boc[5] = 0x01;
  boc[6] = 0x01;
  boc[7] = 0x01;
  boc[8] = 0x00;
  boc[9] = cellBytes.length;
  boc.set(cellBytes, 10);

  let bin = '';
  for (let i = 0; i < boc.length; i++) bin += String.fromCharCode(boc[i]);
  return btoa(bin);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/tonconnect-manifest.json') {
      return new Response(JSON.stringify({
        url: url.origin,
        name: 'Tonia',
        iconUrl: 'https://ton.org/download/ton_symbol.png'
      }), { headers: { ...JSONH, 'access-control-allow-origin': '*' } });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/tg/') || url.pathname.startsWith('/setup/')) {
      return env.GAME.get(env.GAME.idFromName('main')).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

export class Game {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.ctxIp = '';
    this.ctxUa = '';
    this.ready = state.blockConcurrencyWhile(() => this.load());
  }
  async load() {
    const s = this.state.storage;
    this.meta = (await s.get('meta')) || {
      settings: { minMult: 1.0, maxMult: 25, edge: 0.08, greed: 0.42, queue: [], startCoins: 0 },
      tonDeposit: { address: DEFAULT_TON_DEPOSIT_ADDR, memo: DEFAULT_TON_DEPOSIT_MEMO },
      missionsConfig: defaultMissionsConfig(),
      promoPool: 1.0,
      history: [],
      crash: null,
      arena: null,
      withdrawals: [],
      usedTonTxs: [],
      tonOrders: []
    };
    this.meta.settings.startCoins = 0;
    if (this.meta.settings.greed === undefined) this.meta.settings.greed = 0.42;
    if (!this.meta.tonDeposit || !this.meta.tonDeposit.address) {
      this.meta.tonDeposit = { address: DEFAULT_TON_DEPOSIT_ADDR, memo: DEFAULT_TON_DEPOSIT_MEMO };
    }
    if (!Array.isArray(this.meta.missionsConfig) || this.meta.missionsConfig.length === 0) {
      this.meta.missionsConfig = defaultMissionsConfig();
    }
    if (typeof this.meta.promoPool !== 'number' || !isFinite(this.meta.promoPool)) this.meta.promoPool = 1.0;
    if (!Array.isArray(this.meta.withdrawals)) this.meta.withdrawals = [];
    if (!Array.isArray(this.meta.usedTonTxs)) this.meta.usedTonTxs = [];
    if (!Array.isArray(this.meta.tonOrders)) this.meta.tonOrders = [];
    if (!this.meta.crash) this.meta.crash = { phase: 'bet', id: 1, betEnd: Date.now() + BET_MS, startAt: 0, crashAt: 0, endAt: 0, bets: {} };

    if (!this.meta.arena || !Array.isArray(this.meta.arena.players)) {
      let migratedPlayers = [];
      let migratedLast = null;
      if (this.meta.arenas && typeof this.meta.arenas === 'object') {
        for (const tObj of Object.values(this.meta.arenas)) {
          if (tObj && Array.isArray(tObj.players)) {
            for (const p of tObj.players) {
              migratedPlayers.push({ id: p.id, name: p.name, amount: r4(tObj.entry || MIN_BET) });
            }
          }
          if (tObj && tObj.last && (!migratedLast || (tObj.last.at || 0) > (migratedLast.at || 0))) {
            migratedLast = tObj.last;
          }
        }
      }
      this.meta.arena = { players: migratedPlayers, endAt: 0, last: migratedLast };
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
      if (!u.arenaEntries) u.arenaEntries = 0;
      if (!u.highMultStreak) u.highMultStreak = 0;
      if (!Array.isArray(u.claimedMissions)) u.claimedMissions = [];
      if (!u.lastIp) u.lastIp = '';
      if (!u.lastUa) u.lastUa = '';
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

  fundPromoPool(amount) {
    const add = r4(Math.max(0, amount));
    if (add > 0) {
      this.meta.promoPool = r4((this.meta.promoPool || 0) + add);
      this.saveMeta();
    }
  }

  applyBalance(u, delta, source, note, status = 'completed', opts = {}) {
    const d = r4(delta);
    const before = r4(u.coins || 0);
    const after = Math.max(0, r4(before + d));
    const actualDelta = r4(after - before);
    u.coins = after;

    if (opts.countWon && actualDelta > 0) u.won = r4((u.won || 0) + actualDelta);
    if (opts.countWager && d < 0) u.wagered = r4((u.wagered || 0) + Math.abs(d));

    if (!Array.isArray(u.txs)) u.txs = [];
    u.txs.unshift({
      id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: actualDelta >= 0 ? 'deposit' : 'withdraw',
      source: source || 'general',
      amount: actualDelta,
      before,
      after,
      ip: this.ctxIp || u.lastIp || '',
      note,
      status,
      at: Date.now()
    });
    u.txs = u.txs.slice(0, 120);
    this.touch(u);
    return actualDelta;
  }

  payoutFromPool(u, requestedAmount, note, source = 'promo_pool') {
    const want = r4(Math.max(0, requestedAmount));
    if (want <= 0) return 0;
    const available = r4(Math.max(0, this.meta.promoPool || 0));
    const granted = r4(Math.min(want, available));
    if (granted <= 0) return 0;
    this.meta.promoPool = r4(available - granted);
    this.applyBalance(
      u,
      granted,
      source,
      note + (granted < want ? ' (سهمیه بودجه بونوس)' : ''),
      'completed',
      { countWon: true }
    );
    this.saveMeta();
    return granted;
  }

  auditUser(u) {
    let tonDeposits = 0;
    let adminAdjustments = 0;
    let promoRewards = 0;
    let referralRewards = 0;
    let gameNetDelta = 0;
    let withdrawGross = 0;
    let withdrawRefunds = 0;

    for (const t of (u.txs || [])) {
      const amt = r4(t.amount || 0);
      const src = t.source || '';
      if (src === 'ton_deposit') {
        tonDeposits = r4(tonDeposits + amt);
      } else if (src === 'admin_coins' || src === 'admin_bulk' || src === 'tg_admin_coins') {
        adminAdjustments = r4(adminAdjustments + amt);
      } else if (src === 'mission' || src === 'streak' || src === 'wheel' || src === 'tag' || src === 'promo_pool') {
        promoRewards = r4(promoRewards + amt);
      } else if (src === 'referral') {
        referralRewards = r4(referralRewards + amt);
      } else if (src === 'withdraw') {
        if (t.status === 'rejected') {
          withdrawRefunds = r4(withdrawRefunds + Math.abs(amt));
        } else {
          withdrawGross = r4(withdrawGross + Math.abs(amt));
        }
      } else if (src === 'withdraw_refund') {
        withdrawRefunds = r4(withdrawRefunds + amt);
      } else {
        gameNetDelta = r4(gameNetDelta + amt);
      }
    }

    const totalIn = r4(tonDeposits + adminAdjustments + promoRewards + referralRewards + Math.max(0, gameNetDelta) + withdrawRefunds);
    const totalOut = r4(withdrawGross + Math.abs(Math.min(0, gameNetDelta)));
    const expectedCoins = r4(Math.max(0, totalIn - totalOut));
    const currentCoins = r4(u.coins || 0);
    const discrepancy = r4(currentCoins - expectedCoins);
    const wagered = r4(u.wagered || 0);
    const won = r4(u.won || 0);

    const flags = [];
    if (Math.abs(discrepancy) > 0.001) {
      flags.push(`اختلاف تراز: موجودی فعلی ${fmtTon(currentCoins)} در برابر انتظار ${fmtTon(expectedCoins)} TON`);
    }
    if (wagered < 0.05 && (currentCoins + withdrawGross) >= 0.2) {
      flags.push(`حجم شرط‌بندی بسیار پایین (${fmtTon(wagered)} TON) نسبت به موجودی/برداشت`);
    }
    if (adminAdjustments >= 0.2 && wagered < adminAdjustments * 0.5) {
      flags.push(`شارژ دستی زیاد (${fmtTon(adminAdjustments)} TON) با گردش بازی کم (${fmtTon(wagered)} TON)`);
    }

    return {
      tonDeposits,
      adminAdjustments,
      promoRewards,
      referralRewards,
      gameNetDelta,
      withdrawGross,
      totalIn,
      totalOut,
      expectedCoins,
      currentCoins,
      discrepancy,
      wagered,
      won,
      flags
    };
  }

  assessWithdrawalRisk(u, amount) {
    const a = this.auditUser(u);
    const reasons = [...a.flags];
    if (a.wagered < r4(amount * 0.5)) {
      reasons.push(`مجموع شرط‌ها (${fmtTon(a.wagered)} TON) کمتر از نصف مبلغ برداشت (${fmtTon(amount)} TON) است`);
    }
    if (a.tonDeposits === 0 && a.adminAdjustments > 0) {
      reasons.push(`واریز آن‌چین TON ثبت نشده ولی شارژ دستی ادمین (${fmtTon(a.adminAdjustments)} TON) وجود دارد`);
    }
    return {
      suspicious: reasons.length > 0,
      reasons,
      audit: a
    };
  }

  missionProgress(u, m) {
    if (m.type === 'referral') {
      return Number(u.refCount || 0);
    }
    if (m.type === 'crash_streak_4x') {
      return Number(u.highMultStreak || 0);
    }
    if (m.type === 'arena_streak') {
      return Number(u.arenaEntries || 0);
    }
    return 0;
  }

  isMissionClaimable(u, m) {
    if (!m || m.enabled === false) return false;
    if ((u.claimedMissions || []).includes(m.id)) return false;
    const prog = this.missionProgress(u, m);
    const target = Number(m.target || 1);
    const minStreak = Number(m.minStreak || 0);
    const curStreak = Math.max(Number(u.streak || 0), Number(u.bestStreak || 0));
    return prog >= target && curStreak >= minStreak;
  }

  addGameLog(u, game, detail, delta) {
    if (!Array.isArray(u.gameLogs)) u.gameLogs = [];
    u.gameLogs.unshift({
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      game, detail, delta: r4(delta), at: Date.now()
    });
    u.gameLogs = u.gameLogs.slice(0, 120);
    this.touch(u);
  }
  rewardReferrer(user, baseAmount, pct, reason) {
    if (!user || !user.refBy) return;
    const inviter = this.users[user.refBy];
    if (!inviter || inviter.id === user.id) return;
    const bonus = r4(baseAmount * pct);
    if (bonus <= 0) return;
    inviter.refEarned = r4((inviter.refEarned || 0) + bonus);
    this.applyBalance(inviter, bonus, 'referral', `${reason} (${user.name})`, 'completed', { countWon: true });
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

  async verifyIncomingTonTx(order) {
    const headers = { accept: 'application/json' };
    if (this.env.TONCENTER_API_KEY) headers['X-API-Key'] = this.env.TONCENTER_API_KEY;
    const depAddr = this.meta.tonDeposit?.address || DEFAULT_TON_DEPOSIT_ADDR;
    const expectedMemo = String(this.meta.tonDeposit?.memo || DEFAULT_TON_DEPOSIT_MEMO).trim();
    const apiUrl = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(depAddr)}&limit=35&archival=false`;
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) return { ok: false, reason: 'خطا در ارتباط با شبکه TON برای استعلام تراکنش' };
    const data = await res.json().catch(() => null);
    if (!data || !data.ok || !Array.isArray(data.result)) {
      return { ok: false, reason: 'پاسخ نامعتبر از شبکه TON' };
    }

    const minNano = BigInt(Math.floor(Number(order.tonAmount) * 1e9 * 0.985));
    const minUtime = Math.floor((order.created - 120000) / 1000);

    for (const tx of data.result) {
      const txHash = tx?.transaction_id?.hash;
      if (!txHash || this.meta.usedTonTxs.includes(txHash)) continue;
      const utime = Number(tx.utime || 0);
      if (utime < minUtime) continue;

      const inMsg = tx.in_msg;
      if (!inMsg || !inMsg.value) continue;
      const valNano = BigInt(String(inMsg.value));
      if (valNano < minNano) continue;

      const msgText = String(inMsg.message || '').trim();
      const matchedMemo = msgText === expectedMemo;
      const matchedSender = order.senderAddress && inMsg.source && String(inMsg.source).includes(order.senderAddress.slice(2, 20));
      if (!matchedMemo && !matchedSender) continue;

      return {
        ok: true,
        txHash,
        tonPaid: r4(Number(valNano) / 1e9),
        sender: inMsg.source || order.senderAddress || ''
      };
    }

    return { ok: false, reason: 'تراکنش هنوز روی بلاک‌چین تایید نشده است. چند ثانیه صبر کنید و دوباره بررسی بزنید.' };
  }

  getUser(tg, refParam = '') {
    const id = String(tg.id);
    let u = this.users[id];
    const isNew = !u;
    if (!u) {
      u = this.users[id] = {
        id, coins: 0, xp: 0, wagered: 0, won: 0, wins: 0,
        games: 0, bestMult: 0, lastWheel: 0, lastTag: 0, banned: false, created: Date.now(),
        name: '', username: '', photo: '', txs: [], gameLogs: [],
        refBy: '', refCount: 0, refEarned: 0, streak: 0, bestStreak: 0,
        arenaEntries: 0, highMultStreak: 0, claimedMissions: [],
        lastIp: this.ctxIp || '', lastUa: this.ctxUa || ''
      };
      this.touch(u);
    }
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || id;
    const uname = tg.username || '';
    if (u.name !== name || u.username !== uname || (tg.photo_url && u.photo !== tg.photo_url)) {
      u.name = name; u.username = uname; u.photo = tg.photo_url || u.photo || '';
      this.touch(u);
    }
    if (this.ctxIp && u.lastIp !== this.ctxIp) {
      u.lastIp = this.ctxIp;
      this.touch(u);
    }
    if (this.ctxUa && u.lastUa !== this.ctxUa) {
      u.lastUa = this.ctxUa;
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
    const rawBot = String(this.env.BOT_USERNAME || '').trim().replace(/^@+/, '');
    const activeMissions = (this.meta.missionsConfig || [])
      .filter(m => m.enabled !== false)
      .map(m => {
        const prog = this.missionProgress(u, m);
        const claimed = (u.claimedMissions || []).includes(m.id);
        const claimable = this.isMissionClaimable(u, m);
        return {
          id: m.id,
          type: m.type,
          title: m.title,
          desc: m.desc || '',
          target: Number(m.target || 1),
          minStake: Number(m.minStake || 0),
          minMult: Number(m.minMult || 0),
          minStreak: Number(m.minStreak || 0),
          reward: r4(m.reward || 0),
          progress: prog,
          claimed,
          claimable
        };
      });

    return {
      id: u.id, name: u.name, username: u.username, photo: u.photo,
      coins: r4(u.coins), xp: u.xp, level: levelOf(u.xp),
      wagered: r4(u.wagered), won: r4(u.won), wins: u.wins, games: u.games, bestMult: u.bestMult,
      streak: u.streak || 0, bestStreak: u.bestStreak || 0,
      arenaEntries: u.arenaEntries || 0,
      highMultStreak: u.highMultStreak || 0,
      missions: activeMissions,
      promoPool: r4(this.meta.promoPool || 0),
      limits: { minBet: MIN_BET, maxBet: MAX_BET },
      wheelIn: Math.max(0, u.lastWheel + DAY - Date.now()),
      tagIn: Math.max(0, u.lastTag + DAY - Date.now()),
      isAdmin: u.id === String(this.env.ADMIN_ID),
      botUsername: rawBot,
      tonDeposit: {
        address: this.meta.tonDeposit?.address || DEFAULT_TON_DEPOSIT_ADDR,
        memo: this.meta.tonDeposit?.memo || DEFAULT_TON_DEPOSIT_MEMO
      },
      refCount: u.refCount || 0,
      refEarned: r4(u.refEarned || 0),
      txs: (u.txs || []).slice(0, 40),
      gameLogs: (u.gameLogs || []).slice(0, 40),
      withdrawals: this.meta.withdrawals.filter(w => w.uid === u.id).slice(0, 20)
    };
  }

  addXp(u, a) { u.xp += Math.max(1, Math.floor(Number(a || 1) * 20)); }
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
    const greed = Math.max(0, Math.min(1, Number(s.greed ?? 0.42)));
    const edge = Math.max(0.02, Math.min(0.35, Number(s.edge ?? 0.08)));
    const r = Math.random();
    let m;
    if (r < 0.22) {
      m = Math.random() < 0.35
        ? 1.01 + Math.random() * 0.13
        : 1.15 + Math.random() * 0.30;
    } else if (r < 0.22 + (1 - 0.22) * (0.68 + greed * 0.18)) {
      m = 1.45 + Math.pow(Math.random(), 1.55) * 1.95;
    } else if (r < 0.96) {
      m = 3.4 + Math.pow(Math.random(), 2.1) * 4.1;
    } else {
      m = 7.5 + Math.pow(Math.random(), 2.8) * 8.5;
    }
    const maxCap = Math.min(Number(s.maxMult) || 25, 25);
    const minFloor = Math.max(1.0, Number(s.minMult) || 1.0);
    m = Math.min(Math.max(m * (1 - edge * 0.25), minFloor), maxCap);
    return Math.max(1.0, Math.round(m * 100) / 100);
  }

  recordWinStreak(u) {
    u.streak = (u.streak || 0) + 1;
    u.bestStreak = Math.max(u.bestStreak || 0, u.streak);
    if (u.streak > 0 && u.streak % STREAK_MILESTONE === 0) {
      const reward = this.payoutFromPool(u, STREAK_REWARD, `جایزه برد متوالی (${u.streak} برد پیاپی)`, 'streak');
      if (reward > 0) {
        this.addXp(u, 0.4);
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
    if (u.highMultStreak) {
      u.highMultStreak = 0;
      this.touch(u);
    }
  }

  settleCrashSlot(u, slot, mult, slotLabel) {
    slot.cashed = Math.round(mult * 100) / 100;
    const win = r4(slot.amount * slot.cashed);
    slot.winAmount = win;
    const profit = r4(win - slot.amount);
    this.applyBalance(u, win, 'crash_win', `برد کرش (${slotLabel}) در ضریب ${slot.cashed}x`, 'completed', { countWon: true });
    u.wins += 1;
    u.bestMult = Math.max(u.bestMult, slot.cashed);

    if (slot.amount >= 0.1 && slot.cashed > 4.0) {
      u.highMultStreak = (u.highMultStreak || 0) + 1;
    } else {
      u.highMultStreak = 0;
    }

    this.recordWinStreak(u);
    this.addXp(u, slot.amount * 2 + 0.1);
    this.addGameLog(u, 'crash', `برد ${slotLabel} در ضریب ${slot.cashed}x (شرط ${fmtTon(slot.amount)} TON)`, profit);
    this.touch(u);
  }

  settleCrashLossSlot(u, slot, crashAt, slotLabel) {
    slot.lost = true;
    const shieldFee = r4(slot.shieldFee || 0);
    let refund = 0;
    if (slot.shield && crashAt < SHIELD_MAX_MULT) {
      refund = r4(slot.amount * SHIELD_REFUND);
      this.applyBalance(u, refund, 'crash_shield_refund', `بازگشت ۵۰٪ شرط با سپر ضد انفجار (انفجار در ${crashAt}x)`);
    }
    this.resetStreak(u);
    const netDelta = r4(-(slot.amount + shieldFee) + refund);
    this.addGameLog(u, 'crash', `انفجار در ${crashAt}x (${slotLabel}, شرط ${fmtTon(slot.amount)} TON${slot.shield ? ' + سپر' : ''})`, netDelta);
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

    const a = this.meta.arena;
    if (a && Array.isArray(a.players)) {
      if (a.players.length >= 2 && !a.endAt) {
        a.endAt = now + ARENA_WAIT;
        this.saveMeta();
      }
      if (a.endAt && now >= a.endAt) {
        const totalPool = r4(a.players.reduce((sum, p) => sum + Number(p.amount || 0), 0));
        const houseCut = r4(totalPool * FEE);
        this.fundPromoPool(houseCut * 0.25);
        const prize = r4(totalPool * (1 - FEE));

        const weights = a.players.map(p => Math.max(0.0001, Number(p.amount || MIN_BET)));
        const weightSum = weights.reduce((s, w) => s + w, 0);
        let pick = Math.random() * weightSum;
        let winIdx = a.players.length - 1;
        for (let i = 0; i < weights.length; i++) {
          pick -= weights[i];
          if (pick <= 0) { winIdx = i; break; }
        }

        const w = a.players[winIdx];
        const wu = this.users[w.id];
        if (wu) {
          this.applyBalance(wu, prize, 'arena_win', `جایزه آرنا (${fmtTon(totalPool)} TON استخر)`, 'completed', { countWon: true });
          wu.wins++;
          this.recordWinStreak(wu);
          this.addXp(wu, Math.max(0.2, totalPool * 3));
          this.addGameLog(wu, 'arena', `برنده آرنا با ورود ${fmtTon(w.amount)} TON از استخر ${fmtTon(totalPool)} TON`, r4(prize - w.amount));
          this.touch(wu);
        }
        a.players.forEach(p => {
          const pu = this.users[p.id];
          if (!pu) return;
          pu.games++;
          this.addXp(pu, Math.max(0.1, Number(p.amount || 0.01) * 2));
          if (p.id !== w.id) {
            this.resetStreak(pu);
            this.addGameLog(pu, 'arena', `باخت در آرنا با ورود ${fmtTon(p.amount)} TON (برنده: ${w.name})`, -r4(p.amount));
          }
          this.touch(pu);
        });
        a.last = {
          winner: w.name, winnerId: w.id, winnerIdx: winIdx,
          winnerStake: r4(w.amount),
          prize, pool: totalPool, playersCount: a.players.length,
          players: a.players.map(p => ({ id: p.id, name: p.name, amount: r4(p.amount) })),
          at: now
        };
        a.players = []; a.endAt = 0;
        this.saveMeta();
      }
    }
  }

  async fetch(req) {
    await this.ready;
    this.ctxIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '';
    this.ctxUa = (req.headers.get('user-agent') || '').slice(0, 120);
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
      allowed_updates: ['message']
    });
    const r2_ = await this.tg('setChatMenuButton', {
      menu_button: { type: 'web_app', text: '💎 Tonia', web_app: { url: url.origin } }
    });
    return new Response(`webhook: ${JSON.stringify(r1)}\nmenu: ${JSON.stringify(r2_)}\nURL: ${url.origin}`);
  }
  async webhook(req, url) {
    if (url.pathname !== '/tg/' + this.env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    const up = await req.json().catch(() => ({}));
    const m = up.message;

    if (m && (m.text || m.photo)) {
      const id = String(m.from.id), origin = url.origin;
      const rawText = String(m.text || m.caption || '').trim();
      const [cmd, ...a] = rawText ? rawText.split(/\s+/) : [''];
      const isAdminMsg = id === String(this.env.ADMIN_ID);

      if (m.text && cmd === '/start') {
        const startParam = a[0] || '';
        this.getUser(m.from, startParam);
        const appUrl = startParam ? `${origin}/?ref=${encodeURIComponent(startParam)}` : origin;
        await this.tg('sendMessage', {
          chat_id: id,
          text: '💎 به Tonia خوش آمدید!\nبرای ورود به بازی، دعوت دوستان و واریز TON روی دکمه زیر بزنید:\n\n💬 برای ارسال پیام یا عکس به پشتیبانی، کافیست همین‌جا متن یا عکس خود را بفرستید تا مستقیم برای ادمین ارسال شود.',
          reply_markup: { inline_keyboard: [[{ text: '🚀 ورود به Tonia', web_app: { url: appUrl } }]] }
        });
      } else if (isAdminMsg) {
        if (m.text && (cmd === '/give' || cmd === '/take')) {
          const t = this.findUserByQuery(a[0]), n = Number(a[1]);
          if (t && isFinite(n) && n > 0) {
            const delta = cmd === '/give' ? r4(n) : r4(-n);
            this.applyBalance(t, delta, 'tg_admin_coins', 'تغییر موجودی TON توسط ادمین (بات)');
            this.touch(t);
            await this.tg('sendMessage', { chat_id: id, text: `${t.name}: ${fmtTon(t.coins)} TON` });
          }
        } else if (m.text && cmd === '/next') {
          this.meta.settings.queue.push(...a.map(Number).filter(n => n >= 1).map(n => Math.round(n * 100) / 100));
          this.saveMeta();
          await this.tg('sendMessage', { chat_id: id, text: 'صف: ' + this.meta.settings.queue.join(', ') });
        } else if (m.text && cmd === '/clearnext') {
          this.meta.settings.queue = [];
          this.saveMeta();
          await this.tg('sendMessage', { chat_id: id, text: 'صف خالی شد.' });
        } else if (m.text && cmd === '/reply') {
          const targetId = String(a[0] || '').trim();
          const replyText = m.text.replace(/^\/reply\s+\S+\s*/i, '').trim();
          if (targetId && replyText) {
            await this.tg('sendMessage', {
              chat_id: targetId,
              text: `💬 پاسخ پشتیبانی Tonia:\n${replyText}`
            });
            await this.tg('sendMessage', { chat_id: id, text: `✅ پاسخ برای کاربر ${targetId} ارسال شد.` });
          } else {
            await this.tg('sendMessage', { chat_id: id, text: 'فرمت صحیح: /reply USER_ID متن پاسخ' });
          }
        } else if (m.reply_to_message) {
          const origText = m.reply_to_message.text || m.reply_to_message.caption || '';
          const match = origText.match(/آیدی:\s*(\d+)/) || origText.match(/\((\d+)\)/);
          if (match && match[1]) {
            if (m.photo && m.photo.length) {
              const bestPhoto = m.photo[m.photo.length - 1];
              await this.tg('sendPhoto', {
                chat_id: match[1],
                photo: bestPhoto.file_id,
                caption: m.caption ? `💬 پاسخ پشتیبانی Tonia:\n${m.caption}` : '💬 پاسخ پشتیبانی Tonia'
              });
            } else if (m.text) {
              await this.tg('sendMessage', {
                chat_id: match[1],
                text: `💬 پاسخ پشتیبانی Tonia:\n${m.text}`
              });
            }
            await this.tg('sendMessage', { chat_id: id, text: `✅ پاسخ برای کاربر ${match[1]} ارسال شد.` });
          }
        }
      } else {
        const u = this.getUser(m.from);
        if (this.env.ADMIN_ID) {
          const unameStr = u.username ? `@${u.username}` : 'ندارد';
          const infoHeader = `📩 پیام جدید پشتیبانی:\nنام: ${u.name}\nیوزرنیم: ${unameStr}\nآیدی: ${u.id}\nموجودی: ${fmtTon(u.coins)} TON`;
          if (m.photo && m.photo.length) {
            const bestPhoto = m.photo[m.photo.length - 1];
            const cap = m.caption
              ? `${infoHeader}\n\nتوضیح عکس:\n${m.caption}\n\n💡 برای پاسخ دادن، روی همین پیام Reply کنید یا بنویسید:\n/reply ${u.id} متن شما`
              : `${infoHeader}\n\n📷 عکس ارسال شده توسط کاربر\n\n💡 برای پاسخ دادن، روی همین پیام Reply کنید یا بنویسید:\n/reply ${u.id} متن شما`;
            await this.tg('sendPhoto', {
              chat_id: String(this.env.ADMIN_ID),
              photo: bestPhoto.file_id,
              caption: cap
            });
          } else {
            await this.tg('sendMessage', {
              chat_id: String(this.env.ADMIN_ID),
              text: `${infoHeader}\n\nمتن پیام:\n${m.text}\n\n💡 برای پاسخ دادن، روی همین پیام Reply کنید یا بنویسید:\n/reply ${u.id} متن شما`
            });
          }
        }
        await this.tg('sendMessage', {
          chat_id: id,
          text: m.photo && m.photo.length
            ? '✅ عکس و پیام شما به پشتیبانی ارسال شد. به زودی پاسخ داده می‌شود.'
            : '✅ پیام شما به پشتیبانی ارسال شد. به زودی پاسخ داده می‌شود.'
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
    const S = this.meta.settings, c = this.meta.crash, a = this.meta.arena, now = Date.now();
    const bad = (m) => json(400, { error: m });
    if (key.includes('/api/admin/') && !isAdmin) return json(403, { error: 'forbidden' });

    switch (key) {
      case 'GET /api/me': {
        const rawBot = String(this.env.BOT_USERNAME || '').trim().replace(/^@+/, '');
        return json(200, { user: this.pub(u), botUsername: rawBot });
      }

      case 'GET /api/state': {
        const playersList = [];
        for (const [id, entry] of Object.entries(c.bets)) {
          const pName = this.users[id]?.name || id;
          if (entry.a) {
            playersList.push({
              name: `${pName} #1${entry.a.shield ? ' 🛡️' : ''}`,
              amount: entry.a.amount,
              cashed: entry.a.cashed || null,
              wonAmount: entry.a.cashed ? r4(entry.a.winAmount ?? entry.a.amount * entry.a.cashed) : null
            });
          }
          if (entry.b) {
            playersList.push({
              name: `${pName} #2${entry.b.shield ? ' 🛡️' : ''}`,
              amount: entry.b.amount,
              cashed: entry.b.cashed || null,
              wonAmount: entry.b.cashed ? r4(entry.b.winAmount ?? entry.b.amount * entry.b.cashed) : null
            });
          }
        }

        const roundTop3 = playersList
          .filter(p => p.cashed && Number(p.wonAmount || 0) > 0)
          .sort((x, y) => Number(y.wonAmount) - Number(x.wonAmount))
          .slice(0, 3)
          .map(p => ({ name: p.name, wonAmount: r4(p.wonAmount), mult: p.cashed }));

        const arenaPlayers = (a?.players || []).map(p => ({
          id: p.id,
          name: p.name,
          amount: r4(p.amount),
          photo: this.users[p.id]?.photo || ''
        }));

        const out = {
          user: this.pub(u),
          crash: {
            phase: c.phase, id: c.id, betLeft: Math.max(0, c.betEnd - now),
            mult: c.phase === 'run' ? (Math.round(this.crashMult(now) * 100) / 100) : (c.phase === 'crashed' ? c.crashAt : 1),
            crashAt: c.phase === 'crashed' ? c.crashAt : null,
            runningMs: c.phase === 'run' ? now - c.startAt : 0,
            growth: GROWTH,
            history: this.meta.history.slice(0, 15),
            players: playersList.slice(0, 40),
            top3: roundTop3,
            my: c.bets[u.id] || null
          },
          arena: {
            players: arenaPlayers,
            pool: r4(arenaPlayers.reduce((s, p) => s + Number(p.amount || 0), 0)),
            left: a?.endAt ? Math.max(0, a.endAt - now) : null,
            joined: arenaPlayers.some(p => p.id === u.id),
            last: a?.last || null
          }
        };
        if (isAdmin) out.crash.adminNext = S.queue.slice(0, 5);
        return json(200, out);
      }

      case 'POST /api/crash/bet': {
        const slotKey = body.slot === 'b' ? 'b' : 'a';
        const amt = r4(body.amount);
        const useShield = !!body.shield;
        if (c.phase !== 'bet') return bad('ثبت شرط بسته است');
        if (!(isFinite(amt) && amt >= MIN_BET && amt <= MAX_BET)) {
          return bad(`مبلغ شرط باید بین ${fmtTon(MIN_BET)} تا ${fmtTon(MAX_BET)} TON باشد`);
        }
        const shieldFee = useShield ? r4(amt * SHIELD_RATE) : 0;
        const totalCost = r4(amt + shieldFee);
        if (totalCost > r4(u.coins + 1e-9)) return bad('موجودی TON برای شرط و سپر کافی نیست');

        const entry = c.bets[u.id] || { a: null, b: null };
        if (entry[slotKey]) return bad('این پنل شرط در این دور قبلاً ثبت شده است');

        this.applyBalance(
          u,
          -totalCost,
          'crash_bet',
          `شرط ${slotKey === 'a' ? '۱' : '۲'} کرش دور #${c.id}${useShield ? ` (+سپر ${fmtTon(shieldFee)} TON)` : ''}`,
          'completed',
          { countWager: true }
        );
        u.games++;
        if (shieldFee > 0) this.fundPromoPool(shieldFee * 0.45);
        this.addXp(u, amt * 2 + 0.1);
        this.rewardReferrer(u, amt, 0.005, 'پاداش ۰.۵٪ بازی کرش زیرمجموعه');

        entry[slotKey] = {
          amount: amt,
          shield: useShield,
          shieldFee,
          auto: Number(body.auto) > 1 ? (Math.round(Number(body.auto) * 100) / 100) : 0,
          winAmount: 0
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
        return json(200, { ok: true, mult: slot.cashed, wonAmount: slot.winAmount });
      }

      case 'POST /api/mission/claim': {
        const mid = String(body.mission || '');
        const m = (this.meta.missionsConfig || []).find(x => x.id === mid && x.enabled !== false);
        if (!m) return bad('ماموریت یافت نشد یا غیرفعال است');
        if ((u.claimedMissions || []).includes(m.id)) return bad('این ماموریت قبلاً دریافت شده است');
        if (!this.isMissionClaimable(u, m)) {
          return bad('شرایط تکمیل این ماموریت هنوز فراهم نشده است');
        }
        const paid = this.payoutFromPool(u, m.reward, `جایزه ماموریت: ${m.title}`, 'mission');
        if (paid <= 0) return bad('بودجه بونوس فعلاً تکمیل شده است');
        u.claimedMissions = [...(u.claimedMissions || []), m.id];
        this.addXp(u, 0.5);
        this.addGameLog(u, 'mission', m.title, paid);
        this.touch(u);
        return json(200, { ok: true, reward: paid });
      }

      case 'POST /api/arena/join': {
        const amt = r4(body.amount);
        if (!(isFinite(amt) && amt >= MIN_BET && amt <= MAX_BET)) {
          return bad(`مبلغ ورود به آرنا باید بین ${fmtTon(MIN_BET)} تا ${fmtTon(MAX_BET)} TON باشد`);
        }
        if (!a || !Array.isArray(a.players)) return bad('آرنا در دسترس نیست');
        if (a.players.some(p => p.id === u.id)) return bad('شما در این دور آرنا وارد شده‌اید');
        if (a.endAt && a.endAt - now < 1200) return bad('دور آرنا در حال پایان است');
        if (amt > r4(u.coins + 1e-9)) return bad('موجودی TON کافی نیست');

        this.applyBalance(u, -amt, 'arena_join', `ورود به آرنا (${fmtTon(amt)} TON)`, 'completed', { countWager: true });
        u.arenaEntries = (u.arenaEntries || 0) + 1;
        a.players.push({ id: u.id, name: u.name, amount: amt });
        if (a.players.length >= 2 && !a.endAt) {
          a.endAt = now + ARENA_WAIT;
        }
        this.rewardReferrer(u, amt, 0.005, 'پاداش ۰.۵٪ بازی آرنا زیرمجموعه');
        this.touch(u);
        this.saveMeta();
        return json(200, { ok: true, amount: amt });
      }

      case 'POST /api/ton/prepare': {
        const tonAmount = r4(body.tonAmount);
        const senderAddress = String(body.senderAddress || '').trim();
        if (!isFinite(tonAmount) || tonAmount < MIN_BET || tonAmount > MAX_BET) {
          return bad(`مبلغ واریز باید بین ${fmtTon(MIN_BET)} تا ${fmtTon(MAX_BET)} TON باشد`);
        }
        const depAddr = this.meta.tonDeposit?.address || DEFAULT_TON_DEPOSIT_ADDR;
        const fullMemo = String(this.meta.tonDeposit?.memo || DEFAULT_TON_DEPOSIT_MEMO).trim();
        const nanoAmount = String(Math.round(tonAmount * 1e9));
        const payloadBoc = textCommentToBocBase64(fullMemo);
        const orderId = 'ton_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const order = {
          id: orderId,
          uid: u.id,
          tonAmount,
          nanoAmount,
          address: depAddr,
          fullMemo,
          senderAddress,
          status: 'pending',
          created: now
        };
        this.meta.tonOrders.unshift(order);
        this.meta.tonOrders = this.meta.tonOrders.slice(0, 250);
        this.saveMeta();

        const tonkeeperUniversal = `https://app.tonkeeper.com/transfer/${depAddr}?amount=${nanoAmount}&text=${encodeURIComponent(fullMemo)}`;
        const tonDeepLink = `ton://transfer/${depAddr}?amount=${nanoAmount}&text=${encodeURIComponent(fullMemo)}`;

        return json(200, {
          ok: true,
          orderId,
          address: depAddr,
          memo: fullMemo,
          tonAmount,
          nanoAmount,
          payloadBoc,
          tonkeeperUniversal,
          tonDeepLink
        });
      }

      case 'POST /api/ton/verify': {
        const orderId = String(body.orderId || '').trim();
        const senderAddress = String(body.senderAddress || '').trim();
        const order = this.meta.tonOrders.find(o => o.id === orderId && o.uid === u.id);
        if (!order) return bad('سفارش واریز TON یافت نشد');
        if (order.status === 'completed') {
          return json(200, { ok: true, already: true, tonPaid: order.tonAmount, coins: u.coins });
        }
        if (senderAddress && !order.senderAddress) {
          order.senderAddress = senderAddress;
          this.saveMeta();
        }

        const check = await this.verifyIncomingTonTx(order);
        if (!check.ok) {
          return json(202, { ok: false, pending: true, error: check.reason });
        }

        if (this.meta.usedTonTxs.includes(check.txHash)) {
          return bad('این تراکنش قبلاً ثبت و استفاده شده است');
        }
        this.meta.usedTonTxs.unshift(check.txHash);
        this.meta.usedTonTxs = this.meta.usedTonTxs.slice(0, 500);

        order.status = 'completed';
        order.txHash = check.txHash;
        order.completedAt = now;

        const creditedTon = r4(Math.max(order.tonAmount, check.tonPaid));
        this.applyBalance(u, creditedTon, 'ton_deposit', `شارژ تاییدشده با Tonkeeper (+${fmtTon(creditedTon)} TON)`);
        this.rewardReferrer(u, creditedTon, 0.08, 'پاداش ۸٪ واریز زیرمجموعه');
        this.touch(u);
        this.saveMeta();

        await this.tg('sendMessage', {
          chat_id: u.id,
          text: `💎 واریز ${fmtTon(creditedTon)} TON با موفقیت در بلاک‌چین تایید شد!\nموجودی فعلی شما: ${fmtTon(u.coins)} TON`
        });
        if (this.env.ADMIN_ID) {
          await this.tg('sendMessage', {
            chat_id: String(this.env.ADMIN_ID),
            text: `💎 واریز تاییدشده Tonkeeper:\nکاربر: ${u.name} (${u.id})\nمبلغ: ${fmtTon(creditedTon)} TON\nممو: ${order.fullMemo}`
          });
        }

        return json(200, { ok: true, tonPaid: creditedTon, coins: u.coins });
      }

      case 'POST /api/withdraw': {
        const amount = r4(body.amount);
        const tonAddress = String(body.tonAddress || '').trim();
        if (!isFinite(amount) || amount < 0.2) return bad('حداقل مبلغ برداشت 0.2 TON است');
        if (r4(u.coins) < amount) return bad('موجودی TON کافی نیست');
        const tax = r4(amount * 0.10);
        this.fundPromoPool(tax * 0.20);
        const net = r4(amount - tax);
        const risk = this.assessWithdrawalRisk(u, amount);

        this.applyBalance(
          u,
          -amount,
          'withdraw',
          `درخواست برداشت ${fmtTon(amount)} TON (۱۰٪ مالیات: ${fmtTon(tax)} TON، خالص: ${fmtTon(net)} TON)${tonAddress ? ` • آدرس: ${tonAddress}` : ''}`,
          'pending'
        );

        const reqId = 'wd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const item = {
          id: reqId, uid: u.id, name: u.name, username: u.username || '',
          tonAddress,
          gross: amount, tax, net,
          suspicious: risk.suspicious,
          riskReasons: risk.reasons,
          status: 'pending', created: now
        };
        this.meta.withdrawals.unshift(item);
        this.meta.withdrawals = this.meta.withdrawals.slice(0, 200);
        this.touch(u);
        this.saveMeta();

        if (this.env.ADMIN_ID) {
          const riskBlock = risk.suspicious
            ? `\n\n⚠️ هشدار ضدتقلب:\n• ${risk.reasons.join('\n• ')}`
            : '\n\n✅ وضعیت حسابرسی: عادی';
          await this.tg('sendMessage', {
            chat_id: String(this.env.ADMIN_ID),
            text: `💸 درخواست برداشت جدید:\nکاربر: ${u.name} (${u.id})\nمبلغ درخواستی: ${fmtTon(amount)} TON\nمالیات ۱۰٪: ${fmtTon(tax)} TON\nقابل پرداخت خالص: ${fmtTon(net)} TON\nآدرس TON: ${tonAddress || 'وارد نشده'}${riskBlock}`
          });
        }
        return json(200, { ok: true, withdrawal: item });
      }

      case 'POST /api/wheel': {
        if (now < u.lastWheel + DAY) return bad('هنوز زمان چرخش نرسیده');
        const v = Math.random() < 0.99 ? 0.01 : 0.1;
        const paid = this.payoutFromPool(u, v, `جایزه گردونه روزانه (${fmtTon(v)} TON)`, 'wheel');
        if (paid <= 0) return bad('بودجه جایزه روزانه فعلاً تکمیل شده است');
        u.lastWheel = now;
        this.addXp(u, 0.25);
        this.addGameLog(u, 'wheel', `جایزه گردونه روزانه`, paid);
        this.touch(u);
        return json(200, { prize: paid });
      }

      case 'POST /api/tag': {
        if (now < u.lastTag + DAY) return bad('جایزه‌ی امروز گرفته شده');
        const bu = String(this.env.BOT_USERNAME || '').trim().replace(/^@+/, '');
        if (!bu) return bad('BOT_USERNAME تنظیم نشده');
        let name = u.name;
        const ch = await this.tg('getChat', { chat_id: u.id });
        if (ch) name = [ch.first_name, ch.last_name].filter(Boolean).join(' ');
        if (!name.toLowerCase().includes(bu.toLowerCase())) return bad(`@${bu} را در اسم پروفایل‌تان بگذارید`);
        const paid = this.payoutFromPool(u, 0.01, 'جایزه اسم ربات در پروفایل', 'tag');
        if (paid <= 0) return bad('بودجه جایزه فعلاً تکمیل شده است');
        u.lastTag = now;
        this.addGameLog(u, 'tag', 'جایزه اسم ربات در پروفایل', paid);
        this.touch(u);
        return json(200, { ok: true, prize: paid });
      }

      case 'GET /api/leaderboard': {
        const us = Object.values(this.users);
        const top = k => [...us].sort((a, b) => b[k] - a[k]).slice(0, 20)
          .map(x => ({ name: x.name, photo: x.photo, level: levelOf(x.xp), value: r4(x[k]) }));
        return json(200, { circulation: top('wagered'), winners: top('won'), rich: top('coins') });
      }

      case 'GET /api/admin/users':
        return json(200, {
          users: Object.values(this.users).sort((a, b) => b.created - a.created).slice(0, 200).map(x => ({
            id: x.id, name: x.name, username: x.username, coins: r4(x.coins),
            wagered: r4(x.wagered || 0), won: r4(x.won || 0),
            refCount: x.refCount || 0, refEarned: r4(x.refEarned || 0),
            streak: x.streak || 0, bestStreak: x.bestStreak || 0,
            arenaEntries: x.arenaEntries || 0, highMultStreak: x.highMultStreak || 0,
            lastIp: x.lastIp || '',
            banned: x.banned,
            audit: this.auditUser(x),
            txs: (x.txs || []).slice(0, 120),
            gameLogs: (x.gameLogs || []).slice(0, 120)
          })),
          withdrawals: this.meta.withdrawals.slice(0, 100),
          promoPool: r4(this.meta.promoPool || 0),
          tonDeposit: {
            address: this.meta.tonDeposit?.address || DEFAULT_TON_DEPOSIT_ADDR,
            memo: this.meta.tonDeposit?.memo || DEFAULT_TON_DEPOSIT_MEMO
          },
          missionsConfig: this.meta.missionsConfig || [],
          settings: { ...S, startCoins: 0 }
        });

      case 'POST /api/admin/broadcast': {
        const text = String(body.text || '').trim();
        if (!text) return bad('متن پیام همگانی را وارد کنید');
        const targets = Object.values(this.users).filter(x => !x.banned && x.id);
        let sent = 0, failed = 0;
        for (const target of targets) {
          const res = await this.tg('sendMessage', {
            chat_id: target.id,
            text: `📢 اطلاعیه Tonia:\n${text}`
          });
          if (res) sent++;
          else failed++;
        }
        return json(200, { ok: true, sent, failed, total: targets.length });
      }

      case 'POST /api/admin/coins': {
        const t = this.findUserByQuery(body.id), amt = r4(body.amount);
        if (!t || !isFinite(amt) || amt === 0) return bad('کاربر (آیدی یا یوزرنیم) یا مقدار TON نامعتبر است');
        const actual = this.applyBalance(t, amt, 'admin_coins', 'تغییر دستی موجودی TON توسط ادمین');
        this.touch(t);
        await this.tg('sendMessage', {
          chat_id: t.id,
          text: `${actual >= 0 ? '➕' : '➖'} ${fmtTon(Math.abs(actual))} TON ${actual >= 0 ? 'به حساب شما اضافه' : 'از حساب شما کم'} شد.\nموجودی فعلی: ${fmtTon(t.coins)} TON`
        });
        return json(200, { ok: true, coins: t.coins });
      }

      case 'POST /api/admin/bulk_coins': {
        const amt = r4(body.amount);
        if (!isFinite(amt) || amt === 0) return bad('مقدار TON نامعتبر است');
        const allUsers = Object.values(this.users);
        let count = 0;
        for (const target of allUsers) {
          const actual = this.applyBalance(
            target,
            amt,
            'admin_bulk',
            amt >= 0 ? `افزایش همگانی توسط ادمین (+${fmtTon(amt)} TON)` : `کاهش همگانی توسط ادمین (${fmtTon(amt)} TON)`
          );
          if (actual !== 0) count++;
        }
        return json(200, { ok: true, updatedCount: count, delta: amt });
      }

      case 'POST /api/admin/bonus': {
        const delta = r4(body.delta);
        if (!isFinite(delta) || delta === 0) return bad('مقدار تغییر بونوس نامعتبر است');
        this.meta.promoPool = Math.max(0, r4((this.meta.promoPool || 0) + delta));
        this.saveMeta();
        return json(200, { ok: true, promoPool: this.meta.promoPool });
      }

      case 'POST /api/admin/ton_config': {
        const address = String(body.address || '').trim();
        const memo = String(body.memo || '').trim();
        if (!address || address.length < 10) return bad('آدرس TON معتبر وارد کنید');
        if (!memo) return bad('ممو (Memo) معتبر وارد کنید');
        this.meta.tonDeposit = { address, memo };
        this.saveMeta();
        return json(200, { ok: true, tonDeposit: this.meta.tonDeposit });
      }

      case 'POST /api/admin/mission_add': {
        const title = String(body.title || '').trim();
        const type = ['referral', 'crash_streak_4x', 'arena_streak'].includes(body.type) ? body.type : 'referral';
        const target = Math.max(1, Math.floor(Number(body.target || 1)));
        const reward = r4(Number(body.reward || 0.01));
        const minStreak = Math.max(0, Math.floor(Number(body.minStreak || 0)));
        const minStake = r4(Math.max(0, Number(body.minStake || 0)));
        const minMult = Number(Math.max(0, Number(body.minMult || 0)));
        if (!title) return bad('عنوان ماموریت را وارد کنید');
        if (!isFinite(reward) || reward <= 0) return bad('مبلغ جایزه TON باید بزرگ‌تر از صفر باشد');
        const newM = {
          id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          type,
          title,
          desc: String(body.desc || title).trim(),
          target,
          minStake,
          minMult,
          minStreak,
          reward,
          enabled: true
        };
        this.meta.missionsConfig = [...(this.meta.missionsConfig || []), newM];
        this.saveMeta();
        return json(200, { ok: true, mission: newM, missionsConfig: this.meta.missionsConfig });
      }

      case 'POST /api/admin/mission_remove': {
        const mid = String(body.id || '').trim();
        if (!mid) return bad('شناسه ماموریت نامعتبر است');
        this.meta.missionsConfig = (this.meta.missionsConfig || []).filter(m => m.id !== mid);
        this.saveMeta();
        return json(200, { ok: true, missionsConfig: this.meta.missionsConfig });
      }

      case 'POST /api/admin/mission_toggle': {
        const mid = String(body.id || '').trim();
        const m = (this.meta.missionsConfig || []).find(x => x.id === mid);
        if (!m) return bad('ماموریت یافت نشد');
        m.enabled = m.enabled === false ? true : false;
        this.saveMeta();
        return json(200, { ok: true, mission: m });
      }

      case 'POST /api/admin/withdraw': {
        const wid = String(body.id || ''), act = body.action;
        const adminNote = String(body.note || '').trim();
        const idx = this.meta.withdrawals.findIndex(w => w.id === wid);
        if (idx === -1) return bad('درخواست یافت نشد');
        const w = this.meta.withdrawals[idx];
        if (w.status !== 'pending') return bad('قبلاً بررسی شده است');
        const targetUser = this.users[w.uid];
        if (act === 'approve') {
          w.status = 'approved';
          w.adminNote = adminNote;
          w.decidedAt = now;
          if (targetUser) {
            const tx = (targetUser.txs || []).find(t => t.status === 'pending' && t.source === 'withdraw' && Math.abs(t.amount) === w.gross);
            if (tx) {
              tx.status = 'approved';
              tx.note = `${tx.note} • واریز TON تایید شد${adminNote ? ` • پیام ادمین: ${adminNote}` : ''}`;
            }
            this.touch(targetUser);
            const msgLines = [
              `✅ برداشت ${fmtTon(w.gross)} TON شما (خالص ${fmtTon(w.net)} TON پس از ۱۰٪ مالیات) تایید و واریز شد.`
            ];
            if (w.tonAddress) msgLines.push(`آدرس TON: ${w.tonAddress}`);
            if (adminNote) msgLines.push(`💬 پیام ادمین: ${adminNote}`);
            await this.tg('sendMessage', { chat_id: targetUser.id, text: msgLines.join('\n') });
          }
        } else if (act === 'reject') {
          w.status = 'rejected';
          w.adminNote = adminNote;
          w.decidedAt = now;
          if (targetUser) {
            const pendingTx = (targetUser.txs || []).find(t => t.status === 'pending' && t.source === 'withdraw' && Math.abs(t.amount) === w.gross);
            if (pendingTx) pendingTx.status = 'rejected';
            this.applyBalance(
              targetUser,
              w.gross,
              'withdraw_refund',
              `بازگشت وجه برداشت ردشده (${fmtTon(w.gross)} TON)${adminNote ? ` • پیام ادمین: ${adminNote}` : ''}`
            );
            this.touch(targetUser);
            const msgLines = [
              `❌ درخواست برداشت ${fmtTon(w.gross)} TON شما رد شد و مبلغ به موجودی بازگشت.`
            ];
            if (adminNote) msgLines.push(`💬 پیام ادمین: ${adminNote}`);
            await this.tg('sendMessage', { chat_id: targetUser.id, text: msgLines.join('\n') });
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
        S.queue = (body.queue || []).map(Number).filter(n => n >= 1 && n <= 1000).map(n => Math.round(n * 100) / 100).slice(0, 50);
        this.saveMeta();
        return json(200, { ok: true, queue: S.queue });

      case 'POST /api/admin/settings':
        if (body.minMult >= 1) S.minMult = Number(body.minMult);
        if (body.maxMult >= 1.1) S.maxMult = Math.min(25, Number(body.maxMult));
        if (body.edge >= 0 && body.edge < 0.5) S.edge = Number(body.edge);
        if (body.greed >= 0 && body.greed <= 1) S.greed = Number(body.greed);
        S.startCoins = 0;
        if (body.promoPool !== undefined && Number(body.promoPool) >= 0) this.meta.promoPool = r4(Number(body.promoPool));
        this.saveMeta();
        return json(200, { ok: true, settings: S, promoPool: this.meta.promoPool });
    }
    return json(404, { error: 'not found' });
  }
}
