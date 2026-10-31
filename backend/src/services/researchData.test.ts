/**
 * Integrity of the research data after a checkout, Windows included
 * (Task 007E). The SHA-256 checks stay mandatory; this test makes sure a
 * checkout cannot change the bytes they check.
 *
 * Run: npx tsx --test src/services/researchData.test.ts
 *
 * On Windows, Git's usual core.autocrlf=true turned LF into CRLF in
 * MANIFEST.json, books.json and meta.json and broke their checksums. The
 * repository .gitattributes now stores research/exit-rules/data unchanged
 * (-text) and the generated results with LF. Test 4 reproduces the Windows
 * checkout (autocrlf=true also converts on Linux) on the committed HEAD.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repoRoot = path.resolve(backendDir, '..')
const dataDir = path.join(backendDir, 'research/exit-rules/data')
const lib = (await import(new URL('../../research/exit-rules/lib.mts', import.meta.url).href)) as {
  verifiedManifest: (dir?: string) => { files: Record<string, { sha256: string }> }
}
const git = (args: string[], cwd = repoRoot) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const hasGit = git(['rev-parse', '--git-dir']).status === 0
const TEXT_FILES = ['MANIFEST.json', 'books.json', 'meta.json']

test('1. the committed research data passes its checksums, and its JSON files have LF line endings', () => {
  const m = lib.verifiedManifest(dataDir)
  assert.equal(Object.keys(m.files).length, 6)
  for (const f of TEXT_FILES) assert.ok(!fs.readFileSync(path.join(dataDir, f)).includes(13), `${f} contains CR`)
})

test('2. .gitattributes: the data is never converted (-text), the results are always LF', { skip: !hasGit && 'not a git checkout' }, () => {
  const files = ['backend/research/exit-rules/data/MANIFEST.json', 'backend/research/exit-rules/data/books.json',
    'backend/research/exit-rules/data/meta.json', 'backend/research/exit-rules/data/candles-15m.csv.gz']
  const out = git(['check-attr', 'text', '--', ...files]).stdout
  for (const f of files) assert.match(out, new RegExp(`${f.replace(/[.]/g, '\\.')}: text: unset`), f)
  assert.match(git(['check-attr', 'eol', '--', 'backend/research/exit-rules/results/results.json']).stdout, /eol: lf/)
})

test('3. a CRLF copy is still refused, with a message that names the line endings (the checksums are not disabled)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-crlf-'))
  try {
    for (const f of fs.readdirSync(dataDir)) fs.copyFileSync(path.join(dataDir, f), path.join(dir, f))
    const books = path.join(dir, 'books.json')
    fs.writeFileSync(books, fs.readFileSync(books, 'utf8').replace(/\n/g, '\r\n'))
    assert.throws(() => lib.verifiedManifest(dir), /integrity check failed for books\.json: .*Windows line endings \(CRLF\).*git checkout -- backend\/research\/exit-rules\/data/)
    // any other change is refused as well, without the line-ending hint
    fs.copyFileSync(path.join(dataDir, 'books.json'), books)
    const meta = path.join(dir, 'meta.json')
    fs.writeFileSync(meta, fs.readFileSync(meta, 'utf8').replace('"szDecimals": 5', '"szDecimals": 4'))
    assert.throws(() => lib.verifiedManifest(dir), (e: Error) => /integrity check failed for meta\.json/.test(e.message) && !/CRLF/.test(e.message))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('4. a Windows-style checkout (core.autocrlf=true) of the committed HEAD keeps every checksum', { skip: !hasGit && 'not a git checkout' }, (t) => {
  const head = git(['rev-parse', 'HEAD']).stdout.trim()
  if (git(['cat-file', '-e', `${head}:.gitattributes`]).status !== 0) {
    t.skip('HEAD has no .gitattributes yet (run after committing)')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-autocrlf-'))
  try {
    assert.equal(git(['clone', '-q', '--no-checkout', '-c', 'core.autocrlf=true', repoRoot, dir]).status, 0)
    assert.equal(git(['-c', 'core.autocrlf=true', 'checkout', '-q', head], dir).status, 0)
    const cloned = path.join(dir, 'backend/research/exit-rules/data')
    assert.doesNotThrow(() => lib.verifiedManifest(cloned))
    for (const f of TEXT_FILES) assert.ok(!fs.readFileSync(path.join(cloned, f)).includes(13), `${f} converted to CRLF`)
    // and the generated results stay LF, so a re-run on Windows is still byte-identical
    assert.ok(!fs.readFileSync(path.join(dir, 'backend/research/exit-rules/results/summary.md')).includes(13))
    // a source file elsewhere is converted as usual: the rule is limited to the research data and results
    assert.ok(fs.readFileSync(path.join(dir, 'backend/package.json')).includes(13), 'autocrlf was not active in the clone')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
