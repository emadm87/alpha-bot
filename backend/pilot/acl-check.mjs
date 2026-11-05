// ALPHA BOT pilota (009B-FIX) - controllo dei permessi effettivi dei file della prova su Windows (ACL NTFS).
// Su Windows i permessi POSIX non esistono: Node riporta sempre 0o666 (0o444 se in sola lettura) e chmod 0o600
// non restringe nulla. La protezione reale e l'ACL del file, ereditata dalla cartella. Questo controllo legge
// l'ACL con PowerShell (Get-Acl), traduce ogni identita nel suo SID (indipendente dalla lingua di Windows) e
// segnala ogni voce "Allow" per gruppi ampi: Everyone, Authenticated Users, Users, Guests, Anonymous.
//
// CLI (Windows):  node pilot/acl-check.mjs <file-o-cartella> [...]   (una cartella: lei e i file che contiene)
// Esito: 0 = nessun accesso per gruppi ampi, 1 = accesso trovato o ACL non leggibile.
// Modulo: windowsAcl(path) -> [{ sid, rights, type, inherited }]; broadAccess(aces) -> voci da correggere.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BROAD_SIDS = {
  'S-1-1-0': 'Everyone',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-32-545': 'Users',
  'S-1-5-32-546': 'Guests',
  'S-1-5-7': 'Anonymous',
}

/** Voci "Allow" per gruppi ampi (qualunque diritto: anche la sola lettura espone il contenuto). */
export function broadAccess(aces) {
  return aces
    .filter((a) => String(a.type).toLowerCase() === 'allow' && a.sid in BROAD_SIDS)
    .map((a) => ({ ...a, group: BROAD_SIDS[a.sid] }))
}

// Il percorso passa per una variabile d'ambiente: nessun problema di virgolette o spazi nel comando.
const PS = [
  '$ErrorActionPreference = "Stop"',
  '$acl = Get-Acl -LiteralPath $env:ALPHA_ACL_TARGET',
  '$out = @(foreach ($ace in $acl.Access) {',
  '  try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$ace.IdentityReference }',
  '  [pscustomobject]@{ sid = $sid; rights = [string]$ace.FileSystemRights; type = [string]$ace.AccessControlType; inherited = [bool]$ace.IsInherited }',
  '})',
  'ConvertTo-Json -InputObject $out -Compress',
].join('\n')

/** ACL di un file o di una cartella (solo Windows). Lancia un errore se non e leggibile. */
export function windowsAcl(target) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
    encoding: 'utf8', env: { ...process.env, ALPHA_ACL_TARGET: path.resolve(target) }, windowsHide: true,
  })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`Get-Acl fallito (${r.status}): ${String(r.stderr).trim().slice(0, 300)}`)
  const parsed = JSON.parse(String(r.stdout).trim() || '[]')
  return Array.isArray(parsed) ? parsed : [parsed]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  if (process.platform !== 'win32') {
    console.error('acl-check: solo Windows (altrove valgono i permessi POSIX, es. 0600)')
    process.exit(64)
  }
  const targets = process.argv.slice(2).flatMap((t) => (fs.existsSync(t) && fs.statSync(t).isDirectory()
    ? [t, ...fs.readdirSync(t).map((f) => path.join(t, f)).filter((f) => fs.statSync(f).isFile())] : [t]))
  if (!targets.length) {
    console.error('uso: node pilot/acl-check.mjs <file-o-cartella> [...]')
    process.exit(64)
  }
  let bad = 0
  for (const t of targets) {
    try {
      const aces = windowsAcl(t)
      const broad = broadAccess(aces)
      if (broad.length || !aces.length) bad++
      console.log(JSON.stringify({ path: t, ok: broad.length === 0 && aces.length > 0, broad, sids: [...new Set(aces.map((a) => a.sid))] }))
    } catch (e) {
      bad++
      console.log(JSON.stringify({ path: t, ok: false, error: String(e.message ?? e) }))
    }
  }
  process.exit(bad ? 1 : 0)
}
