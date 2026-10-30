// bot.js — Galah (revived) — insider trading scanner for Discord.
//
// Adapted Oct 23, 2026 from the owner's original Galah bot (the original bot).
// KEPT from the original: the gradeBuy grading brain (executive role, buy size,
// position increase %, cluster buys within 14 days), the config thresholds
// (min buy $100K, grade threshold B, hourly scans), sell warnings, and the alert
// content shape (stock + price, insider + amount, grade breakdown, suggested
// options play, SEC filing link on every alert).
// SEC EDGAR is the data source (direct from the primary source, no scraping)
// Form 4 data (Atom current-filings feed + daily index + ownership XML), price
// comes from the Yahoo chart API, the options-play line comes from Tradier, and
// transport is Discord REST only (no gateway connection needed),
// mirroring the shared bot env. Sell warnings are tightened: C-suite only,
// position reduction >= 20% AND sale value >= $250K.
// OPUS CONSULT (Oct 23, 2026): hard gates reject planned (10b5-1) and placement
// purchases before they can alert; every evaluated filing logs lag_bdays,
// late_flag, runup, insider CIK + prior-filing count, and direct/indirect
// ownership for the follow-through analysis layer; the options line requires
// 45-75 DTE and delta 0.60-0.75 with a liquidity check, else "stock-only".
//
// SAFETY: config.dryRun ships true. In dry-run mode nothing is posted to Discord;
// would-be alerts are written to dry-run-alerts.jsonl and logged to the console.
// Posting is two-key and fail-closed: it needs config.dryRun === false (a
// missing/garbled flag means dry run) AND GALAH_ALLOW_POST=1 in the
// environment; --dry-run on the command line forces dry run regardless.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const p = (f) => `${HERE}/${f}`;

// ===== CONFIG + STATE =====

const config = JSON.parse(readFileSync(p('config.json'), 'utf-8'));
const DRY_RUN = config.dryRun !== false
  || process.env.GALAH_ALLOW_POST !== '1'
  || process.argv.includes('--dry-run');
// SEC fair access: every EDGAR request must declare who we are + a contact.
if (!/@/.test(config.edgar?.userAgent || '')) {
  console.error('config.edgar.userAgent must include a contact email (SEC fair-access policy)');
  process.exit(1);
}

let state;
if (existsSync(p('state.json'))) {
  state = JSON.parse(readFileSync(p('state.json'), 'utf-8'));
} else {
  state = { seenAccessions: [], seenFingerprints: [], recentBuys: [], alerts: [], insiderFilings: {}, scanCount: 0, alertCount: 0, lastScan: null };
}
state.insiderFilings ??= {};
function saveState() {
  writeFileSync(p('state.json'), JSON.stringify(state, null, 2));
}

// ===== UTILS =====

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtMoney = (n) => '$' + fmtInt(n);
const fmtCompact = (n) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(0)}K` : fmtMoney(n));
const daysBetween = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
const dashedAccession = (nodash) => `${nodash.slice(0, 10)}-${nodash.slice(10, 12)}-${nodash.slice(12)}`;

// ===== EDGAR CLIENT =====
// Fair access: declared User-Agent with contact email on every request,
// paced to ~5 req/sec (min interval from config), 15s timeouts (lesson:
// a hung request must never silently stall the bot).

let lastEdgarAt = 0;
async function edgarFetch(url, { tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const wait = Math.max(0, (config.edgar?.minIntervalMs ?? 220) - (Date.now() - lastEdgarAt));
    if (wait) await sleep(wait);
    lastEdgarAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': config.edgar.userAgent, Accept: '*/*' },
        signal: AbortSignal.timeout(20000),
      });
      // 403 from SEC usually means "slow down" (fair-access throttle), not a
      // hard block — back off longer and retry like 429.
      if (res.status === 403 || res.status === 429 || res.status >= 500) throw new Error(`EDGAR ${res.status}`);
      if (!res.ok) return null; // 404 etc: caller treats as missing
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(/403|429/.test(e.message) ? 2000 * (i + 1) : 600 * (i + 1));
    }
  }
  throw lastErr;
}

// Ticker <-> CIK map (fallback when a filing's XML omits the trading symbol).
let tickerByCik = null;
async function loadTickerMap() {
  if (tickerByCik) return tickerByCik;
  tickerByCik = new Map();
  try {
    const text = await edgarFetch('https://www.sec.gov/files/company_tickers.json');
    const data = JSON.parse(text);
    for (const row of Object.values(data)) tickerByCik.set(Number(row.cik_str), row.ticker);
  } catch (e) {
    console.error('Ticker map load failed (continuing without it):', e.message);
  }
  return tickerByCik;
}

// Current-filings Atom feed -> [{ cik, accession (nodash), filedAt }]
// The feed's type=4 filter is a PREFIX match (it also returns 424B2, 425,
// 40-17F2, ...), so keep only entries whose form-type category is 4 or 4/A.
function parseAtomFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const form = entry.match(/<category[^>]*term="([^"]+)"/)?.[1];
    if (form !== '4' && form !== '4/A') continue;
    const link = entry.match(/href="(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/[^"]+)"/);
    if (!link) continue;
    const updated = entry.match(/<updated>([^<]+)<\/updated>/)?.[1] || null;
    out.push({ cik: Number(link[2]), accession: link[3], filedAt: updated });
  }
  return out;
}

// SEC header <ACCEPTANCE-DATETIME>YYYYMMDDHHMMSS (Eastern) -> ISO with offset.
function acceptanceIso(stamp) {
  const m = stamp?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // Approximate UTC instant (EST guess) is close enough to pick EDT vs EST.
  const approx = new Date(Date.UTC(+y, +mo - 1, +d, +h + 5, +mi, +s));
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(approx).find((x) => x.type === 'timeZoneName')?.value;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${tz === 'GMT-4' ? '-04:00' : '-05:00'}`;
}

// Daily index file for one date -> [{ cik, accession (nodash), filedAt }]
async function fetchDailyIndex(date) {
  const y = date.getUTCFullYear();
  const q = Math.floor(date.getUTCMonth() / 3) + 1;
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const text = await edgarFetch(`https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${ymd}.idx`);
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    // Index filenames carry the DASHED accession (0001234567-26-000001.txt);
    // the accession number itself is that string with dashes removed.
    const m = line.match(/^4(?:\/A)?\s{2,}.*?\s{2,}(\d{1,10})\s+(\d{8})\s+edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt/);
    if (!m) continue;
    const d = m[2];
    out.push({ cik: Number(m[1]), accession: m[3].replace(/-/g, ''), filedAt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` });
  }
  return out;
}

// Collect the filing list for the trailing window: today's live feed plus the
// daily index files for the calendar days the window touches.
async function collectFilings(windowHours) {
  const byAccession = new Map();
  // The live feed holds only 100 entries per page (~1-2 hours of Form 4s at
  // the after-close peak), and the daily index for today is not published
  // until the evening — so page back through the feed until it passes the
  // window (or the page cap), or same-day filings slip a whole day.
  const cutoff = Date.now() - windowHours * 3600000;
  const maxPages = config.edgar?.feedPages ?? 10;
  for (let page = 0; page < maxPages; page++) {
    const feedUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=include&count=100&start=${page * 100}&output=atom`;
    let feedXml = await edgarFetch(feedUrl);
    let rawEntries = feedXml ? (feedXml.match(/<entry>/g) || []).length : 0;
    // Sanity check: entries present but no <updated> stamps parsed (a
    // truncated/throttled response can do that) -> refetch once after a pause.
    if (rawEntries > 0 && !/<updated>[^<]+<\/updated>/.test(feedXml.replace(/^[\s\S]*?<entry>/, ''))) {
      console.log(`   ⚠️ Feed sanity: page ${page + 1} unparseable — refetching after a pause`);
      await sleep(3000);
      feedXml = await edgarFetch(feedUrl);
      rawEntries = feedXml ? (feedXml.match(/<entry>/g) || []).length : 0;
    }
    if (!rawEntries) break;
    for (const f of parseAtomFeed(feedXml)) if (!byAccession.has(f.accession)) byAccession.set(f.accession, f);
    const stamps = [...feedXml.matchAll(/<entry>[\s\S]*?<updated>([^<]+)<\/updated>/g)].map((m) => new Date(m[1]).getTime());
    if (!stamps.length || Math.min(...stamps) < cutoff) break;
  }

  const days = Math.ceil(windowHours / 24) + 1;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const rows = await fetchDailyIndex(d).catch(() => []);
    for (const f of rows) if (!byAccession.has(f.accession)) byAccession.set(f.accession, f);
  }
  return [...byAccession.values()].sort((a, b) => new Date(a.filedAt || 0) - new Date(b.filedAt || 0));
}

// Fetch one filing's ownership XML. The full-submission .txt carries the XML
// inline (one request per filing); fall back to directory listing + XML file.
// Returns { xml, acceptedAt } on success or { error } with a short reason for
// the log. acceptedAt is the EDGAR acceptance time from the SEC header (the
// daily index only carries a date) — the follow-through windows key off it.
async function fetchOwnershipXml(cik, accessionNodash) {
  const dir = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNodash}`;
  let txt = null, txtErr = '';
  try { txt = await edgarFetch(`${dir}/${dashedAccession(accessionNodash)}.txt`); }
  catch (e) { txtErr = `txt fetch: ${e.message}`; }
  const acceptedAt = acceptanceIso(txt?.match(/<ACCEPTANCE-DATETIME>(\d{14})/)?.[1]);
  const fromTxt = txt?.match(/<ownershipDocument>[\s\S]*?<\/ownershipDocument>/)?.[0];
  if (fromTxt) return { xml: fromTxt, acceptedAt };
  // Fallback: some .txt names differ; list the directory and try its XML files.
  let idxText = null;
  try { idxText = await edgarFetch(`${dir}/index.json`); } catch (e) { return { error: `${txtErr || 'txt had no ownership XML'}; index fetch: ${e.message}` }; }
  if (!idxText) return { error: txtErr || 'txt and index both missing' };
  let items = [];
  try { items = JSON.parse(idxText).directory.item.map((i) => i.name); } catch { return { error: 'index.json unparseable' }; }
  for (const name of items.filter((n) => n.endsWith('.xml') && !/meta/i.test(n))) {
    const xml = await edgarFetch(`${dir}/${name}`).catch(() => null);
    if (xml?.includes('<ownershipDocument>')) return { xml: xml.match(/<ownershipDocument>[\s\S]*?<\/ownershipDocument>/)[0], acceptedAt };
  }
  return { error: 'no ownership XML in filing directory' };
}

// ===== FORM 4 XML PARSER =====
// Regex extraction against the stable EDGAR ownership schema. Most numeric
// fields wrap their payload in a <value> child; footnotes ride along for the
// 10b5-1 plan-sale check.

function firstBlock(xml, tag) {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;
}
function allBlocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
}
function field(block, tag) {
  if (!block) return null;
  const inner = block.match(new RegExp(`<${tag}>\\s*<value>([\\s\\S]*?)</value>`))?.[1]
    ?? block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
  return inner == null ? null : decodeEntities(inner);
}
const num = (block, tag) => {
  const v = field(block, tag);
  const n = v == null ? null : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Placement kill-list (Opus consult, filing forensics): a "purchase" that is
// really an offering / placement / plan allocation is not an open-market buy.
const PLACEMENT_TERMS = [
  [/private placement/i, 'private placement'],
  [/rights offering/i, 'rights offering'],
  [/offering/i, 'offering'],
  [/subscription/i, 'subscription'],
  [/\bESPP\b|employee stock purchase/i, 'ESPP'],
  [/\bDRIP\b|dividend reinvestment/i, 'DRIP'],
];
function placementTermIn(text) {
  if (!text) return null;
  for (const [re, label] of PLACEMENT_TERMS) if (re.test(text)) return label;
  return null;
}

// EDGAR XML booleans come as "1"/"0" OR "true"/"false" depending on the filer.
const xmlTrue = (v) => /^(1|true)$/i.test(String(v ?? '').trim());

// Footnote says this row was under a Rule 10b5-1 plan. Tolerates the dash and
// spacing variants filers use ("10b5-1", "10b5–1", "10b-5-1", "10b5 1") and
// ignores explicit negations ("not made pursuant to a Rule 10b5-1 plan").
const PLAN_RE = /10b-?5[\s\-–‑]*1/i;
function planFootnote(text) {
  if (!text || !PLAN_RE.test(text)) return false;
  return text.split(/(?<=\.)\s+/).some((s) => PLAN_RE.test(s)
    && !/\b(not|no|outside( of)?|other than)\b[^.]{0,60}10b-?5[\s\-–‑]*1/i.test(s));
}

function parseOwnership(xml) {
  const footnotes = {};
  for (const m of xml.matchAll(/<footnote id="([^"]+)">([\s\S]*?)<\/footnote>/g)) {
    footnotes[m[1]] = decodeEntities(m[2].replace(/<[^>]*>/g, ''));
  }
  const footnoteText = Object.values(footnotes).join(' ');
  const issuer = firstBlock(xml, 'issuer');
  const owner = firstBlock(xml, 'reportingOwner');
  const ownerId = owner ? firstBlock(owner, 'reportingOwnerId') : null;
  const rel = owner ? firstBlock(owner, 'reportingOwnerRelationship') : null;

  // Rule 10b5-1 checkbox (Form 4 since Apr 2023). It is ONE document-level
  // element (<aff10b5One> sits beside periodOfReport, outside every
  // transaction block), so it applies to the filing as a whole: when it is
  // checked, every row is treated as planned (conservative — planned buys are
  // weak and routine plan sales are exactly what the sell feed must skip).
  const planCheckbox = xmlTrue(field(xml, 'aff10b5One'));

  const transactions = [];
  for (const t of allBlocks(xml, 'nonDerivativeTransaction')) {
    // Per-row forensics: the filing's checkbox plus this row's own referenced
    // footnotes (a filing-level footnote scan would false-flag rows the
    // footnote doesn't describe).
    const footnoteIds = [...t.matchAll(/<footnoteId id="([^"]+)"/g)].map((m) => m[1]);
    const refText = footnoteIds.map((id) => footnotes[id] || '').join(' ');
    transactions.push({
      date: field(t, 'transactionDate'),
      code: field(t, 'transactionCode'),
      shares: num(t, 'transactionShares') ?? 0,
      price: num(t, 'transactionPricePerShare') ?? 0,
      adCode: field(t, 'transactionAcquiredDisposedCode'),
      ownedAfter: num(t, 'sharesOwnedFollowingTransaction'),
      direct: field(t, 'directOrIndirectOwnership'),
      planFlag: planCheckbox || planFootnote(refText),
      placementTerm: placementTermIn(refText),
    });
  }

  return {
    docType: field(xml, 'documentType'),
    periodOfReport: field(xml, 'periodOfReport'),
    issuerCik: num(issuer, 'issuerCik'),
    issuerName: field(issuer, 'issuerName'),
    // Unlisted issuers file "NONE" / "N/A" as the symbol — not a ticker.
    ticker: (() => { const s = field(issuer, 'issuerTradingSymbol')?.toUpperCase(); return s && !/^(NONE|N\/?A)$/.test(s) ? s : null; })(),
    ownerName: field(ownerId, 'rptOwnerName'),
    ownerCik: field(ownerId, 'rptOwnerCik'),
    isOfficer: xmlTrue(field(rel, 'isOfficer')),
    isDirector: xmlTrue(field(rel, 'isDirector')),
    isTenPercentOwner: xmlTrue(field(rel, 'isTenPercentOwner')),
    officerTitle: field(rel, 'officerTitle'),
    transactions,
    planCheckbox,
    planSale: planCheckbox || planFootnote(footnoteText),
    signatureDate: field(xml, 'signatureDate'),
  };
}

// Aggregate all rows of one kind (e.g. code P + acquired) in a filing into a
// single position event: total shares, total value, weighted-average price,
// and shares owned after (direct-ownership rows preferred, last row wins).
// { clean: true } drops rows hit by a hard gate (10b5-1 plan / placement
// footnote) first — the gates kill ROWS, so an open-market row in the same
// filing as a placement row still counts on its own.
function aggregateTxns(transactions, code, adCode, { clean = false } = {}) {
  const rows = transactions.filter((t) => t.code === code && t.adCode === adCode
    && (!clean || (!t.planFlag && !t.placementTerm)));
  if (!rows.length) return null;
  const shares = rows.reduce((s, r) => s + r.shares, 0);
  const value = rows.reduce((s, r) => s + r.shares * r.price, 0);
  const direct = rows.filter((r) => r.direct === 'D');
  const use = direct.length ? direct : rows;
  const directValues = [...new Set(rows.map((r) => r.direct).filter(Boolean))];
  return {
    shares,
    value,
    price: shares ? value / shares : 0,
    ownedAfter: use[use.length - 1].ownedAfter,
    // Shares traded in the same holding ownedAfter describes — position %
    // must not subtract indirect (trust/LLC) shares from a direct balance.
    positionShares: use.reduce((s, r) => s + r.shares, 0),
    date: rows.map((r) => r.date).filter(Boolean).sort()[0] || null,
    dates: [...new Set(rows.map((r) => r.date).filter(Boolean))].sort(),
    rows: rows.length,
    planFlag: rows.some((r) => r.planFlag),
    placementTerm: rows.map((r) => r.placementTerm).find(Boolean) || null,
    ownershipNature: directValues.length === 1 ? directValues[0] : directValues.length > 1 ? 'mixed' : null,
  };
}

// Position increase % — the original formula: shares acquired divided by
// shares owned AFTER this trade (ownedAfter), not by prior holdings.
function positionIncreasePct(agg) {
  if (!agg || agg.ownedAfter == null || agg.ownedAfter <= 0) return null;
  return (agg.positionShares / agg.ownedAfter) * 100;
}
// Position reduction % for sales — the original formula:
// shares sold relative to (shares still owned + shares sold).
function positionReductionPct(agg) {
  if (!agg || agg.ownedAfter == null) return null;
  const denom = agg.ownedAfter + agg.positionShares;
  return denom > 0 ? (agg.positionShares / denom) * 100 : null;
}

// ===== ROLE TESTS =====
// EDGAR spells titles out ("Chief Executive Officer") where Finviz used
// abbreviations, so the substring test is normalized to equivalent patterns.

// "Vice President" is NOT President: Finviz abbreviated VP titles (SVP/EVP),
// so the substring test never scored them; EDGAR spells them out.
function isExecRole(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return /\bceo\b/.test(t) || /\bcfo\b/.test(t) || t.includes('chief executive')
    || t.includes('chief financial') || /(?<!vice[\s-])\bpresident\b/.test(t);
}
function isCSuite(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return isExecRole(t) || /\bcoo\b/.test(t) || t.includes('chief operating')
    || /\bchief\s+[\w&,\s-]{2,40}?\bofficer\b/.test(t);
}
function relationshipLabel(filing) {
  if (filing.officerTitle) return filing.officerTitle;
  if (filing.isDirector) return 'Director';
  if (filing.isTenPercentOwner) return '10% Owner';
  if (filing.isOfficer) return 'Officer';
  return 'Insider';
}

// ===== GRADING SYSTEM (gradeBuy system, ported) =====
// Points: executive role +2 · buy > $500K +2 / > $100K +1 · position increase
// > 50% +2 / > 25% +1 / > 10% +0 · cluster buy (2+ distinct insiders, same
// ticker, within 14 days) +2. Grades: A >= 8, B 5-7, C 3-4, D below 3.

function clusterMembers(ticker, ownerName, txnDate, pool) {
  const owners = new Map(); // normalized owner -> display name
  for (const b of pool) {
    if (b.ticker === ticker && daysBetween(b.date, txnDate) <= 14) owners.set(b.ownerKey, b.owner);
  }
  if (ownerName) owners.set(ownerName.toUpperCase(), ownerName);
  return { count: owners.size, members: [...owners.values()] };
}

function gradeBuy(buy, pool) {
  let points = 0;
  const breakdown = [];
  // Machine-readable per-factor points for the follow-through analysis.
  const factors = { role: 0, size: 0, position: 0, cluster: 0 };

  if (isExecRole(buy.relationship)) {
    points += 2; factors.role = 2;
    breakdown.push('Executive role: +2');
  }
  if (buy.value > 500000) {
    points += 2; factors.size = 2;
    breakdown.push('Buy > $500K: +2');
  } else if (buy.value > 100000) {
    points += 1; factors.size = 1;
    breakdown.push('Buy > $100K: +1');
  }
  if (buy.positionIncrease != null) {
    const pct = buy.positionIncrease;
    if (pct > 50) { points += 2; factors.position = 2; breakdown.push(`Position +${pct.toFixed(1)}%: +2`); }
    else if (pct > 25) { points += 1; factors.position = 1; breakdown.push(`Position +${pct.toFixed(1)}%: +1`); }
    else if (pct > 10) { breakdown.push(`Position +${pct.toFixed(1)}%: +0`); }
  }
  const cluster = clusterMembers(buy.ticker, buy.owner, buy.date, pool);
  if (cluster.count >= 2) {
    points += 2; factors.cluster = 2;
    breakdown.push('Cluster buy: +2');
  }

  let grade;
  if (points >= 8) grade = 'A';
  else if (points >= 5) grade = 'B';
  else if (points >= 3) grade = 'C';
  else grade = 'D';

  return { grade, points, breakdown, factors, cluster };
}

// ===== FILTERS =====
// Buys: open-market purchase (code P), value >= minBuyValue,
// CEO/CFO/President only.
function passesBuyFilter(buy) {
  if (buy.value < config.settings.minBuyValue) return false;
  return isExecRole(buy.relationship);
}
// Sells (tightened per revival plan): C-suite only, position reduction
// >= minSellReductionPct AND sale value >= minSellValue AND not a routine
// Rule 10b5-1 plan sale (Opus: plan sales carry no information).
function passesSellFilter(sell) {
  if (sell.planSale) return false;
  if (!isCSuite(sell.relationship)) return false;
  if (sell.value < config.settings.minSellValue) return false;
  if (sell.reduction == null || sell.reduction < config.settings.minSellReductionPct) return false;
  return true;
}
const GRADE_RANK = { A: 4, B: 3, C: 2, D: 1 };
const meetsGradeThreshold = (grade) => GRADE_RANK[grade] >= GRADE_RANK[config.settings.gradeThreshold];

// ===== MARKET ENRICHMENT =====

// Current price via Yahoo chart API.
// Falls back to the price the insider paid, the original fallback.
const priceCache = new Map();
async function getStockPrice(ticker) {
  if (priceCache.has(ticker)) return priceCache.get(ticker);
  let price = null;
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    }
  } catch { price = null; }
  priceCache.set(ticker, price);
  return price;
}

// Daily bars (3 months) per ticker, cached — used for "price at filing time":
// the close on the filing date (or the last trading day before it).
const historyCache = new Map();
async function getPriceHistory(ticker) {
  if (historyCache.has(ticker)) return historyCache.get(ticker);
  let bars = [];
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      const stamps = result?.timestamp || [];
      const quote = result?.indicators?.quote?.[0] || {};
      const closes = quote.close || [];
      bars = stamps
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i], high: quote.high?.[i] ?? null, low: quote.low?.[i] ?? null, volume: quote.volume?.[i] ?? null }))
        .filter((b) => b.close != null);
    }
  } catch { bars = []; }
  historyCache.set(ticker, bars);
  return bars;
}
async function getPriceAtFiling(ticker, filingDate) {
  if (!filingDate) return null;
  const bars = await getPriceHistory(ticker);
  let best = null;
  for (const b of bars) {
    if (b.date <= filingDate) best = b.close;
    else break;
  }
  return best;
}
const daysTxnToFiling = (txnDate, filingDate) =>
  txnDate && filingDate ? Math.round(((new Date(filingDate) - new Date(txnDate)) / 86400000) * 10) / 10 : null;

// Business days from transaction date to EDGAR acceptance (filing date).
// The Form 4 deadline is 2 business days; late_flag = lag > 2. (Opus consult:
// late filings test POSITIVE for opportunism — log it, assume nothing.)
function lagBdays(txnDate, filingDate) {
  if (!txnDate || !filingDate) return null;
  const start = new Date(txnDate + 'T00:00:00Z');
  const end = new Date(filingDate + 'T00:00:00Z');
  // (Number.isNaN(dateObject) is always false — test the timestamp.)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return 0;
  let n = 0;
  const cur = new Date(start);
  while (cur < end) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// Was the insider's average price inside the trading range of the day(s) the
// trade printed on? Outside-range pricing smells like an issuer deal rather
// than an open-market trade. Logged as a feature (not a gate in this build).
async function priceRangeFlag(ticker, agg) {
  if (!agg?.dates?.length || !agg.price) return 'unknown';
  const bars = await getPriceHistory(ticker);
  let lo = Infinity, hi = -Infinity, found = false;
  for (const d of agg.dates) {
    const b = bars.find((x) => x.date === d);
    if (b && b.low != null && b.high != null) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); found = true; }
  }
  if (!found) return 'unknown';
  return agg.price < lo * 0.999 || agg.price > hi * 1.001 ? 'outside' : 'inside';
}

// Last ~20 trading days' average dollar volume from the cached daily bars
// (feeds the options liquidity gate: underlying 20d ADV >= $5M).
async function avgDollarVolume20(ticker) {
  const bars = (await getPriceHistory(ticker)).filter((b) => b.volume != null).slice(-20);
  if (bars.length < 10) return null;
  return bars.reduce((s, b) => s + b.close * b.volume, 0) / bars.length;
}

// Options play via Tradier: expiry inside the 45-75 DTE window, call delta in
// the 0.60-0.75 band, strike open interest >= 500 when reported — otherwise
// no contract is suggested ("stock-only"). Credential arrives as a
// short-lived surrogate (same pattern as
// the options scanner's live script) — never the real token.
// Any failure returns null and the alert simply omits the contract line.
let tradierSurrogate = null;
async function getTradierSurrogate(force = false) {
  if (tradierSurrogate && !force) return tradierSurrogate;
  try {
    const { stdout } = await execFileP('python3', ['-c',
      "import sys; sys.path.insert(0, '/opt/muse/skills/custom-connector-setup/bin')\n" +
      "from dynamic_credentials import dynamic_credential_entry\n" +
      "print(dynamic_credential_entry('custom.tradier')['surrogate'])"],
      { timeout: 15000 });
    tradierSurrogate = stdout.trim();
    return tradierSurrogate;
  } catch { return null; }
}
async function tradierGet(path, surr) {
  const res = await fetch(`https://api.tradier.com/v1${path}`, {
    headers: { Authorization: `Bearer ${surr}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tradier ${res.status}`);
  return res.json();
}
// Returns a contract, { stockOnly: '<which gate failed>' } when a gate
// rejects every contract, or null when the options data itself was
// unavailable (credential/API failure) — those must not read as "illiquid".
async function getOptionsPlay(ticker, refPrice) {
  // Underlying gates (Opus: exclude stocks under $5; underlying 20d ADV >= $5M).
  if (refPrice != null && refPrice < 5) return { stockOnly: `share price $${refPrice.toFixed(2)} is under $5` };
  const adv = await avgDollarVolume20(ticker);
  if (adv != null && adv < 5_000_000) return { stockOnly: `20-day avg dollar volume ${fmtCompact(adv)} is under $5M` };
  try {
    let surr = await getTradierSurrogate();
    if (!surr) return null;
    let data;
    try {
      data = await tradierGet(`/markets/options/expirations?symbol=${encodeURIComponent(ticker)}&includeAllRoots=true`, surr);
    } catch (e) {
      if (!/401|403/.test(e.message)) throw e;
      surr = await getTradierSurrogate(true);
      if (!surr) return null;
      data = await tradierGet(`/markets/options/expirations?symbol=${encodeURIComponent(ticker)}&includeAllRoots=true`, surr);
    }
    const dates = [].concat(data?.expirations?.date || []);
    if (!dates.length) return { stockOnly: 'no listed options' };
    const now = Date.now();
    // Opus options rule: expiry inside 45-75 DTE (hold is ~20 trading days;
    // exit with >= 21 days left), closest to the middle of the window.
    const candidates = dates
      .map((d) => ({ d, dte: Math.round((new Date(d + 'T16:00:00-04:00') - now) / 86400000) }))
      .filter((c) => c.dte >= 45 && c.dte <= 75)
      .sort((a, b) => Math.abs(a.dte - 60) - Math.abs(b.dte - 60));
    if (!candidates.length) return { stockOnly: 'no expiry inside 45–75 DTE' };
    const expiry = candidates[0].d;

    const chain = await tradierGet(`/markets/options/chains?symbol=${encodeURIComponent(ticker)}&expiration=${expiry}&greeks=true`, surr);
    const calls = [].concat(chain?.options?.option || []).filter((o) => o.option_type === 'call');
    if (!calls.length) return null;
    // Delta band 0.60-0.75 (slightly ITM calls for top grades; never chase
    // cheap far-OTM deltas), then the liquidity gate: strike open interest
    // >= 500 (unreported OI fails) and bid/ask spread <= 10% of mid (Opus
    // hard max). Nothing left -> the caller says "stock-only".
    const deltaBand = calls.filter((c) => c.greeks?.delta != null && c.greeks.delta >= 0.60 && c.greeks.delta <= 0.75);
    if (!deltaBand.length) return { stockOnly: `no ${expiry} call in the 0.60–0.75 delta band` };
    const inBand = deltaBand.filter((c) => {
      if (!(c.open_interest >= 500)) return false;
      if (!(c.bid > 0 && c.ask > 0)) return false;
      return (c.ask - c.bid) / ((c.ask + c.bid) / 2) <= 0.10;
    });
    if (!inBand.length) return { stockOnly: `no 0.60–0.75 delta ${expiry} call passed the liquidity check (OI ≥ 500, spread ≤ 10% of mid)` };
    const pick = inBand.sort((a, b) => Math.abs(a.greeks.delta - 0.675) - Math.abs(b.greeks.delta - 0.675))[0];
    const mid = pick.bid != null && pick.ask != null ? (pick.bid + pick.ask) / 2 : pick.last;
    return {
      expiry, dte: candidates[0].dte, strike: pick.strike, type: 'Call',
      mid: mid ?? null, delta: pick.greeks?.delta ?? null, openInterest: pick.open_interest ?? null,
    };
  } catch { return null; }
}

// Suggested-play block: a concrete Tradier contract only when one passes the
// Opus options gates (price >= $5, 20d ADV >= $5M, 45-75 DTE, delta
// 0.60-0.75, strike OI >= 500, spread <= 10% of mid). Otherwise the alert
// honestly says stock-only, with the gate that failed.
function suggestedPlayLines(buy, price, play) {
  const contract = play && !play.stockOnly;
  const lines = [
    contract ? '**Direction:** 🟢 CALLS (Bullish)' : '**Direction:** 🟢 LONG STOCK (Bullish)',
    '**Why:** Insider is buying → they expect the stock to go UP',
  ];
  if (contract) {
    lines.push(`**Contract:** $${buy.ticker} ${play.expiry} $${play.strike} ${play.type} (~${play.dte} DTE)${play.mid != null ? ` · mid $${play.mid.toFixed(2)}` : ''}${play.delta != null ? ` · Δ ${Number(play.delta).toFixed(2)}` : ''}${play.openInterest != null ? ` · OI ${fmtInt(play.openInterest)}` : ''}`);
    lines.push('**Expiry:** 45–75 DTE window (hold ~20 trading days; exit with ≥21 days left)');
  } else if (play?.stockOnly) {
    lines.push(`**Contract:** Stock-only — ${play.stockOnly}`);
  } else {
    lines.push('**Contract:** Stock-only — options data unavailable this scan (no contract checked)');
  }
  lines.push('**Risk:** Only what you can afford to lose');
  return lines;
}

// ===== EMBEDS (established embed format) =====
// Grade A -> purple 0x9B59B6 (stands out), Grade B -> orange 0xE8590C,
// sell warning -> muted red 0xE03E2D, 10b5-1 plan sale -> gold 0xE3B341.
// No @everyone anywhere in this build.

function buildBuyEmbed(buy, grading, price, play, filingUrl) {
  const whyMatters = [];
  if (buy.value > 1000000) whyMatters.push(`${buy.owner} put **${fmtCompact(buy.value)}** of their OWN money in — that's massive conviction`);
  else if (buy.value > 500000) whyMatters.push(`${buy.owner} bet **${fmtCompact(buy.value)}** of personal cash — serious conviction`);
  else whyMatters.push(`**${fmtCompact(buy.value)}** personal purchase — notable size`);
  if (buy.positionIncrease != null && buy.positionIncrease > 40) whyMatters.push(`Increased their position by **${buy.positionIncrease.toFixed(1)}%** — they're loading up`);
  else if (buy.positionIncrease != null && buy.positionIncrease > 20) whyMatters.push(`Position grew **${buy.positionIncrease.toFixed(1)}%** — meaningful addition`);
  if (grading.cluster.count >= 2) whyMatters.push(`**Cluster buy** — ${grading.cluster.count} insiders bought within 14 days: ${grading.cluster.members.join(', ')}`);

  const fields = [
    { name: '💡 Why This Matters', value: whyMatters.join('\n'), inline: false },
    {
      name: '📊 The Numbers', inline: false,
      value: [
        `**Stock Price:** $${price.toFixed(2)}`,
        `**Insider Paid:** $${buy.price.toFixed(2)} per share`,
        `**Position Increase:** ${buy.positionIncrease != null ? buy.positionIncrease.toFixed(1) + '%' : 'N/A'}`,
        `**Total Holdings:** ${buy.ownedAfter != null ? fmtInt(buy.ownedAfter) + ' shares' : 'N/A'}`,
        `**Traded:** ${buy.date || 'N/A'} · **Filed:** ${buy.filedDate || 'N/A'}`,
      ].join('\n'),
    },
    { name: '🎯 Suggested Play', value: suggestedPlayLines(buy, price, play).join('\n'), inline: false },
    { name: '📋 How It Scored', value: grading.breakdown.join('\n') || 'No points earned', inline: false },
    { name: '🔗 SEC Filing', value: `[View SEC Filing](${filingUrl})`, inline: false },
  ];
  return {
    title: '🏛️ GALAH — Insider Buy Detected',
    description: `## $${buy.ticker}\n**Grade ${grading.grade}** · ${grading.points} points\n\n**${buy.owner}** — ${buy.relationship}\nbought **${fmtInt(buy.shares)} shares** at **$${buy.price.toFixed(2)}**\nTotal spent: **${fmtMoney(buy.value)}**`,
    color: grading.grade === 'A' ? 0x9B59B6 : 0xE8590C,
    fields,
    footer: { text: 'DYOR — not financial advice · Galah גָּלָה — The Revealer · Form 4 · EDGAR' },
    timestamp: new Date().toISOString(),
  };
}

function buildSellEmbed(sell, filingUrl) {
  const fields = [
    { name: '👤 Insider', value: `${sell.owner}\n${sell.relationship}`, inline: true },
    { name: '💸 Sale', value: `${fmtMoney(sell.value)}\n${fmtInt(sell.shares)} shares @ $${sell.price.toFixed(2)}`, inline: true },
    { name: '📉 Position Reduction', value: `${sell.reduction != null ? sell.reduction.toFixed(1) + '%' : 'N/A'}`, inline: true },
  ];
  if (sell.planSale) fields.push({ name: '🗓️ Plan Sale', value: 'Filed under a Rule 10b5-1 trading plan — pre-scheduled, lower signal weight.', inline: false });
  fields.push({ name: '🔗 SEC Filing', value: `[View SEC Filing](${filingUrl})`, inline: false });
  return {
    title: `⚠️ ${sell.ticker} Insider Sell Warning${sell.planSale ? ' (10b5-1 plan sale)' : ''}`,
    color: sell.planSale ? 0xE3B341 : 0xE03E2D,
    fields,
    footer: { text: 'Galah גָּלָה — The Revealer · Form 4 · EDGAR' },
    timestamp: new Date().toISOString(),
  };
}

// ===== TRANSPORT (Discord REST only) =====

async function postToDiscord(payload) {
  // Last-line guard: even a caller bug cannot post while dry-run is in force.
  if (DRY_RUN) throw new Error('postToDiscord called in dry-run mode — refusing to post');
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN not set (launcher loads it from the shared bot env/.env)');
  const res = await fetch(`https://discord.com/api/v10/channels/${config.channels.alerts}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord REST ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

function writeJsonl(file, obj) {
  appendFileSync(p(file), JSON.stringify(obj) + '\n');
}

// Every alert carries a full evaluation record (filing timestamp, transaction
// date, gap days, prices at filing and at alert time, role, code, size,
// position change, cluster, grade + breakdown, options play) — the follow-
// through analysis layer reads these fields. In dry-run mode the Discord
// payload plus its record lands in dry-run-alerts.jsonl. NOTHING is posted
// while DRY_RUN is in force (see SAFETY in the header).
async function emitAlert(kind, payload, record) {
  writeJsonl('alerts-log.jsonl', record);
  if (DRY_RUN) {
    writeJsonl('dry-run-alerts.jsonl', { ...payload, record });
    console.log(`   [DRY RUN] would post ${kind}: ${payload.content}`);
  } else {
    await postToDiscord(payload);
    console.log(`   🚨 Posted ${kind}: ${payload.content}`);
  }
  state.alertCount++;
}

// ===== SCANNER =====

// Evaluation floor: every buy/sell at or above this value gets graded and
// logged to evaluated-log.jsonl, alert or not (backtest data).
const EVAL_FLOOR = 10000;

const filingUrl = (cik, accessionNodash) =>
  `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNodash}/${dashedAccession(accessionNodash)}-index.htm`;

async function runScan({ once = false } = {}) {
  const windowHours = config.settings.windowHours ?? 48;
  console.log(`🏛️ Scanning… EDGAR Form 4 window: last ${windowHours}h${DRY_RUN ? ' (DRY RUN — nothing will be posted)' : ''}`);
  const stats = { listed: 0, alreadySeen: 0, parsed: 0, parseFailed: 0, buysSeen: 0, evaluatedBuys: 0, gatedBuys: 0, buysFiltered: 0, buysAlerted: 0, sellsSeen: 0, evaluatedSells: 0, sellsAlerted: 0, graded: { A: 0, B: 0, C: 0, D: 0 } };
  const examples = [];

  const tickers = await loadTickerMap();
  const filings = await collectFilings(windowHours);
  stats.listed = filings.length;
  const maxFilings = config.settings.maxFilingsPerScan ?? 1200;
  const queue = filings.slice(-maxFilings); // newest filings are at the end after the ascending sort
  if (queue.length < filings.length) console.log(`   (capped at ${maxFilings} newest of ${filings.length} listed)`);

  const seen = new Set(state.seenAccessions);
  const fingerprints = new Set(state.seenFingerprints);

  // Checkpointing: persist dedupe sets + pool + insider counts every few
  // filings. If the process dies mid-scan, the
  // next run resumes from the checkpoint instead of re-alerting everything.
  let sinceCheckpoint = 0;
  const checkpoint = () => {
    state.seenAccessions = [...seen];
    state.seenFingerprints = [...fingerprints];
    state.lastCheckpoint = new Date().toISOString();
    saveState();
  };

  for (const f of queue) {
    if (seen.has(f.accession)) { stats.alreadySeen++; continue; }
    const own = await fetchOwnershipXml(f.cik, f.accession).catch((e) => ({ error: e.message }));
    if (!own.xml) {
      stats.parseFailed++;
      if (stats.parseFailed <= 10) console.log(`   ⚠️ filing ${dashedAccession(f.accession)} (CIK ${f.cik}): ${own.error || 'unknown fetch error'}`);
      continue;
    }
    let filing;
    try { filing = parseOwnership(own.xml); } catch { stats.parseFailed++; continue; }
    stats.parsed++;
    seen.add(f.accession);

    // Insider history (raw material for the routine-vs-opportunistic layer):
    // how many of this insider's Form 4 filings we had already seen BEFORE
    // this one, across everything this bot has ever parsed.
    const ownerCik = filing.ownerCik ? String(filing.ownerCik) : null;
    const priorFilings = ownerCik ? (state.insiderFilings[ownerCik] || 0) : 0;
    if (ownerCik) state.insiderFilings[ownerCik] = priorFilings + 1;
    if (++sinceCheckpoint >= 10) { checkpoint(); sinceCheckpoint = 0; }

    const ticker = filing.ticker || tickers.get(filing.issuerCik) || null;
    if (!ticker) continue;
    const url = filingUrl(f.cik, f.accession);
    const relationship = relationshipLabel(filing);
    // Acceptance time from the SEC header when we have it (feed <updated> is
    // close; the daily index is date-only).
    const filedAt = own.acceptedAt || f.filedAt || null;
    const filedDate = (filedAt || filing.signatureDate || '').slice(0, 10);
    // Amendments (4/A): never alert or backfill from amended values — the
    // original filing is the event (Opus filing forensics).
    const isAmendment = /\/A$/i.test(filing.docType || '');

    // --- Buys (code P, acquired) ---
    // Hard gates kill ROWS: buyAgg is the clean (non-plan, non-placement) P
    // rows when any exist; if every P row is gated, it is all of them and the
    // buy is logged as gated.
    const allBuyAgg = aggregateTxns(filing.transactions, 'P', 'A');
    const cleanBuyAgg = aggregateTxns(filing.transactions, 'P', 'A', { clean: true });
    const buyAgg = cleanBuyAgg || allBuyAgg;
    if (cleanBuyAgg && cleanBuyAgg.value >= 10000 && !isAmendment) {
      // Rolling cluster pool: every meaningful open-market buy, any insider.
      // Planned (10b5-1) and placement rows are excluded — they carry no
      // opportunistic signal, so they must not build cluster conviction.
      if (!state.recentBuys.some((b) => b.accession === f.accession && b.ticker === ticker)) {
        state.recentBuys.push({ ticker, owner: filing.ownerName, ownerKey: (filing.ownerName || '').toUpperCase(), date: cleanBuyAgg.date, value: cleanBuyAgg.value, accession: f.accession });
      }
    }
    if (buyAgg && buyAgg.shares > 0) {
      stats.buysSeen++;
      const buy = {
        ticker, owner: filing.ownerName, relationship,
        shares: buyAgg.shares, price: buyAgg.price, value: buyAgg.value,
        ownedAfter: buyAgg.ownedAfter, date: buyAgg.date,
        filedDate,
        positionIncrease: positionIncreasePct(buyAgg),
        planFlag: !cleanBuyAgg && allBuyAgg.planFlag,
        placementTerm: !cleanBuyAgg ? allBuyAgg.placementTerm : null,
        ownershipNature: buyAgg.ownershipNature,
      };
      if (buyAgg.value >= EVAL_FLOOR) {
        // Grade EVERY meaningful buy — not just filter-passers — and log the
        // full evaluation to evaluated-log.jsonl. The backtest layer needs
        // the misses (and their reasons) as much as the alerts.
        stats.evaluatedBuys++;
        const grading = gradeBuy(buy, state.recentBuys);
        stats.graded[grading.grade]++;
        if (passesBuyFilter(buy)) stats.buysFiltered++;
        const fp = `buy|${ticker}|${(filing.ownerName || '').toUpperCase()}|${buy.date}|${buy.shares}`;
        let outcome, passFailReason;
        if (isAmendment) { outcome = 'gated'; passFailReason = 'Form 4/A amendment — the original filing is the event; amended values never alert'; }
        else if (buy.placementTerm) { outcome = 'gated'; passFailReason = `placement kill-list — transaction footnote mentions "${buy.placementTerm}"`; }
        else if (buy.planFlag) { outcome = 'gated'; passFailReason = 'Rule 10b5-1 plan purchase (aff10b5One checkbox / linked plan footnote) — planned buys do not alert'; }
        else if (buy.value < config.settings.minBuyValue) { outcome = 'filtered'; passFailReason = `below min buy value (${fmtMoney(buy.value)} < ${fmtMoney(config.settings.minBuyValue)})`; }
        else if (!isExecRole(buy.relationship)) { outcome = 'filtered'; passFailReason = `non-executive role (${buy.relationship})`; }
        else if (!meetsGradeThreshold(grading.grade)) { outcome = 'below-threshold'; passFailReason = `grade ${grading.grade} below threshold ${config.settings.gradeThreshold}`; }
        else if (fingerprints.has(fp)) { outcome = 'duplicate'; passFailReason = 'same transaction already alerted (fingerprint match)'; }
        else { outcome = 'alerted'; passFailReason = 'passed all filters — alert emitted'; }

        if (outcome === 'gated') stats.gatedBuys++;
        const priceNow = await getStockPrice(ticker);
        const lag = lagBdays(buy.date, buy.filedDate);
        const record = {
          ts: new Date().toISOString(), kind: 'buy', dryRun: DRY_RUN,
          ticker, issuer: filing.issuerName, owner: buy.owner, role: buy.relationship,
          insiderCik: ownerCik, insiderPriorFilings: priorFilings,
          ownershipNature: buyAgg.ownershipNature,
          planFlag10b5One: allBuyAgg.planFlag, planCheckbox: filing.planCheckbox,
          placementTerm: allBuyAgg.placementTerm,
          gatedRows: allBuyAgg.rows - (cleanBuyAgg?.rows ?? 0), amendment: isAmendment,
          lagBdays: lag, lateFlag: lag != null ? lag > 2 : null,
          runup: priceNow != null && buy.price > 0 ? Math.round((priceNow / buy.price - 1) * 10000) / 10000 : null,
          priceRangeFlag: await priceRangeFlag(ticker, buyAgg),
          transactionCode: 'P', transactionDate: buy.date,
          filingTimestamp: filedAt, filingDate: buy.filedDate,
          daysTxnToFiling: daysTxnToFiling(buy.date, buy.filedDate),
          sharesAcquired: buy.shares, transactionValue: buy.value, pricePerShare: buy.price,
          positionIncreasePct: buy.positionIncrease,
          clusterFlag: grading.cluster.count >= 2, clusterCount: grading.cluster.count, clusterMembers: grading.cluster.members,
          grade: grading.grade, gradePoints: grading.points, gradeBreakdown: grading.breakdown, gradeFactors: grading.factors,
          priceAtFiling: await getPriceAtFiling(ticker, buy.filedDate),
          priceAtAlert: priceNow,
          optionsPlay: null,
          filing: url, accession: f.accession,
          outcome, passFailReason,
        };
        if (outcome === 'alerted') {
          fingerprints.add(fp);
          const price = priceNow ?? buy.price; // the fallback: price the insider paid
          const play = await getOptionsPlay(ticker, priceNow);
          record.optionsPlay = !play ? { stockOnly: 'options data unavailable' }
            : play.stockOnly ? { stockOnly: play.stockOnly }
            : { strike: play.strike, expiry: play.expiry, dte: play.dte, type: play.type, mid: play.mid, delta: play.delta, openInterest: play.openInterest };
          const embed = buildBuyEmbed(buy, grading, price, play, url);
          const emoji = grading.grade === 'A' ? '🟣' : '🟠';
          await emitAlert('buy', { content: `${emoji} GALAH — Grade ${grading.grade} insider buy: $${ticker} ${relationship} bought ${fmtCompact(buy.value)}`, embeds: [embed] }, record);
          stats.buysAlerted++;
          state.alerts.push({ ticker, owner: buy.owner, date: buy.date, alertDate: new Date().toISOString(), price, grade: grading.grade, value: buy.value });
        }
        writeJsonl('evaluated-log.jsonl', record);
        examples.push({ kind: 'buy', ticker, owner: buy.owner, relationship, value: buy.value, grade: grading.grade, points: grading.points, alerted: outcome === 'alerted' });
      }
    }

    // --- Sell warnings (code S, disposed; tightened filters) ---
    // Routine 10b5-1 plan rows are dropped first; if every S row was planned,
    // the sale is evaluated whole and filtered as a plan sale.
    const allSellAgg = aggregateTxns(filing.transactions, 'S', 'D');
    const unplannedSellAgg = aggregateTxns(filing.transactions.filter((t) => !t.planFlag), 'S', 'D');
    const sellAgg = unplannedSellAgg || allSellAgg;
    if (sellAgg && sellAgg.shares > 0) {
      stats.sellsSeen++;
      const sell = {
        ticker, owner: filing.ownerName, relationship,
        shares: sellAgg.shares, price: sellAgg.price, value: sellAgg.value,
        ownedAfter: sellAgg.ownedAfter, date: sellAgg.date,
        filedDate,
        reduction: positionReductionPct(sellAgg),
        planSale: !unplannedSellAgg,
      };
      if (sellAgg.value >= EVAL_FLOOR) {
        stats.evaluatedSells++;
        const fp = `sell|${ticker}|${(filing.ownerName || '').toUpperCase()}|${sell.date}|${sell.shares}`;
        let outcome, passFailReason;
        if (!isCSuite(sell.relationship)) { outcome = 'filtered'; passFailReason = `non-C-suite role (${sell.relationship})`; }
        else if (sell.value < config.settings.minSellValue) { outcome = 'filtered'; passFailReason = `below min sell value (${fmtMoney(sell.value)} < ${fmtMoney(config.settings.minSellValue)})`; }
        else if (sell.reduction == null) { outcome = 'filtered'; passFailReason = 'position reduction unknown (no post-transaction holdings in filing)'; }
        else if (sell.reduction < config.settings.minSellReductionPct) { outcome = 'filtered'; passFailReason = `position reduction ${sell.reduction.toFixed(1)}% below ${config.settings.minSellReductionPct}%`; }
        else if (sell.planSale) { outcome = 'filtered'; passFailReason = 'routine Rule 10b5-1 plan sale (aff10b5One checkbox / linked plan footnote) — plan sales never warn'; }
        else if (isAmendment) { outcome = 'filtered'; passFailReason = 'Form 4/A amendment — the original filing is the event; amended values never alert'; }
        else if (fingerprints.has(fp)) { outcome = 'duplicate'; passFailReason = 'same transaction already alerted (fingerprint match)'; }
        else { outcome = 'alerted'; passFailReason = 'passed all filters — alert emitted'; }

        const priceNow = await getStockPrice(ticker);
        const record = {
          ts: new Date().toISOString(), kind: 'sell', dryRun: DRY_RUN,
          ticker, issuer: filing.issuerName, owner: sell.owner, role: sell.relationship,
          transactionCode: 'S', transactionDate: sell.date,
          filingTimestamp: filedAt, filingDate: sell.filedDate,
          daysTxnToFiling: daysTxnToFiling(sell.date, sell.filedDate),
          sharesDisposed: sell.shares, transactionValue: sell.value, pricePerShare: sell.price,
          positionReductionPct: sell.reduction, planSale: sell.planSale, planCheckbox: filing.planCheckbox,
          planRows: allSellAgg.rows - (unplannedSellAgg?.rows ?? 0), amendment: isAmendment,
          insiderCik: ownerCik, insiderPriorFilings: priorFilings,
          ownershipNature: sellAgg.ownershipNature,
          lagBdays: lagBdays(sell.date, sell.filedDate),
          lateFlag: (() => { const l = lagBdays(sell.date, sell.filedDate); return l != null ? l > 2 : null; })(),
          runup: priceNow != null && sell.price > 0 ? Math.round((priceNow / sell.price - 1) * 10000) / 10000 : null,
          priceRangeFlag: await priceRangeFlag(ticker, sellAgg),
          clusterFlag: null, grade: null, gradePoints: null, gradeBreakdown: null,
          priceAtFiling: await getPriceAtFiling(ticker, sell.filedDate),
          priceAtAlert: priceNow,
          optionsPlay: null,
          filing: url, accession: f.accession,
          outcome, passFailReason,
        };
        if (outcome === 'alerted') {
          fingerprints.add(fp);
          const embed = buildSellEmbed(sell, url);
          await emitAlert('sell', { content: `🔴 GALAH — Sell warning: $${ticker} ${sell.owner} (${relationship}) sold ${sell.reduction?.toFixed(1)}% (${fmtCompact(sell.value)})${sell.planSale ? ' · 10b5-1 plan sale' : ''}`, embeds: [embed] }, record);
          stats.sellsAlerted++;
          examples.push({ kind: 'sell', ticker, owner: sell.owner, relationship, value: sell.value, grade: null, points: null, alerted: true });
          state.alerts.push({ ticker, owner: sell.owner, date: sell.date, alertDate: new Date().toISOString(), type: 'sell' });
        }
        writeJsonl('evaluated-log.jsonl', record);
      }
    }
  }

  // Prune the cluster pool to the trailing 14 days (relative to newest buy).
  if (state.recentBuys.length) {
    const newest = state.recentBuys.map((b) => new Date(b.date || 0)).sort((a, b) => b - a)[0];
    state.recentBuys = state.recentBuys.filter((b) => daysBetween(b.date, newest) <= 14);
  }
  state.seenAccessions = [...seen];
  state.seenFingerprints = [...fingerprints];
  state.scanCount++;
  state.lastScan = new Date().toISOString();
  saveState();

  console.log(`✅ Scan complete: ${stats.listed} filings listed · ${stats.parsed} parsed (${stats.parseFailed} failed, ${stats.alreadySeen} already seen)`);
  console.log(`   Buys: ${stats.buysSeen} seen · ${stats.evaluatedBuys} evaluated/graded · ${stats.buysFiltered} passed CEO/CFO/President + $${fmtInt(config.settings.minBuyValue)} filter · grades A:${stats.graded.A} B:${stats.graded.B} C:${stats.graded.C} D:${stats.graded.D} · ${stats.buysAlerted} alerts`);
  console.log(`   Sells: ${stats.sellsSeen} seen · ${stats.evaluatedSells} evaluated · ${stats.sellsAlerted} warnings passed tightened filter`);
  return { stats, examples };
}

// ===== MAIN =====

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    const { stats, examples } = await runScan({ once });
    console.log('\n=== TOP GRADED EXAMPLES ===');
    const top = [...examples].sort((a, b) => (b.points ?? -1) - (a.points ?? -1) || b.value - a.value).slice(0, 8);
    for (const e of top) {
      console.log(`${e.kind.toUpperCase()} $${e.ticker} — ${e.owner} (${e.relationship}) · ${fmtMoney(e.value)}${e.grade ? ` · Grade ${e.grade} (${e.points} pts)` : ''} · alerted: ${e.alerted}`);
    }
    console.log('\n=== SUMMARY JSON ===');
    console.log(JSON.stringify(stats));
    return;
  }

  // Live mode (not used in this build's dry run): verify identity, then scan
  // on the hourly cadence.
  if (!DRY_RUN) {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) { console.error('DISCORD_BOT_TOKEN not set — use run-galah-lab.sh'); process.exit(1); }
    const me = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!me.ok) { console.error(`Discord identity check failed: ${me.status}`); process.exit(1); }
    const meJson = await me.json();
    console.log(`✅ Galah bot connected as ${meJson.username} (REST mode)`);
  } else {
    console.log('🏛️ Galah starting in DRY RUN mode — alerts go to dry-run-alerts.jsonl, nothing is posted.');
  }
  await runScan();
  setInterval(() => runScan().catch((e) => console.error('Scan error:', e)), config.settings.scanIntervalMs);
  console.log(`📅 Scan schedule: every ${Math.round(config.settings.scanIntervalMs / 60000)} min`);
}

// Run only when executed directly — importing (tests) must never start a scan.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
}
export { getOptionsPlay, parseOwnership, aggregateTxns, positionIncreasePct, positionReductionPct, planFootnote, placementTermIn, isExecRole, isCSuite, acceptanceIso, lagBdays, parseAtomFeed, gradeBuy, DRY_RUN };
