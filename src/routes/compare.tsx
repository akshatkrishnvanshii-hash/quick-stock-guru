import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import {
  getStock,
  tickerSchema,
  type StockData,
  type StockLookupResult,
} from "@/lib/stock.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowDown, ArrowUp, Loader2, Scale } from "lucide-react";

export const Route = createFileRoute("/compare")({
  head: () => ({
    meta: [
      { title: "Stock Comparison — Side-by-side Quotes" },
      {
        name: "description",
        content:
          "Compare two stocks side by side: price, daily change, 52-week range, volume, market cap, and a normalized 6-month chart.",
      },
    ],
  }),
  component: Compare,
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

type Pair = { a: StockData | null; b: StockData | null };

const COLORS = ["#3b82f6", "#f59e0b"] as const;

function StockColumn({
  data,
  color,
}: {
  data: StockData;
  color: string;
}) {
  const isUp = data.change >= 0;
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: color }}
              />
              <span>
                {data.symbol} · {data.exchange || "—"}
              </span>
            </div>
            <h2 className="text-lg font-bold leading-tight text-foreground">
              {data.name}
            </h2>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums text-foreground">
              {formatNumber(data.price, {
                style: "currency",
                currency: data.currency,
              })}
            </div>
            <div
              className={`mt-0.5 inline-flex items-center gap-1 text-xs font-medium tabular-nums ${
                isUp ? "text-emerald-600" : "text-destructive"
              }`}
            >
              {isUp ? (
                <ArrowUp className="h-3 w-3" />
              ) : (
                <ArrowDown className="h-3 w-3" />
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

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Row label="Open" value={formatNumber(data.open, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Row label="Prev Close" value={formatNumber(data.previousClose, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Row label="Day Low" value={formatNumber(data.dayLow, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Row label="Day High" value={formatNumber(data.dayHigh, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Row label="52w Low" value={formatNumber(data.fiftyTwoWeekLow, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Row label="52w High" value={formatNumber(data.fiftyTwoWeekHigh, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Row label="Volume" value={formatCompact(data.volume)} />
          <Row label="Avg Volume" value={formatCompact(data.avgVolume)} />
          <Row label="Market Cap" value={formatCompact(data.marketCap)} />
          <Row label="Currency" value={data.currency} />
        </dl>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums text-foreground">
        {value}
      </dd>
    </>
  );
}

function buildNormalizedSeries(a: StockData, b: StockData) {
  // Normalize both series to % change from first point so different price
  // scales can be compared on a single chart.
  const norm = (history: StockData["history"]) => {
    if (!history.length) return new Map<number, number>();
    const base = history[0].c;
    return new Map(history.map((p) => [p.t, base ? ((p.c - base) / base) * 100 : 0]));
  };
  const ma = norm(a.history);
  const mb = norm(b.history);
  const ts = Array.from(new Set([...ma.keys(), ...mb.keys()])).sort(
    (x, y) => x - y,
  );
  return ts.map((t) => ({
    t,
    [a.symbol]: ma.get(t) ?? null,
    [b.symbol]: mb.get(t) ?? null,
  }));
}

function Compare() {
  const [symA, setSymA] = useState("AAPL");
  const [symB, setSymB] = useState("MSFT");
  const [validationError, setValidationError] = useState<string | null>(null);
  const fetchStock = useServerFn(getStock);

  const { mutate, data: pair, isPending, error, reset } = useMutation<
    Pair,
    Error,
    { a: string; b: string }
  >({
    mutationFn: async ({ a, b }) => {
      const [ra, rb] = await Promise.all([
        fetchStock({ data: { symbol: a } }) as Promise<StockLookupResult>,
        fetchStock({ data: { symbol: b } }) as Promise<StockLookupResult>,
      ]);
      if (!ra.stock) throw new Error(ra.error ?? `Couldn't load ${a}.`);
      if (!rb.stock) throw new Error(rb.error ?? `Couldn't load ${b}.`);
      return { a: ra.stock, b: rb.stock };
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const pa = tickerSchema.safeParse(symA);
    const pb = tickerSchema.safeParse(symB);
    if (!pa.success || !pb.success) {
      setValidationError(
        (pa.success ? "" : `Ticker A: ${pa.error.issues[0]?.message}. `) +
          (pb.success ? "" : `Ticker B: ${pb.error.issues[0]?.message}.`),
      );
      return;
    }
    if (pa.data === pb.data) {
      setValidationError("Pick two different tickers to compare.");
      return;
    }
    reset();
    setSymA(pa.data);
    setSymB(pb.data);
    mutate({ a: pa.data, b: pb.data });
  };

  const a = pair?.a ?? null;
  const b = pair?.b ?? null;
  const series = a && b ? buildNormalizedSeries(a, b) : [];

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              <Scale className="h-7 w-7" />
              Stock Comparison
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Compare two tickers side by side with a normalized 6-month chart.
            </p>
          </div>
          <Link
            to="/"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            ← Single lookup
          </Link>
        </header>

        <form
          onSubmit={onSubmit}
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          noValidate
        >
          <Input
            value={symA}
            onChange={(e) => {
              setSymA(e.target.value.replace(/\s+/g, "").toUpperCase().slice(0, 16));
              if (validationError) setValidationError(null);
            }}
            placeholder="First ticker (e.g. AAPL)"
            className="h-12 text-base"
            maxLength={16}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <Input
            value={symB}
            onChange={(e) => {
              setSymB(e.target.value.replace(/\s+/g, "").toUpperCase().slice(0, 16));
              if (validationError) setValidationError(null);
            }}
            placeholder="Second ticker (e.g. MSFT)"
            className="h-12 text-base"
            maxLength={16}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <Button
            type="submit"
            size="lg"
            disabled={isPending || !symA.trim() || !symB.trim()}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Scale className="h-4 w-4" />
            )}
            <span className="ml-2">Compare</span>
          </Button>
        </form>

        {(validationError || error) && (
          <Card className="mt-6 border-destructive/50">
            <CardContent className="p-4 text-sm text-destructive">
              {validationError || error?.message || "Failed to load data."}
            </CardContent>
          </Card>
        )}

        {a && b && (
          <section className="mt-8 space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <StockColumn data={a} color={COLORS[0]} />
              <StockColumn data={b} color={COLORS[1]} />
            </div>

            <Card>
              <CardContent className="p-4">
                <div className="mb-2 text-xs text-muted-foreground">
                  Normalized 6-month performance (% change from start)
                </div>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={series}>
                      <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                      <XAxis
                        dataKey="t"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        scale="time"
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
                        tick={{ fontSize: 11 }}
                        width={50}
                        tickFormatter={(v) => `${v.toFixed(0)}%`}
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
                        formatter={(v) => {
                          const n = typeof v === "number" ? v : Number(v);
                          return [Number.isFinite(n) ? `${n.toFixed(2)}%` : "—", ""];
                        }}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey={a.symbol}
                        stroke={COLORS[0]}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey={b.symbol}
                        stroke={COLORS[1]}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <p className="text-center text-xs text-muted-foreground">
              {a.symbol} via {a.provider} · {b.symbol} via {b.provider}. May be
              delayed up to 15 minutes.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
