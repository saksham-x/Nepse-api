/**
 * Fetches the latest daily snapshot for each instrument and stores candles + quotes.
 *
 *   npm run sync
 *   npm run sync -- --symbols NABIL,HRL
 *   npm run sync -- --force        # refetch even if the session is already final
 */
import { parseArgs } from 'node:util';
import { getIngestionService } from '../modules/ingestion/ingestion.service.js';
import { parseSymbols, runJob } from './run-job.js';

const { values } = parseArgs({
  options: {
    symbols: { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

await runJob('sync', (signal) =>
  getIngestionService().runSync({ symbols: parseSymbols(values.symbols), force: values.force, signal }),
);
