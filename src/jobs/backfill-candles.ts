/**
 * Imports historical daily candles from a CSV file.
 *
 *   npm run backfill -- --file data/history.csv
 *   npm run backfill -- --file data/history.csv --symbols NABIL --from 2023-01-01 --to 2023-12-31
 *   npm run backfill -- --file data/history.csv --dry-run
 *   npm run backfill -- --file data/history.csv --overwrite   # replace differing stored candles
 *
 * Required columns: symbol, date (YYYY-MM-DD), open, high, low, close, volume. Optional: trades.
 */
import { parseArgs } from 'node:util';
import { isValidTradeDate } from '../common/utils/time.js';
import { getIngestionService } from '../modules/ingestion/ingestion.service.js';
import { parseSymbols, runJob } from './run-job.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    symbols: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    overwrite: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!values.file) {
  console.error('Usage: npm run backfill -- --file <path.csv> [--symbols A,B] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--overwrite] [--dry-run]');
  process.exit(1);
}
for (const key of ['from', 'to'] as const) {
  const v = values[key];
  if (v !== undefined && !isValidTradeDate(v)) {
    console.error(`--${key} must be a date in YYYY-MM-DD format`);
    process.exit(1);
  }
}

const file = values.file;
await runJob('backfill', () =>
  getIngestionService().runBackfill({
    filePath: file,
    symbols: parseSymbols(values.symbols),
    from: values.from,
    to: values.to,
    overwrite: values.overwrite,
    dryRun: values['dry-run'],
  }),
);
