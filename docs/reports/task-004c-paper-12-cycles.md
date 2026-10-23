# Task 004C — Simulazione paper, 12 cicli AI

Simulazione paper con 1.000 USDC virtuali, nessun trading reale.

## Configurazione

- Branch: `claude/tender-faraday-pug90t`, commit `edc0d0b` (correzioni 005A–005I); `main` invariato su `15d47c1`.
- Modello: `gemini-3.5-flash-lite` via endpoint compatibile OpenAI; chiave fornita solo tramite Network Secret.
- Ciclo AI ogni 300 s; prezzi Hyperliquid (cache 30 s); margin monitor ogni 5 s.
- Database su file temporaneo, cancellato a fine prova.

## Risultati

| Voce | Valore |
|---|---|
| Cicli completati | 12/12 (22/10/2026, 23:00:10–23:55:36 UTC) |
| Ciclo 1 | Apertura BTC LONG 0,006147 @ 81.336,5, leva 3 (50% del cash) |
| Margine / commissione | 166,6585 / 0,3500 USDC; cash residuo 832,9915 |
| Cicli 2–12 | HOLD |
| Equity finale | 1.000,11 USDC (BTC 81.411,5) |
| Risultato netto | +0,11 USDC (+0,011%) |
| P&L realizzato / non realizzato | 0 / +0,4610 |
| Commissioni | 0,35 |
| Interessi addebitati | 0 (maturati ≈ 0,0038, addebitati alla chiusura) |
| Max drawdown | 0,66 USDC (0,066%) alle 23:37:08 (campionamento ~60 s) |
| Posizione aperta a fine prova | BTC LONG 0,006147, leva 3 |

Equity per ciclo: 999,65 · 999,75 · 999,88 · 999,83 · 999,66 · 999,63 · 999,50 · 999,40 · 999,48 · 999,71 · 999,91 · 1.000,11.

## Rete e prezzi

- 0 errori 429; 2 ECONNRESET (23:35:40, 23:50:10) senza effetti.
- 75 letture congiunte dei 6 prezzi (≈ 900 richieste HTTP stimate).
- Total Assets passato all'AI ≈ 1.000: correzione 005A confermata.

## Problemi aperti

- Le decisioni HOLD vengono registrate con `symbol` vuoto.
- Liquidazioni, chiusure e SHORT non esercitati in questa prova.
- Il registratore della prova ha aggiunto letture REST proprie.
- Già noti: insolvenza, interessi invece di funding, soglia di liquidazione diversa da Hyperliquid, segno errato degli SHORT nella dashboard WebSocket, `orderMatching` ancora usato per ordini manuali e fallback, semantica di `target_portion`.
