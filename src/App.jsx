import { useState, useEffect, useRef } from "react";

// ─── NSE CONSTANTS ────────────────────────────────────────────────────────────
const LOT_SIZE = 75;
const DAYS_TO_EXPIRY = 3;

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────
const calcEMA = (data, p) => {
  if (data.length < p) return data[data.length - 1] || 0;
  const k = 2 / (p + 1);
  let e = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
};
const calcRSI = (closes, p = 14) => {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return 100 - 100 / (1 + g / (l || 0.001));
};
const calcMACD = closes => {
  if (closes.length < 26) return { hist: 0 };
  const m = calcEMA(closes, 12) - calcEMA(closes, 26);
  return { hist: m - m * 0.8 };
};
const calcBB = (closes, p = 20) => {
  if (closes.length < p) return { upper: 0, mid: 0, lower: 0 };
  const s = closes.slice(-p), mid = s.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(s.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
  return { upper: mid + 2 * std, mid, lower: mid - 2 * std };
};
const calcVIX = candles => {
  if (candles.length < 5) return 14;
  const r = candles.slice(-10).map(c => ((c.high - c.low) / c.close) * 100);
  return Math.min(35, Math.max(8, r.reduce((a, b) => a + b, 0) / r.length * 8));
};
const getATM = price => Math.round(price / 50) * 50;
const getNearbyStrikes = (atm, n = 5) => Array.from({ length: n * 2 + 1 }, (_, i) => atm + (i - n) * 50);
const estimatePremium = (spot, strike, dte, vix, isCall) => {
  const mono = isCall ? spot - strike : strike - spot;
  const tv = spot * (vix / 100) * Math.sqrt(dte / 365) * 0.4;
  return Math.max(1, Math.max(0, mono) + tv * (0.5 + Math.random() * 0.3));
};
const makeCandles = (base, n) => {
  let p = base;
  return Array.from({ length: n }, (_, i) => {
    const chg = (Math.random() - 0.488) * 42;
    const o = p, c = p + chg; p = c;
    return { open: o, close: c, high: Math.max(o, c) + Math.random() * 20, low: Math.min(o, c) - Math.random() * 20, vol: Math.floor(60000 + Math.random() * 140000), time: i };
  });
};

// ─── LEGEND STRATEGIES ────────────────────────────────────────────────────────
const LEGENDS = {
  tudor: {
    name: "Paul Tudor Jones", short: "PTJ", title: "MACRO MOMENTUM", color: "#f5a623",
    quote: "Never average a losing position.",
    rules: ["200-EMA filter", "5:1 Risk/Reward", "Cut loss at 2%", "Ride winners"],
    analyze: (candles, ema50) => {
      if (candles.length < 10) return null;
      const last = candles[candles.length - 1], prev5 = candles.slice(-6, -1);
      const mom = last.close - prev5[0].close, above = last.close > ema50;
      if (above && mom > 15) return { signal: "BUY CALL", type: "ENTRY", confidence: Math.min(90, 68 + Math.abs(mom) * 0.3), reason: "Above EMA50 + strong momentum", sl: "2% below entry", target: "5:1 R/R", trend: "BULL" };
      if (!above && mom < -15) return { signal: "BUY PUT", type: "ENTRY", confidence: Math.min(90, 68 + Math.abs(mom) * 0.3), reason: "Below EMA50 + bearish momentum", sl: "2% above entry", target: "5:1 R/R", trend: "BEAR" };
      return { signal: "WAIT", type: "HOLD", confidence: 28, reason: "No momentum confirmation", sl: "-", target: "-", trend: above ? "BULL" : "BEAR" };
    }
  },
  livermore: {
    name: "Jesse Livermore", short: "JL", title: "PIVOTAL BREAKOUT", color: "#e94560",
    quote: "The market does what it's supposed to — just not when.",
    rules: ["Trade at pivot points", "Pyramid winners only", "Never fade the trend", "Wait for confirmation"],
    analyze: (candles) => {
      if (candles.length < 15) return null;
      const rec = candles.slice(-15), pH = Math.max(...rec.slice(0, 10).map(c => c.high)), pL = Math.min(...rec.slice(0, 10).map(c => c.low));
      const last = candles[candles.length - 1];
      if (last.close > pH) return { signal: "BUY CALL", type: "ENTRY", confidence: Math.min(92, 72 + ((last.close - pH) / pH) * 500), reason: `Breakout above pivot ₹${Math.round(pH)}`, sl: `₹${Math.round(pH)}`, target: "Next resistance", trend: "BULL" };
      if (last.close < pL) return { signal: "BUY PUT", type: "ENTRY", confidence: Math.min(92, 72 + ((pL - last.close) / pL) * 500), reason: `Break below pivot ₹${Math.round(pL)}`, sl: `₹${Math.round(pL)}`, target: "Next support", trend: "BEAR" };
      return { signal: "WATCHING", type: "HOLD", confidence: 42, reason: `Coiling ₹${Math.round(pL)}–₹${Math.round(pH)}`, sl: "-", target: "-", trend: "NEUTRAL" };
    }
  },
  williams: {
    name: "Larry Williams", short: "LW", title: "VOLATILITY %R", color: "#00d4aa",
    quote: "Most traders lose because they overtrade.",
    rules: ["%R oscillator signal", "Volatility breakout", "Selective entries only", "Weekly cycle aware"],
    analyze: (candles) => {
      if (candles.length < 14) return null;
      const p = candles.slice(-14), hH = Math.max(...p.map(c => c.high)), lL = Math.min(...p.map(c => c.low));
      const last = candles[candles.length - 1], wR = ((hH - last.close) / (hH - lL)) * -100;
      if (wR < -80) return { signal: "BUY CALL", type: "ENTRY", confidence: Math.min(88, 65 + Math.abs(wR + 80) * 1.5), reason: `%R ${wR.toFixed(0)} oversold — reversal`, sl: `₹${Math.round(lL)}`, target: `₹${Math.round(hH)}`, trend: "REVERSAL ↑", wR };
      if (wR > -20) return { signal: "BUY PUT", type: "ENTRY", confidence: Math.min(88, 65 + Math.abs(wR + 20) * 1.5), reason: `%R ${wR.toFixed(0)} overbought — reversal`, sl: `₹${Math.round(hH)}`, target: `₹${Math.round(lL)}`, trend: "REVERSAL ↓", wR };
      return { signal: "NEUTRAL", type: "HOLD", confidence: 32, reason: `%R ${wR.toFixed(0)} — no extreme`, sl: "-", target: "-", trend: "NEUTRAL", wR };
    }
  },
  buffett: {
    name: "Warren Buffett", short: "WB", title: "SELL PREMIUM", color: "#7c5cbf",
    quote: "Risk comes from not knowing what you are doing.",
    rules: ["Sell IV spikes", "Collect theta decay", "Iron Condor sideways", "Only quality index"],
    analyze: (candles) => {
      if (candles.length < 20) return null;
      const rec = candles.slice(-20), avg = rec.reduce((s, c) => s + (c.high - c.low), 0) / 20;
      const last = candles[candles.length - 1], lr = last.high - last.low, atm = getATM(last.close);
      if (lr > avg * 1.3) return { signal: "SELL STRADDLE", type: "ENTRY", confidence: 82, reason: `IV spike — range ${lr.toFixed(0)} vs avg ${avg.toFixed(0)}`, sl: "20% position loss", target: "Full theta decay", trend: "SIDEWAYS", strike: `ATM ${atm}` };
      if (lr < avg * 0.7) return { signal: "IRON CONDOR", type: "ENTRY", confidence: 76, reason: "Low vol — sell OTM CE+PE strangle", sl: "Sold strike breach", target: "Full premium", trend: "SIDEWAYS", strike: `±100 from ${atm}` };
      return { signal: "WAIT FOR IV", type: "HOLD", confidence: 48, reason: "IV normal — await spike to sell", sl: "-", target: "-", trend: "SIDEWAYS" };
    }
  }
};

// ─── SIGNAL ENGINE (Technical) ────────────────────────────────────────────────
const generateTechSignal = (candles, vix) => {
  if (candles.length < 26) return null;
  const closes = candles.map(c => c.close), last = candles[candles.length - 1];
  const rsi = calcRSI(closes), macd = calcMACD(closes), bb = calcBB(closes);
  const e9 = calcEMA(closes, 9), e21 = calcEMA(closes, 21), e50 = calcEMA(closes, 50);
  let bull = 0, bear = 0, reasons = [];
  if (e9 > e21) { bull += 2; reasons.push("EMA9>EMA21 ↑"); } else { bear += 2; reasons.push("EMA9<EMA21 ↓"); }
  if (last.close > e50) { bull += 2; reasons.push("Above EMA50 ↑"); } else { bear += 2; reasons.push("Below EMA50 ↓"); }
  if (rsi < 35) { bull += 3; reasons.push(`RSI ${rsi.toFixed(0)} oversold`); } else if (rsi > 65) { bear += 3; reasons.push(`RSI ${rsi.toFixed(0)} overbought`); }
  if (macd.hist > 0) { bull += 2; reasons.push("MACD bullish"); } else { bear += 2; reasons.push("MACD bearish"); }
  if (last.close < bb.lower) { bull += 2; reasons.push("Below BB band"); } else if (last.close > bb.upper) { bear += 2; reasons.push("Above BB band"); }
  const atm = getATM(last.close), total = bull + bear || 1;
  if (bull > bear + 2) return { direction: "BULLISH", signal: "BUY CALL", optionType: "CE", strike: atm, confidence: Math.round(55 + (bull / total) * 35), rsi, bb, e9, e21, e50, reasons: reasons.slice(0, 3), vix };
  if (bear > bull + 2) return { direction: "BEARISH", signal: "BUY PUT", optionType: "PE", strike: atm, confidence: Math.round(55 + (bear / total) * 35), rsi, bb, e9, e21, e50, reasons: reasons.slice(0, 3), vix };
  if (vix > 18) return { direction: "SIDEWAYS", signal: "SELL STRADDLE", optionType: "BOTH", strike: atm, confidence: Math.round(58 + vix * 0.8), rsi, bb, e9, e21, e50, reasons: [`VIX ${vix.toFixed(1)} rich`, "No clear trend", "Sell premium"], vix };
  return { direction: "NEUTRAL", signal: "WAIT", optionType: "NONE", strike: atm, confidence: 22, rsi, bb, e9, e21, e50, reasons: ["Mixed signals", "Await setup"], vix };
};

// ─── MINI CHART ───────────────────────────────────────────────────────────────
function MiniChart({ candles, color = "#00e09a", h = 80, w = 300 }) {
  const last = candles.slice(-35);
  if (last.length < 2) return null;
  const allH = last.map(c => c.high), allL = last.map(c => c.low);
  const mx = Math.max(...allH), mn = Math.min(...allL), rng = mx - mn || 1;
  const cW = w / last.length;
  const toY = v => h - 6 - ((v - mn) / rng) * (h - 12);
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      {last.map((c, i) => {
        const x = i * cW + cW * 0.1, bw = cW * 0.8, isG = c.close >= c.open;
        const col = isG ? "#00e09a" : "#ff4560";
        const bTop = toY(Math.max(c.open, c.close)), bH = Math.max(1, Math.abs(toY(c.open) - toY(c.close)));
        return (
          <g key={i}>
            <line x1={x + bw / 2} y1={toY(c.high)} x2={x + bw / 2} y2={toY(c.low)} stroke={col} strokeWidth="0.8" opacity="0.6" />
            <rect x={x} y={bTop} width={bw} height={bH} fill={col} opacity="0.85" rx="0.5" />
          </g>
        );
      })}
    </svg>
  );
}

// ─── INDICATOR BAR ────────────────────────────────────────────────────────────
function IndBar({ label, val, mn, mx, color, fmt = v => v.toFixed(1) }) {
  const pct = Math.max(0, Math.min(100, ((val - mn) / (mx - mn)) * 100));
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 3, color: "#4a6080" }}>
        <span>{label}</span><span style={{ color, fontWeight: 700 }}>{fmt(val)}</span>
      </div>
      <div style={{ height: 3, background: "#0f1825", borderRadius: 2 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width .4s" }} />
      </div>
    </div>
  );
}

// ─── OPTION CHAIN ─────────────────────────────────────────────────────────────
function OptionChain({ spot, vix, onSelect }) {
  const atm = getATM(spot), strikes = getNearbyStrikes(atm, 5);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "monospace" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #1e2d45" }}>
            {["CE OI", "CE Vol", "CE LTP", "STRIKE", "PE LTP", "PE Vol", "PE OI"].map(h => (
              <th key={h} style={{ padding: "6px 8px", color: "#4a6080", fontWeight: 600, textAlign: h === "STRIKE" ? "center" : h.startsWith("CE") ? "right" : "left", fontSize: 10 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {strikes.map(s => {
            const isATM = s === atm;
            const ceLTP = estimatePremium(spot, s, DAYS_TO_EXPIRY, vix, true);
            const peLTP = estimatePremium(spot, s, DAYS_TO_EXPIRY, vix, false);
            const ceOI = Math.floor(50000 + Math.random() * 200000);
            const peOI = Math.floor(50000 + Math.random() * 200000);
            return (
              <tr key={s} style={{ background: isATM ? "#00e09a08" : "transparent", borderBottom: "1px solid #0f1825" }}>
                <td style={{ padding: "5px 8px", color: "#4a90d9", textAlign: "right" }}>{(ceOI / 1000).toFixed(0)}K</td>
                <td style={{ padding: "5px 8px", color: "#4a7090", textAlign: "right" }}>{(ceOI * 0.08 / 1000).toFixed(1)}K</td>
                <td onClick={() => onSelect({ strike: s, type: "CE", premium: ceLTP })}
                  style={{ padding: "5px 8px", color: "#00e09a", textAlign: "right", cursor: "pointer", fontWeight: isATM ? 700 : 400 }}>
                  {ceLTP.toFixed(1)} ▶
                </td>
                <td style={{ padding: "6px 10px", textAlign: "center", fontWeight: 700, color: isATM ? "#00e09a" : "#94a3b8", background: isATM ? "#00e09a15" : "transparent", borderLeft: "1px solid #1e2d45", borderRight: "1px solid #1e2d45" }}>
                  {s}{isATM && <span style={{ fontSize: 8, color: "#00e09a", marginLeft: 3 }}>ATM</span>}
                </td>
                <td onClick={() => onSelect({ strike: s, type: "PE", premium: peLTP })}
                  style={{ padding: "5px 8px", color: "#ff4560", textAlign: "left", cursor: "pointer", fontWeight: isATM ? 700 : 400 }}>
                  ◀ {peLTP.toFixed(1)}
                </td>
                <td style={{ padding: "5px 8px", color: "#4a7090", textAlign: "left" }}>{(peOI * 0.08 / 1000).toFixed(1)}K</td>
                <td style={{ padding: "5px 8px", color: "#d9604a", textAlign: "left" }}>{(peOI / 1000).toFixed(0)}K</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function MegaNiftyBot() {
  const BASE = 24350;
  const [candles, setCandles] = useState(() => makeCandles(BASE, 60));
  const [running, setRunning] = useState(false);
  const [mainTab, setMainTab] = useState("signal");   // signal | legends | chain | positions | log
  const [activeLegend, setActiveLegend] = useState("tudor");
  const [techSignal, setTechSignal] = useState(null);
  const [legendSignals, setLegendSignals] = useState({});
  const [vix, setVix] = useState(14.5);
  const [positions, setPositions] = useState([]);
  const [log, setLog] = useState([]);
  const [realizedPnl, setRealizedPnl] = useState(0);
  const [lots, setLots] = useState(1);
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const intervalRef = useRef(null);

  const price = Math.round(candles[candles.length - 1]?.close || BASE);
  const prevPrice = Math.round(candles[candles.length - 2]?.close || BASE);
  const delta = price - prevPrice;
  const isUp = delta >= 0;
  const closes = candles.map(c => c.close);
  const atm = getATM(price);
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const legend = LEGENDS[activeLegend];
  const curLegSig = legendSignals[activeLegend];
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);

  // ── Tick engine
  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setCandles(prev => {
        const last = prev[prev.length - 1];
        const chg = (Math.random() - 0.487) * 40;
        const close = last.close + chg;
        return [...prev.slice(-99), { open: last.close, close, high: Math.max(last.close, close) + Math.random() * 16, low: Math.min(last.close, close) - Math.random() * 16, vol: Math.floor(60000 + Math.random() * 130000), time: last.time + 1 }];
      });
    }, 1100);
    return () => clearInterval(intervalRef.current);
  }, [running]);

  // ── Recompute on candle change
  useEffect(() => {
    const newVix = calcVIX(candles);
    setVix(newVix);
    setTechSignal(generateTechSignal(candles, newVix));
    const e50 = calcEMA(closes, 50);
    const sigs = {};
    Object.values(LEGENDS).forEach(l => { sigs[l.name.split(" ").pop()] = l.analyze(candles, e50); });
    // map by id
    const mapped = {};
    Object.keys(LEGENDS).forEach(k => { mapped[k] = LEGENDS[k].analyze(candles, e50); });
    setLegendSignals(mapped);
    // Update positions
    setPositions(prev => prev.map(p => {
      const cur = estimatePremium(price, p.strike, Math.max(0.1, DAYS_TO_EXPIRY - p.daysHeld), newVix, p.type === "CE");
      const pts = (cur - p.entryPremium) * LOT_SIZE * p.lots * (p.dir === "SELL" ? -1 : 1);
      return { ...p, currentPremium: cur, unrealizedPnl: Math.round(pts) };
    }));
  }, [candles]);

  function addLog(msg, type = "info") {
    const t = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    setLog(p => [{ t, msg, type }, ...p.slice(0, 49)]);
  }

  function enterTrade(sig, dir = "BUY", source = "TECH") {
    if (!sig || sig.signal === "WAIT" || sig.signal === "WAIT FOR IV" || sig.signal === "WATCHING" || sig.signal === "NEUTRAL") return;
    const optType = sig.optionType === "BOTH" || !sig.optionType ? "CE" : sig.optionType;
    const strike = sig.strike || atm;
    const prem = estimatePremium(price, strike, DAYS_TO_EXPIRY, vix, optType === "CE");
    const pos = { id: Date.now(), strike, type: optType, dir, lots, entryPremium: prem, currentPremium: prem, entryPrice: price, unrealizedPnl: 0, daysHeld: 0, sl: prem * 0.5, target: prem * 2, label: sig.signal, source, color: sig.direction === "BULLISH" || sig.trend === "BULL" ? "#00e09a" : sig.direction === "BEARISH" || sig.trend === "BEAR" ? "#ff4560" : "#f5a623" };
    setPositions(p => [pos, ...p]);
    addLog(`${dir} ${lots}L · ${strike}${optType} @ ₹${prem.toFixed(1)} · ${source}`, "entry");
    setMainTab("positions");
  }

  function exitPos(pos) {
    setRealizedPnl(p => p + pos.unrealizedPnl);
    setPositions(p => p.filter(x => x.id !== pos.id));
    addLog(`EXIT ${pos.strike}${pos.type} @ ₹${pos.currentPremium.toFixed(1)} | P&L: ${pos.unrealizedPnl >= 0 ? "+" : ""}₹${pos.unrealizedPnl.toLocaleString()}`, pos.unrealizedPnl >= 0 ? "profit" : "loss");
  }

  function enterFromChain() {
    if (!selected) return;
    const pos = { id: Date.now(), strike: selected.strike, type: selected.type, dir: "BUY", lots, entryPremium: selected.premium, currentPremium: selected.premium, entryPrice: price, unrealizedPnl: 0, daysHeld: 0, sl: selected.premium * 0.5, target: selected.premium * 2, label: `BUY ${selected.type}`, source: "CHAIN", color: selected.type === "CE" ? "#00e09a" : "#ff4560" };
    setPositions(p => [pos, ...p]);
    addLog(`CHAIN BUY ${lots}L · ${selected.strike}${selected.type} @ ₹${selected.premium.toFixed(1)}`, "entry");
    setSelected(null);
    setMainTab("positions");
  }

  async function getAI(mode = "tech") {
    setAiLoading(true); setAiText("");
    const isTech = mode === "tech";
    const sig = isTech ? techSignal : curLegSig;
    const prompt = `You are an expert NSE Nifty 50 options trader in India. Give PRACTICAL, SPECIFIC advice in 4-5 sentences.

Market Data:
- Nifty 50: ₹${price} (${isUp ? "+" : ""}${delta} pts) | ATM: ${atm}
- India VIX: ${vix.toFixed(1)} | RSI: ${rsi.toFixed(1)} | MACD: ${macd.hist.toFixed(2)}
- Days to Expiry: ${DAYS_TO_EXPIRY} (Weekly Thursday) | Lot Size: ${LOT_SIZE}
- Capital: ${lots} lot(s) ≈ ₹${Math.round(estimatePremium(price, atm, DAYS_TO_EXPIRY, vix, true) * LOT_SIZE * lots).toLocaleString()}
${isTech ? `- Tech Signal: ${sig?.signal} (${sig?.direction}) | Confidence: ${sig?.confidence}%` : `- Legend: ${legend.name} — ${legend.title}\n- Legend Signal: ${sig?.signal} | Reason: ${sig?.reason}\n- Legend Rules: ${legend.rules.join(", ")}`}

Answer:
1. Exact trade RIGHT NOW (strike, CE or PE)?
2. Entry price range?
3. Stop-loss in premium points?
4. Target profit?
5. Key risk today?
Be direct. Indian market context only.`;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }) });
      const data = await res.json();
      setAiText(data.content?.map(b => b.text || "").join("") || "Could not fetch analysis.");
    } catch { setAiText("⚠️ Connection failed. Retry."); }
    setAiLoading(false);
  }

  const techColor = techSignal?.direction === "BULLISH" ? "#00e09a" : techSignal?.direction === "BEARISH" ? "#ff4560" : techSignal?.direction === "SIDEWAYS" ? "#f5a623" : "#4a6080";
  const legColor = curLegSig?.type === "ENTRY" ? legend.color : "#4a6080";
  const netPnl = realizedPnl + unrealizedPnl;

  const TABS = [
    ["signal", "📊 SIGNALS"],
    ["legends", `🏆 LEGENDS`],
    ["chain", "⛓ CHAIN"],
    ["positions", `📁 POSITIONS${positions.length ? ` (${positions.length})` : ""}`],
    ["log", "📋 LOG"],
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#060a10", color: "#d4e4f4", fontFamily: "'Fira Code','Courier New',monospace", fontSize: 13 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600;700&family=Teko:wght@400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        .card{background:#0a1018;border:1px solid #162030;border-radius:10px}
        .btn{border:none;cursor:pointer;font-family:'Fira Code',monospace;border-radius:6px;transition:all .15s;font-weight:600}
        .btn:hover{filter:brightness(1.2);transform:translateY(-1px)}
        .btn:disabled{opacity:.35;cursor:not-allowed;transform:none!important;filter:none!important}
        .tab{background:transparent;border:none;border-bottom:2px solid transparent;color:#3a5570;padding:9px 14px;cursor:pointer;font-family:'Fira Code',monospace;font-size:10px;letter-spacing:1px;transition:all .2s;white-space:nowrap}
        .tab.active{color:#00e09a;border-bottom-color:#00e09a}
        .tab:hover:not(.active){color:#6a90b0}
        .leg-btn{background:#0a1018;border:1px solid #162030;color:#3a5570;padding:9px 12px;cursor:pointer;font-family:'Fira Code',monospace;font-size:10px;border-radius:8px;transition:all .2s;text-align:left;width:100%}
        .leg-btn.active{border-color:var(--lc);color:var(--lc);background:var(--la)}
        .leg-btn:hover:not(.active){border-color:#2a3a5c;color:#7a90b0}
        .blink{animation:blink 1.2s step-end infinite}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        .fade{animation:fade .35s ease}
        @keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-thumb{background:#162030;border-radius:2px}
        input[type=number]{background:#0a1018;border:1px solid #162030;color:#d4e4f4;padding:5px 8px;border-radius:6px;font-family:'Fira Code',monospace;width:64px;font-size:12px}
        input[type=number]:focus{outline:none;border-color:#00e09a}
        .tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.5px}
      `}</style>

      {/* ══ HEADER ══ */}
      <div style={{ background: "#07090f", borderBottom: "1px solid #162030", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div>
            <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 22, letterSpacing: 3, background: "linear-gradient(90deg,#00e09a,#4a90d9)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", lineHeight: 1 }}>
              NIFTY 50 MEGA BOT
            </div>
            <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2 }}>NSE OPTIONS · GLOBAL LEGENDS · WEEKLY EXPIRY · LOT {LOT_SIZE}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: running ? "#00e09a" : "#3a5570" }} className={running ? "blink" : ""} />
            <span style={{ fontSize: 9, color: running ? "#00e09a" : "#3a5570" }}>{running ? "LIVE SIM" : "PAUSED"}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          {/* Price */}
          <div>
            <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 28, color: isUp ? "#00e09a" : "#ff4560", lineHeight: 1 }}>{price.toLocaleString("en-IN")}</div>
            <div style={{ fontSize: 9, color: isUp ? "#00e09a70" : "#ff456070" }}>{isUp ? "▲" : "▼"} {Math.abs(delta)} · ATM {atm}</div>
          </div>
          {/* Stats */}
          {[["VIX", vix.toFixed(1), vix > 20 ? "#f5a623" : "#00e09a"], ["RSI", rsi.toFixed(0), rsi > 65 ? "#ff4560" : rsi < 35 ? "#00e09a" : "#f5a623"], ["NET P&L", `${netPnl >= 0 ? "+" : ""}₹${netPnl.toLocaleString()}`, netPnl >= 0 ? "#00e09a" : "#ff4560"]].map(([l, v, c]) => (
            <div key={l} style={{ borderLeft: "1px solid #162030", paddingLeft: 12, textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 1 }}>{l}</div>
              <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 18, color: c, lineHeight: 1.1 }}>{v}</div>
            </div>
          ))}
          {/* Lots */}
          <div style={{ borderLeft: "1px solid #162030", paddingLeft: 12 }}>
            <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 1, marginBottom: 3 }}>LOTS</div>
            <input type="number" min="1" max="50" value={lots} onChange={e => setLots(Math.max(1, +e.target.value || 1))} />
          </div>
          <button className="btn" onClick={() => { setRunning(r => !r); addLog(running ? "Bot paused" : "Bot started — simulation active", "system"); }}
            style={{ background: running ? "#0a2518" : "#0a1830", border: `1px solid ${running ? "#00e09a50" : "#4a90d960"}`, color: running ? "#00e09a" : "#4a90d9", padding: "8px 16px", fontSize: 11 }}>
            {running ? "⏸ PAUSE" : "▶ START"}
          </button>
        </div>
      </div>

      {/* ══ TABS ══ */}
      <div style={{ background: "#07090f", borderBottom: "1px solid #162030", display: "flex", paddingLeft: 8, overflowX: "auto" }}>
        {TABS.map(([k, label]) => <button key={k} className={`tab ${mainTab === k ? "active" : ""}`} onClick={() => setMainTab(k)}>{label}</button>)}
      </div>

      <div style={{ padding: "14px 16px", maxWidth: 1140, margin: "0 auto" }}>

        {/* ══ SIGNALS TAB ══ */}
        {mainTab === "signal" && (
          <div className="fade" style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

              {/* Tech Signal */}
              <div className="card" style={{ padding: "16px 18px", borderColor: techColor + "40" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 5 }}>📊 TECHNICAL SIGNAL ENGINE</div>
                    <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 32, color: techColor, letterSpacing: 2, lineHeight: 1 }}>{techSignal?.signal || "LOADING..."}</div>
                    <div style={{ fontSize: 10, color: "#4a7090", marginTop: 3 }}>{techSignal?.direction} · Strike {techSignal?.strike} · {DAYS_TO_EXPIRY}DTE</div>
                  </div>
                  <MiniChart candles={candles} color={techColor} h={75} w={260} />
                </div>
                {techSignal?.reasons && (
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
                    {techSignal.reasons.map((r, i) => <span key={i} className="tag" style={{ background: techColor + "15", border: `1px solid ${techColor}30`, color: techColor }}>{r}</span>)}
                  </div>
                )}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#4a6080", marginBottom: 4 }}>
                    <span>CONFIDENCE</span><span style={{ color: techColor }}>{techSignal?.confidence || 0}%</span>
                  </div>
                  <div style={{ height: 4, background: "#0f1825", borderRadius: 2 }}>
                    <div style={{ height: "100%", width: `${techSignal?.confidence || 0}%`, background: techColor, borderRadius: 2, transition: "width .5s" }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  <button className="btn" onClick={() => enterTrade(techSignal, "BUY")} disabled={!techSignal || techSignal.signal === "WAIT"}
                    style={{ background: "#0a2518", border: "1px solid #00e09a60", color: "#00e09a", padding: "9px 20px", fontSize: 11 }}>✅ BUY {techSignal?.optionType !== "NONE" ? techSignal?.optionType : ""}</button>
                  <button className="btn" onClick={() => enterTrade(techSignal, "SELL")} disabled={!techSignal || techSignal.signal === "WAIT"}
                    style={{ background: "#180a10", border: "1px solid #ff456060", color: "#ff4560", padding: "9px 20px", fontSize: 11 }}>🔴 SELL</button>
                  <button className="btn" onClick={() => getAI("tech")} disabled={aiLoading}
                    style={{ background: "#0a1428", border: "1px solid #4a90d960", color: "#4a90d9", padding: "9px 16px", fontSize: 11 }}>🤖 {aiLoading ? "Thinking..." : "AI ADVICE"}</button>
                  <button className="btn" onClick={() => setMainTab("chain")}
                    style={{ background: "#0a1020", border: "1px solid #2a4060", color: "#4a6080", padding: "9px 14px", fontSize: 11 }}>⛓ CHAIN</button>
                </div>
              </div>

              {/* Legend Quick Signals */}
              <div>
                <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 8 }}>🏆 LEGEND SIGNALS AT A GLANCE</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                  {Object.entries(LEGENDS).map(([k, l]) => {
                    const s = legendSignals[k];
                    return (
                      <button key={k} onClick={() => { setActiveLegend(k); setMainTab("legends"); setAiText(""); }}
                        className="card btn" style={{ padding: "10px 12px", textAlign: "left", borderColor: s?.type === "ENTRY" ? l.color + "60" : "#162030", cursor: "pointer" }}>
                        <div style={{ fontSize: 9, color: l.color, fontWeight: 700, marginBottom: 3 }}>{l.short}</div>
                        <div style={{ fontSize: 10, color: s?.type === "ENTRY" ? l.color : "#4a6080", fontWeight: 700 }}>{s?.signal || "—"}</div>
                        <div style={{ fontSize: 9, color: "#2a4060", marginTop: 2 }}>{s?.confidence || 0}%</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* AI output */}
              {(aiText || aiLoading) && (
                <div className="card" style={{ padding: "14px 16px" }}>
                  <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 10 }}>🤖 AI TRADE ADVISOR</div>
                  {aiLoading && <div style={{ fontSize: 11, color: "#2a4060" }} className="blink">Analyzing Nifty 50 conditions...</div>}
                  {aiText && !aiLoading && <div className="fade" style={{ fontSize: 11, color: "#8aaccc", lineHeight: 1.9, borderLeft: "2px solid #4a90d9", paddingLeft: 12 }}>{aiText}</div>}
                </div>
              )}

              {/* Quick stats */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
                {[
                  { l: "ATM CE", v: `₹${estimatePremium(price, atm, DAYS_TO_EXPIRY, vix, true).toFixed(0)}`, s: `${atm} CE · ${DAYS_TO_EXPIRY}DTE` },
                  { l: "ATM PE", v: `₹${estimatePremium(price, atm, DAYS_TO_EXPIRY, vix, false).toFixed(0)}`, s: `${atm} PE · ${DAYS_TO_EXPIRY}DTE` },
                  { l: "COST / LOT", v: `₹${Math.round(estimatePremium(price, atm, DAYS_TO_EXPIRY, vix, true) * LOT_SIZE * lots).toLocaleString()}`, s: `${lots}L × ${LOT_SIZE} qty` },
                ].map(s => (
                  <div key={s.l} className="card" style={{ padding: "11px 13px" }}>
                    <div style={{ fontSize: 9, color: "#4a6080", letterSpacing: 1, marginBottom: 4 }}>{s.l}</div>
                    <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 18, color: "#d4e4f4" }}>{s.v}</div>
                    <div style={{ fontSize: 9, color: "#2a4060", marginTop: 2 }}>{s.s}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: Indicators */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="card" style={{ padding: "14px" }}>
                <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 12 }}>INDICATORS</div>
                <IndBar label="RSI (14)" val={rsi} mn={0} mx={100} color={rsi > 65 ? "#ff4560" : rsi < 35 ? "#00e09a" : "#f5a623"} />
                <IndBar label="INDIA VIX" val={vix} mn={8} mx={35} color={vix > 20 ? "#f5a623" : "#00e09a"} />
                <IndBar label="EMA 9" val={calcEMA(closes, 9)} mn={price - 180} mx={price + 180} color="#4a90d9" fmt={v => v.toFixed(0)} />
                <IndBar label="EMA 21" val={calcEMA(closes, 21)} mn={price - 180} mx={price + 180} color="#9a6ad9" fmt={v => v.toFixed(0)} />
                <IndBar label="EMA 50" val={calcEMA(closes, 50)} mn={price - 300} mx={price + 300} color="#d96a4a" fmt={v => v.toFixed(0)} />
                <IndBar label="MACD Hist" val={macd.hist} mn={-60} mx={60} color={macd.hist > 0 ? "#00e09a" : "#ff4560"} />
              </div>
              <div className="card" style={{ padding: "13px" }}>
                <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 10 }}>BOLLINGER BANDS</div>
                {techSignal?.bb && [["Upper", techSignal.bb.upper, "#ff4560"], ["Mid", techSignal.bb.mid, "#4a6080"], ["Lower", techSignal.bb.lower, "#00e09a"]].map(([l, v, c]) => (
                  <div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 5 }}>
                    <span style={{ color: "#4a6080" }}>{l}</span><span style={{ color: c, fontWeight: 700 }}>₹{v.toFixed(0)}</span>
                  </div>
                ))}
                <div style={{ marginTop: 10, borderTop: "1px solid #162030", paddingTop: 10 }}>
                  {[["Trend", price > calcEMA(closes, 50) ? "BULL ↑" : "BEAR ↓", price > calcEMA(closes, 50) ? "#00e09a" : "#ff4560"], ["VIX State", vix > 20 ? "HIGH (Sell)" : vix < 13 ? "LOW (Buy)" : "NORMAL", vix > 20 ? "#f5a623" : "#00e09a"], ["Expiry", `${DAYS_TO_EXPIRY} days`, "#4a90d9"], ["Positions", positions.length, positions.length ? "#f5a623" : "#4a6080"]].map(([l, v, c]) => (
                    <div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 6 }}>
                      <span style={{ color: "#4a6080" }}>{l}</span><span style={{ color: c, fontWeight: 600 }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ══ LEGENDS TAB ══ */}
        {mainTab === "legends" && (
          <div className="fade" style={{ display: "grid", gridTemplateColumns: "190px 1fr", gap: 14 }}>
            {/* Legend list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 4 }}>SELECT LEGEND</div>
              {Object.entries(LEGENDS).map(([k, l]) => {
                const s = legendSignals[k];
                return (
                  <button key={k} className={`leg-btn ${activeLegend === k ? "active" : ""}`}
                    style={{ "--lc": l.color, "--la": l.color + "15" }}
                    onClick={() => { setActiveLegend(k); setAiText(""); }}>
                    <div style={{ fontWeight: 700, fontSize: 11, marginBottom: 2 }}>{l.name}</div>
                    <div style={{ fontSize: 9, opacity: .7, letterSpacing: .5 }}>{l.title}</div>
                    {s && <div style={{ marginTop: 4, fontSize: 9, color: s.type === "ENTRY" ? l.color : "#4a6080" }}>● {s.signal}</div>}
                  </button>
                );
              })}
              <div style={{ marginTop: 8, borderTop: "1px solid #162030", paddingTop: 10 }}>
                <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 1, marginBottom: 8 }}>RULES</div>
                {legend.rules.map((r, i) => (
                  <div key={i} style={{ fontSize: 10, color: "#4a6080", marginBottom: 5, display: "flex", gap: 6 }}>
                    <span style={{ color: legend.color }}>›</span>{r}
                  </div>
                ))}
              </div>
            </div>

            {/* Legend detail */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Header */}
              <div className="card" style={{ padding: "16px 18px", borderColor: legend.color + "40", background: `linear-gradient(135deg,#0a1018,${legend.color}10)` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 24, color: legend.color, letterSpacing: 2 }}>{legend.name}</div>
                    <div style={{ fontSize: 9, color: "#4a6080", letterSpacing: 2, marginBottom: 6 }}>{legend.title} STRATEGY</div>
                    <div style={{ fontSize: 11, color: "#6a8aaa", fontStyle: "italic" }}>"{legend.quote}"</div>
                  </div>
                  <MiniChart candles={candles} color={legend.color} h={65} w={240} />
                </div>
              </div>

              {/* Signal */}
              <div className="card" style={{ padding: "16px 18px", borderColor: curLegSig?.type === "ENTRY" ? legend.color + "60" : "#162030" }}>
                <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 10 }}>LEGEND SIGNAL</div>
                <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 28, color: legColor, letterSpacing: 1, lineHeight: 1, marginBottom: 6 }}>{curLegSig?.signal || "LOADING..."}</div>
                <div style={{ fontSize: 11, color: "#7a9ab8", marginBottom: 12 }}>{curLegSig?.reason}</div>
                {curLegSig?.sl && curLegSig.sl !== "-" && (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                    {[["SL", curLegSig.sl, "#ff4560"], ["TARGET", curLegSig.target, "#00e09a"], curLegSig.strike && ["STRIKE", curLegSig.strike, legend.color]].filter(Boolean).map(([l, v, c]) => (
                      <div key={l} style={{ background: c + "12", border: `1px solid ${c}30`, borderRadius: 6, padding: "7px 12px" }}>
                        <div style={{ fontSize: 9, color: c, letterSpacing: 1 }}>{l}</div>
                        <div style={{ fontSize: 12, color: c, fontWeight: 700, marginTop: 2 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Confidence */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#4a6080", marginBottom: 4 }}>
                    <span>CONFIDENCE</span><span style={{ color: legColor }}>{curLegSig?.confidence || 0}%</span>
                  </div>
                  <div style={{ height: 4, background: "#0f1825", borderRadius: 2 }}>
                    <div style={{ height: "100%", width: `${curLegSig?.confidence || 0}%`, background: legend.color, borderRadius: 2, transition: "width .5s" }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  <button className="btn" onClick={() => enterTrade(curLegSig, "BUY", legend.short)} disabled={curLegSig?.type !== "ENTRY"}
                    style={{ background: "#0a2518", border: "1px solid #00e09a60", color: "#00e09a", padding: "9px 20px", fontSize: 11 }}>✅ ENTER TRADE</button>
                  <button className="btn" onClick={() => getAI("legend")} disabled={aiLoading}
                    style={{ background: "#0a1428", border: `1px solid ${legend.color}50`, color: legend.color, padding: "9px 16px", fontSize: 11 }}>
                    🤖 {aiLoading ? "Thinking..." : `ASK ${legend.name.split(" ").pop().toUpperCase()} AI`}
                  </button>
                </div>
              </div>

              {/* All legends quick view */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                {Object.entries(LEGENDS).map(([k, l]) => {
                  const s = legendSignals[k];
                  return (
                    <button key={k} onClick={() => setActiveLegend(k)} className="card btn"
                      style={{ padding: "10px", textAlign: "left", borderColor: activeLegend === k ? l.color + "70" : "#162030" }}>
                      <div style={{ fontSize: 9, color: l.color, fontWeight: 700, marginBottom: 3 }}>{l.short}</div>
                      <div style={{ fontSize: 11, color: s?.type === "ENTRY" ? l.color : "#4a6080", fontWeight: 700 }}>{s?.signal || "—"}</div>
                      <div style={{ fontSize: 9, color: "#2a4060" }}>{s?.confidence || 0}%</div>
                    </button>
                  );
                })}
              </div>

              {/* AI output */}
              {(aiText || aiLoading) && (
                <div className="card" style={{ padding: "14px 16px" }}>
                  <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 10 }}>🤖 AI LEGEND ADVISOR</div>
                  {aiLoading && <div style={{ fontSize: 11, color: "#2a4060" }} className="blink">Channeling {legend.name}'s wisdom...</div>}
                  {aiText && !aiLoading && <div className="fade" style={{ fontSize: 11, color: "#8aaccc", lineHeight: 1.9, borderLeft: `2px solid ${legend.color}`, paddingLeft: 12 }}>{aiText}</div>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══ CHAIN TAB ══ */}
        {mainTab === "chain" && (
          <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="card" style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 18, color: "#d4e4f4", letterSpacing: 1 }}>
                  NIFTY 50 OPTION CHAIN &nbsp;·&nbsp; <span style={{ color: "#00e09a" }}>ATM {atm}</span> &nbsp;·&nbsp; <span style={{ color: "#4a6080", fontSize: 14 }}>Spot ₹{price.toLocaleString()}</span>
                </div>
                <div style={{ fontSize: 9, color: "#4a6080" }}>Click CE or PE price to select → then buy below · Weekly Expiry · Lot {LOT_SIZE}</div>
              </div>
              {selected && (
                <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 11, color: selected.type === "CE" ? "#00e09a" : "#ff4560" }}>
                    Selected: {selected.strike} {selected.type} @ ₹{selected.premium.toFixed(1)}
                    &nbsp;· Cost: ₹{Math.round(selected.premium * LOT_SIZE * lots).toLocaleString()}
                  </div>
                  <button className="btn" onClick={enterFromChain} style={{ background: "#0a2518", border: "1px solid #00e09a60", color: "#00e09a", padding: "7px 14px", fontSize: 11 }}>BUY {lots}L</button>
                  <button className="btn" onClick={() => setSelected(null)} style={{ background: "#180a10", border: "1px solid #ff456060", color: "#ff4560", padding: "7px 10px", fontSize: 11 }}>✕</button>
                </div>
              )}
            </div>
            <div className="card"><OptionChain spot={price} vix={vix} onSelect={setSelected} /></div>
            <div style={{ fontSize: 9, color: "#2a4060", textAlign: "center" }}>CE = Call (profit if Nifty rises) · PE = Put (profit if Nifty falls) · OI = Open Interest · LTP = Last Traded Price</div>
          </div>
        )}

        {/* ══ POSITIONS TAB ══ */}
        {mainTab === "positions" && (
          <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2 }}>OPEN POSITIONS · {positions.length}</div>
              <div style={{ display: "flex", gap: 16 }}>
                <div style={{ fontSize: 11, color: unrealizedPnl >= 0 ? "#00e09a" : "#ff4560" }}>Unrealized: {unrealizedPnl >= 0 ? "+" : ""}₹{unrealizedPnl.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: realizedPnl >= 0 ? "#00e09a" : "#ff4560" }}>Realized: {realizedPnl >= 0 ? "+" : ""}₹{realizedPnl.toLocaleString()}</div>
              </div>
            </div>
            {positions.length === 0 ? (
              <div className="card" style={{ padding: "40px", textAlign: "center", color: "#2a4060" }}>No open positions. Go to Signals or Legends tab to enter a trade.</div>
            ) : positions.map(pos => (
              <div key={pos.id} className="card" style={{ padding: "13px 16px", borderColor: pos.color + "30" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                  <div>
                    <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 18, color: pos.color, letterSpacing: 1 }}>
                      {pos.dir} {pos.lots}L · {pos.strike} {pos.type}
                      <span style={{ fontSize: 10, color: "#4a6080", marginLeft: 10, fontFamily: "monospace" }}>via {pos.source}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#4a6080", marginTop: 2 }}>
                      Entry ₹{pos.entryPremium.toFixed(1)} · Now ₹{pos.currentPremium.toFixed(1)} · SL ₹{pos.sl.toFixed(1)} · Target ₹{pos.target.toFixed(1)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontFamily: "'Teko',sans-serif", fontSize: 20, color: pos.unrealizedPnl >= 0 ? "#00e09a" : "#ff4560" }}>
                        {pos.unrealizedPnl >= 0 ? "+" : ""}₹{pos.unrealizedPnl.toLocaleString()}
                      </div>
                      <div style={{ fontSize: 9, color: "#2a4060" }}>UNREALIZED</div>
                    </div>
                    <button className="btn" onClick={() => exitPos(pos)}
                      style={{ background: "#180a10", border: "1px solid #ff456060", color: "#ff4560", padding: "7px 14px", fontSize: 11 }}>EXIT</button>
                  </div>
                </div>
                <div style={{ marginTop: 8, height: 3, background: "#0f1825", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, 50 + (pos.unrealizedPnl / (pos.entryPremium * LOT_SIZE * pos.lots || 1)) * 100))}%`, background: pos.unrealizedPnl >= 0 ? "#00e09a" : "#ff4560", transition: "width .5s" }} />
                </div>
              </div>
            ))}
            <div className="card" style={{ padding: "11px 16px", display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: "#4a6080" }}>Total Net P&L (Realized + Unrealized)</span>
              <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Teko',sans-serif", color: netPnl >= 0 ? "#00e09a" : "#ff4560" }}>{netPnl >= 0 ? "+" : ""}₹{netPnl.toLocaleString()}</span>
            </div>
          </div>
        )}

        {/* ══ LOG TAB ══ */}
        {mainTab === "log" && (
          <div className="fade">
            <div className="card" style={{ padding: "14px 16px" }}>
              <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, marginBottom: 12 }}>ACTIVITY LOG · {log.length} entries</div>
              {log.length === 0
                ? <div style={{ color: "#2a4060", fontSize: 11 }}>No activity yet. Start the bot and enter trades.</div>
                : <div style={{ maxHeight: "65vh", overflowY: "auto" }}>
                  {log.map((l, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, padding: "5px 0", borderBottom: "1px solid #0f1825", opacity: i === 0 ? 1 : 0.55 }}>
                      <span style={{ color: "#2a4060", flexShrink: 0, fontSize: 10 }}>{l.t}</span>
                      <span style={{ color: l.type === "entry" ? "#00e09a" : l.type === "profit" ? "#00d4aa" : l.type === "loss" ? "#ff4560" : l.type === "system" ? "#4a90d9" : "#7a9ab8", fontSize: 10 }}>
                        {l.type === "entry" ? "→" : l.type === "profit" ? "✓" : l.type === "loss" ? "✗" : "·"} {l.msg}
                      </span>
                    </div>
                  ))}
                </div>
              }
            </div>
          </div>
        )}

        {/* Disclaimer */}
        <div style={{ marginTop: 14, fontSize: 9, color: "#162030", textAlign: "center", lineHeight: 1.8 }}>
          ⚠️ EDUCATIONAL SIMULATOR · Synthetic price data only · Not connected to live NSE/BSE · Not SEBI-registered advice<br />
          For live trading: Use Zerodha Kite + Kite Connect API (₹2,000/month) for real Nifty 50 data & order execution
        </div>
      </div>
    </div>
  );
}
