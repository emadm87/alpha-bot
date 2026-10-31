"""ALPHA BOT 007B (independent implementation, Python) - exit-rule sensitivity on Hyperliquid 15m candles (research only, read-only data).
Entries are generated (every 4 h, LONG and SHORT, every market): they stand for 'any entry', since entries
are Gemini's decision. Results are in R (risk units) and in bps of notional, net of taker fees, spread,
slippage and funding. Hold-out: no window touches 2026-10-28 00:00 UTC or later (the 30 Oct pilot day)."""
import json, sys, math
import numpy as np
import gzip, csv, os
W = sys.argv[1]   # the data directory (research/exit-rules/data)

def load_committed(d):
    """The committed data set, in the shape of the original market.json of Task 007B."""
    out = {'candles': {}, 'funding': {}, 'books': {}}
    with gzip.open(os.path.join(d, 'candles-15m.csv.gz'), 'rt') as f:
        for r in csv.DictReader(f):
            out['candles'].setdefault(r['coin'], []).append({'t': int(r['open_time']), 'o': r['open'], 'h': r['high'], 'l': r['low'], 'c': r['close']})
    with gzip.open(os.path.join(d, 'funding-1h.csv.gz'), 'rt') as f:
        for r in csv.DictReader(f):
            out['funding'].setdefault(r['coin'], []).append({'time': int(r['time']), 'fundingRate': r['funding_rate']})
    for c, snaps in json.load(open(os.path.join(d, 'books.json'))).items():
        out['books'][c] = [{'levels': [b['bids'], b['asks']]} for b in snaps]
    return out

D = load_committed(W)
COINS = ['BTC','ETH','SOL','BNB','XRP','DOGE']
FEE = 0.00045                     # Hyperliquid perp taker, base tier, per side
H = 96                            # max holding: 24 h of 15 m bars
STEP = 16                         # one entry every 4 h
import datetime as _dt
HOLDOUT = int(_dt.datetime(2026, 10, 28, tzinfo=_dt.timezone.utc).timestamp() * 1000)  # 2026-10-28T00:00:00Z
SLIP = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0002  # extra slippage on market stop exits (2 bps)

def arr(c):
    rows = sorted(D['candles'][c], key=lambda r: r['t'])
    t = np.array([r['t'] for r in rows], dtype=np.int64)
    o, h, l, cl = (np.array([float(r[k]) for r in rows]) for k in 'ohlc')
    return t, o, h, l, cl

def book_stats(c):
    sp, d1 = [], []
    for b in D['books'][c]:
        bid, ask = float(b['levels'][0][0]['px']), float(b['levels'][1][0]['px'])
        mid = (bid + ask) / 2
        sp.append((ask - bid) / mid)
        d1.append(min(sum(float(x['px']) * float(x['sz']) for x in b['levels'][s][:5]) for s in (0, 1)))
    return float(np.median(sp)), float(np.median(d1))

def funding_series(c):
    rows = D['funding'][c]
    rates = {int(r['time']) // 3600000 * 3600000: float(r['fundingRate']) for r in rows}
    return rates, float(np.mean(list(rates.values())))

MK = {}
for c in COINS:
    t, o, h, l, cl = arr(c)
    # 1 h bars from 4 aligned 15 m bars
    hour = t // 3600000
    starts = [i for i in range(len(t) - 3) if t[i] % 3600000 == 0 and hour[i + 3] == hour[i]]
    hh = np.array([h[i:i+4].max() for i in starts]); hl = np.array([l[i:i+4].min() for i in starts])
    hc = np.array([cl[i+3] for i in starts]); hend = np.array([t[i] + 3600000 for i in starts])  # close time
    tr = np.maximum(hh - hl, np.maximum(abs(hh - np.r_[hc[0], hc[:-1]]), abs(hl - np.r_[hc[0], hc[:-1]])))
    atr = np.full(len(tr), np.nan); atr[13] = tr[:14].mean()
    for k in range(14, len(tr)): atr[k] = (atr[k-1] * 13 + tr[k]) / 14   # Wilder ATR(14)
    sp, depth = book_stats(c)
    rates, mean_rate = funding_series(c)
    MK[c] = dict(t=t, o=o, h=h, l=l, c=cl, hh=hh, hl=hl, hend=hend, atr=atr, spread=sp, depth=depth, rates=rates, mean_rate=mean_rate)

def context(c, i):
    """ATR and 24 h structure known at the close of 15 m bar i (completed 1 h bars only)."""
    m = MK[c]; close_time = m['t'][i] + 900000
    k = np.searchsorted(m['hend'], close_time, side='right') - 1
    if k < 37 or np.isnan(m['atr'][k]): return None
    return dict(atr=m['atr'][k], lo24=m['hl'][k-23:k+1].min(), hi24=m['hh'][k-23:k+1].max())

def stop_distance(rule, c, i, side, entry, ctx):
    a = ctx['atr']
    if rule[0] == 'F': return entry * rule[1]
    if rule[0] == 'A': return rule[1] * a
    if rule[0] == 'S':  # structure: beyond the 24 h swing low/high + 0.25 ATR, kept within [1, 4] ATR
        raw = (entry - ctx['lo24'] + 0.25 * a) if side > 0 else (ctx['hi24'] - entry + 0.25 * a)
        return min(max(raw, 1.0 * a), 4.0 * a)
    raise ValueError(rule)

def simulate(c, i, side, srule, mgmt, horizon=H):
    m = MK[c]; ctx = context(c, i)
    if ctx is None or i + horizon >= len(m['t']): return None
    hs = m['spread'] / 2
    entry = m['c'][i] * (1 + side * hs)
    d = stop_distance(srule, c, i, side, entry, ctx)
    if not d > 0: return None
    j0, j1 = i + 1, i + 1 + horizon
    if side > 0:
        fav = (m['h'][j0:j1] - entry) / d; adv = (m['l'][j0:j1] - entry) / d
        op = (m['o'][j0:j1] - entry) / d; clo = (m['c'][j0:j1] - entry) / d
    else:
        fav = (entry - m['l'][j0:j1]) / d; adv = (entry - m['h'][j0:j1]) / d
        op = (entry - m['o'][j0:j1]) / d; clo = (entry - m['c'][j0:j1]) / d
    atrR = ctx['atr'] / d
    n = len(fav)
    peak_prev = np.r_[-np.inf, np.maximum.accumulate(fav)[:-1]]   # best excursion known before each bar
    kind, frac, legs = mgmt[0], 0.0, []
    def first(mask):
        idx = np.flatnonzero(mask); return int(idx[0]) if len(idx) else None
    def floor_path(start, base):
        """stop level per bar for a trailing or staged rule, from the peak known before the bar"""
        pk = peak_prev
        if kind == 'BETR':   # Task 007A defaults: -1R, break-even after +1R, 50% of the peak after +2R
            lv = np.where(pk >= 2, 0.5 * pk, np.where(pk >= 1, 0.0, -1.0))
        elif kind == 'CH':   # chandelier: peak - k ATR (from the start, or after +1R with break-even)
            k, after = mgmt[1], mgmt[2]
            ch = pk - k * atrR
            lv = np.maximum(-1.0, ch) if after == 0 else np.where(pk >= after, np.maximum(0.0, ch), -1.0)
        elif kind == 'PREST':  # remainder after a partial: break-even, then chandelier 3 ATR
            lv = np.maximum(0.0, pk - 3.0 * atrR)
        else:
            lv = np.full(n, -1.0)
        return lv
    def exit_at(lv, tp=None, start=0):
        """first exit from bar `start`: stop level lv (array) or take profit tp; stop first if both"""
        hit_s = adv[start:] <= lv[start:]
        hit_t = (fav[start:] >= tp) if tp is not None else np.zeros(n - start, bool)
        js, jt = first(hit_s), first(hit_t)
        if js is not None and (jt is None or js <= jt):
            j = start + js; lvl = lv[j]
            px = min(op[j], lvl) if op[j] < lvl else lvl          # gap through the stop: filled at the open
            return j, px, 'stop' if lvl <= -1.0 + 1e-12 else 'trail', js is not None and jt is not None and js == jt
        if jt is not None:
            j = start + jt; px = max(op[j], tp) if op[j] > tp else tp
            return j, px, 'target', False
        return n - 1, clo[-1], 'time', False
    ambiguous = False
    if kind == 'TP':
        j, px, why, ambiguous = exit_at(np.full(n, -1.0), mgmt[1]); legs = [(1.0, j, px, why)]
    elif kind == 'TIME':
        j, px, why, ambiguous = exit_at(np.full(n, -1.0)); legs = [(1.0, j, px, why)]
    elif kind in ('BETR', 'CH'):
        j, px, why, ambiguous = exit_at(floor_path(0, None)); legs = [(1.0, j, px, why)]
    elif kind == 'P':      # partial: close `frac` at +kR, rest break-even + chandelier 3 ATR
        frac, k = mgmt[1], mgmt[2]
        j, px, why, ambiguous = exit_at(np.full(n, -1.0), k)
        if why != 'target':
            legs = [(1.0, j, px, why)]
        else:
            legs = [(frac, j, px, 'partial')]
            # remainder from the next bar on (the bar of the partial is treated as done: conservative)
            pk = np.r_[np.full(j + 1, -np.inf), np.maximum.accumulate(fav[j+1:])]  # peak after the partial
            peak_prev_r = np.r_[np.full(j + 1, -np.inf), np.r_[k, pk[j+1:-1]].clip(min=k)] if j + 1 < n else None
            if j + 1 >= n:
                legs.append((1 - frac, n - 1, clo[-1], 'time'))
            else:
                lv = np.maximum(0.0, peak_prev_r - 3.0 * atrR); lv[:j+1] = 99  # not active before
                lv[:j+1] = -np.inf
                j2, px2, why2, _ = exit_at(lv, None, j + 1)
                legs.append((1 - frac, j2, px2, why2))
    gross = sum(w * px for w, _, px, _ in legs)
    jend = max(j for _, j, _, _ in legs)
    # costs, in R: taker fee on entry and on every exit leg, half spread on each side, slippage on stop/trail exits
    dpct = d / entry
    fee_R = FEE * 2 / dpct
    spread_R = (m['spread'] / 2) / dpct * 1  # exit half spread (entry half spread is already in the entry price)
    slip_R = sum(w * SLIP for w, _, _, why in legs if why in ('stop', 'trail')) / dpct
    hours = (jend + 1) * 0.25
    t_entry = m['t'][i] + 900000
    fsum = 0.0
    for hh in range(int(t_entry // 3600000 + 1), int((t_entry + hours * 3600000) // 3600000) + 1):
        fsum += m['rates'].get(hh * 3600000, m['mean_rate'])
    funding_R = -side * fsum / dpct
    net = gross - fee_R - spread_R - slip_R + funding_R
    mfe = float(fav.max())
    after_stop_1R = None
    if legs[0][3] == 'stop' and len(legs) == 1:
        after_stop_1R = bool((fav[legs[0][1]+1:] >= 1).any())
    return dict(coin=c, i=i, side=side, d_pct=dpct, atr_pct=ctx['atr'] / entry, gross=gross, net=net, cost=fee_R + spread_R + slip_R - funding_R,
                why=[x[3] for x in legs], bars=jend + 1, mfe=mfe, premature=after_stop_1R, ambiguous=ambiguous,
                with_trend=side * (m['c'][i] - m['c'][i - 96]) > 0, exit_bar=i + 1 + jend)

STOPS = {'F0.5%': ('F', 0.005), 'F1%': ('F', 0.01), 'F2%': ('F', 0.02), 'A1': ('A', 1.0), 'A1.5': ('A', 1.5), 'A2': ('A', 2.0), 'A3': ('A', 3.0), 'STR': ('S', 0)}
MGMT = {'TP1.5': ('TP', 1.5), 'TP2': ('TP', 2.0), 'TP3': ('TP', 3.0), 'TIME24h': ('TIME',), 'BETR(007A)': ('BETR',),
        'CH3': ('CH', 3.0, 0), 'CH2@1R': ('CH', 2.0, 1.0), 'P50@1R+CH3': ('P', 0.5, 1.0), 'P25@1.5R+CH3': ('P', 0.25, 1.5), 'P50@1.5R+CH3': ('P', 0.5, 1.5)}

def entries():
    for c in COINS:
        m = MK[c]
        for i in range(200, len(m['t']) - 2 * H - 2, STEP):
            if m['t'][i] + (2 * H + 2) * 900000 >= HOLDOUT: break
            for side in (1, -1): yield c, i, side

if __name__ == '__main__':
    E = list(entries())
    out = {'n_entries': len(E), 'slip': SLIP, 'market': {}, 'configs': {}}
    for c in COINS:
        m = MK[c]; ok = ~np.isnan(m['atr'])
        atrp = m['atr'][ok] / m['hh'][ok]
        out['market'][c] = dict(spread_bps=m['spread'] * 1e4, depth5_usd=m['depth'], atr1h_pct_median=float(np.median(atrp) * 100),
                                atr1h_pct_p10=float(np.percentile(atrp, 10) * 100), atr1h_pct_p90=float(np.percentile(atrp, 90) * 100),
                                funding_mean_hourly=m['mean_rate'], funding_apr_pct=m['mean_rate'] * 24 * 365 * 100,
                                funding_pos_share=float(np.mean([v > 0 for v in m['rates'].values()])))
    for sn, sr in STOPS.items():
        for mn, mg in MGMT.items():
            res = [r for r in (simulate(c, i, s, sr, mg) for c, i, s in E) if r]
            net = np.array([r['net'] for r in res]); gross = np.array([r['gross'] for r in res])
            dp = np.array([r['d_pct'] for r in res]); bps = net * dp * 1e4
            stops = [r for r in res if r['why'] == ['stop']]
            prem = [r for r in stops if r['premature']]
            big = [r for r in res if r['mfe'] >= 3]
            wt = np.array([bool(r['with_trend']) for r in res], dtype=bool)
            def s(x): return dict(mean=float(np.mean(x)), se=float(np.std(x) / math.sqrt(len(x) / 6)))  # /6: overlapping 24 h windows every 4 h
            out['configs'][f'{sn} | {mn}'] = dict(
                n=len(res), net_R=s(net), gross_R=float(gross.mean()), net_bps=s(bps), bps_with_trend=float(bps[wt].mean()), bps_counter=float(bps[~wt].mean()),
                win=float((net > 0).mean()), stop_rate=len(stops) / len(res), premature_share_of_stops=(len(prem) / len(stops)) if stops else 0.0,
                premature_share_all=len(prem) / len(res), cost_R=float(np.mean([r['cost'] for r in res])), cost_bps=float(np.mean([r['cost'] * r['d_pct'] * 1e4 for r in res])),
                stop_pct_median=float(np.median(dp) * 100), hold_h=float(np.mean([r['bars'] for r in res]) / 4),
                capture_big=float(np.mean([r['gross'] / r['mfe'] for r in big])) if big else None, n_big=len(big),
                ambiguous=sum(r['ambiguous'] for r in res), worst_R=float(net.min()))
    json.dump(out, open(sys.argv[3] if len(sys.argv) > 3 else f'sens_{int(SLIP*1e4)}bps.json', 'w'), indent=1)
    print('entries', len(E), 'configs', len(out['configs']))
