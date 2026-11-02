# Pilota AI forward — ALPHA BOT

Strumenti per la prima prova forward dell'AI originale con **1.000 USDC simulati**.
Preflight nel Task 006G-6D; piloti da 12 cicli eseguiti (006G-7, 006J-1, 006J-3); prova da 24 h non ancora eseguita.

> ⚠️ `run-pilot.mjs --authorized` avvia l'app e fa **chiamate AI a pagamento**.
> Usarlo solo dopo un'autorizzazione esplicita, separata per il pilota (12 cicli) e per la prova da 24 h.
> Senza `--authorized` stampa il piano ed esce senza fare nulla.

Nessun trading reale: ccxt è creato senza credenziali e il motore scrive solo su SQLite.
Gli script non modificano codice, prompt, strategie, sizing, leva, monitor o liquidazioni.

## File

| File | Ruolo |
|---|---|
| `run-pilot.mjs` | Avvio sorvegliato dell'app con arresto automatico, poi report |
| `check-run.mjs` | Controllo di `backend.log` e della traccia 006B (sola lettura) |
| `report.mjs` | Report economico dal database (aperto in sola lettura) e dalla traccia |
| `compare.mjs` | Confronto a posteriori Originale vs Hyperliquid sugli stessi fill (sezione `comparison` del report, 006I-6) |
| `ccxt-proxy.mjs` | Shim di trasporto: aggiunge solo `httpsProxy` a ccxt (serve solo con proxy HTTPS obbligatorio) |
| `hl-guard.mjs` | Sorveglianza Hyperliquid (429, monitor cross margin, funding, riconciliazione): arresto automatico dal launcher e stato da CLI (006J-4B) |
| `key-inject.mjs` | Preload: inserisce la chiave AI solo nelle richieste verso l'host AI; il database contiene solo il segnaposto (006J-4B) |
| `test/selftest.mjs` | Verifica offline di tutti gli script (nessuna rete, nessuna AI) |
| `test/build-synthetic.mts` | Database SINTETICO generato dal motore reale, solo per i test |
| `test/fake-backend.mjs` | Finto backend per testare il launcher, solo per i test |

## Requisiti

- Node.js 22 (verificato con v22.22.0) e le dipendenze del monorepo: dalla radice `pnpm install`.
  Gli script usano `backend/node_modules` (`better-sqlite3`, `ccxt`, `tsx`).
- Rete verso `api.hyperliquid.xyz` (prezzi), il feed RSS CoinJournal (notizie) e
  `generativelanguage.googleapis.com` (Gemini).
- Porta locale libera (default `5611`).

Verifica offline prima di ogni pilota (da `backend/`):

```bash
node pilot/test/selftest.mjs        # atteso: 12/12 verifiche superate
```

## 1. Database separato

Il launcher crea **sempre** un database nuovo in `--run-dir` e rifiuta una cartella non vuota.
Non riusa né modifica `backend/data.db` o database di prove precedenti.
Usare `pilot/runs/<data>` (ignorata da git) o una cartella fuori dal repository.

L'app all'avvio esegue il seed originale (utente `default` e conto "GPT" da 10.000 con chiave segnaposto,
che l'AI salta). Il launcher crea poi **un solo** conto AI da 1.000 USDC con `POST /api/account`:
è questa chiamata ad avviare il ciclo 1. Non usare la dashboard né altre API durante la prova:
ogni salvataggio di un conto avvia un ciclo in più.

## 2. Chiave API senza esporla

**Claude Code cloud (Network Secret).** Configurare nell'ambiente un Network Secret per
`generativelanguage.googleapis.com` con intestazione `Authorization: Bearer`. Il proxy inserisce la
chiave: il conto usa il segnaposto `network-secret-placeholder` (default `--key-mode network-secret`),
quindi la chiave non entra mai in database, log o traccia.

**PC di casa (nessun proxy).** Il Network Secret non esiste: la chiave va passata in una variabile
d'ambiente (`--key-mode env --key-env GEMINI_API_KEY`). Dal 006J-4B il conto riceve **solo il segnaposto**,
come nel cloud: il preload `key-inject.mjs`, caricato dal launcher nel processo dell'app, aggiunge la chiave
alle sole richieste HTTPS verso l'host di `--base-url` e la rimuove dall'ambiente dell'app. La chiave non
viene mai scritta nel database, nel log o nella traccia, quindi anche dopo un crash o un'interruzione di
corrente non c'e nulla da cancellare nei file della prova (verificato nel selftest con l'arresto brusco di
launcher e app). Resta nella memoria dei processi e, come ogni dato in memoria, puo finire nel file di
paging o di ibernazione di Windows: fuori dal controllo del pilota. Se la riga `[key-inject] attivo` manca
nel log all'avvio, il launcher si ferma prima di creare il conto.

Database di prove precedenti al 006J-4B interrotte senza arresto controllato: la chiave puo essere rimasta
nel conto. Pulizia (da `backend/`, PowerShell o bash):

```powershell
node -e "const D=require('better-sqlite3');const d=new D(process.argv[1],{timeout:5000});const r=d.prepare('UPDATE accounts SET api_key=? WHERE name LIKE ?').run('redacted-after-run','pilot-%');console.log('righe:',r.changes);d.close()" "pilot\runs\<cartella>\pilot.db"
```

```powershell
# Windows PowerShell 7+: chiave solo per la sessione corrente, mai salvata in file
$env:GEMINI_API_KEY = Read-Host -MaskInput "Gemini API key"
```
```bash
# Linux/macOS
read -rs GEMINI_API_KEY && export GEMINI_API_KEY
```

Non scrivere mai la chiave in file, comandi salvati nella cronologia o messaggi.

## 3. Avvio del pilota (solo dopo autorizzazione)

Da `backend/`:

```bash
# Claude Code cloud (proxy obbligatorio: lo shim si attiva da solo con HTTPS_PROXY)
node pilot/run-pilot.mjs --authorized --run-dir pilot/runs/pilot-AAAAMMGG-HHMM

# PC di casa
node pilot/run-pilot.mjs --authorized --run-dir pilot/runs/pilot-AAAAMMGG-HHMM --key-mode env --proxy-shim off
```

Parametri fissi del pilota: modello `gemini-3.5-flash-lite`, base URL
`https://generativelanguage.googleapis.com/v1beta/openai`, 12 cicli ogni 300 s (circa 55–60 minuti),
mercati BTC ETH SOL BNB XRP DOGE del prompt originale, solo perpetual MARKET.
Per la prova da 24 h (autorizzazione separata): `--cycles 288 --max-attempts 300 --timeout-min 1460`.

**Modello economico (`--cost-model`, default `original`).** Fissato alla creazione del conto e poi
immutabile, quindi una prova non mescola mai due modelli:

- `original`: regole dell'autore (commissione taker 0,07%, interessi, monitor e prezzi originali);
- `hyperliquid`: commissione taker perpetual 0,045% (livello base di Hyperliquid senza sconti:
  un'ipotesi esplicita) e **funding orario** al posto degli interessi: a ogni ora piena, per ogni
  perpetual tenuta (anche 1x), quantità × prezzo oracle × tasso orario realizzato; con tasso positivo
  paga il LONG e incassa lo SHORT. Il tasso viene da `fundingHistory`; il prezzo oracle viene
  catturato dall'app entro 60 s dall'ora (Hyperliquid non ne pubblica lo storico): se l'app era ferma
  a quell'ora, l'ora resta **non regolata** (`missing_oracle`), senza importo. Equity, P&L non
  realizzato e margine sono a **mark price**; la liquidazione segue il **cross margin** di Hyperliquid
  (valore del conto a mark sotto la somma dei margini di mantenimento delle fasce ufficiali, anche 1x)
  e le aperture sopra la leva massima del mercato (da `meta`) sono rifiutate. Senza mark price valido
  e recente o senza tabelle di margine non si liquida nulla. Ordini e liquidazioni si eseguono come IOC
  sul book `l2Book` (006I-5), con la precisione e il minimo di 10 USD di Hyperliquid (006I-4). Non
  modellato: backstop della vault di liquidazione.

Il launcher invia il modello alla creazione del conto e si ferma se l'app risponde con un altro
modello. Fuori dal launcher lo stesso valore si può dare con la variabile `ALPHA_COST_MODEL` (usata
quando la richiesta di creazione non indica `cost_model`). I conti dei database precedenti restano
`original`.

**Limite rigido dei tentativi verso l'AI (`ai-budget.mjs`, automatico dal 007G).** Il launcher carica sempre il
preload nel processo dell'app con `--max-attempts` (default 12), l'host di `--base-url` e il registro
`<cartella>/ai-attempts.jsonl`; non serve impostare `NODE_OPTIONS` o `AI_BUDGET_*`.

- Ogni tentativo HTTP verso l'host AI, retry automatici del client e tentativi finiti in timeout compresi, viene
  scritto nel registro e contato PRIMA dell'invio; oltre il limite la richiesta viene rifiutata senza partire
  (il client la tratta come un errore: ciclo senza decisione). Se il registro non si puo scrivere, la richiesta
  non parte.
- Il limite vale dentro l'app, non dipende dai controlli del launcher (ogni `--poll-ms`, 15 s): nemmeno una raffica
  di tentativi tra due controlli lo supera.
- Il launcher non crea il conto se nel log dell'app manca la riga
  `[ai-budget] attivo: max <N> tentativi verso <host>, gia inviati 0`; al primo tentativo rifiutato si ferma
  ("limite tentativi AI raggiunto"), con controllo, report e rimozione della chiave come negli altri arresti.
- Il conteggio usato e quello del registro (tentativi inviati); la stima dal log (richieste + righe di retry,
  che conta anche i retry rifiutati) resta solo informativa in `check.json`.
- Dopo una risposta 401/403/404 nessun altro tentativo viene inviato.

Il launcher:

1. rifiuta se manca `--authorized`, se la cartella non è vuota, se la porta è occupata o la chiave manca;
2. avvia l'app originale (`src/index.ts`) con `DATABASE_PATH`, `AI_DIAGNOSTICS_FILE`, `LOG_LEVEL=info`;
3. **prima di creare il conto** verifica nel log: exchange inizializzato, prezzi pronti, job AI
   pianificato a 300 s, monitor a 5 s, nessun ripiego su ordini casuali. Se qualcosa manca si ferma
   senza alcuna chiamata AI;
4. crea il conto una sola volta e sorveglia log e traccia ogni 15 s.

## 3b. Variante sperimentale (branch `claude/exp-007a-profit-protection`, Task 007A / 007C)

Due interruttori indipendenti, **spenti per default**: con i default il prompt inviato a Gemini e il
comportamento sono identici alla versione originale (verificato: stesso SHA-256 del prompt di `b2459e8`).

| Opzione del launcher | Variabile dell'app | Effetto |
|---|---|---|
| `--position-info v2` | `ALPHA_POSITION_INFO=v2` | All'AI: `entry_value` distinto da `current_value` (in v1 `current_value` era quantità × prezzo di ingresso), `current_price`, `unrealized_pnl`, `fees_paid`, `estimated_exit_fee`, `financing_net`, `estimated_net_pnl_if_closed_now`, `return_on_margin_pct`, `opened_at`, `holding_minutes`; con il modulo acceso anche `exit_plan` (stop, livello di uscita, target, rischio allo stop) e la riga dei cooldown attivi. |
| `--protection C1` / `C2` / `C3` | `ALPHA_PROTECTION=C1…` | Gestione delle uscite, **solo modello `hyperliquid`**, nel monitor cross margin (5 s), a mark price valido e fresco. |
| `--protection-config '{...}'` | `ALPHA_PROTECTION_CONFIG` | Parametri diversi dai default (JSON convalidato: un valore sconosciuto o fuori intervallo ferma l'app all'avvio). |
| `--prompt v1` / `v3` / `v4` | `ALPHA_PROMPT=…` | Prompt dell'AI. `v1` originale (default); `v3` contesto di mercato, memoria, notizie filtrate, risposta convalidata (007F); `v4` come v3 piu confronto LONG/SHORT/HOLD con lo stesso standard, una sola convenzione dei segni (`price_minus_<x>_atr`), riferimenti LONG/SHORT con il modulo di uscita, memoria senza il testo dei ragionamenti precedenti, `max_tokens` 1500 (008; `research/ai-decisions/README.md`). |

Il launcher scrive la variante in `run-meta.json` (`plan.experiment`) e nel report, e **si ferma prima di
creare il conto** se l'app non conferma nel log `Experiment config: position_info=… protection=… prompt=…`.

**Regole** (`src/services/exitRules.ts`; Gemini decide ingressi, dimensione e leva):

- tutte: stop iniziale a **2 × ATR(14, 1 h)** dal prezzo di ingresso; R = quella distanza. L'ATR viene solo da
  barre 1 h chiuse **prima del primo fill** (dalle candele 15 m già in cache) e resta fisso per la posizione;
- **C1**: chandelier = miglior prezzo − 3 ATR (mai sotto lo stop), nessun take profit;
- **C2**: 25% realizzato a +1,5 R; poi il resto con pareggio (prezzo di ingresso) e chandelier 3 ATR. Se il 25%
  arrotondato al lotto vale meno di 10 USD (minimo Hyperliquid) non si piazza: evento `skipped` una sola volta e
  pareggio + chandelier si applicano all'intera posizione;
- **C3**: take profit dell'intera posizione a +2 R, altrimenti lo stop;
- **cooldown**: dopo un'uscita del modulo che chiude la posizione, l'AI non può riaprire la stessa moneta nella
  stessa direzione per 2 h (`cooldownMs`); la direzione opposta è libera. Il rifiuto è registrato;
- **emergenza sul conto** (separata dagli stop): se le posizioni aperte insieme perdono il 3% del valore del conto
  (`emergencyLossPctOfEquity`), si chiudono tutte;
- **rischio sul capitale**: per ogni posizione si calcola la perdita allo stop (movimento + commissioni +
  slippage stimato) in USDC e in % del conto, il confronto con i profili 0,5 / 1 / 2% e il segnale `oversized` sopra
  il riferimento 1%. **Il sizing resta quello di Gemini**: una posizione sovradimensionata è segnalata, non ridotta;
- esecuzione: ordini `PRT-…` del motore (stesse commissioni, book, lotti, minimi, riconciliazione); fill parziale
  del book → resto al tentativo successivo; errori → nuovi tentativi dopo 15 s, 30 s, 60 s… fino a 15 min;
  posizione cambiata nel frattempo → riletta e chiusa una volta con la quantità attuale.

Tutto è registrato: `exit_plans` (livelli, ATR, rischio, stato) ed `exit_events` (piani, parziali, uscite
eseguite/parziali/fallite con fill e slippage rispetto al mark, emergenze, cooldown). `report.json` ha le sezioni
`exit_management` e `decision_trace` (cronologia unica AI + modulo).

**Replay cronologico** su una prova registrata (sola lettura, senza AI né rete):

```bash
node --import tsx pilot/replay-exits.mjs pilot/runs/<cartella> --text
```

Usa le candele 15 m di `research/exit-rules/data` (SHA-256 verificati; coprono fino al 31/10/2026 20:45 UTC) e
`pilot.db` / `trace.jsonl` della prova. Il risultato è **ipotetico**; i limiti (candele = prezzi di scambio, non mark;
book non registrato; decisioni di Gemini dopo un'uscita ipotetica non simulabili) sono nel campo `limits`.
La ricerca riproducibile su C1/C2/C3 è in `research/exit-rules/README.md`.

## 4. Controllo dello scheduler

L'unica prova valida è la riga dello scheduler:

```
services.scheduler: Auto trading job reset successfully - interval: 300s
```

La riga `api.account: Auto trading job reset successfully after account creation` **non** prova nulla:
viene scritta anche quando il reset è fallito. Controllo manuale in qualunque momento (sola lettura):

```bash
node pilot/check-run.mjs pilot/runs/<cartella>/backend.log pilot/runs/<cartella>/trace.jsonl
# 0 = OK, 1 = problemi bloccanti, 2 = da fermare subito
```

## 5. Arresto

Automatico quando si verifica una di queste condizioni:

- completati i cicli previsti (eventi `outcome` nella traccia);
- primo tentativo AI rifiutato dal limite preventivo `--max-attempts` (retry e timeout compresi; nessun tentativo oltre il limite viene inviato);
- 3 cicli consecutivi senza decisione o con esecuzione fallita;
- errore 401/403/404, chiamate duplicate (meno di 240 s), chiave nel log o nella traccia;
- reset dello scheduler fallito, ordini manuali, nessuna chiamata AI entro 6 minuti dalla creazione del conto;
- timeout (`--timeout-min`, default 62);
- **sorveglianza Hyperliquid** (`hl-guard.mjs`, dal 006J-4B; `--guard off` la disattiva), a ogni controllo:
  - posizione aperta (conto `hyperliquid`) e monitor cross margin senza valutazioni da oltre 5 minuti
    (episodio `not evaluated` senza `evaluated again`, oppure nessun prezzo aggiornato da 5 minuti);
  - HTTP 429 di Hyperliquid persistenti (almeno 2 senza prezzi validi per oltre 10 minuti) o piu di 30
    nell'ultima ora (le righe di uno stesso 429 contano una volta; i 429 di Gemini sono esclusi);
  - funding non regolato per 3 ore consecutive con posizione aperta (un'ora senza riga conta dopo 60 minuti);
  - riconciliazione contabile errata in 2 controlli consecutivi (ogni `--recon-ms`, default 2 minuti),
    oppure non verificabile (errore di lettura) in 5 controlli di fila;
  - sorveglianza che non riesce a leggere log e database per 20 controlli di fila (~5 minuti).

  Sono solo avvisi (salvati in `run-meta.json` alla voce `guard`): un 429 isolato o seguito da prezzi
  validi, un controllo del monitor saltato e recuperato entro 5 minuti, una o due ore di funding non
  regolate, una riconciliazione errata isolata, un errore temporaneo di lettura del database.

Stato in qualunque momento, da un'altra finestra (sola lettura; 0 = nessun problema bloccante, 2 = bloccante):

```bash
node pilot/hl-guard.mjs pilot/runs/<cartella>
```

Arresto manuale, su qualunque sistema:

- **file `STOP`** nella cartella della prova (consigliato, anche da un altro terminale):
  `New-Item -ItemType File pilot\runs\<cartella>\STOP` in PowerShell (`type nul > ...` vale solo nel
  Prompt dei comandi), `touch pilot/runs/<cartella>/STOP` altrove;
- **`Ctrl+C`** nel terminale del launcher.

Entrambi fermano l'app, salvano `run-meta.json`, `check.json` e `report.json` e, con `--key-mode env`,
cancellano la chiave dal database. Conviene fermare subito dopo un ciclo, non durante una chiamata.

Dettagli per sistema:

- **Linux/macOS:** il launcher invia SIGTERM; l'app ferma lo scheduler e chiude il server
  (nel log compare `Received SIGTERM`).
- **Windows:** non esiste SIGTERM. Il launcher termina l'app con `taskkill /T /F`, quindi la riga
  `Received SIGTERM` non compare. Le scritture SQLite sono transazioni atomiche e i dati restano nel
  file `pilot.db-wal`, che va conservato insieme a `pilot.db`. Un `kill` inviato al launcher da un
  altro processo lo termina senza report: usare il file `STOP`. Se la finestra del launcher viene
  chiusa, verificare che la porta 5611 sia libera (`netstat -ano | findstr 5611`) e chiudere il
  processo rimasto (`taskkill /pid <pid> /T /F`).
- L'app gira in un solo processo Node (`node --import tsx src/index.ts`), così l'arresto non lascia
  processi orfani.

## 6. Report economico

Generato automaticamente in `report.json`; a mano (sola lettura):

```bash
node pilot/report.mjs pilot/runs/<cartella>/pilot.db pilot/runs/<cartella>/trace.jsonl --price-in <USD/1M> --price-out <USD/1M>
```

Contiene:

- capitale iniziale e finale;
- P&L lordo, netto, realizzato e non realizzato, in USDC e %;
- `cost_model`: modello economico del conto, tasso taker applicato e tassi registrati nei fill, con
  la nota di cosa il modello copre;
- commissioni e interessi addebitati, e a parte quelli maturati ma non addebitati;
- `margin`: regola di liquidazione del modello ed eventi di liquidazione cross (valore del conto,
  margine di mantenimento, mark usati, ordini `LIQ-`, modalità di esecuzione);
- `funding` (modello hyperliquid): pagato, ricevuto e netto, già inclusi in cassa, equity e netto;
  ore regolate, non regolate per dati mancanti (`missing_oracle`, `missing_rate`) e non registrate
  (regolazione in attesa o app ferma);
- `if_closed`, separato dal risultato registrato: commissione stimata per chiudere ogni posizione
  aperta al prezzo finale (commissione taker del motore), interessi maturati non addebitati, P&L netto
  ed equity finale ipotetici dopo la chiusura, in USDC e %. È una stima: nessuno spread, slippage,
  impatto di prezzo o funding; senza un prezzo finale per ogni posizione aperta resta vuota
  (`complete: false`);
- aperture e chiusure LONG/SHORT, HOLD;
- chiusure e posizioni vincenti e perdenti;
- liquidazioni (`LIQ-`);
- drawdown massimo sui "Total Assets" di ogni ciclo (campionamento 5 min);
- risultati giornalieri;
- benchmark HOLD e BTC compra-e-tieni 1x;
- token e costo AI;
- anomalie.

Commissione e tasso d'interesse sono letti da `src/db/schema.ts` (`CRYPTO_TAKER_FEE_RATE`,
`CRYPTO_INTEREST_RATE_HOURLY`): il report usa sempre le regole del motore.

Riconciliazione, con ogni costo contato una sola volta:
`cassa = capitale + P&L realizzato − commissioni − interessi − margine delle posizioni aperte`.
Il prezzo finale è quello dell'ultimo ciclo (massimo 5 minuti prima dell'arresto); si può forzare
con `--prices '{"BTC":...}' --at <ISO>`. La curva della dashboard non è usata: non è attendibile
per SHORT e leva.

## 7. Conservare i risultati

La cartella della prova contiene `pilot.db`, `backend.log`, `trace.jsonl`, `run-meta.json`,
`check.json` e `report.json`.

- Non pubblicare mai la cartella su git (`pilot/runs/` è ignorata).
- Conservarla in privato: la traccia contiene prompt, notizie e risposte complete.
- Per condividere i risultati basta `report.json` (nessuna chiave, nessun prompt).

## Limiti dichiarati della prova

- Modello `original` (default): monitor originale (equity/marginUsed < 0,5; posizioni 1x, SHORT compreso,
  non monitorate), interessi dell'autore (0,00125%/h), commissione 0,07% senza slippage né spread,
  esecuzione all'ultimo prezzo (cache 30 s).
- Modello `hyperliquid`: regole e limiti descritti nella sezione 3 e nella nota `cost_model` del report
  (backstop della vault di liquidazione non riprodotto; funding non regolato se l'app era ferma all'ora).
- Un prezzo mancante salta il ciclo; nell'equity il PnL di quel simbolo vale 0 per quel momento.
- 12 cicli verificano pipeline e contabilità, non la redditività.
- La sorveglianza Hyperliquid legge le righe di log introdotte nel 006J-2 (`evaluated again after N
  skipped checks`): su log di versioni precedenti un controllo saltato e poi recuperato resta "aperto".
