# nepse-api

Backend for a small NEPSE analysis and charting app: instrument search, daily OHLCV candles (with weekly and monthly aggregation), latest quotes with freshness metadata, and SMA/EMA/RSI/MACD indicators.

Stack: Node.js, Express 5, TypeScript (strict, ESM), MySQL, Prisma 6, Zod 4, Pino and Vitest.

> **Data source warning.** All market data comes from the **unofficial** web endpoints behind `nepalstock.com.np`. NEPSE does not document, version or support them, and access needs the same token transformation that the NEPSE website runs in the browser. These endpoints can change or be blocked without notice. Check NEPSE's terms of use before you deploy this publicly.

---

## Requirements

- **Node.js 20.19 or newer** (22 LTS or 24 recommended; tested on 24.16)
- **MySQL 8.0.19 or newer.** The bulk upsert uses the `INSERT … AS new ON DUPLICATE KEY UPDATE` row-alias syntax.

## Setup

For a step-by-step Windows walkthrough with troubleshooting, see [docs/RUNNING.md](docs/RUNNING.md).

```bash
npm install                       # also runs `prisma generate`
cp .env.example .env              # then edit DATABASE_URL and the other settings
```

Create the database and a user:

```sql
CREATE DATABASE nepse CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'nepse'@'%' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON nepse.* TO 'nepse'@'%';
```

Apply migrations and seed the instrument list:

```bash
npm run db:deploy                 # apply migrations (use `npm run db:migrate` while changing the schema)
npm run db:seed                   # upserts the 573-entry symbol → security-id map
```

### TLS

The original script disabled TLS certificate checks for the whole process (`NODE_TLS_REJECT_UNAUTHORIZED=0`). This version keeps verification on. If Node rejects NEPSE's certificate chain, trust the missing CA instead:

```bash
NODE_EXTRA_CA_CERTS=/path/to/nepse-chain.pem npm start
# or, on Node 22.15+/23.8+, trust the OS certificate store:
NODE_OPTIONS=--use-system-ca npm start
```

## Running

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start with reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run typecheck` | `tsc --noEmit` over the source and tests |
| `npm test` | Unit and HTTP tests (no DB or network needed) |
| `npm run test:integration` | MySQL repository tests (needs `TEST_DATABASE_URL`) |
| `npm run db:migrate` / `db:deploy` | Prisma migrations (dev / deploy) |
| `npm run db:seed` | Seed or refresh instruments from the symbol map |
| `npm run sync` | Fetch the latest snapshot for every active instrument |
| `npm run backfill -- --file x.csv` | Import historical daily candles from CSV |

In production, the compiled jobs run as `node dist/jobs/sync-market-data.js` and `node dist/jobs/backfill-candles.js --file …`.

### Synchronization

```bash
npm run sync                              # every active instrument (or SYNC_SYMBOLS)
npm run sync -- --symbols NABIL,HRL       # a subset
npm run sync -- --force                   # also refetch instruments already final for the session
```

Each run fetches one snapshot per instrument and stores that session's daily candle, the latest quote, and the instrument's name, sector and type. Run it on a schedule: once after the market closes gives final candles, and every few minutes during trading keeps quotes and the provisional candle current. Use either:

- an external scheduler such as cron, systemd timers or Windows Task Scheduler (recommended), or
- the in-process scheduler: set `SYNC_INTERVAL_MINUTES` > 0 on the API server.

Exit codes: `0` succeeded, `1` failed, `2` partial, `3` another run holds the lock.

### Backfill

The existing code only uses a **current-day snapshot** endpoint, and no historical endpoint was verified. History therefore builds up from daily syncs, and older history is imported from CSV:

```bash
npm run backfill -- --file data/history.csv --dry-run
npm run backfill -- --file data/history.csv --symbols NABIL --from 2023-01-01 --to 2023-12-31
npm run backfill -- --file data/history.csv --overwrite
```

```csv
symbol,date,open,high,low,close,volume,trades
NABIL,2024-06-10,520.00,531.00,515.10,528.00,"104,233",812
```

- Required columns: `symbol`, `date` (`YYYY-MM-DD` or `YYYY/MM/DD`), `open`, `high`, `low`, `close`, `volume`. `trades` is optional. Headers are case-insensitive, and a few aliases are accepted (`ticker`, `trade_date`, `ltp`, `qty`).
- Every rejected row is reported with its line number and reason: `INVALID_DATE`, `UNKNOWN_SYMBOL`, `DUPLICATE_IN_INPUT`, `INVALID_PRICES`, `OHLC_INCONSISTENT`, `INVALID_VOLUME` or `FUTURE_DATE`.
- By default a stored candle with **different** values is left alone and reported as `CONFLICT_NOT_OVERWRITTEN`. Pass `--overwrite` to replace it.
- Only import data you are allowed to use, and **do not import adjusted prices**. All stored prices are treated as unadjusted.

---

## API

Base path: `/api/v1`. Every route is a read-only `GET` with no authentication. Ingestion is only available through the CLI jobs, not over HTTP.

### Conventions

| Topic | Rule |
| --- | --- |
| Success shape | `{ "data": …, "meta": { … } }` |
| Error shape | `{ "error": { "code", "message", "details"?, "requestId" } }` |
| Candle `time` | A trading date string `YYYY-MM-DD` on the Asia/Kathmandu exchange calendar. It is a date, not an instant. For `1w` it is the Sunday that starts the week; for `1mo` it is the 1st of the month. |
| Instants | ISO-8601 UTC strings, e.g. `fetchedAt`, `sourceUpdatedAt`, `lastSuccessfulSyncAt` |
| Prices | JSON numbers, stored as `DECIMAL(14,4)`, unadjusted for corporate actions (`meta.adjusted: false`) |
| Volume | JSON number of shares, stored as `BIGINT UNSIGNED`. Values above 2^53 are rejected rather than rounded. |
| Order | Candles are always in ascending chronological order |
| Request id | `X-Request-Id` is accepted if well formed (else generated), echoed in responses and included in every log line |

### `GET /health`

```json
{ "data": { "status": "ok", "database": "up", "uptimeSeconds": 42, "lastSuccessfulSyncAt": "2024-06-12T09:20:11.000Z" } }
```

Returns `503` with `"status": "degraded", "database": "down"` when MySQL is unreachable.

### `GET /instruments?search=nab&limit=20`

```json
{ "data": [ { "symbol": "NABIL", "name": "Nabil Bank Limited", "sector": "Commercial Banks", "instrumentType": "Equity" } ],
  "meta": { "count": 1 } }
```

`search` matches a symbol prefix or a substring of the name, case-insensitively. An exact symbol match is ranked first. `name`, `sector` and `instrumentType` stay `null` until the first sync fills them in.

### `GET /instruments/:symbol`

Symbols containing `/` must be URL-encoded, e.g. `NICD83%2F84`.

```json
{ "data": { "symbol": "NABIL", "name": "Nabil Bank Limited", "sector": "Commercial Banks", "instrumentType": "Equity",
            "isActive": true, "lastSyncedAt": "2024-06-12T09:20:03.120Z",
            "dailyCandles": { "count": 245, "firstDate": "2023-06-11", "lastDate": "2024-06-12" },
            "supportedIntervals": ["1d", "1w", "1mo"] } }
```

### `GET /market-data/:symbol/candles`

| Param | Default | Meaning |
| --- | --- | --- |
| `interval` | `1d` | `1d`, `1w` or `1mo`. `1w` and `1mo` are aggregated from daily candles. |
| `from` | — | Inclusive start date. For `1w`/`1mo` it is aligned down to the bucket start, so the first bucket is complete. |
| `to` | today (Kathmandu) | Inclusive end date |
| `before` | — | Exclusive upper bound for paging backwards. Pass the previous response's `meta.nextBefore`. |
| `limit` | `300` | 1–1000 candles per page |
| `format` | `ohlcv` | `ohlcv`, or `line` for `{ time, value }` points built from close prices |

A page holds the **newest** `limit` candles in the range, in ascending order. To load older data when the user scrolls back, request again with `before=meta.nextBefore` until `hasMore` is `false`. Pages never overlap or leave gaps, and a weekly or monthly bucket is never split across pages. The test suite checks this for several page sizes.

```json
{
  "data": [
    { "time": "2024-06-11", "open": 520, "high": 531, "low": 515.1, "close": 528, "volume": 104233, "provisional": false },
    { "time": "2024-06-12", "open": 528, "high": 534, "low": 522, "close": 530.5, "volume": 90120, "provisional": true }
  ],
  "meta": {
    "symbol": "NABIL", "interval": "1d", "format": "ohlcv",
    "source": "nepalstock.com.np", "adjusted": false,
    "timezone": "Asia/Kathmandu", "timeFormat": "YYYY-MM-DD trading date",
    "count": 2, "hasMore": true, "nextBefore": "2024-06-11",
    "dataStatus": "OK", "latestCandleProvisional": true,
    "instrumentLastSyncedAt": "2024-06-12T06:05:00.000Z",
    "lastSuccessfulSyncAt": "2024-06-12T06:05:09.000Z"
  }
}
```

`dataStatus` is `OK`, `NO_DATA_IN_RANGE` (the instrument has data, but not in this range) or `NO_DATA` (nothing stored yet). `provisional: true` means the session was still open when the candle was captured.

### `GET /market-data/:symbol/quote`

```json
{
  "data": { "symbol": "NABIL", "businessDate": "2024-06-12", "lastTradedPrice": 530.5, "previousClose": 528,
            "change": 2.5, "changePercent": 0.47, "totalTradedQuantity": 90120, "totalTrades": 701,
            "fiftyTwoWeekHigh": 640, "fiftyTwoWeekLow": 480,
            "sourceUpdatedAt": "2024-06-12T06:04:58.000Z", "fetchedAt": "2024-06-12T06:05:00.000Z" },
  "meta": {
    "source": "nepalstock.com.np",
    "freshness": { "fetchedAt": "2024-06-12T06:05:00.000Z", "ageSeconds": 75, "maxAgeSeconds": 300, "isStale": false, "marketOpenAtFetch": true },
    "refresh": { "attempted": false }
  }
}
```

By default the endpoint serves the quote stored by the last sync. With `QUOTE_ON_DEMAND_REFRESH=true`, a stale quote triggers one upstream fetch first (concurrent requests share it):

| Situation | Response |
| --- | --- |
| Refresh succeeds | `200`, fresh data, `refresh: { attempted: true, succeeded: true }` |
| Refresh fails, stored quote exists | `200`, stored data with `isStale: true` and `refresh: { attempted: true, succeeded: false, errorCode: "UPSTREAM_UNAVAILABLE" }` |
| Refresh fails, nothing stored | `503 UPSTREAM_UNAVAILABLE`, `504 UPSTREAM_TIMEOUT` or `502 REFRESH_FAILED` (upstream answered with unusable data) |
| Nothing stored, refresh disabled | `404 QUOTE_NOT_AVAILABLE` |

### `GET /indicators/:symbol`

Takes the same `interval`, `from`, `to`, `before` and `limit` parameters as `/candles`, and returns values for exactly the same page of candles. Points still inside the warm-up period are left out.

| `type` | Params (defaults) | Point shape |
| --- | --- | --- |
| `sma` | `period` (20) | `{ time, value }` |
| `ema` | `period` (20) | `{ time, value }` |
| `rsi` | `period` (14) | `{ time, value }` |
| `macd` | `fast` (12), `slow` (26), `signal` (9) | `{ time, macd, signal, histogram }` |

```
GET /api/v1/indicators/NABIL?type=rsi&period=14&interval=1d&limit=300
```

```json
{ "data": [ { "time": "2024-06-12", "value": 61.2381 } ],
  "meta": { "symbol": "NABIL", "interval": "1d", "indicator": "rsi", "params": { "period": 14 },
            "warmupBars": 14, "historyBars": 245, "insufficientHistory": false, "precision": 4,
            "hasMore": true, "nextBefore": "2023-08-01", "dataStatus": "OK" } }
```

**Methods**

- **SMA**: the mean of the last `period` closes. The first value appears at bar `period-1`.
- **EMA**: `k = 2/(period+1)`, seeded with the SMA of the first `period` closes. The first value appears at bar `period-1`.
- **RSI**: Wilder's smoothing. The first average gain and loss is the simple mean of changes 1…`period`; after that, `avg = (prev*(period-1) + current)/period`. If the average loss is 0, RSI is 100; if prices are completely flat, RSI is 50. The first value appears at bar `period`.
- **MACD**: `EMA(fast) − EMA(slow)`. The signal line is an EMA of the MACD line, seeded with the SMA of its first `signal` values. The histogram is MACD minus signal. The first full point appears at bar `slow + signal − 2`.
- **Warm-up**: values are computed over the instrument's **whole stored history** up to the end of the requested page, so a given date gets the same value whichever page it appears on. If the history is shorter than the warm-up, `insufficientHistory` is `true`.
- **Precision**: calculations use float64 and responses are rounded to 4 decimals.
- These are descriptive statistics only. The API does not produce buy or sell signals.

### Error codes

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Bad path or query parameters (`details.issues` lists them) |
| 400 | `INVALID_JSON` | A request body that is not valid JSON |
| 413 | `PAYLOAD_TOO_LARGE` | Body over `JSON_BODY_LIMIT` |
| 404 | `ROUTE_NOT_FOUND` | Unknown route |
| 404 | `INSTRUMENT_NOT_FOUND` | Unknown symbol |
| 404 | `QUOTE_NOT_AVAILABLE` | Known symbol with no stored quote |
| 429 | `RATE_LIMITED` | Over `API_RATE_LIMIT_MAX` requests per window (standard `RateLimit` headers) |
| 502 | `REFRESH_FAILED` | Upstream responded, but with unusable data |
| 503 | `UPSTREAM_UNAVAILABLE` | Upstream unreachable, refusing or rate limiting us |
| 504 | `UPSTREAM_TIMEOUT` | Upstream timed out |
| 503 / 500 | `DATABASE_ERROR` | Database unreachable (503) or a query failed (500) |
| 500 | `INTERNAL_ERROR` | Anything unexpected |

Stack traces are only included when `NODE_ENV=development`. Database messages, provider responses and tokens never reach clients, and logs redact `Authorization` headers and tokens.

---

## Design

### Folder structure

```
src/
  app.ts                      Express app factory (no listen)
  server.ts                   listen, optional scheduler, graceful shutdown
  config/                     env (Zod), logger (Pino), prisma client
  common/
    errors/app-error.ts       AppError + stable error codes
    middleware/               request-id, not-found, error-handler
    utils/                    time (Kathmandu calendar), serialization, concurrency
  modules/
    instruments/              search + details
    market-data/              candles (paging, aggregation), quotes
    indicators/               SMA/EMA/RSI/MACD (pure functions in calculations/)
    ingestion/
      ingestion.service.ts    sync, CSV backfill, on-demand refresh
      ingestion.repository.ts bulk writes, runs, lock
      ingestion.rules.ts      candle invariants + diffing (pure)
      csv.ts                  CSV parsing
      providers/              NEPSE client, token algorithm, schemas, mapper, symbol map
  jobs/                       CLI entry points: sync, backfill, seed
  routes/index.ts             /api/v1 router + health
prisma/                       schema + migrations
tests/unit, tests/integration
```

There is no `async-handler` utility, because Express 5 already forwards rejected promises from handlers to the error middleware.

### Database

- `instruments`: symbol (unique), NEPSE security id (unique), name, sector, type, `last_synced_at`.
- `daily_candles`: `UNIQUE (instrument_id, trade_date)` prevents duplicates and also serves chronological range scans. Prices are `DECIMAL(14,4)`, volume is `BIGINT UNSIGNED`, plus `is_provisional` and `source` (`NEPSE` or `CSV_IMPORT`). There is no interval column, because only daily data exists; weekly and monthly candles are computed at read time.
- `quotes`: the latest snapshot per instrument.
- `ingestion_runs`: type, status (`RUNNING`, `SUCCEEDED`, `PARTIAL`, `FAILED`, `ABANDONED`), counts, timestamps, error message, and capped JSON details of skipped records and failures.
- `ingestion_locks`: a lease-style mutex row.

Indicators are not stored; they are cheap to compute on read.

### Ingestion

- **Provider** (`nepse.provider.ts`): one authenticated session (Salter token plus payload id) is reused for `PROVIDER_SESSION_TTL_MS`, and concurrent callers share one in-flight authentication. A `401`/`403` triggers a single re-authentication. Every request has a timeout. Transient failures (network, timeout, 5xx, 429) are retried up to `PROVIDER_MAX_RETRIES` times with exponential backoff and jitter. `Retry-After` is honoured; if it asks for more than `PROVIDER_MAX_RETRY_DELAY_MS`, the request fails instead of waiting. All workers share one throttle that keeps request starts at least `PROVIDER_MIN_INTERVAL_MS` apart.
- **Validation** (`nepse.types.ts`, `nepse.mapper.ts`): responses are checked with Zod. Candles must satisfy `low ≤ min(open, close)`, `high ≥ max(open, close)`, all prices positive, integer volume ≥ 0, and a real date no later than today. A bad record is skipped with a reason and never partially stored. Missing optional fields never overwrite stored values: quote and instrument fields use non-null updates, and `trades` uses `COALESCE`.
- **Provisional candles**: a candle is provisional when the market reported itself open and the record belongs to the current session. While provisional, the last traded price is its close. A later sync after the close turns it final, and a provisional candle never replaces a final one.
- **Idempotency and corrections**: incoming candles are compared with stored rows. Identical data counts as `unchanged` and writes nothing; different values count as `updated`. Each batch of candles, quotes and instrument updates is written in **one transaction** after the network calls finish, so no transaction is ever open during a request.
- **Concurrency**: `SYNC_CONCURRENCY` workers (default 3), flushing in batches of `SYNC_BATCH_SIZE`. The run aborts after `SYNC_MAX_CONSECUTIVE_FAILURES` consecutive upstream failures so it doesn't hammer a struggling server.
- **No overlapping runs**: a DB lease lock (`ingestion_locks`) with a TTL, extended after every batch. A second run exits with code 3.
- **Recovery**: a crashed run leaves a `RUNNING` row and an expiring lock. The next run takes over the expired lock and marks the orphan `ABANDONED`. Sync is incremental: once a session has closed, instruments that already have a final candle for it are skipped, so a rerun only fetches what is missing. Use `--force` to refetch everything. SIGINT and SIGTERM stop new work, wait for in-flight work, and record the run as `PARTIAL`.

### Running more than one instance

The database lock already prevents overlapping ingestion across processes. Before scaling out, though:

1. Set `SYNC_INTERVAL_MINUTES=0` on API instances and run `sync` from a single external scheduler.
2. The API rate limiter keeps counts in memory per process. Use a shared store if limits must be global.
3. The on-demand quote refresh only de-duplicates within a process, and each process runs its own provider throttle. Total upstream request rates grow with the number of instances, so keep `QUOTE_ON_DEMAND_REFRESH=false` or lower the provider rate.
4. Set `TRUST_PROXY` to match your load balancer so rate limiting sees client IPs.

### Frontend responsibilities

The API supplies the data. The chart UI (for example TradingView Lightweight Charts, which accepts `time: 'YYYY-MM-DD'` directly) owns:

- rendering candles, lines and volume
- crosshair, zoom, pan and drawing tools
- styling
- calling `before=nextBefore` when the user scrolls to the left edge
- polling `/quote` during market hours

WebSockets are not used. The source has no push feed, and its data only changes as often as you poll it, so client-side polling of `/quote` is the right fit.

---

## Original implementation: analysis

The original project (`nepse.js`, `algorithms.js`, `all.js`) was a script that printed one security's details to the console.

**Flow**

1. `GET https://nepalstock.com.np/api/authenticate/prove` returns `accessToken`, `refreshToken` and `salt1`–`salt5`.
2. `cdx`, `rdx`, `bdx`, `ndx` and `mdx` (decompiled WebAssembly) compute five positions. The characters at those positions are removed from the 250-character `accessToken`, leaving the 245-character key sent as `Authorization: Salter <key>`. In practice **only `salt2`** matters: each function reads its units, tens and hundreds digits and indexes a lookup table.
3. `GET https://www.nepalstock.com/api/nots/nepse-data/market-open` (with that header) returns `{ isOpen, asOf, id }`.
4. The payload id is `dummyData[id] + id + 2 × dayOfMonth`.
5. `POST https://nepalstock.com.np/api/nots/security/{securityId}` with body `{ "id": payloadId }` returns the security's details and the current day's trade snapshot.
6. `all.js` maps 573 symbols to security ids.

**What it provided**: one snapshot per call, covering the current or last session's OHLC, LTP, previous close, quantity and 52-week range. There was no history, no storage, no intraday data and no indicators.

**Problems found**

| Issue | Fix |
| --- | --- |
| `NODE_TLS_REJECT_UNAUTHORIZED = "0"` disabled TLS verification for the whole process | Removed; supply CA certificates instead (see *TLS*) |
| `dummyId` was an implicit global | Scoped |
| No `res.ok` checks; error pages were parsed as JSON | Status handling with typed `ProviderError`s |
| No timeouts, retries or rate limiting | Added |
| Re-authenticated on every call (3 requests per symbol) | Session reuse; 1 request per symbol |
| Mixed hosts (`www.nepalstock.com` and `nepalstock.com.np`) plus a hand-set `Host` header | A single `NEPSE_BASE_URL` |
| Hand-computed `Content-Length` | Left to `fetch` |
| `new Date().getDate()` used the host machine's timezone | Uses the Kathmandu day (see below) |
| `marketStatus.id ≥ 100` gave `NaN` | Validated |
| No validation of response shapes | Zod schemas and candle invariants |
| `console.log` output only | Structured storage, run records and logs |

### Preserved, changed, verified

**Preserved**

- The token algorithm, ported to readable code in `nepse.auth.ts`. The original `algorithms.js` is kept as a test oracle in `tests/fixtures/`, and the port matches it for every `salt2` from 0 to 99,999.
- The payload id formula, checked for every market id and several days of the month.
- The three endpoints and request methods, the `Salter` scheme, the request body, and the symbol map (copied unchanged).

**Intentionally changed**

- The payload day of month uses **Asia/Kathmandu**, not the server's local time. On a UTC server, the original computed the wrong day between 18:15 and 24:00 UTC. A browser in Nepal computes the Kathmandu day, so this matches what NEPSE presumably expects.
- One base URL instead of mixed hosts.
- TLS verification stays on.

**Verified**

- `npm run typecheck` and `npm run build` pass.
- `npm test` runs 135 tests: the algorithm port, provider retry, backoff and session behaviour against a fake `fetch`, the mapper with malformed records, candle rules, duplicate and corrected ingestion, incremental resume, locking and abort, CSV import, pagination round-trips, Kathmandu date handling, indicators against hand-computed values, and HTTP validation and error shapes.
- The compiled server was booted without a database. It returned `404 ROUTE_NOT_FOUND`, `503` on health, `503 DATABASE_ERROR` and `400 VALIDATION_ERROR` as designed.

**Not verified**

- The MySQL integration tests (`tests/integration/repository.mysql.test.ts`) and the migration against a live MySQL server. No MySQL was available while this was built. Run `npm run test:integration` with a `*_test` database.
- Live NEPSE responses. `nepalstock.com.np` closed connections from the build environment, so the `/api/nots/security/{id}` field names (`securityDailyTradeDto.openPrice`, `businessDate`, `lastUpdatedDateTime`, `security.securityName`, …) come from the existing code's target endpoint and commonly observed payloads, not from a captured response. If a field differs, records are skipped with `INVALID_RECORD` and appear in the run details, so check the first sync's output.

### Data-source limitations

- **Daily granularity only.** No intraday candles are offered, and none are synthesized from daily data. `1w` and `1mo` are true aggregates of stored days.
- **No historical endpoint is used.** History accumulates from syncs and CSV imports. A day missed by sync cannot be recovered from this source later.
- **Unadjusted prices.** There is no corporate-action data, so bonus and right-share adjustments are not applied (`adjusted: false`).
- **Holidays.** Missing calendar days are not errors; candles exist only for sessions that had trades. A stock that didn't trade in a session has no candle (`NO_TRADES` in the run details).
- **Snapshot timing.** A candle captured during trading is provisional. The final close may differ until a post-close sync runs.
- **The symbol map is static** (last updated 2024-06-12). Newly listed securities need to be added to `nepse.securities.ts` and seeded again. A symbol returned for the wrong id is reported as `SYMBOL_MISMATCH`.
- **The endpoints are unofficial** and can change or be blocked at any time.
