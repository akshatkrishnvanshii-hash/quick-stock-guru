import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { getStock, tickerSchema, type StockData, type StockLookupResult } from "@/lib/stock.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowDown, ArrowUp, Search, Loader2 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Stock Lookup — Real-time Quotes & Financials" },
      {
        name: "description",
        content:
          "Enter a stock ticker to get live price, daily range, 52-week range, volume, market cap, and a 6-month price chart.",
      },
    ],
  }),
  component: Index,
});

function formatNumber(n: number | null, opts?: Intl.NumberFormatOptions) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", opts).format(n);
}

function formatCompact(n: number | null) {
  if (n === null || n === undefined || !n) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-base font-semibold text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

function Index() {
  const [symbol, setSymbol] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const fetchStock = useServerFn(getStock);

  const { mutate, data: lookup, isPending, error, reset } = useMutation<
    StockLookupResult,
    Error,
    string
  >({
    mutationFn: (sym: string) => fetchStock({ data: { symbol: sym } }),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const parsed = tickerSchema.safeParse(symbol);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Invalid ticker");
      return;
    }
    reset();
    setSymbol(parsed.data);
    mutate(parsed.data);
  };

  const data: StockData | null = lookup?.stock ?? null;
  const providerError = lookup?.error
    ? `${lookup.error} ${lookup.details.length ? `Details: ${lookup.details.join(" ")}` : ""}`
    : null;
  const isUp = data ? data.change >= 0 : true;

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-12 sm:py-16">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Stock Lookup
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter a ticker symbol (e.g. AAPL, MSFT, TSLA) for live quotes.
          </p>
          <Link
            to="/compare"
            className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Compare two stocks →
          </Link>
        </header>

        <form onSubmit={onSubmit} className="flex gap-2" noValidate>
          <Input
            value={symbol}
            onChange={(e) => {
              // Strip whitespace, uppercase, cap length as the user types.
              const cleaned = e.target.value.replace(/\s+/g, "").toUpperCase().slice(0, 16);
              setSymbol(cleaned);
              if (validationError) setValidationError(null);
            }}
            placeholder="Search ticker symbol…"
            className="h-12 text-base"
            maxLength={16}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={!!validationError}
            autoFocus
          />
          <Button type="submit" size="lg" disabled={isPending || !symbol.trim()}>
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            <span className="ml-2 hidden sm:inline">Search</span>
          </Button>
        </form>

        {(validationError || providerError || error) && (
          <Card className="mt-6 border-destructive/50">
            <CardContent className="p-4 text-sm text-destructive">
              {validationError || providerError || error?.message || "Failed to load data."}
            </CardContent>
          </Card>
        )}

        {data && (
          <section className="mt-8 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{data.symbol} · {data.exchange}</span>
                  <span className="rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                    {data.provider}
                  </span>
                </div>
                <h2 className="text-2xl font-bold text-foreground">
                  {data.name}
                </h2>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold tabular-nums text-foreground">
                  {formatNumber(data.price, {
                    style: "currency",
                    currency: data.currency,
                  })}
                </div>
                <div
                  className={`mt-1 inline-flex items-center gap-1 text-sm font-medium tabular-nums ${
                    isUp ? "text-emerald-600" : "text-destructive"
                  }`}
                >
                  {isUp ? (
                    <ArrowUp className="h-3.5 w-3.5" />
                  ) : (
                    <ArrowDown className="h-3.5 w-3.5" />
                  )}
                  {formatNumber(data.change, {
                    signDisplay: "always",
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{" "}
                  ({data.changePercent.toFixed(2)}%)
                </div>
              </div>
            </div>

            <Card>
              <CardContent className="p-4">
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.history}>
                      <defs>
                        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                          <stop
                            offset="0%"
                            stopColor={isUp ? "#10b981" : "#ef4444"}
                            stopOpacity={0.35}
                          />
                          <stop
                            offset="100%"
                            stopColor={isUp ? "#10b981" : "#ef4444"}
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="t"
                        tickFormatter={(t) =>
                          new Date(t).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })
                        }
                        tick={{ fontSize: 11 }}
                        minTickGap={40}
                      />
                      <YAxis
                        domain={["auto", "auto"]}
                        tick={{ fontSize: 11 }}
                        width={50}
                        tickFormatter={(v) => v.toFixed(0)}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        labelFormatter={(t) =>
                          new Date(t as number).toLocaleDateString()
                        }
                        formatter={(v: number) => [
                          formatNumber(v, {
                            style: "currency",
                            currency: data.currency,
                          }),
                          "Close",
                        ]}
                      />
                      <Area
                        type="monotone"
                        dataKey="c"
                        stroke={isUp ? "#10b981" : "#ef4444"}
                        strokeWidth={2}
                        fill="url(#g)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Open" value={formatNumber(data.open, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
              <Stat label="Previous Close" value={formatNumber(data.previousClose, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
              <Stat
                label="Day Range"
                value={`${formatNumber(data.dayLow, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} – ${formatNumber(data.dayHigh, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              />
              <Stat
                label="52-Week Range"
                value={`${formatNumber(data.fiftyTwoWeekLow, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} – ${formatNumber(data.fiftyTwoWeekHigh, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              />
              <Stat label="Volume" value={formatCompact(data.volume)} />
              <Stat label="Avg Volume" value={formatCompact(data.avgVolume)} />
              <Stat label="Market Cap" value={formatCompact(data.marketCap)} />
              <Stat label="Currency" value={data.currency} />
              <Stat label="Exchange" value={data.exchange || "—"} />
            </div>

            <p className="text-center text-xs text-muted-foreground">
              Data from {data.provider}. May be delayed up to 15 minutes.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
