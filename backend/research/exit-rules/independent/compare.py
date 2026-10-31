"""ALPHA BOT 007C - independent check: the Python simulator of Task 007B (written separately from the app's
TypeScript rules) against research/exit-rules/results/results.json on the in-sample window.
Run from backend/:  python3 research/exit-rules/independent/compare.py
Same entries, same costs. C1 = A2|CH3 and C3 = A2|TP2 must agree; C2 differs by construction (the Python
version starts the trailing peak of the remainder at the bar after the partial, the app includes that bar)."""
import importlib.util, json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
data = os.path.join(here, '..', 'data')
sys.argv = [sys.argv[0], data, '0.0002']
spec = importlib.util.spec_from_file_location('sim', os.path.join(here, 'sim007b.py'))
sim = importlib.util.module_from_spec(spec); spec.loader.exec_module(sim)
E = list(sim.entries())
ts = json.load(open(os.path.join(here, '..', 'results', 'results.json')))['sets']['in_sample_15m']['configs']
rows, ok = [], True
for name, srule, mg, tol in [('C1', ('A', 2.0), ('CH', 3.0, 0), 0.5), ('C3', ('A', 2.0), ('TP', 2.0), 0.5), ('C2', ('A', 2.0), ('P', 0.25, 1.5), None)]:
    res = [r for r in (sim.simulate(c, i, s, srule, mg) for c, i, s in E) if r]
    py = sum(r['net'] * r['d_pct'] * 1e4 for r in res) / len(res)
    prem = sum(1 for r in res if r['premature']) / len(res)
    t = ts[name]
    d = py - t['net_bps']['mean']
    agree = tol is None or abs(d) <= tol
    ok &= agree
    rows.append(f"{name}: python {py:+.2f} bps (n={len(res)}, premature {prem:.1%}) | app rules {t['net_bps']['mean']:+.2f} bps (premature {t['premature_stop_share']:.1%}) | diff {d:+.2f}" + ('' if tol is None else f" -> {'AGREE' if agree else 'DIFFER'} (tolerance {tol} bps)"))
print('\n'.join(rows))
sys.exit(0 if ok else 1)
