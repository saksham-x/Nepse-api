# Running nepse-api

A step-by-step guide to running the backend on a Windows machine, from a fresh checkout to a working API. Commands are for **PowerShell**. For the full API reference and design notes, see [../README.md](../README.md).

---

## 1. Install the prerequisites

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 20.19 or newer (22 LTS or 24 recommended) | `node -v` |
| npm | comes with Node | `npm -v` |
| MySQL Server | 8.0.19 or newer | `mysql --version` |

If MySQL isn't installed, either:

- install it with winget: `winget install Oracle.MySQL`, or
- download **MySQL Installer** from dev.mysql.com, choose "Server only", and set a root password during setup.

Make sure the MySQL service is running: open **Services** (`services.msc`) and find `MySQL80` (or similar), or run `Get-Service *mysql*` in PowerShell.

> If `mysql` isn't recognised, add its `bin` folder to your PATH, usually `C:\Program Files\MySQL\MySQL Server 8.x\bin`, or use MySQL Workbench for the SQL in step 2.

---

## 2. Create the database

Open a MySQL shell as root:

```powershell
mysql -u root -p
```

Then run the following, replacing `change-me` with a real password:

```sql
CREATE DATABASE nepse CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'nepse'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON nepse.* TO 'nepse'@'localhost';

-- Optional: a separate database for the MySQL integration tests (name must end in _test)
CREATE DATABASE nepse_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON nepse_test.* TO 'nepse'@'localhost';
EXIT;
```

---

## 3. Configure the project

```powershell
cd "D:\Saksham full stack\Nepse-summary\nepse-api"
Copy-Item .env.example .env
```

Open `.env` and set at least:

```ini
DATABASE_URL=mysql://nepse:change-me@localhost:3306/nepse
TEST_DATABASE_URL=mysql://nepse:change-me@localhost:3306/nepse_test
CORS_ORIGINS=http://localhost:5173
```

- If your password contains special characters such as `@`, `#` or `:`, URL-encode them (`@` → `%40`).
- `CORS_ORIGINS` should be the address of your future frontend.
- `.env` is git-ignored. Never commit it.

Every other setting has a sensible default and is explained in `.env.example`.

---

## 4. Install dependencies

```powershell
npm install
```

This also runs `prisma generate`, which builds the database client.

---

## 5. Create the tables

```powershell
npm run db:deploy
```

This applies the migration in `prisma/migrations/`. You should see `All migrations have been successfully applied.`

---

## 6. Load the instrument list

```powershell
npm run db:seed
```

This inserts the 573 NEPSE symbols and their security ids. It is safe to run again at any time. Names and sectors stay empty until the first sync fills them in.

---

## 7. Fetch market data

Start with a couple of symbols so you can check the output quickly:

```powershell
npm run sync -- --symbols NABIL,ADBL
```

At the end, the log shows a summary with `status` and counts (`inserted`, `updated`, `skipped`, `failed`).

- `SUCCEEDED`: everything worked. Run `npm run sync` for all instruments, which takes a few minutes.
- `skipped` > 0: look at `skippedSample` in the log for the reason. `NO_TRADES` is normal; `INVALID_RECORD` means NEPSE's response format didn't match (see Troubleshooting).
- `FAILED` with `could not start a provider session`: NEPSE couldn't be reached (see Troubleshooting).

---

## 8. Start the API

Development mode, which restarts when you edit code:

```powershell
npm run dev
```

Production mode:

```powershell
npm run build
npm start
```

The server listens on `http://localhost:3000` by default (`PORT` in `.env`).

---

## 9. Check it works

Use `curl.exe` (plain `curl` in Windows PowerShell 5.1 is a different command), or open the URLs in a browser.

```powershell
curl.exe http://localhost:3000/api/v1/health
curl.exe "http://localhost:3000/api/v1/instruments?search=nabil"
curl.exe http://localhost:3000/api/v1/instruments/NABIL
curl.exe http://localhost:3000/api/v1/market-data/NABIL/quote
curl.exe "http://localhost:3000/api/v1/market-data/NABIL/candles?interval=1d&limit=100"
curl.exe "http://localhost:3000/api/v1/indicators/NABIL?type=rsi&period=14"
```

A healthy server returns `{"data":{"status":"ok","database":"up",...}}`.

> Right after the first sync, each symbol has only **one** daily candle, so indicators will report `insufficientHistory: true`. That is expected: history grows by one candle per trading day, or you can import older data (step 11).

---

## 10. Keep data up to date

NEPSE only provides today's snapshot, so the sync must run **every trading day**. A day that is missed can't be fetched later. NEPSE trades Sunday to Thursday, typically 11:00–15:00 Nepal time.

**Option A: Windows Task Scheduler (recommended)**

1. Build once: `npm run build`.
2. Open **Task Scheduler**, then **Create Basic Task**, named for example "NEPSE sync".
3. Trigger: **Daily**, at a time after the market closes (e.g. 15:30 Nepal time).
4. Action: **Start a program**:
   - Program: `node`, or the full path from `(Get-Command node).Source`
   - Arguments: `dist\jobs\sync-market-data.js`
   - Start in: `D:\Saksham full stack\Nepse-summary\nepse-api`. This is required so `.env` is found.

To keep quotes fresh during trading hours, add a second trigger that repeats every 5–15 minutes between 11:00 and 15:00.

**Option B: in-process scheduler**

Set `SYNC_INTERVAL_MINUTES=15` in `.env`. The API server then syncs on its own while it is running. Use this only when running a single server instance.

Overlapping runs are prevented automatically: a second sync exits with code `3` instead of running.

---

## 11. Import older history (optional)

If you have historical daily prices in CSV form:

```csv
symbol,date,open,high,low,close,volume
NABIL,2024-06-10,520.00,531.00,515.10,528.00,104233
```

Preview first, then import:

```powershell
npm run backfill -- --file data\history.csv --dry-run
npm run backfill -- --file data\history.csv
```

- Useful filters: `--symbols NABIL,ADBL`, `--from 2023-01-01`, `--to 2023-12-31`.
- Rows that already exist with different values are reported, not replaced. Add `--overwrite` to replace them.
- Use only unadjusted prices from a source you're allowed to use.

---

## 12. Run the tests

```powershell
npm run typecheck          # TypeScript checks
npm test                   # unit + API tests, no database or network needed
npm run test:integration   # MySQL tests, uses TEST_DATABASE_URL (the nepse_test database)
```

The integration tests apply migrations to `nepse_test` and delete its data. They refuse to run against a database whose name doesn't end in `_test`.

---

## Script reference

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the API with auto-restart |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled API |
| `npm run db:deploy` | Apply database migrations |
| `npm run db:migrate` | Create a new migration after editing `prisma/schema.prisma` |
| `npm run db:seed` | Insert or refresh the symbol list |
| `npm run sync` | Fetch the latest snapshot (`--symbols`, `--force`) |
| `npm run backfill -- --file x.csv` | Import CSV history (`--dry-run`, `--overwrite`, `--from`, `--to`, `--symbols`) |
| `npm test` | Unit and API tests |
| `npm run test:integration` | MySQL repository tests |
| `npm run typecheck` | Type-check everything |

Sync and backfill exit codes: `0` succeeded, `1` failed, `2` partial, `3` another run in progress.

---

## Troubleshooting

**`Invalid environment configuration`** on startup
: A required `.env` value is missing or malformed. The message names the variable. Check that `.env` exists in the project folder and that `DATABASE_URL` starts with `mysql://`.

**`Can't reach database server`** / health shows `"database":"down"`
: MySQL isn't running, or host, port or credentials are wrong. Start the MySQL service and test with `mysql -u nepse -p -h localhost nepse`.

**`P1000 Authentication failed`** during `db:deploy`
: Wrong user or password in `DATABASE_URL`, or a special character that wasn't URL-encoded.

**`The table ... does not exist`**
: Run `npm run db:deploy`.

**Sync: `could not start a provider session`, timeouts or `network` failures**
: nepalstock.com.np isn't reachable from your network. It is often unreachable from outside Nepal or when the site is down. Check that you can open https://nepalstock.com.np in a browser on the same machine, then retry later.

**Sync: `unable to verify the first certificate` / certificate errors**
: Node doesn't trust NEPSE's certificate chain. Do **not** disable TLS checks. Instead, trust Windows' certificate store (Node 22.15+):
  ```powershell
  $env:NODE_OPTIONS = "--use-system-ca"; npm run sync
  ```
  Or export the certificate chain to a `.pem` file and run:
  ```powershell
  $env:NODE_EXTRA_CA_CERTS = "C:\certs\nepse-chain.pem"; npm run sync
  ```

**Sync: many `INVALID_RECORD` skips**
: NEPSE's response format differs from what the mapper expects. The `message` shows which field. Update the schema in `src/modules/ingestion/providers/nepse.types.ts` and the mapper to match.

**Sync: `SYMBOL_MISMATCH`**
: The symbol → id map is out of date for that symbol. Fix it in `src/modules/ingestion/providers/nepse.securities.ts`, then run `npm run db:seed`.

**Sync exits with code `3`: "Another ingestion run is in progress"**
: A sync is already running. If an earlier run crashed, its lock expires after `INGESTION_LOCK_TTL_SECONDS` (30 minutes by default), and the next run takes over automatically.

**Candles return `"dataStatus":"NO_DATA"`**
: Nothing has been synced for that symbol yet. Run `npm run sync -- --symbols SYMBOL`.

**Quote returns `404 QUOTE_NOT_AVAILABLE`**
: No sync has stored a quote for that symbol yet.

**`EADDRINUSE` on startup**
: Port 3000 is already in use. Change `PORT` in `.env`, or find the process with `Get-NetTCPConnection -LocalPort 3000`.

**Symbols with `/`** (e.g. `NICD83/84`) return 404 ROUTE_NOT_FOUND
: Encode the slash as `%2F` in the URL: `/api/v1/instruments/NICD83%2F84`.

**Readable logs**
: `npm run dev` uses pretty logs when `NODE_ENV=development`. In production, logs are JSON lines, one per event, and each request log includes its `X-Request-Id`.
