// make.fun bounty u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1 — "Tiny Bot, Easy $2".
//
// A long-only EMA(5)/EMA(13) crossover bot for the bars-replay/v1 protocol.
// Nothing is tuned to the dev window: two spans, one take-profit, one stop-loss,
// one stake rule for every symbol, no hard-coded prices or dates, no network,
// no clock, no randomness — deterministic given the bars.
//
//   import { runBars } from './vendor/makefun-bars.ts';
//
//   - Indicators, per symbol over its own closes: EMA(5) and EMA(13), each
//     seeded as the mean of its first span of closes, then moving
//     2 / (span + 1) of the way to each new close (float64). Bars whose volume
//     is exactly 0 update nothing and signal nothing.
//   - Per-symbol state: flat or long. Flat + EMA(5) crossing above EMA(13) → long
//     (entry candidate). Long → exit the whole position when the sticky exit
//     signal is set (EMA(13) crossed above EMA(5); the signal is held while it
//     persists, so a refused sell is retried on the next bar), or the position is
//     worth >= 25% over its cost at the close, or >= 10% under it (stop-loss).
//   - Stake: equity over n slots, n = min(symbols, caps.max_open_positions); each
//     buy the smallest of equity / n, caps.max_weight_bps of equity and the cash
//     this reply has not spent yet; below fees.min_notional_quote_units buy nothing.
//   - Sells first, then buys in universe order, at most caps.max_orders_per_bar
//     orders per batch. max_slippage_bps 100 (1%) on every order.

import {
  BPS,
  runBars,
  type BarsState,
  type Batch,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

const FAST_BARS = 5;
const SLOW_BARS = 13;
// worth >= 25% over cost: value * 4 >= cost * 5
const TAKE_NUM = 5n;
const TAKE_DEN = 4n;
// worth <= 10% under cost: value * 10 <= cost * 9
const STOP_NUM = 9n;
const STOP_DEN = 10n;
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
  /** Fresh: the fast EMA crossed above the slow EMA on this bar. */
  crossUp: boolean;
  /** Sticky exit signal: the slow EMA crossed above the fast, held while fast < slow. */
  exit: boolean;
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
      exit: false,
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
  if (s.curr !== null && s.prev !== null) {
    if (s.curr > 0 && s.prev <= 0) s.crossUp = true;
    if (s.curr < 0) s.exit = true; // cross just happened, or the signal persists
    else s.exit = false;
  }
  return s;
}

/** Whether the held position exits on this close: the sticky sell signal, the take-profit or the stop-loss. */
function exits(
  state: BarsState,
  symbol: string,
  held: { qty: bigint; cost: bigint },
  exit: boolean,
): boolean {
  if (exit) return true;
  const value = state.value(symbol, held.qty);
  if (value === 0n) return false;
  return (
    value * TAKE_DEN >= held.cost * TAKE_NUM || value * STOP_DEN <= held.cost * STOP_NUM
  );
}

await runBars({
  onBatch(state, batch) {
    const entries: string[] = [];
    for (const bar of batch.bars) {
      const s = onBar(bar);
      if (s !== null && s.crossUp) entries.push(bar.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const s = states.get(symbol);
        const exit = s !== undefined ? s.exit : false;
        if (exits(state, symbol, held, exit)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }

    const orders: (SellInput | BuyInput)[] = sells;
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let spend = stake < byWeight ? stake : byWeight;
    const minNotional = BigInt(fees.min_notional_quote_units);
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      if (state.positions.has(symbol)) continue;
      let size = spend;
      if (cash < size) size = cash;
      if (size === 0n || size < minNotional) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= size;
      room -= 1;
    }
    return orders;
  },
});
