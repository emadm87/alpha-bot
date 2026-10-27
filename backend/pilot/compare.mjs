// ALPHA BOT (Task 006I-6) — confronto economico a posteriori: regole Originali vs Hyperliquid
// sugli STESSI fill registrati di un conto. Funzione pura: riceve righe gia lette (in sola lettura)
// dal report, non scrive nulla, non chiama rete o AI. Non e il risultato di due AI indipendenti.
//
// A. Stessi fill: quantita, sequenza e orari dei trade restano quelli registrati; cambiano solo le
//    componenti economiche ricalcolabili. Il P&L lordo e calcolato ai prezzi mid (identico per i due
//    modelli), poi ogni modello sottrae i propri costi:
//      Originale:   netto = lordo al mid - commissioni 0,07% sul nozionale al mid - interessi originali
//      Hyperliquid: netto = lordo al mid - costo di spread e profondita - commissioni 0,045% sul
//                   nozionale eseguito + funding netto
//    Il costo di spread e profondita e la differenza fra prezzo eseguito sul book e mid dello snapshot,
//    quindi nulla e contato due volte. Il modello del conto deve ritrovare il netto registrato.
// B. Stesse intenzioni d'ordine: per ogni ordine la quantita richiesta e quella eseguita; nessun P&L
//    concatenato, perche arrotondamenti, rifiuti e parziali cambiano le posizioni successive.

const HOUR = 3_600_000
const dbMs = (s) => (s ? Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : NaN)
const isOpenSide = (side) => side === 'LONG' || side === 'SHORT'

/**
 * @param {object} p
 * @param {'original'|'hyperliquid'} p.costModel modello del conto
 * @param {number} p.initialCapital
 * @param {object[]} p.trades trade del motore ordinati (con order_id, order_no, order_leverage)
 * @param {object[]} p.orders
 * @param {object[]} p.bookFills righe book_fills del conto
 * @param {object[]} p.fundingRows righe funding_payments del conto
 * @param {number} p.fundingNotRecorded ore con posizione senza riga di funding
 * @param {Record<string, number>|null} p.finalPrices prezzi finali (mid) per le posizioni aperte
 * @param {string} p.asOf
 * @param {{ original: number, hyperliquid: number }} p.feeRates
 * @param {number} p.interestRateHourly
 * @param {object[]} [p.refused] esiti execution_failed "Hyperliquid order refused" dalla traccia
 * @param {number} p.recordedNet netto registrato dal report (equity finale - capitale)
 */
export function buildComparison(p) {
  const { costModel, initialCapital, trades, orders, bookFills, fundingRows, finalPrices, asOf, feeRates } = p
  const RATE_H = p.interestRateHourly
  const bookByOrder = new Map(bookFills.map((f) => [f.order_id, f]))
  const issues = []
  const notes = []
  const perp = trades.filter((t) => t.taker_fee > 0)
  if (perp.length !== trades.length) issues.push(`${trades.length - perp.length} trade fuori dal motore perpetual esclusi`)

  // --- replay dei fill: un registro al mid (lordo e modello Originale) e uno ai prezzi eseguiti ---
  const mid = {} // symbol -> { side, qty, avg, margin, leverage, last } (motore originale, prezzi mid)
  const exe = {} // symbol -> { side, qty, avg } (prezzi eseguiti del modello Hyperliquid)
  const rows = []
  const tot = {
    realizedMid: 0, realizedExe: 0, feeOriginal: 0, feeHyperliquid: 0, interestOriginal: 0,
    spreadCost: 0, fillsWithBook: 0, fillsWithoutBook: 0,
  }
  for (const t of perp) {
    const ms = dbMs(t.trade_time)
    const book = bookByOrder.get(t.order_id)
    const q = t.quantity
    // prezzo mid di riferimento: mid dello snapshot se c'e un book; altrimenti il prezzo registrato,
    // che e un'esecuzione al mid (conti originali e fill hyperliquid precedenti al 006I-5)
    const midPx = book ? book.mid : t.price
    // prezzo Hyperliquid: quello eseguito sul book; senza book non si conosce (n.d.)
    const hlPx = book ? book.avg_price : null
    if (book) tot.fillsWithBook++
    else tot.fillsWithoutBook++
    if (book && costModel === 'hyperliquid' && Math.abs(book.avg_price - t.price) > 1e-9) {
      issues.push(`trade ${t.id}: prezzo ${t.price} diverso dal prezzo medio del book ${book.avg_price}`)
    }
    // il registro Hyperliquid usa il prezzo eseguito; senza book il prezzo registrato (stima al mid)
    const exePx = hlPx ?? t.price
    const feeO = q * midPx * feeRates.original
    const feeH = q * exePx * feeRates.hyperliquid
    tot.feeOriginal += feeO
    tot.feeHyperliquid += feeH
    const m = (mid[t.symbol] ??= { side: null, qty: 0, avg: 0, margin: 0, leverage: 1, last: null })
    const x = (exe[t.symbol] ??= { side: null, qty: 0, avg: 0 })
    // interessi del motore originale sulla parte presa a prestito, dall'ultimo addebito a questo fill
    const interestDue = () => {
      if (!(m.qty > 0) || m.leverage <= 1 || m.last === null) return 0
      return Math.max(m.qty * m.avg - m.margin, 0) * RATE_H * Math.max(ms - m.last, 0) / HOUR
    }
    let action, positionSide, interest = 0, realizedMid = null, realizedExe = null
    let spread = null
    if (isOpenSide(t.side)) {
      positionSide = t.side
      const leverage = Math.max(1, t.order_leverage ?? 1)
      const notional = q * midPx
      if (m.qty > 0) {
        action = 'increase'
        interest = interestDue()
        const newMargin = m.margin + notional / leverage
        const total = m.qty * m.avg + notional
        m.leverage = Math.max(1, Math.ceil(total / newMargin - 1e-9))
        m.avg = total / (m.qty + q)
        m.margin = newMargin
        m.qty = Number((m.qty + q).toFixed(10))
      } else {
        action = 'open'
        Object.assign(m, { side: t.side, qty: q, avg: midPx, margin: notional / leverage, leverage })
      }
      m.last = ms
      x.avg = x.qty > 0 ? (x.qty * x.avg + q * exePx) / (x.qty + q) : exePx
      x.qty = Number((x.qty + q).toFixed(10))
      x.side = t.side
      if (book) spread = (t.side === 'LONG' ? 1 : -1) * (hlPx - midPx) * q // acquisto per LONG, vendita per SHORT
    } else {
      positionSide = m.side
      if (!(m.qty > 0)) {
        issues.push(`trade ${t.id}: chiusura senza posizione nel replay`)
        continue
      }
      action = Math.abs(q - m.qty) <= 1e-12 ? 'close' : 'partial_close'
      interest = interestDue()
      const sign = m.side === 'LONG' ? 1 : -1
      realizedMid = sign * (midPx - m.avg) * q
      realizedExe = sign * (exePx - x.avg) * q
      tot.realizedMid += realizedMid
      tot.realizedExe += realizedExe
      if (book) spread = (m.side === 'LONG' ? -1 : 1) * (hlPx - midPx) * q // vendita per LONG, acquisto per SHORT
      const remaining = Number((m.qty - q).toFixed(10))
      m.margin = remaining > 0 ? m.margin * remaining / m.qty : 0
      m.qty = remaining
      x.qty = Number((x.qty - q).toFixed(10))
      if (remaining <= 0) Object.assign(m, { side: null, qty: 0, avg: 0, margin: 0, leverage: 1, last: null })
      else m.last = ms
      if (x.qty <= 0) Object.assign(x, { side: null, qty: 0, avg: 0 })
    }
    tot.interestOriginal += interest
    if (spread !== null) tot.spreadCost += spread
    rows.push({
      trade_id: t.id, at: new Date(ms).toISOString(), symbol: t.symbol, position_side: positionSide, action,
      liquidation: String(t.order_no ?? '').startsWith('LIQ-'), quantity: q,
      mid_price: midPx, hyperliquid_price: hlPx, mid_source: book ? 'book snapshot' : 'prezzo registrato (esecuzione al mid)',
      fee_original: feeO, fee_hyperliquid: feeH, spread_cost: spread,
      interest_original: interest, interest_recorded: t.interest_charged,
      realized_at_mid: realizedMid, realized_hyperliquid: book || costModel === 'hyperliquid' ? realizedExe : null,
    })
  }

  // --- posizioni aperte ai prezzi finali (stessi prezzi per i due modelli) ---
  let unrealizedMid = 0, unrealizedExe = 0, accruedOriginal = 0
  let closingFeeOriginal = 0, closingFeeHyperliquid = 0
  let pricesComplete = true
  const open = []
  for (const [symbol, m] of Object.entries(mid)) {
    if (!(m.qty > 0)) continue
    const x = exe[symbol]
    const px = finalPrices?.[symbol]
    const accrued = m.leverage > 1 && m.last !== null
      ? Math.max(m.qty * m.avg - m.margin, 0) * RATE_H * Math.max(Date.parse(asOf) - m.last, 0) / HOUR
      : 0
    accruedOriginal += accrued
    if (!(px > 0)) {
      pricesComplete = false
      open.push({ symbol, side: m.side, quantity: m.qty, final_price: null })
      continue
    }
    const sign = m.side === 'LONG' ? 1 : -1
    unrealizedMid += sign * (px - m.avg) * m.qty
    unrealizedExe += sign * (px - x.avg) * x.qty
    closingFeeOriginal += m.qty * px * feeRates.original
    closingFeeHyperliquid += m.qty * px * feeRates.hyperliquid
    open.push({ symbol, side: m.side, quantity: m.qty, final_price: px, avg_at_mid: m.avg, avg_executed: x.avg, accrued_interest_original: accrued })
  }

  // --- funding (solo dove registrato) ---
  const settled = fundingRows.filter((f) => f.status === 'settled')
  const fundingNet = settled.reduce((s, f) => s + f.amount, 0)
  const fundingPaid = settled.filter((f) => f.amount < 0).reduce((s, f) => s - f.amount, 0)
  const fundingReceived = settled.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0)
  const fundingMissing = fundingRows.length - settled.length + (p.fundingNotRecorded ?? 0)

  // --- totali per modello ---
  const grossMid = tot.realizedMid + unrealizedMid
  const recordedInterest = perp.reduce((s, t) => s + t.interest_charged, 0)
  // Originale: per un conto originale gli interessi sono quelli addebitati; per un conto hyperliquid
  // sono ricostruiti con la formula del motore sugli orari dei fill
  const interestOriginal = costModel === 'original' ? recordedInterest : tot.interestOriginal
  const original = {
    gross: grossMid, fees: tot.feeOriginal, interest: interestOriginal, funding: null, spread_cost: 0,
    net: grossMid - tot.feeOriginal - interestOriginal,
    complete: pricesComplete,
    sources: {
      prices: 'mid (snapshot del book o esecuzione registrata al mid)',
      fees: `${feeRates.original * 100}% sul nozionale al mid`,
      interest: costModel === 'original' ? 'addebitati dal motore (registrati)' : 'ricostruiti: formula del motore sugli orari dei fill (stima)',
    },
  }
  const spreadKnown = tot.fillsWithoutBook === 0
  const fundingKnown = costModel === 'hyperliquid' && fundingMissing === 0
  const hlNetPartial = grossMid - (spreadKnown ? tot.spreadCost : 0) - tot.feeHyperliquid + (costModel === 'hyperliquid' ? fundingNet : 0)
  const hyperliquid = {
    gross: grossMid,
    fees: tot.feeHyperliquid,
    interest: 0,
    funding: costModel === 'hyperliquid' ? fundingNet : null,
    funding_paid: costModel === 'hyperliquid' ? fundingPaid : null,
    funding_received: costModel === 'hyperliquid' ? fundingReceived : null,
    spread_cost: spreadKnown ? tot.spreadCost : null,
    net: spreadKnown && fundingKnown && pricesComplete ? hlNetPartial : null,
    net_known_components_only: hlNetPartial,
    complete: spreadKnown && fundingKnown && pricesComplete,
    sources: {
      prices: spreadKnown ? 'prezzi eseguiti sul book (book_fills)' : `${tot.fillsWithoutBook} fill senza snapshot del book: spread n.d.`,
      fees: `${feeRates.hyperliquid * 100}% sul nozionale eseguito`,
      funding: costModel === 'hyperliquid'
        ? (fundingMissing ? `${fundingMissing} intervalli non regolati o non registrati: funding incompleto` : 'funding regolato e registrato')
        : 'n.d.: il conto non ha registrato funding (tassi e oracle storici non salvati)',
    },
  }
  if (!pricesComplete) issues.push('prezzo finale mancante per una posizione aperta: P&L non realizzato incompleto')
  if (costModel === 'original') {
    notes.push('conto originale: il lato Hyperliquid ha solo la commissione ricalcolabile; spread e funding non sono stati ' +
      'registrati e non vengono stimati, quindi il suo netto e n.d.')
  }

  // --- verifica: il modello del conto ritrova il netto registrato (nessun profitto attribuito) ---
  const ownNet = costModel === 'hyperliquid' ? hyperliquid.net : original.net
  const selfCheck = {
    model: costModel,
    recorded_net: p.recordedNet,
    rebuilt_net: ownNet,
    difference: ownNet === null || p.recordedNet === null ? null : ownNet - p.recordedNet,
  }
  if (selfCheck.difference !== null && Math.abs(selfCheck.difference) > 1e-6) {
    issues.push(`il replay non ritrova il netto registrato del modello ${costModel}: differenza ${selfCheck.difference}`)
  }
  if (costModel === 'original') {
    const gap = tot.interestOriginal - recordedInterest
    selfCheck.interest_rebuilt = tot.interestOriginal
    selfCheck.interest_recorded = recordedInterest
    selfCheck.interest_gap = gap // orari dei trade al secondo: differenza attesa minima
  }

  // --- if_closed: chiusura ipotetica ai prezzi finali, per modello ---
  const ifClosed = {
    basis: 'STIMA: posizioni aperte chiuse ai prezzi finali (mid), stessa quantita per i due modelli; nessun book ' +
      'di chiusura (spread e profondita di uscita n.d. per Hyperliquid); funding dell\'ora in corso escluso',
    original: original.complete
      ? { closing_fees: closingFeeOriginal, accrued_interest: accruedOriginal, net: original.net - closingFeeOriginal - accruedOriginal }
      : null,
    hyperliquid: hyperliquid.complete
      ? { closing_fees: closingFeeHyperliquid, net: hyperliquid.net - closingFeeHyperliquid, spread_at_close: null }
      : null,
  }

  // --- B. stesse intenzioni d'ordine ---
  const byOrder = orders.filter((o) => o.status === 'FILLED' || o.status === 'PARTIALLY_FILLED').map((o) => {
    const book = bookByOrder.get(o.id)
    return {
      order_no: o.order_no, symbol: o.symbol, side: o.side, requested: o.quantity, executed: o.filled_quantity,
      not_executed: Number((o.quantity - o.filled_quantity).toFixed(10)), status: o.status,
      requested_at_mid_original: book ? o.quantity * book.mid : null,
      executed_notional_hyperliquid: book ? book.notional : null,
    }
  })
  const intentions = costModel === 'hyperliquid'
    ? {
        available: true,
        orders: byOrder,
        rounded_or_partial: byOrder.filter((o) => o.not_executed > 1e-12).length,
        refused: (p.refused ?? []).length,
        note: 'per ordine: l\'Originale avrebbe eseguito l\'intera quantita richiesta al mid; Hyperliquid ha eseguito ' +
          'la quantita arrotondata e riempita dal book. Nessun P&L concatenato: dopo il primo arrotondamento, rifiuto o ' +
          'parziale le posizioni (e quindi le chiusure decise dall\'AI) divergono. Rifiuti contati dalla traccia, se fornita.',
      }
    : {
        available: false,
        note: 'n.d.: un conto originale non registra book ne metadati Hyperliquid; l\'esecuzione alternativa non e ricostruibile',
      }

  const diff = (a, b) => (a === null || b === null ? null : b - a)
  return {
    kind: 'confronto a posteriori sugli stessi fill registrati; NON il risultato di due AI indipendenti',
    account_model: costModel,
    fills_compared: rows.length,
    fills_with_book: tot.fillsWithBook,
    fills_without_book: tot.fillsWithoutBook,
    funding_intervals_missing: costModel === 'hyperliquid' ? fundingMissing : null,
    same_fills: {
      final_prices: finalPrices ?? null,
      as_of: asOf,
      original: { ...original, equity: initialCapital + original.net, return_pct: (original.net / initialCapital) * 100 },
      hyperliquid: {
        ...hyperliquid,
        equity: hyperliquid.net === null ? null : initialCapital + hyperliquid.net,
        return_pct: hyperliquid.net === null ? null : (hyperliquid.net / initialCapital) * 100,
      },
      difference_hyperliquid_minus_original: {
        fees: hyperliquid.fees - original.fees,
        interest_or_funding: hyperliquid.funding === null ? null : hyperliquid.funding - -original.interest,
        spread_cost: hyperliquid.spread_cost,
        net: diff(original.net, hyperliquid.net),
      },
      realized_at_mid: tot.realizedMid,
      unrealized_at_mid: unrealizedMid,
      unrealized_executed: unrealizedExe,
      open_positions: open,
    },
    if_closed: ifClosed,
    same_intentions: intentions,
    operations: rows,
    self_check: selfCheck,
    limits: [
      'stessi fill per i due modelli: le liquidazioni e le decisioni AI dipendono dal modello e non vengono rigiocate',
      'mid di riferimento = mid dello snapshot del book; il motore originale avrebbe usato il prezzo della cache (stessa fonte mid, istante leggermente diverso)',
      'interessi originali di un conto hyperliquid ricostruiti dagli orari dei fill (stima della formula del motore)',
      'funding, book e mark non registrati non vengono stimati: le voci relative risultano n.d.',
      'P&L non realizzato valutato agli stessi prezzi finali per i due modelli (mid): il mark non e salvato',
    ],
    notes,
    issues,
  }
}
