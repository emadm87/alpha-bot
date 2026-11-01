"""ALPHA BOT 007F-BACKUP - study only: tokens of the market section in more compact forms (the prompt is NOT changed).

    python3 -I research/ai-decisions/compact_study.py <tokenizer.json> research/ai-decisions/examples/sizes/<scenario>.user.txt

A: drop repeated or redundant fields; B: 5 significant digits; C: the six markets as one table with the header once.
"""
import json, re, sys
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from count_tokens import Tok
tok = Tok(sys.argv[1])
user = open(sys.argv[2]).read()
lines = user.split('\n')
mk = [(i, l.split(': ', 1)) for i, l in enumerate(lines) if re.match(r'^(BTC|ETH|SOL|BNB|XRP|DOGE): \{', l)]
def sig(x, n):
    if isinstance(x, float) and x != 0:
        return float(f'{x:.{n}g}')
    return x
def walk(o, f):
    if isinstance(o, dict): return {k: walk(v, f) for k, v in o.items()}
    if isinstance(o, list): return [walk(v, f) for v in o]
    return f(o)
def dedup(b):
    b = json.loads(json.dumps(b))
    b.pop('mid_price', None)                                  # = price within a few bps (mark vs mid)
    if b.get('price_source') == 'mark (live)': b.pop('price_source')
    q = b['data_quality']
    if q['status'] == 'ok':                                   # keep quality only when it matters
        b['data_quality'] = {'status': 'ok'} if not q['missing'] else {'status': 'ok', 'missing': q['missing']}
    b['costs'].pop('taker_fee_pct_each_side', None)           # the same for all coins: already in ACCOUNT
    v = b.get('volume', {})
    if v.get('notional_24h_usd'): v['notional_24h_usd'] = float(f"{v['notional_24h_usd']:.2g}")
    st = b.get('structure', {})
    for k in ('swing_highs_1h', 'swing_lows_1h'):
        for s in st.get(k, []): s.pop('distance_atr', None)    # price and age kept; nearest levels keep the distance
    return b
def rnd(b):
    def f(x):
        if isinstance(x, float):
            return round(x, 1) if abs(x) < 100 and abs(x) >= 1 and abs(x - round(x, 1)) < 0.05 else sig(x, 5)
        return x
    return walk(b, f)
def variant(fn):
    out = list(lines)
    for i, (c, js) in mk: out[i] = f'{c}: ' + json.dumps(fn(json.loads(js)), separators=(',', ':'))
    return '\n'.join(out)
base = tok.count(user)
for name, fn in [('A: drop repeated/redundant fields', dedup), ('A+B: plus 5 significant digits, ATR distances 1 decimal', lambda b: rnd(dedup(b)))]:
    t = tok.count(variant(fn))
    print(f'{name}: {t} tokens ({(t / base - 1) * 100:+.1f}%)')
print('current:', base)
def flat(o, p=''):
    if isinstance(o, dict):
        r = {}
        for k, v in o.items(): r.update(flat(v, f'{p}.{k}' if p else k))
        return r
    if isinstance(o, list): return {p: json.dumps(o, separators=(',', ':'))}
    return {p: o}
rows = {c: flat(rnd(dedup(json.loads(js)))) for i, (c, js) in mk}
keys = list(dict.fromkeys(k for r in rows.values() for k in r))
table = 'coin|' + '|'.join(keys) + '\n' + '\n'.join(c + '|' + '|'.join('' if r.get(k) is None else str(r.get(k)) for k in keys) for c, r in rows.items())
first, lastm = mk[0][0], mk[-1][0]
t = tok.count('\n'.join(lines[:first] + [table] + lines[lastm + 1:]))
print(f'A+B+C: markets as one table (header once): {t} tokens ({(t / base - 1) * 100:+.1f}%)')
