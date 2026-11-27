# Second-Leg Momentum Rider — Pump Paper r2

[![Pump.fun Replay Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=makefun)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/agentic-404/pump-paper-jackxyz72-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/agentic-404/pump-paper-jackxyz72-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A momentum rider for the pump.fun paper-trading replay, round 2. Round 1
("Pump Paper Rider", strict momentum) scored −0.048 SOL on the dev window:
forward momentum is real price-only, but the 2-slot fill latency buys the
spike top and the winners are too rare to carry the losers. Round 2 keeps
the confirmed-momentum entry and changes the three things the data says
matter: a tighter stop, a second leg, and a smaller stake.

Strategy: buy a coin once its price is up at least 1.5x over the last 50
slots, on a curve holding at least 2 SOL of real reserve, with at least 3
distinct buyers and a creator who has not sold. One 0.05 SOL buy per leg,
no top-ups — adding into strength lost more the bigger the adds. Exit on a
hard −25% stop under blended basis, a −35% trailing stop armed at +50%, or
a 400-slot time limit. After any exit the same coin may be entered again
after a 50-slot cooldown: the second leg is the edge. Dip-recovery and
launch sniping were measured and rejected (0% of dipped coins recover to
peak; snipers cap at about −0.26 SOL).

Measured on the dev window with an offline simulator validated against the
official grader (±0.1 SOL): +0.113 SOL net, 125 round trips, 26% win rate,
110 distinct mints, max drawdown 0.374 SOL. Per-part scores: −0.083 /
−0.157 / +0.355 SOL (worst part −0.157). The strategy is deterministic:
no clock, no environment, no randomness — every decision is a pure
function of the event stream.
