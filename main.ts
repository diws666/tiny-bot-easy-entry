// make.fun bounty u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1 — "Tiny Bot, Easy $2", v2.
//
// A long-only EMA(8)/EMA(21) crossover bot for the bars-replay/v1 protocol that
// trades little and wins often: a 0.3% gap hysteresis plus a second-bar
// confirmation keep it out of choppy, whipsaw-prone entries.
// Nothing is tuned to the dev window: two spans, one hysteresis, one
// take-profit, one stop-loss, one stake rule for every symbol, no hard-coded
// prices or dates, no network, no clock, no randomness — deterministic given
// the bars.
//
//   import { runBars } from './vendor/makefun-bars.ts';
//
//   - Indicators, per symbol over its own closes: EMA(8) and EMA(21), each
//     seeded as the mean of its first span of closes, then moving
//     2 / (span + 1) of the way to each new close (float64). Bars whose volume
//     is exactly 0 update nothing and signal nothing.
//   - Entry (long only, on a symbol not held): EMA(8) crosses above EMA(21)
//     AND the gap (fast - slow) exceeds 0.3% of the close price AND the cross
//     is confirmed on a second consecutive bar (fast still above slow with
//     gap > 0.3%). A buy the market refuses is not retried blindly: the next
//     cross is needed.
//   - Exit the whole position when EMA(21) crosses above EMA(8) with the same
//     0.3% gap on the other side, confirmed on a second bar — the exit signal
//     is held while fast stays below slow, so a refused sell is retried on the
//     next bar — or the position is worth >= 30% over its cost at the close
//     (take-profit), or >= 8% under it (stop-loss).
//   - Stake: equity over n slots, n = min(symbols, caps.max_open_positions);
//     each buy the smallest of equity / n, caps.max_weight_bps of equity and
//     the cash this reply has not spent yet; below fees.min_notional_quote_units
//     buy nothing.
//   - Sells first, then buys in universe order, at most caps.max_orders_per_bar
//     orders per batch. max_slippage_bps 100 (1%) on every order. No orders
//     while state.warmingUp.
//

import {
  BPS,
  runBars,
  type BarsState,
  type Batch,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
// worth >= 30% over cost: value * 10 >= cost * 13
const TAKE_NUM = 13n;
const TAKE_DEN = 10n;
// worth <= 8% under cost: value * 25 <= cost * 23
const STOP_NUM = 23n;
const STOP_DEN = 25n;
// hysteresis: gap must exceed 0.3% of the close
const HYSTERESIS = 0.003;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  /** Closes collected until the span is full; then the seeded mean. */
  acc: number[];
  value: number | null;
}

interface SymbolState {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the previous bar of this symbol, once both are set. */
  prev: number | null;
  /** fast - slow after this bar, once both are set. */
  curr: number | null;
  /** A fresh upward cross (fast crossed above slow) on this bar. */
  crossUp: boolean;
  /** A fresh downward cross (slow crossed above fast) on this bar. */
  crossDown: boolean;
  /** An upward cross has armed an entry, awaiting its confirming bar. Stays
   * armed while the trend holds, so a buy the market refuses is retried on
   * the next bar, just like a refused sell. Cleared by a downward cross. */
  pendingEntry: boolean;
  /** The previous bar was bullish (gap > 0 and gap > 0.3% of close). */
  bullishPrev: boolean;
  /** The previous bar was bearish (gap < 0 and gap > 0.3% of close). */
  bearishPrev: boolean;
  /** A downward cross has armed the exit, awaiting its confirming bar. */
  exitArmed: boolean;
  /** Sticky exit signal: set on a confirmed downward cross, held while fast < slow. */
  exit: boolean;
  /** True this bar: entry confirmed (two consecutive bullish bars after a cross). */
  entrySig: boolean;
}

const states = new Map<string, SymbolState>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.acc.push(close);
  if (e.acc.length === e.span) {
    let sum = 0;
    for (const x of e.acc) sum += x;
    e.value = sum / e.span;
  }
}

/** Fold one bar into its symbol's EMA state. Zero-volume bars are skipped entirely. */
function onBar(bar: Batch['bars'][number]): SymbolState | null {
  if (bar.v === '0') return null;
  let s = states.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, acc: [], value: null },
      slow: { span: SLOW_BARS, acc: [], value: null },
      prev: null,
      curr: null,
      crossUp: false,
      crossDown: false,
      pendingEntry: false,
      bullishPrev: false,
      bearishPrev: false,
      exitArmed: false,
      exit: false,
      entrySig: false,
    };
    states.set(bar.symbol, s);
  }
  const close = Number(bar.c);
  step(s.fast, close);
  step(s.slow, close);
  s.prev = s.curr;
  s.curr =
    s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  s.crossUp = false;
  s.crossDown = false;
  if (s.curr !== null && s.prev !== null) {
    if (s.curr > 0 && s.prev <= 0) s.crossUp = true;
    if (s.curr < 0 && s.prev >= 0) s.crossDown = true;
  }
  const bullish =
    s.curr !== null && s.curr > 0 && s.curr > HYSTERESIS * close;
  const bearish =
    s.curr !== null && s.curr < 0 && -s.curr > HYSTERESIS * close;
  // Entry: a fresh upward cross arms the symbol; two consecutive bullish bars
  // (the cross bar itself counts if it already clears the hysteresis)
  // confirm the entry. The arming is sticky while the trend holds: a buy the
  // market refuses is retried on the next bar, just like a refused sell. A
  // downward cross disarms it; a filled buy is skipped because the symbol is
  // then held.
  if (s.crossUp) s.pendingEntry = true;
  if (s.crossDown) s.pendingEntry = false;
  s.entrySig = s.pendingEntry && s.bullishPrev && bullish;
  s.bullishPrev = bullish;
  // Exit: a fresh downward cross arms the exit; two consecutive bearish bars
  // confirm it, and the signal is held while fast stays below slow.
  if (s.crossDown) s.exitArmed = true;
  const exitSig = s.exitArmed && s.bearishPrev && bearish;
  if (exitSig) s.exit = true;
  if (s.curr !== null && s.curr >= 0) {
    s.exit = false;
    s.exitArmed = false;
  }
  s.bearishPrev = bearish;
  return s;
}

/** Whether the held position exits on this close: the sticky sell signal, the
 * take-profit at +30% or the stop-loss at -8%. */
function exits(
  state: BarsState,
  symbol: string,
  held: { qty: bigint; cost: bigint },
  exit: boolean,
): boolean {
  if (exit) return true;
  const value = state.value(symbol, held.qty);
  if (value === 0n) return false;
  return value * TAKE_DEN >= held.cost * TAKE_NUM || value * STOP_DEN <= held.cost * STOP_NUM;
}

await runBars({
  onBatch(state, batch) {
    const entries: string[] = [];
    for (const bar of batch.bars) {
      const s = onBar(bar);
      if (s !== null && s.entrySig) entries.push(bar.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const s = states.get(symbol);
        if (s !== undefined && exits(state, symbol, held, s.exit)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    const minNotional = BigInt(fees.min_notional_quote_units);
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      if (state.positions.has(symbol)) continue;
      let size = stake < byWeight ? stake : byWeight;
      if (cash < size) size = cash;
      if (size === 0n) break;
      if (size < minNotional) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= size;
      room -= 1;
    }
    return orders;
  },
});
