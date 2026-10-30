# Insider Bot — SEC EDGAR Form 4 Scanner

A Discord bot that watches SEC EDGAR for insider transactions — C-suite
buys and sells reported on Form 4 — grades them, and posts the ones that
matter as rich alert cards. Alert-only: it reads filings and does math.
It never trades.

## The core idea

When a CEO, CFO, or President buys their own company's stock on the open
market with serious money, that's a signal worth looking at. When several
do it together, it's worth a louder look. The bot's job is to separate
those signals from the noise of routine filings — planned 10b5-1 sales,
tiny top-ups, backdated paperwork — and show its work on every alert.

## Data source: SEC EDGAR (primary source, no scraping)

Every alert traces to a real Form 4 filing on EDGAR:

- **Company tickers** → SEC's official ticker map
- **Filings** → EDGAR full-text search for Form 4 / 4-A within the window
- **Transactions** → parsed from the filing XML (not scraped HTML)

Requests are paced (~5/sec), retried with backoff, and every request
identifies itself with a contact email per the SEC's fair-access policy
(`edgar.userAgent` in config — required, the bot refuses to start without it).

## Filing forensics

Not every "buy" is a buy. Each transaction row is checked before it can
become an alert:

| Check | What it kills |
|---|---|
| Transaction code | Only **P** (open-market purchase) counts as a buy. A/M/X/F/C are grants, exercises, tax withholdings — mechanical, not signals |
| 10b5-1 plans | Form 4 checkbox + footnote parsing — planned sales carry no information |
| Footnote forensics | Rows mentioning offerings, private placements, ESPP, DRIP, or priced outside the day's range are issuer deals, not insider conviction |
| Amendments (4/A) | Deduped — keeps the original acceptance timestamp, never backfills amended values |
| Role parsing | "Vice President" is not President — title matching is strict |

## The grading system

Buys that survive forensics get scored out of 8 points:

| Factor | Points |
|---|---|
| Executive role (CEO/CFO/President) | +2 |
| Buy value > $500K | +2 (>$100K: +1) |
| Position increase > 50% | +2 (>25%: +1) |
| Cluster buy (2+ insiders, 14 days) | +2 |

**A** (8) · **B** (5–7) · **C** (3–4) · **D** (<3). Only grades at or above
the configured threshold post. Every card shows the point breakdown, so
the grade is auditable, not a black box.

Sells run a separate, stricter filter: C-suite only, not a 10b5-1 plan
sale, ≥20% position reduction, ≥$250K value. Sells are warnings, never
netted against buys.

## Alert cards

Each alert is a Discord embed with the insider, the company, the
transaction details, the grade with its breakdown, the current price vs
the insider's price, and a direct link to the source filing on EDGAR.
Sells get a distinct warning format. No @everyone, ever.

## Safety design

- **Dry-run by default.** Posts to Discord only when `dryRun: false` in
  config **and** `GALAH_ALLOW_POST=1` in the environment. Anything else —
  including a missing channel ID — means scan-and-log, post nothing.
- **Dedup by fingerprint.** Every filing accession and transaction
  fingerprint is recorded; restarts never re-alert.
- **State file.** Seen filings, recent buys, and alert history persist in
  `state.json` so the bot picks up where it left off.

## Project layout

```
bot.js         The scanner: EDGAR client, forensics, grading, Discord poster
config.json    Thresholds, channels, EDGAR settings (IDs empty — fill in yours)
package.json   Zero dependencies — pure Node.js (fetch only)
```

## Running it

```bash
cp .env.example .env   # DISCORD_BOT_TOKEN, ALERTS_CHANNEL_ID
node bot.js --once     # single dry-run scan, posts nothing
node bot.js            # hourly scans (dry-run unless GALAH_ALLOW_POST=1)
```

## Stack

Node.js (no dependencies), SEC EDGAR, Yahoo Finance (current prices),
Discord REST API. One file, one job: watch the filings, grade them,
alert on the ones that matter.
