import { createServerFn } from "@tanstack/react-start";

export type StockData = {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  volume: number;
  avgVolume: number;
  marketCap: number | null;
  history: { t: number; c: number }[];
};

export const getStock = createServerFn({ method: "GET" })
  .inputValidator((d: { symbol: string }) => ({
    symbol: String(d.symbol || "").trim().toUpperCase(),
  }))
  .handler(async ({ data }): Promise<StockData> => {
    if (!data.symbol) throw new Error("Symbol is required");

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      data.symbol,
    )}?range=6mo&interval=1d`;

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!res.ok) throw new Error(`Upstream error (${res.status})`);
    const json: any = await res.json();

    const err = json?.chart?.error;
    if (err) throw new Error(err.description || "Symbol not found");

    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`No data for "${data.symbol}"`);

    const meta = result.meta;
    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] =
      result.indicators?.quote?.[0]?.close || [];

    const history = timestamps
      .map((t, i) => ({ t: t * 1000, c: closes[i] as number }))
      .filter((p) => typeof p.c === "number" && !Number.isNaN(p.c));

    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;

    return {
      symbol: meta.symbol,
      name: meta.longName || meta.shortName || meta.symbol,
      exchange: meta.fullExchangeName || meta.exchangeName || "",
      currency: meta.currency || "USD",
      price,
      previousClose: prev,
      change: price - prev,
      changePercent: ((price - prev) / prev) * 100,
      open: meta.regularMarketOpen ?? meta.open ?? price,
      dayHigh: meta.regularMarketDayHigh ?? 0,
      dayLow: meta.regularMarketDayLow ?? 0,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
      volume: meta.regularMarketVolume ?? 0,
      avgVolume: meta.averageDailyVolume3Month ?? 0,
      marketCap: meta.marketCap ?? null,
      history,
    };
  });
