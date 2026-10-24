# Nota di continuità — Task 006G (stato al 24/10/2026)

Branch `claude/tender-faraday-pug90t`; `main` invariato su `15d47c1` (fork di `etrobot/open-alpha-arena`).
Laboratorio paper: nessun trading reale, nessun merge o PR.

## Stato

**Preflight del pilota completato (006G-6D). La simulazione AI NON è ancora stata eseguita.**

| Task | Esito | Commit |
|---|---|---|
| 006G-0 | Calcolatore Hyperliquid cross margin, puro e isolato | `c8d3344` |
| 006G-1 | Dati validati di mark price e margin table (isolati) | `184eb79` |
| 006G-2 | Confronto integrato simulatore/Hyperliquid (analisi) | — |
| 006G-3 | Adattatore dalla contabilità del bot al calcolatore (isolato) | `3aea85a` |
| 006G-4 | Leve miste: margine realmente depositato registrato (`positions.margin`) | `de0b4de` |
| 006G-5 | Margin table con id < 50 come fascia unica ufficiale | `c46cbf3` |
| 006G-6A | Rifiuto: perpetual sopra uno SPOT; righe storiche non riconciliabili | `e444099` |
| 006G-6B | Architettura Unified USDC (analisi) | — |
| 006G-6C | Prontezza per la simulazione: "pronto con limiti" (analisi) | — |
| 006G-6D | Preflight: script, verifica offline, protocollo; nessun blocco | questo salvataggio |

## Correzioni già realizzate e approvate

- 005A–005I: prezzi condivisi, Total Assets corretto, ecc. (vedi `task-004c-paper-12-cycles.md`).
- 006B: traccia diagnostica opzionale `AI_DIAGNOSTICS_FILE`.
- 006D/006E: indicatori e dati quant (non passati all'AI: prompt originale invariato).
- 006F-3C: chiusura SHORT 1x; ordini manuali bloccati su perpetual aperte (policy M1).
- 006G-4: margine registrato per aggiunte a leve diverse.
- 006G-5: tabelle id < 50.
- 006G-6A: protezione SPOT/PERP e righe storiche.

Test: 246/246, typecheck OK.

## Scelte previste per Unified USDC (non implementate)

- **D1:** `positions.kind` (`SPOT`/`PERP`), poi `kind` su orders/trades e indice unico.
- **D2:** l'AI resta solo PERP (l'autore è passato ai futures con `f5370f4`).
- **D3:** ordini manuali instradati per tipo; PERP solo MARKET; nessuno SPOT a leva.
- **D4:** `current_cash` è l'unico saldo USDC. Si distinguono equity totale ed equity di rischio perp;
  gli SPOT non-USDC non sono collaterale.
- **D5:** formula ufficiale `computeUnifiedAccountRatio` da leggere e verificare prima dell'uso.
- **D6:** ricostruzione automatica solo se certa; altrimenti quarantena e chiusura con conto sospeso.

## Limitazioni ancora presenti

- Monitor dell'autore (equity/marginUsed < 0,5), non Hyperliquid; le posizioni 1x (anche SHORT) non sono monitorate.
- Interessi dell'autore al posto del funding; commissione 0,07%, nessuno slippage.
- Curva della dashboard non attendibile per SHORT e leva.
- Pannello manuale non coerente con il motore perpetual (non usarlo).
- Righe storiche non riconciliabili bloccate e non liquidate.
- Fino a 3 tentativi HTTP per ciclo nel client AI.

## Prossima attività: pilota forward

| Voce | Valore |
|---|---|
| Modello | Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`), endpoint compatibile OpenAI ufficiale Google |
| Capitale | 1.000 USDC simulati |
| Mercati | BTC, ETH, SOL, BNB, XRP, DOGE |
| Frequenza | 300 secondi |
| Durata | 12 cicli, circa 55–60 minuti |
| Operazioni | Solo perpetual MARKET; nessuno SPOT, nessun ordine manuale |
| Trading reale | Nessuno |
| Costi API | Da confermare sul listino ufficiale e da controllare prima dell'avvio (stima pilota: pochi centesimi di USD) |
| Strumenti | `backend/pilot/` (vedi `backend/pilot/README.md`) |

Autorizzazioni **separate e esplicite** sono necessarie per:

1. il pilota da 12 cicli;
2. l'eventuale prova da 24 ore, solo dopo la verifica del pilota.
