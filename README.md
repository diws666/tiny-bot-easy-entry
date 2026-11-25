# tiny-bot-easy-entry

Long-only EMA(8)/EMA(21) crossover paper-trading bot for the make.fun bounty "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" (u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1). Trades FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH and WIF on 1h bars with one rule set for every symbol — no per-symbol tuning, no hard-coded prices or dates, no network, no clock, no randomness: two runs produce byte-identical action logs.

v2 trades less and aims to win more often than v1:

- Indicators, per symbol over its own closes: EMA(8) and EMA(21), each seeded as the mean of its first span of closes, then moving 2 / (span + 1) of the way to each new close (float64). Bars whose volume is exactly 0 update nothing and signal nothing.
- Entry (long only, on a symbol not held): EMA(8) crosses above EMA(21) AND the gap (fast - slow) exceeds 0.3% of the close price (hysteresis against whipsaw) AND the cross is confirmed on a second consecutive bar (fast still above slow with gap > 0.3%). Entry arming is sticky, so a buy the market refuses is retried on the next bar while the trend holds.
- Exit the whole position when EMA(21) crosses above EMA(8) with the same 0.3% gap on the other side, confirmed on a second bar — the exit signal is held while fast stays below slow, so a refused sell is retried on the next bar — or the position is worth >= 30% over its cost at the close (take-profit), or >= 8% under it (stop-loss).
- Stake: equity over n slots, n = min(symbols, caps.max_open_positions); each buy the smallest of equity / n, caps.max_weight_bps of equity and the cash this reply has not spent yet; below fees.min_notional_quote_units buy nothing.
- Sells first, then buys in universe order, at most caps.max_orders_per_bar orders per batch. max_slippage_bps 100 (1%) on every order. No orders while state.warmingUp.

[![Bounty](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/diws666/tiny-bot-easy-entry/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/diws666/tiny-bot-easy-entry/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Bounty: https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1
