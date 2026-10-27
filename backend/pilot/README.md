# Pilota AI forward — ALPHA BOT

Strumenti per la prima prova forward dell'AI originale con **1.000 USDC simulati**.
Preflight completato nel Task 006G-6D; **la simulazione non è ancora stata eseguita**.

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
| `ccxt-proxy.mjs` | Shim di trasporto: aggiunge solo `httpsProxy` a ccxt (serve solo con proxy HTTPS obbligatorio) |
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
d'ambiente e il launcher la mette nel conto (`--key-mode env --key-env GEMINI_API_KEY`).
La chiave resta nel database della prova solo durante l'esecuzione: a fine prova il launcher la
sostituisce con `redacted-after-run`. La traccia 006B la maschera sempre.

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
  e recente o senza tabelle di margine non si liquida nulla. Non ancora modellati: esecuzione al
  bid/ask (ordini e liquidazioni si eseguono al mid), precisione degli ordini, backstop della vault.

Il launcher invia il modello alla creazione del conto e si ferma se l'app risponde con un altro
modello. Fuori dal launcher lo stesso valore si può dare con la variabile `ALPHA_COST_MODEL` (usata
quando la richiesta di creazione non indica `cost_model`). I conti dei database precedenti restano
`original`.

**Limite rigido dei tentativi verso Gemini (`ai-budget.mjs`).** `--max-attempts` è solo un controllo a
posteriori. Il limite garantito si ottiene caricando il preload, che rifiuta senza inviarla ogni richiesta
oltre `AI_BUDGET_MAX`, retry compresi (vale per il processo dell'app; il launcher non lo riavvia):

```bash
AI_BUDGET_MAX=300 AI_BUDGET_FILE="$PWD/pilot/runs/<cartella>/ai-attempts.jsonl" \
NODE_OPTIONS="--import file://$PWD/pilot/ai-budget.mjs" node pilot/run-pilot.mjs --authorized ...
```
```powershell
$env:AI_BUDGET_MAX = "300"
$env:AI_BUDGET_FILE = "$PWD\pilot\runs\<cartella>\ai-attempts.jsonl"
$env:NODE_OPTIONS = "--import " + ([System.Uri](Resolve-Path pilot\ai-budget.mjs).Path).AbsoluteUri
node pilot/run-pilot.mjs --authorized ...
```
Il file viene creato alla prima chiamata, quindi può stare nella cartella della prova. Dopo il ciclo 1 il file `ai-attempts.jsonl` deve esistere: se manca, il preload non è attivo e va fermata la prova.

Il launcher:

1. rifiuta se manca `--authorized`, se la cartella non è vuota, se la porta è occupata o la chiave manca;
2. avvia l'app originale (`src/index.ts`) con `DATABASE_PATH`, `AI_DIAGNOSTICS_FILE`, `LOG_LEVEL=info`;
3. **prima di creare il conto** verifica nel log: exchange inizializzato, prezzi pronti, job AI
   pianificato a 300 s, monitor a 5 s, nessun ripiego su ordini casuali. Se qualcosa manca si ferma
   senza alcuna chiamata AI;
4. crea il conto una sola volta e sorveglia log e traccia ogni 15 s.

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
- tentativi HTTP verso l'AI oltre `--max-attempts` (l'app ripete fino a 3 tentativi per ciclo);
- 3 cicli consecutivi senza decisione o con esecuzione fallita;
- errore 401/403/404, chiamate duplicate (meno di 240 s), chiave nel log o nella traccia;
- reset dello scheduler fallito, ordini manuali, nessuna chiamata AI entro 6 minuti dalla creazione del conto;
- timeout (`--timeout-min`, default 62).

Arresto manuale, su qualunque sistema:

- **file `STOP`** nella cartella della prova (consigliato, anche da un altro terminale):
  `type nul > pilot\runs\<cartella>\STOP` su Windows, `touch pilot/runs/<cartella>/STOP` altrove;
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

- Il monitor operativo è quello originale (equity/marginUsed < 0,5), non Hyperliquid. Le posizioni 1x,
  SHORT compreso, non sono monitorate.
- Interessi dell'autore (0,00125%/h) al posto del funding Hyperliquid.
- Commissione 0,07% senza slippage né spread, esecuzione all'ultimo prezzo (cache 30 s).
- Un prezzo mancante salta il ciclo; nell'equity il PnL di quel simbolo vale 0 per quel momento.
- 12 cicli verificano pipeline e contabilità, non la redditività.
