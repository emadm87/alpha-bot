"""ALPHA BOT 007F - offline token counter for Gemini prompts (no API call).

A plain reimplementation of the BPE described by a Gemma 3 `tokenizer.json` (Gemma 3 uses the Gemini tokenizer):
normalizer ' ' -> U+2581, no effective pre-tokenization, merges by rank, byte fallback, added tokens matched first.
The tokenizer file is data and is NOT in this repository (Gemma terms of use): pass its path.

Calibration (Task 007F-BACKUP): on the 36 recorded gemini-3.5-flash-lite calls of the three 12-cycle pilots, the reported
prompt_tokens = this count + 1 for every prompt (one start token per request), and completion_tokens = this count for
every answer.

    python3 -I research/ai-decisions/count_tokens.py <tokenizer.json> <file>...
"""
import heapq, json, re, sys

class Tok:
    def __init__(self, path):
        t = json.load(open(path, encoding='utf8'))
        self.vocab = t['model']['vocab']
        self.rank = {}
        for i, m in enumerate(t['model']['merges']):
            a, b = (m if isinstance(m, list) else m.split(' ', 1))
            self.rank.setdefault((a, b), i)
        added = sorted((a['content'] for a in t['added_tokens']), key=len, reverse=True)
        self.added_re = re.compile('|'.join(re.escape(a) for a in added))

    def _bpe(self, s):
        syms = []
        for ch in s:
            if ch in self.vocab: syms.append(ch)
            else: syms.extend(f'<0x{b:02X}>' for b in ch.encode('utf8'))
        n = len(syms)
        if n < 2: return n
        prev = list(range(-1, n - 1)); nxt = list(range(1, n + 1)); nxt[-1] = -1
        alive = [True] * n
        heap = []
        def push(i):
            j = nxt[i]
            if j == -1: return
            r = self.rank.get((syms[i], syms[j]))
            if r is not None: heapq.heappush(heap, (r, i, syms[i], syms[j]))
        for i in range(n - 1): push(i)
        count = n
        while heap:
            r, i, a, b = heapq.heappop(heap)
            if not alive[i] or syms[i] != a: continue
            j = nxt[i]
            if j == -1 or not alive[j] or syms[j] != b: continue
            syms[i] = a + b; alive[j] = False; count -= 1
            nxt[i] = nxt[j]
            if nxt[j] != -1: prev[nxt[j]] = i
            if prev[i] != -1: push(prev[i])
            push(i)
        return count

    def count(self, text):
        text = text.replace(' ', '▁')
        total, pos = 0, 0
        for m in self.added_re.finditer(text):
            total += self._bpe(text[pos:m.start()]) + 1; pos = m.end()
        return total + self._bpe(text[pos:])

if __name__ == '__main__':
    tok = Tok(sys.argv[1])
    for f in sys.argv[2:]:
        print(f, tok.count(open(f, encoding='utf8').read()))
