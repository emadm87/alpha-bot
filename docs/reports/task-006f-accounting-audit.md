# Task 006F-1 / 006F-2 — Audit contabile e distinzione SPOT / PERPETUAL

> **Stato (aggiornato al 006F-3C):** implementate e autorizzate la correzione A (SHORT 1x), il reset di `side`
> e la protezione SPOT/PERPETUAL in `orderMatching`, con politica M1 per gli ordini pendenti.
> Restano aperti: liquidazione 1x, funding, leve miste, `accumulatedInterest` (vedi in fondo).
> Base analizzata: branch `claude/tender-faraday-pug90t` @ `df84381` (006F-1/2) e `7f6f7f6` (006F-3C); originale `main` @ `15d47c1`.

## Metodo
- Motore paper reale (`placeAndExecuteCrypto`), `orderMatching`, monitor reale (`checkMarginLevels`) e percorso AI reale (`placeAIDrivenCryptoOrder`) con endpoint AI finto.
- Database SQLite temporaneo, prezzi iniettati nella cache, nessuna rete, nessuna AI reale.
- Stessi scenari eseguiti su: codice attuale (`df84381`), originale (`15d47c1`, estratto con `git archive` fuori dal repository) e, per il 006F-2, una copia con la correzione A applicata nello scratchpad.
- Raggiungibilità: `placeAndExecuteCrypto` è chiamata solo dal percorso AI (`tradingCommands`) e dalle liquidazioni; gli ordini manuali REST/WebSocket usano `orderMatching`.

## Riepilogo dei tre problemi contabili (006F-1)

| # | Problema | Esito | Già in `15d47c1` | Raggiungibile dal bot oggi | Effetto | Gravità |
|---|---|---|---|---|---|---|
| 1 | Aumento di posizione con leva diversa | Confermato | Sì (apertura e rilascio margine identici all'originale; equity/monitor 005A/005B lo rendono visibile) | No: la regola AI "una posizione per moneta" impedisce gli aumenti | Cash creato/distrutto alla chiusura, `marginUsed` alla deriva, liquidazione spostata | Alta per impatto, bassa probabilità oggi (latente) |
| 2 | `accumulatedInterest` non azzerato | Confermato solo come dato | Sì | Sì (campo API `accumulated_interest`) | Nessun doppio addebito; solo dato fuorviante | Bassa |
| 3 | SHORT con leva 1x | Confermato | Sì | Sì: se l'AI non indica la leva, il default è 1 | Non chiudibile dall'AI; se chiuso con SELL il P&L è invertito; mai liquidato | Alta |

### 1. Margine con leve diverse
- Causa: in un aumento la leva diventa `Math.trunc(media ponderata per nozionale)`; alla chiusura il margine rilasciato è `nozionale d'ingresso / pos.leverage`, non il margine versato. Anche senza troncamento la media aritmetica è errata (la leva effettiva è nozionale totale / margine totale).
- Risultati (1.000 USDC, identici su codice attuale e originale):

| Caso | Margine versato / ricostruito | Cash finale corretto | Osservato | Errore |
|---|---|---|---|---|
| LONG 3 @80 3x + 3 @80 2x (leva → 2), chiusura 3+3 @80 | 200 / 240 | 999,328 (−0,067%) | 1.039,328 (+3,933%) | +40 creati; `marginUsed` finale −40 |
| SHORT 3 @80 2x + 3 @80 4x (leva → 3), chiusura @80 | 180 / 160 | 999,328 | 979,328 (−2,067%) | −20 distrutti; `marginUsed` finale +20 |
| Come il primo, chiusura @88 | 200 / 240 | 1.047,294 (+4,729%) | 1.087,294 (+8,729%) | profitto gonfiato di 40 |

- Equity mostrata dopo l'aumento: `calcAccountEquity` = 1.039,664 contro 999,664 reali.
- Liquidazione (dopo la deriva, nuova LONG 12 @80 3x): soglia corretta P < 10,112; codice attuale liquida solo sotto 5,112 (a 8 non liquida, circa 60 USDC di perdita in più); originale liquida già a 12 (difetto del vecchio monitor, corretto nel 005B). Se la deriva porta `marginUsed` ≤ 0 il monitor salta il conto.
- Interessi calcolati con la leva troncata: nel primo caso prestito 240 invece di 280 (−14%).
- Correzione minima proposta: rifiutare in `placeAndExecuteCrypto` l'aumento con leva diversa (con stessa leva la formula è esatta). Alternativa completa: colonna `margin` per posizione (modifica di schema).

### 2. Interessi accumulati
- 1 @100 2x, 10 h, chiusura; riapertura, 10 h, chiusura: interessi per trade `[0, 0,00625, 0, 0,00625]`, cash finale 999,7075 = corretto (−0,029%).
- `accumulatedInterest` resta 0,00625 sulla nuova posizione e arriva a 0,0125: dato storico non azzerato, nessun effetto economico.
- Correzione minima proposta: `accumulatedInterest: 0` nel ramo "nuova posizione".

### 3. SHORT 1x
- Apertura SHORT 1 @100 1x: cash 899,93, `marginUsed` 0; equity aperta corretta (1.009,93 a 90).
- Chiusura @90: BUY rifiutato ("Can only SELL spot positions"); SELL accettato come vendita spot → cash 989,867 invece di 1.009,867 (P&L invertito); resta `{q 0, side SHORT}`.
- Percorso AI: `open short` senza leva → leva 1 → aperto; `close short` → BUY → rifiutato (`executed=false`): posizione bloccata e mai liquidata.

## Origine storica SPOT → futures (006F-2)
- Prima di `f5370f4` (Python): solo spot, `order_executor.place_and_execute` con BUY/SELL e quantità intere; AI buy/sell/hold.
- `f5370f4` (01/11/2025, "change spot trading to futures trading"): introduce `order_executor_leverage.py` ("1 = spot, 2-50 = leveraged"), `positions.side` ("'LONG' or 'SHORT' for leveraged positions"), `orders.leverage` ("1 for spot, >1 for leverage"), `margin_used`. Il prompt dice "You can open LONG or SHORT" e "leverage 1-10": lo SHORT 1x è consentito dal progetto; il difetto è nella chiusura, che eredita "leva 1 = spot".
- `15d47c1` (porting TypeScript) conserva il comportamento identico.

### Percorsi attuali
| Percorso | Motore | `side` | Margine / monitor |
|---|---|---|---|
| AI e liquidazioni | `placeAndExecuteCrypto` | sempre LONG/SHORT in apertura; azzerato solo nella chiusura totale del ramo a leva | `marginUsed` solo con leva > 1 |
| REST `/orders` | `orderMatching` | mai valorizzato (null); BUY/SELL, leva 1, commissione 0,1% (min 0,1) | nessun `marginUsed` |
| WebSocket `place_order` | `orderMatching` | null; leva 1-50 | nessun `marginUsed` |
| Monitor | solo posizioni con leva > 1 e `marginUsed` > 0 | — | SHORT 1x mai controllati |

## Risultati numerici dei test SPOT / PERP (1.000 USDC)

| Scenario | Corretto | Attuale | Originale | Con correzione A |
|---|---|---|---|---|
| S1 SPOT manuale BUY 2 @100, SELL 2 @110 | 1.019,58 | ✔ | ✔ | ✔ invariato |
| S2 PERP LONG 1x @100 → SELL @110 | 1.019,706 | ✔ | ✔ | ✔ invariato |
| S3 PERP SHORT 1x @100 → @90 | 1.019,734 | BUY rifiutato; SELL 979,734 | idem | BUY 1.019,734 ✔; SELL rifiutato |
| S4 LONG 3x @100→110 / SHORT 3x @100→90 | 1.019,706 / 1.019,734 | ✔ / ✔ | ✔ / ✔ | ✔ invariato |
| S5a SHORT 1x esistente chiuso con BUY @90 | 1.019,734 | rifiutato (bloccato) | rifiutato | chiuso ✔ |
| S5b riga storica `{q 0, side SHORT}` + BUY spot manuale 1 @100, chiusura @110 | 1.009,823 | SELL ✔ | — | SELL rifiutato; BUY → 989,823 ✗ |
| S5c spot manuale (`side` null) chiuso dall'AI SELL @110 | 1.019,646 | ✔ | ✔ | ✔ invariato |
| S6 SHORT 1x 9 @100, prezzo 250 (equity −350,63) | da liquidare | mai liquidato | mai liquidato | mai liquidato |
| S6 SHORT 3x 9 @100, prezzo 250 | liquidato | liquidato, cash −352,2 | non liquidato (bug pre-005D) | come attuale |

## Confronto delle soluzioni

| | A. Correzione minima chiusura SHORT 1x | B. SPOT/PERP derivato da `side` senza migrazione | C. Colonna esplicita `instrument` + migrazione |
|---|---|---|---|
| Effetto | SHORT 1x chiudibile con BUY, P&L corretto; SELL su SHORT rifiutato; resto invariato | tutte le posizioni con `side` nel ramo perpetual, `side` null nel ramo spot | ogni ordine/posizione dichiara SPOT o PERP |
| Vantaggi | 2 righe, nessuno schema; spot, LONG 1x e leve > 1 identici | più coerente senza schema | distinzione esplicita |
| Svantaggi | non distingue gli strumenti; rischio S5b sulle righe storiche | inaffidabile per righe riusate con `side` residuo e long manuali a leva con `side` null | migrazione di DB, motori, API, frontend, test |
| Rischio contabile | basso | medio | medio-alto |
| Dati esistenti | compatibile; sblocca SHORT 1x esistenti; rischio solo S5b | stesse ambiguità di S5b + righe LONG residue | il backfill userebbe la stessa euristica di B |
| Complessità | molto bassa | media | alta |

### Soluzione raccomandata: A (implementata nel 006F-3C, vedi sotto)
Patch proposta, solo nel ramo di chiusura di `backend/src/services/orderExecutorLeverage.ts` (verificata su una copia nello scratchpad, non nel repository):

```diff
-      if (pos.leverage > 1) {
+      if (pos.leverage > 1 || pos.side === 'SHORT') {
         // Closing leveraged position: BUY closes SHORT, SELL closes LONG
 ...
         currentCash += pnl + marginReleased - takerFee
-        marginUsed -= marginReleased
+        if (pos.leverage > 1) marginUsed -= marginReleased
```

Test necessari: SHORT 1x aperto/chiuso con BUY in profitto, perdita e parziale (`marginUsed` resta 0); SELL su SHORT rifiutato; percorso AI open short senza leva → close short `executed=true`; S1, S2, S4, S5c invariati; regressione 005A-006F.

### Rischio delle righe storiche con `side` residuo
- Un vecchio SHORT 1x chiuso con SELL lascia `{q 0, side SHORT}`; un BUY manuale successivo sulla stessa riga crea una posizione spot etichettata SHORT. Con la correzione A il motore la tratterebbe come SHORT (S5b: 989,823 invece di 1.009,823).
- Mitigazioni opzionali (da autorizzare separatamente): controllo prima del deploy `positions WHERE side='SHORT' AND leverage=1 AND quantity=0` con azzeramento di `side`; oppure `side: null` in `orderMatching` quando un BUY riapre una riga con q 0.
- I database delle nostre simulazioni sono temporanei: oggi non esistono righe di questo tipo.

## Correzioni implementate (006F-3B / 006F-3C)

### Perché A da sola non bastava (006F-3B)
- Test su copie esterne al repository: v0 HEAD, v1 = A, v2 = A + reset di `side`, v3 = A + reset + protezione.
- Un singolo ordine manuale altera una perpetual aperta in tutte le versioni, originale compresa: BUY manuale su uno SHORT lo aumenta come long; SELL manuale lo riduce come vendita spot (P&L invertito); su posizioni a leva mescola le leve e lascia `marginUsed` alla deriva (−33,33); un LIMIT pendente si esegue dentro la perpetual.
- La sola A introduceva una regressione (riga `{q 0, side SHORT}` riaperta come spot: −20 USDC); il reset la elimina, ma non protegge le perpetual aperte. Solo v3 risulta corretta in tutti gli scenari.

### Modifiche implementate
| File | Modifica |
|---|---|
| `backend/src/services/orderExecutorLeverage.ts` | Chiusura nel ramo perpetual se `leverage > 1 \|\| side === 'SHORT'`; `marginUsed` ridotto solo con leva > 1 |
| `backend/src/services/orderMatching.ts` | `createOrder` rifiuta un ordine manuale se il simbolo ha una perpetual aperta (`side` valorizzato e q > 0), senza creare l'ordine; `executeOrder` ripete il controllo dentro la transazione prima di ogni modifica: rollback, ordine PENDING, motivo registrato una sola volta per ordine; un BUY che riapre una riga con q 0 imposta `side: null` |
| `backend/src/services/shortOneX.test.ts` | 13 test SHORT 1x e invarianti (spot, LONG 1x, 3x, monitor) |
| `backend/src/services/manualPerpGuard.test.ts` | 8 test S1-S6, reset su posizione aperta, MARKET pendente (M1) |

Nessuna modifica a prompt, sizing, leve, commissioni, interessi, funding, monitor, liquidazioni o schema.

### Risultati (1.000 USDC)
| Scenario | Prima (HEAD) | Dopo |
|---|---|---|
| S1 SHORT 1x 2@100 + BUY manuale, chiusura @90 | 969,571 (AI bloccata) | manuale rifiutato; 1.019,734 (+19,734, +1,973%) |
| S2 SHORT 1x + SELL manuale @120, chiusura @120 | 1.039,656 (+80 fittizi) | rifiutato; 959,692 (−40,308, −4,031%) |
| S3 SHORT 3x + BUY/SELL manuali @120 | 962,805, `marginUsed` −33,33 | rifiutati; 959,692, `marginUsed` 0 |
| S4 LONG 3x + BUY/SELL manuali @120 | 1.042,805, `marginUsed` −33,33 | rifiutati; 1.039,692 (+39,692, +3,969%) |
| S5 riga {q 0, SHORT} + BUY spot, chiusura AI @110 | con la sola A: 989,823 | 1.009,823 (+9,823, +0,982%), `side` null |
| S6 LIMIT BUY 1@95 creato prima dello SHORT 1x | eseguito dentro lo SHORT (974,571) | PENDING durante la perpetual; dopo, eseguito solo a ≤ 95; finale 1.025,534 (+2,553%) |
| M1 MARKET BUY creato prima dello SHORT 1x | eseguito dentro lo SHORT | PENDING durante la perpetual; eseguito a 92 solo su richiesta esplicita; finale 1.027,534 (+2,753%) |
| SHORT 1x @100 → BUY @90 / @110; AI open/close senza leva | bloccato / P&L invertito | 1.019,734 / 979,706; AI `executed=true` (1.009,867) |

In tutti gli scenari `marginUsed` torna a 0, `frozenCash` resta 0 e ogni commissione è contata una sola volta.

### Politica M1 per gli ordini pendenti (decisione autorizzata)
- Nell'originale `etrobot/open-alpha-arena` anche gli ordini MARKET vengono registrati come PENDING ed eseguiti in una fase successiva: non ci sono prove sufficienti per introdurre un annullamento automatico.
- **Nuovo ordine manuale** su un simbolo con perpetual aperta: rifiutato alla creazione con errore esplicito; nessun ordine, cash, posizione o margine modificati.
- **MARKET o LIMIT già creato** che incontra una perpetual aperta: resta PENDING, senza effetti su cash, equity, quantità, commissioni o margine; il motivo è registrato una sola volta per ordine.
- **Dopo la chiusura della perpetual:** il LIMIT si esegue solo se il prezzo rispetta il limite; il MARKET si esegue al prezzo del momento, come nell'originale. Nessuna cancellazione automatica e nessuna scadenza.
- **Rischio residuo documentato:** un MARKET rimasto PENDING durante una perpetual può essere eseguito più tardi a un prezzo diverso da quello della sua creazione.
- **Esecuzione dei pendenti:** `startOrderScheduler()` (order scheduler dedicato, ogni 5 s) non risulta avviato dal normale startup; gli ordini pendenti vengono eseguiti solo tramite `POST /orders/execute/:id` o `POST /orders/process-all`. Il comportamento non è stato modificato.
- Funzionalità tolta rispetto all'originale: non si possono inviare ordini manuali su un simbolo con perpetual aperta (anche la vendita manuale di un LONG 1x del motore); nell'originale erano accettati ma producevano saldi errati.

## Problemi ancora aperti
- **Liquidazione 1x:** il monitor considera solo leva > 1; SHORT e LONG 1x non vengono mai liquidati e l'equity può diventare negativa senza limite.
- **Funding:** il modello addebita interessi solo sulla parte presa in prestito ((leva − 1)/leva); le posizioni 1x non pagano nulla e gli SHORT non incassano mai funding positivo.
- **Margine con leve differenti:** anomalia 1, latente nel percorso AI ma con impatto economico reale (il percorso manuale che la riproduceva è ora bloccato dalla protezione).
- **Percorsi manuali:** long manuali a leva via WebSocket con `side` null e senza `marginUsed`; commissioni manuali 0,1% contro 0,07% del motore. (Le interferenze manuale ↔ perpetual sono corrette dal 006F-3C.)
- **`accumulatedInterest`** non azzerato alla riapertura: solo dato visualizzato.
- **MARKET pendenti:** possibile esecuzione tardiva dopo una perpetual (politica M1, scelta consapevole).
- **Insolvenza dopo liquidazione** (cash negativo, S6 3x: −352,2): già nota.

## Decisioni che richiedono ancora autorizzazione
1. ~~Implementare la correzione A (SHORT 1x).~~ Fatto nel 006F-3C.
2. ~~Mitigazione delle righe storiche con `side` residuo.~~ Fatto nel 006F-3C (reset nel BUY di `orderMatching`).
3. Correzione dell'anomalia 1 (rifiuto dell'aumento con leva diversa, oppure colonna `margin`).
4. Azzeramento di `accumulatedInterest` alla riapertura.
5. Eventuale liquidazione delle posizioni 1x nel monitor.
6. Eventuale modello di funding al posto degli interessi.
7. Eventuale distinzione esplicita SPOT/PERP (B o C).
