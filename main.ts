// Second-Leg Momentum Rider — pump.fun paper-trading replay bot, round 2.
//
// Idea, measured on the dev window (not theory):
//   * Price-only momentum is real (+55-82% mean forward return at fixed horizons),
//     but it only survives execution when the entry is late and confirmed, the stake
//     is small, the stop is tight, and the coin gets a second chance: most coins
//     spike, cool off, then spike again. Buying the first spike loses to latency;
//     catching the second leg after a cooldown is what makes the dev score positive.
//   * Dip-recovery is dead (0% of dipped coins ever return to peak) and adding into
//     strength is dead (pyramids lose more the bigger the adds). So: one small
//     buy per leg, no top-ups, tight stop, wide trailing stop, hard time limit.
//
// Entry (first trigger per coin, or re-entry after cooldown):
//   price up >= 1.5x over the last 50 slots, real reserve >= 2 SOL, at least
//   3 distinct buyers, creator has not sold. Stake 0.05 SOL.
// Exits: hard stop -25% under blended basis; trailing stop arms at +50% over
//   basis and trails -35% from the best marked value; no take-profit;
//   max hold 400 slots. After any exit, the same coin may be entered again
//   after a 50-slot cooldown.
// Determinism: no clock, no environment, no Math.random; every decision is a
// pure function of the event stream and hello.seed (unused).

import { runBot, LAMPORTS_PER_SOL, BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// ---- tuned constants (dev window; see README for the numbers behind them) ----
const WINDOW_SLOTS = 50;          // momentum lookback
const UP_NUM = 3n;                // price must rise by UP_NUM / UP_DEN ...
const UP_DEN = 2n;                // ... = 1.5x over the window
const MIN_HISTORY_SLOTS = 25;     // need at least this much history to trigger
const MIN_RQ_SOL = 2;             // real quote reserve at entry, in SOL
const MIN_BUYERS = 3;             // distinct non-creator buyers seen
const STAKE_SOL = 0.05;           // SOL per buy (single buy per leg, no top-ups)
const MIN_ORDER_LAMPORTS = 5_000_000n; // 0.005 SOL floor per order
const STOP_LOSS_BPS = 2500;       // hard stop: -25% under blended basis
const TRAIL_ARM_BPS = 5000;       // trailing stop arms at +50% over basis
const TRAIL_BPS = 3500;           // ... and trails -35% from the best value
const MAX_HOLD_SLOTS = 400;       // hard time limit per position
const BUY_SLIPPAGE_BPS = 5000;    // slippage allowed on buys
const SELL_SLIPPAGE_BPS = 10_000; // sells always exit at any price
const REENTRY_COOLDOWN_SLOTS = 50;
const FEE_BPS = 125n;             // protocol 95 + creator 30, charged on fills

const STAKE_LAMPORTS = BigInt(Math.round(STAKE_SOL * 1_000_000_000));
const MIN_RQ_LAMPORTS = BigInt(MIN_RQ_SOL) * LAMPORTS_PER_SOL;

// Mark-to-market sell value of `tokens` against reserves, net of the 125 bps
// curve fee (the tx fee is applied by the caller, since it is per-order).
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const quote = (tokens * vq) / (vt + tokens);
  return quote - (quote * FEE_BPS + BPS - 1n) / BPS;
}

interface PricePoint {
  slot: number;
  vq: bigint;
  vt: bigint;
}

interface Coin {
  mint: Pubkey;
  creator: Pubkey;
  buyers: Set<Pubkey>;
  devSold: boolean;
  done: boolean;
  complete: boolean;
  buys: number;
  coolUntil: number;
  hist: PricePoint[];
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
}

// The strategy closure is built once (module scope) so the bot stays a pure
// function of the stream.
const ctx = makeStrategy();

function makeStrategy() {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell') return true;
    }
    return false;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    // ---- ingest the batch: create / trade / complete events ----
    const touched: Pubkey[] = [];
    const seenTouched = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            mint: e.mint,
            creator: e.creator,
            buyers: new Set(),
            devSold: false,
            done: false,
            complete: false,
            buys: 0,
            coolUntil: -1,
            hist: [],
          });
        }
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (!c) continue;
        c.hist.push({
          slot: e.slot,
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
        });
        if (c.hist.length > 400) c.hist.splice(0, c.hist.length - 400);
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
        if (!seenTouched.has(e.mint)) {
          seenTouched.add(e.mint);
          touched.push(e.mint);
        }
      } else {
        // CompleteEvent: the curve is done; never touch this mint again.
        const c = coins.get(e.mint);
        if (c) {
          c.complete = true;
          c.done = true;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // Latest marks for held / pending mints.
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, {
        vq: BigInt(m.virtual_quote_reserves),
        vt: BigInt(m.virtual_token_reserves),
      });
    }

    // ---- fills: track tx fees paid and drop closed positions ----
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // Internal (harness) fills are not our orders.
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) {
        h.txPaid += BigInt(f.tx_fee_lamports);
      }
      if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
        held.set(f.mint, {
          openedSlot: f.slot,
          txPaid: BigInt(f.tx_fee_lamports),
          best: 0n,
        });
      }
    }
    for (const mint of [...selling]) {
      if (!hasPendingSell(state, mint)) selling.delete(mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) {
        held.delete(mint);
      }
    }

    // ---- exits: hard stop, trailing stop, time limit ----
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx, best: 0n };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const cv = state.curves.get(mint);
        if (cv === undefined) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (value > h.best) h.best = value;
      let exit = false;
      if (basis > 0n) {
        if (value * BPS <= basis * (BPS - BigInt(STOP_LOSS_BPS))) exit = true;
        if (
          h.best * BPS >= basis * (BPS + BigInt(TRAIL_ARM_BPS)) &&
          value * BPS <= h.best * (BPS - BigInt(TRAIL_BPS))
        ) {
          exit = true;
        }
      }
      if (state.slot - h.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      selling.add(mint);
      const c = coins.get(mint);
      if (c !== undefined) {
        // Allow a fresh entry after the cooldown: the second leg is the edge.
        c.buys = 0;
        c.coolUntil = state.slot + REENTRY_COOLDOWN_SLOTS;
      }
    }

    // ---- entries: momentum trigger on touched coins, plus re-entries ----
    // Only coins touched by this batch's trades (or already held) can trigger:
    // scanning every known coin every slot would be O(n^2) over the window.
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    const candidates = new Set<Pubkey>(touched);
    for (const mint of state.positions.keys()) candidates.add(mint);
    for (const mint of candidates) {
      if (orders.length >= cap) break;
      const c = coins.get(mint);
      if (!c || c.done || c.complete) continue;
      if (state.slot < c.coolUntil) continue; // re-entry cooldown
      const curve = state.curves.get(c.mint);
      if (!curve || curve.complete) continue;
      if (state.positions.has(c.mint)) continue; // already holding this coin
      if (selling.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
      if (open >= state.hello.caps.max_open_positions) continue;

      // Momentum: price now vs the oldest point in the window.
      const from = state.slot - WINDOW_SLOTS;
      while (c.hist.length > 0 && c.hist[0]!.slot < from) c.hist.shift();
      const ago = c.hist.length > 0 ? c.hist[0]! : null;
      if (!ago || state.slot - ago.slot < MIN_HISTORY_SLOTS) continue;
      const nowVq = curve.virtual_quote_reserves;
      const nowVt = curve.virtual_token_reserves;
      // nowVq/nowVt >= (ago.vq/ago.vt) * 1.5, in integer math.
      if (nowVq * ago.vt * UP_DEN < ago.vq * nowVt * UP_NUM) continue;

      // Filters: skip coins whose creator sold, thin curves, thin crowds.
      if (c.devSold) {
        c.done = true;
        continue;
      }
      if (curve.real_quote_reserves < MIN_RQ_LAMPORTS) continue;
      if (c.buyers.size < MIN_BUYERS) continue;

      // Size: one 0.05 SOL buy, capped at 1% of real reserve (harness cap).
      const maxBuy = state.maxBuyLamports(c.mint);
      const amount = STAKE_LAMPORTS < maxBuy ? STAKE_LAMPORTS : maxBuy;
      if (amount < MIN_ORDER_LAMPORTS) continue;
      if (free < amount + tx) continue;
      orders.push({
        side: 'buy',
        mint: c.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + tx;
      c.buys += 1;
      open += 1;
    }
    return orders;
  }

  return { onBatch };
}

await runBot({
  onBatch(state, batch) {
    return ctx.onBatch(state, batch);
  },
});
