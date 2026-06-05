import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Tickers: 1–10 chars, letters/digits, optional .EXCHANGE suffix (e.g. BRK.B, AAPL.US, VOD.UK).
const TICKER_REGEX = /^[A-Z0-9]{1,10}(?:\.[A-Z]{1,5})?$/;

export const tickerSchema = z
  .string({ required_error: "Ticker symbol is required" })
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => s.length > 0, { message: "Ticker symbol is required" })
  .refine((s) => s.length <= 16, { message: "Ticker symbol is too long" })
  .refine((s) => TICKER_REGEX.test(s), {
    message:
      "Invalid ticker. Use letters/numbers only, optionally with an exchange suffix (e.g. AAPL or BRK.B).",
  });

export function normalizeTicker(input: string): string {
  return tickerSchema.parse(input);
}


export type StockProvider = "Yahoo Finance" | "Stooq";

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
  provider: StockProvider;
};

function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
}

function toStooqSymbol(symbol: string): string {
  const s = symbol.toLowerCase();
  // If user didn't include an exchange suffix, assume US listing.
  return s.includes(".") ? s : `${s}.us`;
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json,text/csv,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchFromYahoo(symbol: string): Promise<StockData | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol,
    )}?range=1y&interval=1d`;
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (json?.chart?.error) return null;
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    if (!meta?.regularMarketPrice) return null;

    const fullHistory = timestamps
      .map((t, i) => ({ t: t * 1000, c: closes[i] as number }))
      .filter((p) => typeof p.c === "number" && Number.isFinite(p.c));

    const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const history = fullHistory.filter((p) => p.t >= sixMonthsAgo);

    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;

    return {
      provider: "Yahoo Finance",
      symbol,
      name: meta.longName || meta.shortName || symbol,
      exchange: meta.fullExchangeName || meta.exchangeName || "",
      currency: meta.currency || "USD",
      price,
      previousClose: prev,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      open: meta.regularMarketOpen ?? price,
      dayHigh: meta.regularMarketDayHigh ?? price,
      dayLow: meta.regularMarketDayLow ?? price,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? price,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? price,
      volume: meta.regularMarketVolume ?? 0,
      avgVolume: meta.averageDailyVolume3Month ?? 0,
      marketCap: meta.marketCap ?? null,
      history,
    };
  } catch {
    return null;
  }
}

async function fetchFromStooq(symbol: string): Promise<StockData | null> {
  try {
    const stooqSym = toStooqSymbol(symbol);
    const quoteUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(
      stooqSym,
    )}&f=sd2t2ohlcv&h&e=csv`;
    const histUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(
      stooqSym,
    )}&i=d`;

    const [quoteRes, histRes] = await Promise.all([
      fetch(quoteUrl, { headers: BROWSER_HEADERS }),
      fetch(histUrl, { headers: BROWSER_HEADERS }),
    ]);
    if (!quoteRes.ok) return null;

    const quoteText = await quoteRes.text();
    const quoteRows = parseCsv(quoteText);
    if (quoteRows.length < 2) return null;
    const header = quoteRows[0].map((h) => h.toLowerCase());
    const row = quoteRows[1];
    const get = (key: string) => {
      const i = header.indexOf(key);
      return i >= 0 ? row[i] : "";
    };

    const open = parseFloat(get("open"));
    const high = parseFloat(get("high"));
    const low = parseFloat(get("low"));
    const close = parseFloat(get("close"));
    const volume = parseInt(get("volume"), 10);

    if (!Number.isFinite(close) || get("close").toUpperCase() === "N/D") {
      return null;
    }

    let history: { t: number; c: number; v: number }[] = [];
    if (histRes.ok) {
      const histText = await histRes.text();
      const histRows = parseCsv(histText);
      if (histRows.length > 1) {
        const hHeader = histRows[0].map((h) => h.toLowerCase());
        const dateIdx = hHeader.indexOf("date");
        const closeIdx = hHeader.indexOf("close");
        const volIdx = hHeader.indexOf("volume");
        for (let i = 1; i < histRows.length; i++) {
          const r = histRows[i];
          const d = r[dateIdx];
          const c = parseFloat(r[closeIdx]);
          const v = parseFloat(r[volIdx]);
          if (!d || !Number.isFinite(c)) continue;
          const t = new Date(`${d}T00:00:00Z`).getTime();
          if (!Number.isFinite(t)) continue;
          history.push({ t, c, v: Number.isFinite(v) ? v : 0 });
        }
        history.sort((a, b) => a.t - b.t);
      }
    }

    const todayMs = new Date().setUTCHours(0, 0, 0, 0);
    const priorBars = history.filter((p) => p.t < todayMs);
    const previousClose =
      priorBars.length > 0 ? priorBars[priorBars.length - 1].c : open || close;

    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const yearBars = history.filter((p) => p.t >= oneYearAgo);
    const fiftyTwoWeekHigh = yearBars.length
      ? Math.max(...yearBars.map((p) => p.c))
      : high || close;
    const fiftyTwoWeekLow = yearBars.length
      ? Math.min(...yearBars.map((p) => p.c))
      : low || close;

    const threeMonthsAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const recentVols = history
      .filter((p) => p.t >= threeMonthsAgo && p.v > 0)
      .map((p) => p.v);
    const avgVolume = recentVols.length
      ? Math.round(recentVols.reduce((a, b) => a + b, 0) / recentVols.length)
      : 0;

    const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const chartHistory = history
      .filter((p) => p.t >= sixMonthsAgo)
      .map((p) => ({ t: p.t, c: p.c }));

    const change = close - previousClose;
    return {
      provider: "Stooq",
      symbol,
      name: symbol,
      exchange: stooqSym.split(".")[1]?.toUpperCase() || "",
      currency: "USD",
      price: close,
      previousClose,
      change,
      changePercent: previousClose ? (change / previousClose) * 100 : 0,
      open: Number.isFinite(open) ? open : close,
      dayHigh: Number.isFinite(high) ? high : close,
      dayLow: Number.isFinite(low) ? low : close,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      volume: Number.isFinite(volume) ? volume : 0,
      avgVolume,
      marketCap: null,
      history: chartHistory,
    };
  } catch {
    return null;
  }
}

export const getStock = createServerFn({ method: "GET" })
  .inputValidator((d: { symbol: string }) =>
    z.object({ symbol: tickerSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<StockData> => {
    // Try Yahoo first (richer metadata), then Stooq as fallback.
    // Run both in parallel and prefer Yahoo if it succeeds — minimizes latency
    // when one provider is throttling.
    const [yahoo, stooq] = await Promise.all([
      fetchFromYahoo(data.symbol),
      fetchFromStooq(data.symbol),
    ]);

    const result = yahoo ?? stooq;
    if (!result) {
      // Both providers failed — give the user a clearer, consolidated message.
      throw new Error(
        `No data for "${data.symbol}" from either Yahoo Finance or Stooq. Double-check the ticker symbol (e.g. AAPL, MSFT, TSLA) — if it's correct, both data sources may be temporarily unavailable. Please try again in a moment.`,
      );
    }
    return result;
  });

