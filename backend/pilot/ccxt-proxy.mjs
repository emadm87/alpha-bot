// Shim di trasporto per ambienti con proxy HTTPS obbligatorio (es. Claude Code cloud).
// Caricato con NODE_OPTIONS=--import <file URL>; aggiunge SOLO l'opzione httpsProxy a
// ccxt.hyperliquid quando HTTPS_PROXY e impostata. Non tocca prezzi, ordini o logica di trading.
// Risolve ccxt da backend/node_modules, cosi patcha la stessa istanza ESM importata dall'app.
// Senza HTTPS_PROXY (es. PC di casa senza proxy) non fa nulla e non serve caricarlo.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
if (proxy) {
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkgDir = fs.realpathSync(path.join(backendDir, 'node_modules', 'ccxt'))
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const esm = pkg.exports?.['.']?.import ?? pkg.module
  const entry = typeof esm === 'string' ? esm : esm?.default
  const ccxt = (await import(pathToFileURL(path.join(pkgDir, entry)).href)).default
  const Orig = ccxt.hyperliquid
  ccxt.hyperliquid = class extends Orig {
    constructor(config = {}) {
      super({ ...config, httpsProxy: proxy })
    }
  }
}
