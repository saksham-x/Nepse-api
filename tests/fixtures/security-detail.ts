/**
 * Representative POST /api/nots/security/{id} payload, limited to the fields
 * the mapper reads plus a few it ignores. Not a captured live response.
 */
export function securityDetail(overrides: {
  trade?: Record<string, unknown> | null;
  security?: Record<string, unknown> | null;
} = {}) {
  return {
    securityDailyTradeDto: overrides.trade === null ? null : {
      securityId: '397',
      openPrice: 300,
      highPrice: 310.5,
      lowPrice: 298,
      closePrice: 305.2,
      totalTradeQuantity: 12_345,
      totalTrades: 210,
      lastTradedPrice: 305.2,
      previousClose: 299,
      businessDate: '2024-06-12',
      fiftyTwoWeekHigh: 400,
      fiftyTwoWeekLow: 250,
      lastUpdatedDateTime: '2024-06-12T15:00:02.123456',
      ...overrides.trade,
    },
    security: overrides.security === null ? null : {
      id: 397,
      symbol: 'ADBL',
      securityName: 'Agricultural Development Bank Limited',
      companyId: { companyName: 'Agricultural Development Bank Limited', sectorMaster: { sectorDescription: 'Commercial Banks' } },
      instrumentType: { description: 'Equity' },
      ...overrides.security,
    },
    stockListedShares: 1_000_000,
  };
}
