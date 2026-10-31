"""ALPHA BOT 007B (independent Python) - re-entry after a protective exit, the basis of the 2 h cooldown.
Run from backend/:  python3 research/exit-rules/independent/cooldown007b.py   (writes cooldown007b.json here)"""
import sys, json, os, numpy as np
import importlib.util
here = os.path.dirname(os.path.abspath(__file__))
sys.argv = [sys.argv[0], os.path.join(here, '..', 'data'), '0.0002']
spec = importlib.util.spec_from_file_location('sim', os.path.join(here, 'sim007b.py')); sim = importlib.util.module_from_spec(spec); spec.loader.exec_module(sim)
E = list(sim.entries())
out = {}
for base_name, srule, mg in [('A2|CH3', ('A', 2.0), ('CH', 3.0, 0)), ('A2|TP2', ('A', 2.0), ('TP', 2.0)), ('A1.5|CH3', ('A', 1.5), ('CH', 3.0, 0))]:
    base = [r for r in (sim.simulate(c, i, s, srule, mg) for c, i, s in E) if r]
    ub = np.array([r['net'] * r['d_pct'] * 1e4 for r in base])
    row = {'unconditional_bps': float(ub.mean()), 'unconditional_stop_rate': float(np.mean([r['why'] == ['stop'] for r in base])), 'n': len(base)}
    for trigger in ('stop', 'trail'):
        ex = [r for r in base if r['why'][-1] == trigger]
        for lag in (1, 2, 4, 8, 16):     # 15 min, 30 min, 1 h, 2 h, 4 h after the exit
            for same in (True, False):
                rr = [sim.simulate(r['coin'], r['exit_bar'] + lag - 1, r['side'] if same else -r['side'], srule, mg) for r in ex]
                rr = [x for x in rr if x]
                if not rr: continue
                b = np.array([x['net'] * x['d_pct'] * 1e4 for x in rr])
                row[f'after_{trigger}_{lag*15}min_{"same" if same else "opposite"}'] = dict(n=len(rr), bps=float(b.mean()), se=float(b.std() / np.sqrt(len(rr) / 6)),
                    stop_rate=float(np.mean([x['why'] == ['stop'] for x in rr])))
    out[base_name] = row
json.dump(out, open(os.path.join(here, 'cooldown007b.json'), 'w'), indent=1)
for k, v in out.items():
    print(k, f"unconditional {v['unconditional_bps']:+.1f} bps, stop rate {v['unconditional_stop_rate']:.0%}, n={v['n']}")
    for kk, vv in v.items():
        if kk.startswith('after_'): print(f"   {kk:32} n={vv['n']:4} {vv['bps']:+6.1f}±{vv['se']:4.1f} bps  stop {vv['stop_rate']:.0%}")
