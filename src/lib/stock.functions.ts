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

export const getStock = createServerFn({ method: "GET" })
  .inputValidator((d: { symbol: string }) =>
    z.object({ symbol: tickerSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<StockData> => {
    const stooqSym = toStooqSymbol(data.symbol);

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "text/csv,*/*",
    };

    // Latest quote (one row OHLCV)
    const quoteUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(
      stooqSym,
    )}&f=sd2t2ohlcv&h&e=csv`;
    // Daily history (full series — we'll slice to ~1 year)
    const histUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(
      stooqSym,
    )}&i=d`;

    const [quoteRes, histRes] = await Promise.all([
      fetch(quoteUrl, { headers }),
      fetch(histUrl, { headers }),
    ]);

    if (!quoteRes.ok) throw new Error(`Quote request failed (${quoteRes.status})`);
    if (!histRes.ok) throw new Error(`History request failed (${histRes.status})`);

    const quoteText = await quoteRes.text();
    const histText = await histRes.text();

    const quoteRows = parseCsv(quoteText);
    if (quoteRows.length < 2) throw new Error(`No data for "${data.symbol}"`);
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

    // Stooq returns "N/D" in OHLC fields when the symbol is unknown / unsupported.
    const rawClose = get("close");
    if (!Number.isFinite(close) || rawClose.toUpperCase() === "N/D") {
      throw new Error(
        `"${data.symbol}" isn't a supported ticker. Try a major US symbol (e.g. AAPL, MSFT) or include an exchange suffix (e.g. VOD.UK).`,
      );
    }

    // History parse: Date,Open,High,Low,Close,Volume
    const histRows = parseCsv(histText);
    let history: { t: number; c: number; v: number }[] = [];
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

    // Previous close = last close before today's row, fallback to today's open
    const todayMs = new Date().setUTCHours(0, 0, 0, 0);
    const priorBars = history.filter((p) => p.t < todayMs);
    const previousClose =
      priorBars.length > 0 ? priorBars[priorBars.length - 1].c : open || close;

    // 52-week window from history
    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const yearBars = history.filter((p) => p.t >= oneYearAgo);
    const fiftyTwoWeekHigh = yearBars.length
      ? Math.max(...yearBars.map((p) => p.c))
      : high || close;
    const fiftyTwoWeekLow = yearBars.length
      ? Math.min(...yearBars.map((p) => p.c))
      : low || close;

    // Average volume over last ~3 months
    const threeMonthsAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const recentVols = history
      .filter((p) => p.t >= threeMonthsAgo && p.v > 0)
      .map((p) => p.v);
    const avgVolume = recentVols.length
      ? Math.round(recentVols.reduce((a, b) => a + b, 0) / recentVols.length)
      : 0;

    // Trim history to last ~6 months for the chart
    const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const chartHistory = history
      .filter((p) => p.t >= sixMonthsAgo)
      .map((p) => ({ t: p.t, c: p.c }));

    const change = close - previousClose;
    const changePercent = previousClose ? (change / previousClose) * 100 : 0;

    return {
      symbol: data.symbol,
      name: data.symbol,
      exchange: stooqSym.split(".")[1]?.toUpperCase() || "",
      currency: "USD",
      price: close,
      previousClose,
      change,
      changePercent,
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
  });
