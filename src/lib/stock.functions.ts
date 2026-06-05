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


export type StockProvider = "Yahoo Finance" | "Stooq" | "Nasdaq";

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

export type StockLookupResult = {
  stock: StockData | null;
  error: string | null;
  details: string[];
};

type ProviderAttempt = {
  provider: StockProvider;
  stock: StockData | null;
  detail: string;
};

function failedAttempt(
  provider: StockProvider,
  detail: string,
): ProviderAttempt {
  return { provider, stock: null, detail };
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,%+\s]/g, "").replace(/,/g, "");
  if (!cleaned || cleaned.toUpperCase() === "N/A") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values: Array<number | null | undefined>): number | null {
  return values.find((value) => typeof value === "number" && Number.isFinite(value)) ?? null;
}

function numbersFrom(value: unknown): number[] {
  if (typeof value !== "string") return [];
  return (value.match(/[+-]?\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [])
    .map(parseNumber)
    .filter((value): value is number => value !== null);
}

function parseNasdaqDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [month, day, year] = value.split("/").map((part) => Number(part));
  if (!month || !day || !year) return null;
  const timestamp = Date.UTC(year, month - 1, day);
  return Number.isFinite(timestamp) ? timestamp : null;
}

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

const NASDAQ_HEADERS = {
  ...BROWSER_HEADERS,
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
};

async function fetchFromYahoo(symbol: string): Promise<ProviderAttempt> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol,
    )}?range=1y&interval=1d`;
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) return failedAttempt("Yahoo Finance", `Yahoo Finance returned ${res.status}.`);
    const json: any = await res.json();
    if (json?.chart?.error) return failedAttempt("Yahoo Finance", json.chart.error.description || "Yahoo Finance rejected the ticker.");
    const result = json?.chart?.result?.[0];
    if (!result) return failedAttempt("Yahoo Finance", "Yahoo Finance returned no chart result.");
    const meta = result.meta;
    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    if (!meta?.regularMarketPrice) return failedAttempt("Yahoo Finance", "Yahoo Finance returned no current price.");

    const fullHistory = timestamps
      .map((t, i) => ({ t: t * 1000, c: closes[i] as number }))
      .filter((p) => typeof p.c === "number" && Number.isFinite(p.c));

    const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const history = fullHistory.filter((p) => p.t >= sixMonthsAgo);

    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;

    return {
      provider: "Yahoo Finance",
      detail: "Yahoo Finance returned a valid quote.",
      stock: {
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
      },
    };
  } catch (error) {
    return failedAttempt(
      "Yahoo Finance",
      `Yahoo Finance request failed${error instanceof Error ? `: ${error.message}` : "."}`,
    );
  }
}

async function fetchFromStooq(symbol: string): Promise<ProviderAttempt> {
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
    if (!quoteRes.ok) return failedAttempt("Stooq", `Stooq returned ${quoteRes.status}.`);

    const quoteText = await quoteRes.text();
    if (quoteText.trimStart().startsWith("<!DOCTYPE") || quoteText.includes("requires JavaScript")) {
      return failedAttempt("Stooq", "Stooq required browser verification.");
    }
    const quoteRows = parseCsv(quoteText);
    if (quoteRows.length < 2) return failedAttempt("Stooq", "Stooq returned no quote rows.");
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
      return failedAttempt("Stooq", "Stooq did not return a valid close price.");
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
      detail: "Stooq returned a valid quote.",
      stock: {
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
      },
    };
  } catch (error) {
    return failedAttempt(
      "Stooq",
      `Stooq request failed${error instanceof Error ? `: ${error.message}` : "."}`,
    );
  }
}

async function fetchFromNasdaq(symbol: string): Promise<ProviderAttempt> {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 183 * 24 * 60 * 60 * 1000);
    const fmt = (date: Date) => date.toISOString().slice(0, 10);
    const base = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}`;
    const [infoRes, summaryRes, historyRes] = await Promise.all([
      fetch(`${base}/info?assetclass=stocks`, { headers: NASDAQ_HEADERS }),
      fetch(`${base}/summary?assetclass=stocks`, { headers: NASDAQ_HEADERS }),
      fetch(`${base}/historical?assetclass=stocks&fromdate=${fmt(start)}&todate=${fmt(end)}&limit=9999`, {
        headers: NASDAQ_HEADERS,
      }),
    ]);

    if (!infoRes.ok) return failedAttempt("Nasdaq", `Nasdaq returned ${infoRes.status}.`);

    const [infoJson, summaryJson, historyJson]: any[] = await Promise.all([
      infoRes.json(),
      summaryRes.ok ? summaryRes.json() : Promise.resolve(null),
      historyRes.ok ? historyRes.json() : Promise.resolve(null),
    ]);

    const info = infoJson?.data;
    const primary = info?.primaryData ?? {};
    const summary = summaryJson?.data?.summaryData ?? {};
    const rows = historyJson?.data?.tradesTable?.rows ?? [];

    const history = rows
      .map((row: any) => ({
        t: parseNasdaqDate(row?.date),
        c: parseNumber(row?.close),
      }))
      .filter((point: { t: number | null; c: number | null }): point is { t: number; c: number } =>
        point.t !== null && point.c !== null,
      )
      .sort((a: { t: number }, b: { t: number }) => a.t - b.t);

    const latestRow = rows[0] ?? {};
    const price = firstNumber(parseNumber(primary.lastSalePrice), parseNumber(latestRow.close));
    if (price === null) return failedAttempt("Nasdaq", "Nasdaq returned no current price.");

    const previousClose = firstNumber(
      parseNumber(primary.previousClose),
      parseNumber(summary.PreviousClose?.value),
      history.length > 1 ? history[history.length - 2].c : null,
      price,
    ) ?? price;
    const change = firstNumber(parseNumber(primary.netChange), price - previousClose) ?? 0;
    const changePercent = firstNumber(parseNumber(primary.percentageChange), previousClose ? (change / previousClose) * 100 : 0) ?? 0;
    const weekRange = numbersFrom(summary.FiftTwoWeekHighLow?.value || info?.keyStats?.fiftyTwoWeekHighLow?.value);

    return {
      provider: "Nasdaq",
      detail: "Nasdaq returned a valid quote.",
      stock: {
        provider: "Nasdaq",
        symbol: info?.symbol || symbol,
        name: info?.companyName || symbol,
        exchange: info?.exchange || summary.Exchange?.value || "",
        currency: "USD",
        price,
        previousClose,
        change,
        changePercent,
        open: firstNumber(parseNumber(latestRow.open), price) ?? price,
        dayHigh: firstNumber(parseNumber(latestRow.high), price) ?? price,
        dayLow: firstNumber(parseNumber(latestRow.low), price) ?? price,
        fiftyTwoWeekHigh: firstNumber(weekRange[0], price) ?? price,
        fiftyTwoWeekLow: firstNumber(weekRange[1], price) ?? price,
        volume: firstNumber(parseNumber(primary.volume), parseNumber(summary.ShareVolume?.value), parseNumber(latestRow.volume), 0) ?? 0,
        avgVolume: firstNumber(parseNumber(summary.AverageVolume?.value), 0) ?? 0,
        marketCap: parseNumber(summary.MarketCap?.value),
        history,
      },
    };
  } catch (error) {
    return failedAttempt(
      "Nasdaq",
      `Nasdaq request failed${error instanceof Error ? `: ${error.message}` : "."}`,
    );
  }
}

export const getStock = createServerFn({ method: "GET" })
  .inputValidator((d: { symbol: string }) =>
    z.object({ symbol: tickerSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<StockLookupResult> => {
    // Try Yahoo first (richer metadata), then Stooq as fallback.
    // Run both in parallel and prefer Yahoo if it succeeds — minimizes latency
    // when one provider is throttling.
    const [yahoo, nasdaq, stooq] = await Promise.all([
      fetchFromYahoo(data.symbol),
      fetchFromNasdaq(data.symbol),
      fetchFromStooq(data.symbol),
    ]);

    const attempts = [yahoo, nasdaq, stooq];
    const result = attempts.find((attempt) => attempt.stock)?.stock ?? null;
    return {
      stock: result,
      error: result
        ? null
        : `Couldn't find data for "${data.symbol}". Check the ticker symbol (e.g. AAPL, MSFT, TSLA) or try again in a moment.`,
      details: attempts.map((attempt) => attempt.detail),
    };
  });

