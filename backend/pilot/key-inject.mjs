// ALPHA BOT pilota (006J-4B) — preload che inserisce la chiave AI solo nelle richieste verso l'host AI,
// come fa il Network Secret del proxy cloud. Caricato dal launcher con --import nel processo dell'app
// (solo con --key-mode env). Il conto della prova contiene SOLO il segnaposto: la chiave reale non entra mai
// nel database, nel log o nella traccia, quindi anche dopo un crash o un'interruzione di corrente non c'e
// nulla da cancellare nei file della prova. La chiave resta nella memoria dei processi (launcher e app).
//
// Variabili (impostate dal launcher):
//   ALPHA_PILOT_KEY_ENV   nome della variabile con la chiave (es. GEMINI_API_KEY); letta e poi rimossa
//                         dall'ambiente di questo processo
//   ALPHA_PILOT_KEY_HOST  unico host a cui la chiave viene inviata (es. generativelanguage.googleapis.com)
//   ALPHA_PILOT_KEY_PLACEHOLDER  segnaposto salvato nel conto (default network-secret-placeholder)
// Solo HTTPS; ALPHA_PILOT_KEY_INSECURE_TEST=1 ammette HTTP (solo per i test offline su 127.0.0.1).
// Sostituisce l'intestazione solo se e esattamente "Bearer <segnaposto>"; non registra ne stampa la chiave.
const NAME = process.env.ALPHA_PILOT_KEY_ENV
const HOST = process.env.ALPHA_PILOT_KEY_HOST
const PLACEHOLDER = process.env.ALPHA_PILOT_KEY_PLACEHOLDER || 'network-secret-placeholder'
const insecureTest = process.env.ALPHA_PILOT_KEY_INSECURE_TEST === '1'
const key = NAME ? process.env[NAME] : undefined
if (NAME) delete process.env[NAME]

const original = globalThis.fetch
if (key && key.trim() && HOST && typeof original === 'function') {
  globalThis.fetch = function keyInjectedFetch(input, init) {
    let url = null
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    } catch {}
    if (!url || url.hostname !== HOST || !(url.protocol === 'https:' || (insecureTest && url.protocol === 'http:'))) {
      return original(input, init)
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (headers.get('authorization') !== `Bearer ${PLACEHOLDER}`) return original(input, init)
    headers.set('authorization', `Bearer ${key}`)
    return original(input, { ...init, headers })
  }
  // riga di controllo per il launcher (nessun dato sensibile): senza di essa il pilota non parte
  process.stderr.write(`[key-inject] attivo: chiave da ${NAME} solo verso https://${HOST}\n`)
} else {
  process.stderr.write(`[key-inject] NON attivo: variabile ${NAME ?? '(non indicata)'} vuota o host mancante\n`)
}
