import { useState, useEffect, useRef } from "react";

const LOT_SIZE = 75;
const DAYS_TO_EXPIRY = 3;
const PAPER_CAPITAL = 100000;
const DAILY_LOSS_LIMIT = 2000;
const AUTO_SL_PCT = 0.35;
const TRAILING_SL_PCT = 0.20;

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

const LEGENDS = {
  tudor: { name: "Paul Tudor Jones", short: "PTJ", title: "MACRO MOMENTUM", color: "#f5a623", quote: "Never average a losing position.", rules: ["200-EMA filter", "5:1 Risk/Reward", "Cut loss at 2%", "Ride winners"],
    analyze: (candles, ema50) => {
      if (candles.length < 10) return null;
      const last = candles[candles.length - 1], prev5 = candles.slice(-6, -1);
      const mom = last.close - prev5[0].close, above = last.close > ema50;
      if (above && mom > 15) return { signal: "BUY CALL", type: "ENTRY", confidence: Math.min(90, 68 + Math.abs(mom) * 0.3), reason: "Above EMA50 + strong momentum", sl: "2% below", target: "5:1 R/R", trend: "BULL", optionType: "CE", strike: getATM(last.close) };
      if (!above && mom < -15) return { signal: "BUY PUT", type: "ENTRY", confidence: Math.min(90, 68 + Math.abs(mom) * 0.3), reason: "Below EMA50 + bearish momentum", sl: "2% above", target: "5:1 R/R", trend: "BEAR", optionType: "PE", strike: getATM(last.close) };
      return { signal: "WAIT", type: "HOLD", confidence: 28, reason: "No momentum confirmation", trend: above ? "BULL" : "BEAR", optionType: "NONE" };
    }
  },
  livermore: { name: "Jesse Livermore", short: "JL", title: "PIVOTAL BREAKOUT", color: "#e94560", quote: "The market does what it's supposed to — just not when.", rules: ["Trade at pivot points", "Pyramid winners only", "Never fade the trend", "Wait for confirmation"],
    analyze: (candles) => {
      if (candles.length < 15) return null;
      const rec = candles.slice(-15), pH = Math.max(...rec.slice(0, 10).map(c => c.high)), pL = Math.min(...rec.slice(0, 10).map(c => c.low));
      const last = candles[candles.length - 1];
      if (last.close > pH) return { signal: "BUY CALL", type: "ENTRY", confidence: Math.min(92, 72 + ((last.close - pH) / pH) * 500), reason: `Breakout above ₹${Math.round(pH)}`, trend: "BULL", optionType: "CE", strike: getATM(last.close) };
      if (last.close < pL) return { signal: "BUY PUT", type: "ENTRY", confidence: Math.min(92, 72 + ((pL - last.close) / pL) * 500), reason: `Break below ₹${Math.round(pL)}`, trend: "BEAR", optionType: "PE", strike: getATM(last.close) };
      return { signal: "WATCHING", type: "HOLD", confidence: 42, reason: `Coiling ₹${Math.round(pL)}–₹${Math.round(pH)}`, trend: "NEUTRAL", optionType: "NONE" };
    }
  },
  williams: { name: "Larry Williams", short: "LW", title: "VOLATILITY %R", color: "#00d4aa", quote: "Most traders lose because they overtrade.", rules: ["%R oscillator", "Volatility breakout", "Selective entries", "Weekly cycle"],
    analyze: (candles) => {
      if (candles.length < 14) return null;
      const p = candles.slice(-14), hH = Math.max(...p.map(c => c.high)), lL = Math.min(...p.map(c => c.low));
      const last = candles[candles.length - 1], wR = ((hH - last.close) / (hH - lL)) * -100;
      if (wR < -80) return { signal: "BUY CALL", type: "ENTRY", confidence: Math.min(88, 65 + Math.abs(wR + 80) * 1.5), reason: `%R ${wR.toFixed(0)} oversold`, trend: "REVERSAL UP", optionType: "CE", strike: getATM(last.close) };
      if (wR > -20) return { signal: "BUY PUT", type: "ENTRY", confidence: Math.min(88, 65 + Math.abs(wR + 20) * 1.5), reason: `%R ${wR.toFixed(0)} overbought`, trend: "REVERSAL DOWN", optionType: "PE", strike: getATM(last.close) };
      return { signal: "NEUTRAL", type: "HOLD", confidence: 32, reason: `%R ${wR.toFixed(0)} — no extreme`, trend: "NEUTRAL", optionType: "NONE" };
    }
  },
  buffett: { name: "Warren Buffett", short: "WB", title: "SELL PREMIUM", color: "#7c5cbf", quote: "Risk comes from not knowing what you are doing.", rules: ["Sell IV spikes", "Collect theta", "Iron Condor", "Quality index only"],
    analyze: (candles) => {
      if (candles.length < 20) return null;
      const rec = candles.slice(-20), avg = rec.reduce((s, c) => s + (c.high - c.low), 0) / 20;
      const last = candles[candles.length - 1], lr = last.high - last.low, atm = getATM(last.close);
      if (lr > avg * 1.3) return { signal: "SELL STRADDLE", type: "ENTRY", confidence: 82, reason: `IV spike — sell premium`, trend: "SIDEWAYS", optionType: "BOTH", strike: atm };
      if (lr < avg * 0.7) return { signal: "IRON CONDOR", type: "ENTRY", confidence: 76, reason: "Low vol — sell strangle", trend: "SIDEWAYS", optionType: "BOTH", strike: atm };
      return { signal: "WAIT FOR IV", type: "HOLD", confidence: 48, reason: "IV normal — await spike", trend: "SIDEWAYS", optionType: "NONE" };
    }
  }
};

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
  if (vix > 18) return { direction: "SIDEWAYS", signal: "SELL STRADDLE", optionType: "BOTH", strike: atm, confidence: Math.round(58 + vix * 0.8), rsi, bb, e9, e21, e50, reasons: [`VIX ${vix.toFixed(1)} rich`, "No clear trend"], vix };
  return { direction: "NEUTRAL", signal: "WAIT", optionType: "NONE", strike: atm, confidence: 22, rsi, bb, e9, e21, e50, reasons: ["Mixed signals"], vix };
};

function MiniChart({ candles, color = "#00e09a", h = 80, w = 300 }) {
  const last = candles.slice(-35);
  if (last.length < 2) return null;
  const mx = Math.max(...last.map(c => c.high)), mn = Math.min(...last.map(c => c.low)), rng = mx - mn || 1;
  const cW = w / last.length, toY = v => h - 6 - ((v - mn) / rng) * (h - 12);
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      {last.map((c, i) => {
        const x = i * cW + cW * 0.1, bw = cW * 0.8, isG = c.close >= c.open, col = isG ? "#00e09a" : "#ff4560";
        const bTop = toY(Math.max(c.open, c.close)), bH = Math.max(1, Math.abs(toY(c.open) - toY(c.close)));
        return <g key={i}><line x1={x + bw/2} y1={toY(c.high)} x2={x + bw/2} y2={toY(c.low)} stroke={col} strokeWidth="0.8" opacity="0.6"/><rect x={x} y={bTop} width={bw} height={bH} fill={col} opacity="0.85" rx="0.5"/></g>;
      })}
    </svg>
  );
}

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

function OptionChain({ spot, vix, onSelect }) {
  const atm = getATM(spot), strikes = getNearbyStrikes(atm, 5);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "monospace" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #1e2d45" }}>
            {["CE OI","CE LTP","STRIKE","PE LTP","PE OI"].map(h => (
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
                <td style={{ padding: "5px 8px", color: "#4a90d9", textAlign: "right" }}>{(ceOI/1000).toFixed(0)}K</td>
                <td onClick={() => onSelect({ strike: s, type: "CE", premium: ceLTP })} style={{ padding: "5px 8px", color: "#00e09a", textAlign: "right", cursor: "pointer", fontWeight: isATM ? 700 : 400 }}>{ceLTP.toFixed(1)} ▶</td>
                <td style={{ padding: "6px 10px", textAlign: "center", fontWeight: 700, color: isATM ? "#00e09a" : "#94a3b8", background: isATM ? "#00e09a15" : "transparent", borderLeft: "1px solid #1e2d45", borderRight: "1px solid #1e2d45" }}>
                  {s}{isATM && <span style={{ fontSize: 8, color: "#00e09a", marginLeft: 3 }}>ATM</span>}
                </td>
                <td onClick={() => onSelect({ strike: s, type: "PE", premium: peLTP })} style={{ padding: "5px 8px", color: "#ff4560", textAlign: "left", cursor: "pointer", fontWeight: isATM ? 700 : 400 }}>◀ {peLTP.toFixed(1)}</td>
                <td style={{ padding: "5px 8px", color: "#d9604a", textAlign: "left" }}>{(peOI/1000).toFixed(0)}K</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function MegaNiftyBot() {
  const BASE = 24350;
  const [candles, setCandles] = useState(() => makeCandles(BASE, 60));
  const [running, setRunning] = useState(false);
  const [mainTab, setMainTab] = useState("signal");
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
  const [paperMode, setPaperMode] = useState(true);
  const [paperCapital, setPaperCapital] = useState(PAPER_CAPITAL);
  const [paperPositions, setPaperPositions] = useState([]);
  const [paperTrades, setPaperTrades] = useState([]);
  const [paperRealizedPnl, setPaperRealizedPnl] = useState(0);
  const [paperWins, setPaperWins] = useState(0);
  const [paperLosses, setPaperLosses] = useState(0);
  const [dailyLoss, setDailyLoss] = useState(0);
  const [dailyLossHit, setDailyLossHit] = useState(false);
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
  const paperUnrealized = paperPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const netPnl = realizedPnl + unrealizedPnl;
  const paperNetPnl = paperRealizedPnl + paperUnrealized;
  const winRate = (paperWins + paperLosses) > 0 ? Math.round((paperWins / (paperWins + paperLosses)) * 100) : 0;
  const techColor = techSignal?.direction === "BULLISH" ? "#00e09a" : techSignal?.direction === "BEARISH" ? "#ff4560" : techSignal?.direction === "SIDEWAYS" ? "#f5a623" : "#4a6080";
  const legColor = curLegSig?.type === "ENTRY" ? legend.color : "#4a6080";

  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setCandles(prev => {
        const last = prev[prev.length - 1], chg = (Math.random() - 0.487) * 40, close = last.close + chg;
        return [...prev.slice(-99), { open: last.close, close, high: Math.max(last.close, close) + Math.random() * 16, low: Math.min(last.close, close) - Math.random() * 16, vol: Math.floor(60000 + Math.random() * 130000), time: last.time + 1 }];
      });
    }, 1100);
    return () => clearInterval(intervalRef.current);
  }, [running]);

  useEffect(() => {
    const newVix = calcVIX(candles);
    setVix(newVix);
    setTechSignal(generateTechSignal(candles, newVix));
    const e50 = calcEMA(closes, 50);
    const mapped = {};
    Object.keys(LEGENDS).forEach(k => { mapped[k] = LEGENDS[k].analyze(candles, e50); });
    setLegendSignals(mapped);
    setPositions(prev => prev.map(p => {
      const cur = estimatePremium(price, p.strike, Math.max(0.1, DAYS_TO_EXPIRY), newVix, p.type === "CE");
      return { ...p, currentPremium: cur, unrealizedPnl: Math.round((cur - p.entryPremium) * LOT_SIZE * p.lots) };
    }));
    setPaperPositions(prev => prev.map(p => {
      const cur = estimatePremium(price, p.strike, Math.max(0.1, DAYS_TO_EXPIRY), newVix, p.type === "CE");
      const pts = Math.round((cur - p.entryPremium) * LOT_SIZE * p.lots);
      const newHigh = Math.max(p.highPremium || cur, cur);
      const trailSL = newHigh * (1 - TRAILING_SL_PCT);
      // Auto SL
      if (cur <= p.sl) {
        exitPaperPosAuto({ ...p, currentPremium: cur, unrealizedPnl: pts }, "🔴 Auto SL");
        return null;
      }
      if (trailSL > p.sl && cur <= trailSL) {
        exitPaperPosAuto({ ...p, currentPremium: cur, unrealizedPnl: pts }, "🟡 Trailing SL");
        return null;
      }
      return { ...p, currentPremium: cur, unrealizedPnl: pts, highPremium: newHigh, trailSL };
    }).filter(Boolean));
  }, [candles]);

  function addLog(msg, type = "info") {
    const t = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    setLog(p => [{ t, msg, type }, ...p.slice(0, 49)]);
  }

  function exitPaperPosAuto(pos, reason) {
    const realized = pos.unrealizedPnl;
    setPaperRealizedPnl(p => p + realized);
    if (realized >= 0) setPaperWins(w => w + 1); else {
      setPaperLosses(l => l + 1);
      setDailyLoss(d => { const nd = d + Math.abs(realized); if (nd >= DAILY_LOSS_LIMIT) setDailyLossHit(true); return nd; });
    }
    setPaperTrades(t => [{ id: pos.id, strike: pos.strike, type: pos.type, entry: pos.entryPremium, exit: pos.currentPremium, pnl: realized, reason, time: new Date().toLocaleTimeString("en-IN", { hour12: false }) }, ...t.slice(0, 49)]);
    addLog(`${realized >= 0 ? "✅" : "❌"} ${reason} · ${pos.strike}${pos.type} · P&L: ${realized >= 0 ? "+" : ""}₹${realized.toLocaleString()}`, realized >= 0 ? "profit" : "loss");
  }

  function enterPaperTrade(sig) {
    if (!sig || sig.type !== "ENTRY") return;
    if (dailyLossHit) { addLog("⛔ Daily loss limit hit!", "loss"); return; }
    if (paperPositions.length >= 1) { addLog("⚠️ Max 1 trade at a time!", "info"); return; }
    const optType = sig.optionType === "BOTH" || !sig.optionType ? "CE" : sig.optionType;
    const strike = sig.strike || atm;
    const prem = estimatePremium(price, strike, DAYS_TO_EXPIRY, vix, optType === "CE");
    const cost = Math.round(prem * LOT_SIZE * lots);
    if (cost > paperCapital) { addLog("⚠️ Insufficient paper capital!", "loss"); return; }
    const sl = prem * (1 - AUTO_SL_PCT);
    const target = prem * 2;
    setPaperPositions(p => [{ id: Date.now(), strike, type: optType, lots, entryPremium: prem, currentPremium: prem, highPremium: prem, entryPrice: price, unrealizedPnl: 0, sl, trailSL: null, target, color: optType === "CE" ? "#00e09a" : "#ff4560" }, ...p]);
    setPaperCapital(c => c - cost);
    addLog(`📝 PAPER BUY ${lots}L ${strike}${optType} @ ₹${prem.toFixed(1)} · SL ₹${sl.toFixed(1)} · Target ₹${target.toFixed(1)}`, "entry");
    setMainTab("paper");
  }

  function exitPaperPos(pos) {
    const realized = pos.unrealizedPnl;
    const ret = Math.round(pos.currentPremium * LOT_SIZE * pos.lots);
    setPaperRealizedPnl(p => p + realized);
    setPaperCapital(c => c + ret);
    if (realized >= 0) setPaperWins(w => w + 1); else {
      setPaperLosses(l => l + 1);
      setDailyLoss(d => { const nd = d + Math.abs(realized); if (nd >= DAILY_LOSS_LIMIT) setDailyLossHit(true); return nd; });
    }
    setPaperTrades(t => [{ id: pos.id, strike: pos.strike, type: pos.type, entry: pos.entryPremium, exit: pos.currentPremium, pnl: realized, reason: "Manual Exit", time: new Date().toLocaleTimeString("en-IN", { hour12: false }) }, ...t.slice(0, 49)]);
    setPaperPositions(p => p.filter(x => x.id !== pos.id));
    addLog(`${realized >= 0 ? "✅" : "❌"} PAPER EXIT · ${pos.strike}${pos.type} · P&L: ${realized >= 0 ? "+" : ""}₹${realized.toLocaleString()}`, realized >= 0 ? "profit" : "loss");
  }

  function bookPartial(pos) {
    const halfPnl = Math.round(pos.unrealizedPnl / 2);
    setPaperRealizedPnl(p => p + halfPnl);
    setPaperWins(w => w + 1);
    setPaperPositions(prev => prev.map(p => p.id === pos.id ? { ...p, lots: Math.max(1, Math.floor(p.lots / 2)), unrealizedPnl: Math.round(p.unrealizedPnl / 2) } : p));
    addLog(`📊 50% BOOKED · ${pos.strike}${pos.type} · ₹${halfPnl.toLocaleString()}`, "profit");
  }

  function enterTrade(sig, dir = "BUY", source = "TECH") {
    if (!sig || sig.type !== "ENTRY") return;
    const optType = sig.optionType === "BOTH" || !sig.optionType ? "CE" : sig.optionType;
    const strike = sig.strike || atm;
    const prem = estimatePremium(price, strike, DAYS_TO_EXPIRY, vix, optType === "CE");
    setPositions(p => [{ id: Date.now(), strike, type: optType, dir, lots, entryPremium: prem, currentPremium: prem, entryPrice: price, unrealizedPnl: 0, sl: prem * 0.5, target: prem * 2, source, color: sig.direction === "BULLISH" || sig.trend === "BULL" ? "#00e09a" : sig.direction === "BEARISH" || sig.trend === "BEAR" ? "#ff4560" : "#f5a623" }, ...p]);
    addLog(`${dir} ${lots}L ${strike}${optType} @ ₹${prem.toFixed(1)} · ${source}`, "entry");
    setMainTab("positions");
  }

  function exitPos(pos) {
    setRealizedPnl(p => p + pos.unrealizedPnl);
    setPositions(p => p.filter(x => x.id !== pos.id));
    addLog(`EXIT ${pos.strike}${pos.type} @ ₹${pos.currentPremium.toFixed(1)} · P&L: ${pos.unrealizedPnl >= 0 ? "+" : ""}₹${pos.unrealizedPnl.toLocaleString()}`, pos.unrealizedPnl >= 0 ? "profit" : "loss");
  }

  function enterFromChain() {
    if (!selected) return;
    if (paperMode) { enterPaperTrade({ signal: `BUY ${selected.type}`, optionType: selected.type, strike: selected.strike, type: "ENTRY" }); }
    else { const prem = selected.premium; setPositions(p => [{ id: Date.now(), strike: selected.strike, type: selected.type, dir: "BUY", lots, entryPremium: prem, currentPremium: prem, entryPrice: price, unrealizedPnl: 0, sl: prem * 0.5, target: prem * 2, source: "CHAIN", color: selected.type === "CE" ? "#00e09a" : "#ff4560" }, ...p]); setMainTab("positions"); }
    setSelected(null);
  }

  async function getAI(mode = "tech") {
    setAiLoading(true); setAiText("");
    const sig = mode === "tech" ? techSignal : curLegSig;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: `You are an expert NSE Nifty 50 intraday options trader. Give PRACTICAL advice in 4 sentences max.\nNifty: ₹${price} | ATM: ${atm} | VIX: ${vix.toFixed(1)} | RSI: ${rsi.toFixed(1)}\nMode: ${paperMode ? "PAPER" : "LIVE"} | Capital: ₹${paperMode ? paperCapital.toLocaleString() : "Real"}\nSignal: ${sig?.signal} (${sig?.direction || sig?.trend}) | Conf: ${sig?.confidence}%\nPaper P&L: ₹${paperNetPnl.toLocaleString()} | Win Rate: ${winRate}%\nAnswer: 1.Trade NOW? 2.Entry price? 3.Stop-loss? 4.Target? Direct, Indian market only.` }] }) });
      const data = await res.json();
      setAiText(data.content?.map(b => b.text || "").join("") || "Could not fetch.");
    } catch { setAiText("⚠️ Retry."); }
    setAiLoading(false);
  }

  const TABS = [["signal","📊 SIGNALS"],["legends","🏆 LEGENDS"],["paper",`📝 PAPER${paperPositions.length ? ` (${paperPositions.length})` : ""}`],["chain","⛓ CHAIN"],["positions",`📁 LIVE${positions.length ? ` (${positions.length})` : ""}`],["log","📋 LOG"]];

  return (
    <div style={{ minHeight: "100vh", background: "#060a10", color: "#d4e4f4", fontFamily: "'Fira Code','Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600;700&family=Teko:wght@400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        .card{background:#0a1018;border:1px solid #162030;border-radius:10px}
        .btn{border:none;cursor:pointer;font-family:'Fira Code',monospace;border-radius:6px;transition:all .15s;font-weight:600}
        .btn:hover{filter:brightness(1.2);transform:translateY(-1px)}
        .btn:disabled{opacity:.35;cursor:not-allowed;transform:none!important}
        .tab{background:transparent;border:none;border-bottom:2px solid transparent;color:#3a5570;padding:9px 14px;cursor:pointer;font-family:'Fira Code',monospace;font-size:10px;letter-spacing:1px;transition:all .2s;white-space:nowrap}
        .tab.active{color:#00e09a;border-bottom-color:#00e09a}
        .tab:hover:not(.active){color:#6a90b0}
        .leg-btn{background:#0a1018;border:1px solid #162030;color:#3a5570;padding:9px 12px;cursor:pointer;font-family:'Fira Code',monospace;font-size:10px;border-radius:8px;transition:all .2s;text-align:left;width:100%}
        .leg-btn.active{border-color:var(--lc);color:var(--lc);background:var(--la)}
        .blink{animation:blink 1.2s step-end infinite}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        .fade{animation:fade .35s ease}
        @keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-thumb{background:#162030;border-radius:2px}
        input[type=number]{background:#0a1018;border:1px solid #162030;color:#d4e4f4;padding:5px 8px;border-radius:6px;font-family:'Fira Code',monospace;width:64px;font-size:12px}
        input[type=number]:focus{outline:none;border-color:#00e09a}
        .tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
      `}</style>

      {/* HEADER */}
      <div style={{ background:"#07090f", borderBottom:"1px solid #162030", padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div>
            <div style={{ fontFamily:"'Teko',sans-serif", fontSize:22, letterSpacing:3, background:"linear-gradient(90deg,#00e09a,#4a90d9)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", lineHeight:1 }}>NIFTY 50 MEGA BOT</div>
            <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2 }}>NSE · PAPER TRADING · LIVE TRADING · LEGENDS</div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:7, height:7, borderRadius:"50%", background:running?"#00e09a":"#3a5570" }} className={running?"blink":""} />
            <span style={{ fontSize:9, color:running?"#00e09a":"#3a5570" }}>{running?"LIVE SIM":"PAUSED"}</span>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          {/* Mode Toggle */}
          <div style={{ display:"flex", background:"#0a1018", border:"1px solid #162030", borderRadius:20, padding:"3px 4px", gap:3 }}>
            <button onClick={() => setPaperMode(true)} style={{ padding:"5px 12px", borderRadius:16, border:"none", cursor:"pointer", fontFamily:"'Fira Code',monospace", fontSize:10, fontWeight:700, background:paperMode?"#0a2518":"transparent", color:paperMode?"#00e09a":"#4a6080", border:paperMode?"1px solid #00e09a40":"1px solid transparent", transition:"all .2s" }}>📝 PAPER</button>
            <button onClick={() => setPaperMode(false)} style={{ padding:"5px 12px", borderRadius:16, border:"none", cursor:"pointer", fontFamily:"'Fira Code',monospace", fontSize:10, fontWeight:700, background:!paperMode?"#2a0a10":"transparent", color:!paperMode?"#ff4560":"#4a6080", border:!paperMode?"1px solid #ff456040":"1px solid transparent", transition:"all .2s" }}>🔴 LIVE</button>
          </div>
          <div>
            <div style={{ fontFamily:"'Teko',sans-serif", fontSize:28, color:isUp?"#00e09a":"#ff4560", lineHeight:1 }}>{price.toLocaleString("en-IN")}</div>
            <div style={{ fontSize:9, color:isUp?"#00e09a70":"#ff456070" }}>{isUp?"▲":"▼"} {Math.abs(delta)} · ATM {atm}</div>
          </div>
          {[["VIX",vix.toFixed(1),vix>20?"#f5a623":"#00e09a"],["RSI",rsi.toFixed(0),rsi>65?"#ff4560":rsi<35?"#00e09a":"#f5a623"],paperMode?["PAPER P&L",`${paperNetPnl>=0?"+":""}₹${paperNetPnl.toLocaleString()}`,paperNetPnl>=0?"#00e09a":"#ff4560"]:["LIVE P&L",`${netPnl>=0?"+":""}₹${netPnl.toLocaleString()}`,netPnl>=0?"#00e09a":"#ff4560"]].map(([l,v,c]) => (
            <div key={l} style={{ borderLeft:"1px solid #162030", paddingLeft:12, textAlign:"center" }}>
              <div style={{ fontSize:9, color:"#2a4060", letterSpacing:1 }}>{l}</div>
              <div style={{ fontFamily:"'Teko',sans-serif", fontSize:18, color:c, lineHeight:1.1 }}>{v}</div>
            </div>
          ))}
          <div style={{ borderLeft:"1px solid #162030", paddingLeft:12 }}>
            <div style={{ fontSize:9, color:"#2a4060", marginBottom:3 }}>LOTS</div>
            <input type="number" min="1" max="50" value={lots} onChange={e => setLots(Math.max(1,+e.target.value||1))} />
          </div>
          <button className="btn" onClick={() => { setRunning(r=>!r); addLog(running?"Bot paused":"Bot started","system"); }} style={{ background:running?"#0a2518":"#0a1830", border:`1px solid ${running?"#00e09a50":"#4a90d960"}`, color:running?"#00e09a":"#4a90d9", padding:"8px 16px", fontSize:11 }}>
            {running?"⏸ PAUSE":"▶ START"}
          </button>
        </div>
      </div>

      {/* TABS */}
      <div style={{ background:"#07090f", borderBottom:"1px solid #162030", display:"flex", paddingLeft:8, overflowX:"auto" }}>
        {TABS.map(([k,label]) => <button key={k} className={`tab ${mainTab===k?"active":""}`} onClick={() => setMainTab(k)}>{label}</button>)}
      </div>

      <div style={{ padding:"14px 16px", maxWidth:1140, margin:"0 auto" }}>

        {/* SIGNALS TAB */}
        {mainTab==="signal" && (
          <div className="fade" style={{ display:"grid", gridTemplateColumns:"1fr 280px", gap:14 }}>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div className="card" style={{ padding:"16px 18px", borderColor:techColor+"40" }}>
                <div style={{ display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:10, marginBottom:12 }}>
                  <div>
                    <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:5 }}>📊 TECHNICAL SIGNAL</div>
                    <div style={{ fontFamily:"'Teko',sans-serif", fontSize:32, color:techColor, letterSpacing:2, lineHeight:1 }}>{techSignal?.signal||"LOADING..."}</div>
                    <div style={{ fontSize:10, color:"#4a7090", marginTop:3 }}>{techSignal?.direction} · Strike {techSignal?.strike} · {DAYS_TO_EXPIRY}DTE</div>
                  </div>
                  <MiniChart candles={candles} color={techColor} h={70} w={240} />
                </div>
                {techSignal?.reasons && <div style={{ display:"flex", gap:7, flexWrap:"wrap", marginBottom:12 }}>{techSignal.reasons.map((r,i) => <span key={i} className="tag" style={{ background:techColor+"15", border:`1px solid ${techColor}30`, color:techColor }}>{r}</span>)}</div>}
                <div style={{ marginBottom:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#4a6080", marginBottom:4 }}><span>CONFIDENCE</span><span style={{ color:techColor }}>{techSignal?.confidence||0}%</span></div>
                  <div style={{ height:4, background:"#0f1825", borderRadius:2 }}><div style={{ height:"100%", width:`${techSignal?.confidence||0}%`, background:techColor, borderRadius:2, transition:"width .5s" }}/></div>
                </div>
                <div style={{ display:"flex", gap:9, flexWrap:"wrap" }}>
                  {paperMode ? (
                    <button className="btn" onClick={() => enterPaperTrade(techSignal)} disabled={!techSignal||techSignal.type!=="ENTRY"||dailyLossHit} style={{ background:"#0a2518", border:"1px solid #00e09a60", color:"#00e09a", padding:"9px 20px", fontSize:11 }}>📝 PAPER TRADE</button>
                  ) : (
                    <button className="btn" onClick={() => enterTrade(techSignal,"BUY")} disabled={!techSignal||techSignal.type!=="ENTRY"} style={{ background:"#0a2518", border:"1px solid #00e09a60", color:"#00e09a", padding:"9px 20px", fontSize:11 }}>✅ BUY</button>
                  )}
                  <button className="btn" onClick={() => getAI("tech")} disabled={aiLoading} style={{ background:"#0a1428", border:"1px solid #4a90d960", color:"#4a90d9", padding:"9px 16px", fontSize:11 }}>🤖 {aiLoading?"Thinking...":"AI ADVICE"}</button>
                  <button className="btn" onClick={() => setMainTab("chain")} style={{ background:"#0a1020", border:"1px solid #2a4060", color:"#4a6080", padding:"9px 14px", fontSize:11 }}>⛓ CHAIN</button>
                </div>
                {dailyLossHit && <div style={{ marginTop:10, padding:"8px 12px", background:"#2a0a10", border:"1px solid #ff456060", borderRadius:6, fontSize:11, color:"#ff4560" }}>⛔ Daily loss limit ₹{DAILY_LOSS_LIMIT.toLocaleString()} hit! No more trades today.</div>}
              </div>

              {/* Legend quick */}
              <div>
                <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:8 }}>🏆 LEGEND SIGNALS</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
                  {Object.entries(LEGENDS).map(([k,l]) => {
                    const s = legendSignals[k];
                    return <button key={k} onClick={() => { setActiveLegend(k); setMainTab("legends"); }} className="card btn" style={{ padding:"10px 12px", textAlign:"left", borderColor:s?.type==="ENTRY"?l.color+"60":"#162030" }}>
                      <div style={{ fontSize:9, color:l.color, fontWeight:700, marginBottom:3 }}>{l.short}</div>
                      <div style={{ fontSize:10, color:s?.type==="ENTRY"?l.color:"#4a6080", fontWeight:700 }}>{s?.signal||"—"}</div>
                      <div style={{ fontSize:9, color:"#2a4060" }}>{s?.confidence||0}%</div>
                    </button>;
                  })}
                </div>
              </div>

              {(aiText||aiLoading) && <div className="card" style={{ padding:"14px 16px" }}>
                <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:8 }}>🤖 AI ADVISOR</div>
                {aiLoading && <div style={{ fontSize:11, color:"#2a4060" }} className="blink">Analyzing...</div>}
                {aiText && !aiLoading && <div className="fade" style={{ fontSize:11, color:"#8aaccc", lineHeight:1.9, borderLeft:"2px solid #4a90d9", paddingLeft:12 }}>{aiText}</div>}
              </div>}

              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:9 }}>
                {[{l:"ATM CE",v:`₹${estimatePremium(price,atm,DAYS_TO_EXPIRY,vix,true).toFixed(0)}`,s:`${atm} CE`},{l:"ATM PE",v:`₹${estimatePremium(price,atm,DAYS_TO_EXPIRY,vix,false).toFixed(0)}`,s:`${atm} PE`},{l:"COST/LOT",v:`₹${Math.round(estimatePremium(price,atm,DAYS_TO_EXPIRY,vix,true)*LOT_SIZE*lots).toLocaleString()}`,s:`${lots}L × ${LOT_SIZE}`}].map(s => (
                  <div key={s.l} className="card" style={{ padding:"11px 13px" }}>
                    <div style={{ fontSize:9, color:"#4a6080", letterSpacing:1, marginBottom:4 }}>{s.l}</div>
                    <div style={{ fontFamily:"'Teko',sans-serif", fontSize:18, color:"#d4e4f4" }}>{s.v}</div>
                    <div style={{ fontSize:9, color:"#2a4060", marginTop:2 }}>{s.s}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Indicators */}
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div className="card" style={{ padding:"14px" }}>
                <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:12 }}>INDICATORS</div>
                <IndBar label="RSI (14)" val={rsi} mn={0} mx={100} color={rsi>65?"#ff4560":rsi<35?"#00e09a":"#f5a623"} />
                <IndBar label="INDIA VIX" val={vix} mn={8} mx={35} color={vix>20?"#f5a623":"#00e09a"} />
                <IndBar label="EMA 9" val={calcEMA(closes,9)} mn={price-180} mx={price+180} color="#4a90d9" fmt={v=>v.toFixed(0)} />
                <IndBar label="EMA 21" val={calcEMA(closes,21)} mn={price-180} mx={price+180} color="#9a6ad9" fmt={v=>v.toFixed(0)} />
                <IndBar label="EMA 50" val={calcEMA(closes,50)} mn={price-300} mx={price+300} color="#d96a4a" fmt={v=>v.toFixed(0)} />
                <IndBar label="MACD" val={macd.hist} mn={-60} mx={60} color={macd.hist>0?"#00e09a":"#ff4560"} />
              </div>
              <div className="card" style={{ padding:"13px" }}>
                <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:10 }}>🛡️ RISK RULES</div>
                {[["Auto SL",`${(AUTO_SL_PCT*100).toFixed(0)}% loss`,"#ff4560"],["Trailing SL",`${(TRAILING_SL_PCT*100).toFixed(0)}% from peak`,"#f5a623"],["Daily Limit",`₹${DAILY_LOSS_LIMIT.toLocaleString()}`,dailyLossHit?"#ff4560":"#00e09a"],["Max Trades","1 at a time","#4a90d9"],["Win Rate",`${winRate}%`,winRate>=50?"#00e09a":"#ff4560"]].map(([l,v,c]) => (
                  <div key={l} style={{ display:"flex", justifyContent:"space-between", fontSize:10, marginBottom:6 }}>
                    <span style={{ color:"#4a6080" }}>{l}</span><span style={{ color:c, fontWeight:600 }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* LEGENDS TAB */}
        {mainTab==="legends" && (
          <div className="fade" style={{ display:"grid", gridTemplateColumns:"190px 1fr", gap:14 }}>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:4 }}>SELECT LEGEND</div>
              {Object.entries(LEGENDS).map(([k,l]) => {
                const s = legendSignals[k];
                return <button key={k} className={`leg-btn ${activeLegend===k?"active":""}`} style={{"--lc":l.color,"--la":l.color+"15"}} onClick={() => { setActiveLegend(k); setAiText(""); }}>
                  <div style={{ fontWeight:700, fontSize:11, marginBottom:2 }}>{l.name}</div>
                  <div style={{ fontSize:9, opacity:.7 }}>{l.title}</div>
                  {s && <div style={{ marginTop:4, fontSize:9, color:s.type==="ENTRY"?l.color:"#4a6080" }}>● {s.signal}</div>}
                </button>;
              })}
              <div style={{ marginTop:8, borderTop:"1px solid #162030", paddingTop:10 }}>
                {legend.rules.map((r,i) => <div key={i} style={{ fontSize:10, color:"#4a6080", marginBottom:5, display:"flex", gap:6 }}><span style={{ color:legend.color }}>›</span>{r}</div>)}
              </div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div className="card" style={{ padding:"16px 18px", borderColor:legend.color+"40", background:`linear-gradient(135deg,#0a1018,${legend.color}10)` }}>
                <div style={{ display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:10, marginBottom:10 }}>
                  <div>
                    <div style={{ fontFamily:"'Teko',sans-serif", fontSize:24, color:legend.color, letterSpacing:2 }}>{legend.name}</div>
                    <div style={{ fontSize:9, color:"#4a6080", letterSpacing:2, marginBottom:6 }}>{legend.title}</div>
                    <div style={{ fontSize:11, color:"#6a8aaa", fontStyle:"italic" }}>"{legend.quote}"</div>
                  </div>
                  <MiniChart candles={candles} color={legend.color} h={65} w={220} />
                </div>
              </div>
              <div className="card" style={{ padding:"16px 18px", borderColor:curLegSig?.type==="ENTRY"?legend.color+"60":"#162030" }}>
                <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:10 }}>LEGEND SIGNAL</div>
                <div style={{ fontFamily:"'Teko',sans-serif", fontSize:28, color:legColor, lineHeight:1, marginBottom:6 }}>{curLegSig?.signal||"LOADING..."}</div>
                <div style={{ fontSize:11, color:"#7a9ab8", marginBottom:12 }}>{curLegSig?.reason}</div>
                <div style={{ marginBottom:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#4a6080", marginBottom:4 }}><span>CONFIDENCE</span><span style={{ color:legColor }}>{curLegSig?.confidence||0}%</span></div>
                  <div style={{ height:4, background:"#0f1825", borderRadius:2 }}><div style={{ height:"100%", width:`${curLegSig?.confidence||0}%`, background:legend.color, borderRadius:2, transition:"width .5s" }}/></div>
                </div>
                <div style={{ display:"flex", gap:9, flexWrap:"wrap" }}>
                  {paperMode ? (
                    <button className="btn" onClick={() => enterPaperTrade(curLegSig)} disabled={curLegSig?.type!=="ENTRY"||dailyLossHit} style={{ background:"#0a2518", border:"1px solid #00e09a60", color:"#00e09a", padding:"9px 20px", fontSize:11 }}>📝 PAPER TRADE</button>
                  ) : (
                    <button className="btn" onClick={() => enterTrade(curLegSig,"BUY",legend.short)} disabled={curLegSig?.type!=="ENTRY"} style={{ background:"#0a2518", border:"1px solid #00e09a60", color:"#00e09a", padding:"9px 20px", fontSize:11 }}>✅ ENTER</button>
                  )}
                  <button className="btn" onClick={() => getAI("legend")} disabled={aiLoading} style={{ background:"#0a1428", border:`1px solid ${legend.color}50`, color:legend.color, padding:"9px 16px", fontSize:11 }}>🤖 {aiLoading?"...":"ASK AI"}</button>
                </div>
              </div>
              {(aiText||aiLoading) && <div className="card" style={{ padding:"14px 16px" }}>
                {aiLoading && <div style={{ fontSize:11, color:"#2a4060" }} className="blink">Analyzing...</div>}
                {aiText && !aiLoading && <div className="fade" style={{ fontSize:11, color:"#8aaccc", lineHeight:1.9, borderLeft:`2px solid ${legend.color}`, paddingLeft:12 }}>{aiText}</div>}
              </div>}
            </div>
          </div>
        )}

        {/* PAPER TAB */}
        {mainTab==="paper" && (
          <div className="fade" style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:10 }}>
              {[{l:"PAPER CAPITAL",v:`₹${paperCapital.toLocaleString()}`,c:"#4a90d9"},{l:"NET P&L",v:`${paperNetPnl>=0?"+":""}₹${paperNetPnl.toLocaleString()}`,c:paperNetPnl>=0?"#00e09a":"#ff4560"},{l:"WIN RATE",v:`${winRate}%`,c:winRate>=50?"#00e09a":"#ff4560"},{l:"W / L",v:`${paperWins} / ${paperLosses}`,c:"#f5a623"},{l:"DAILY LOSS",v:`₹${dailyLoss} / ₹${DAILY_LOSS_LIMIT}`,c:dailyLossHit?"#ff4560":"#00e09a"}].map(s => (
                <div key={s.l} className="card" style={{ padding:"12px 14px" }}>
                  <div style={{ fontSize:9, color:"#4a6080", letterSpacing:1, marginBottom:4 }}>{s.l}</div>
                  <div style={{ fontFamily:"'Teko',sans-serif", fontSize:18, color:s.c }}>{s.v}</div>
                </div>
              ))}
            </div>

            <div className="card" style={{ padding:"12px 16px", borderColor:"#00e09a20" }}>
              <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:8 }}>🛡️ AUTO RISK — ALWAYS ON</div>
              <div style={{ display:"flex", gap:16, flexWrap:"wrap", fontSize:10, color:"#4a6080" }}>
                <span><span style={{ color:"#ff4560" }}>Auto SL</span> — {(AUTO_SL_PCT*100).toFixed(0)}% premium loss</span>
                <span><span style={{ color:"#f5a623" }}>Trailing SL</span> — {(TRAILING_SL_PCT*100).toFixed(0)}% from peak</span>
                <span><span style={{ color:"#00e09a" }}>Daily Limit</span> — ₹{DAILY_LOSS_LIMIT.toLocaleString()} max</span>
                <span><span style={{ color:"#4a90d9" }}>Max 1 trade</span> — no overtrading</span>
                <span><span style={{ color:"#f5a623" }}>50% Partial</span> — book half at profit</span>
              </div>
            </div>

            <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:4 }}>OPEN POSITIONS · {paperPositions.length}</div>
            {paperPositions.length === 0 ? (
              <div className="card" style={{ padding:"30px", textAlign:"center", color:"#2a4060" }}>No open paper positions. Go to Signals tab → click "📝 PAPER TRADE"</div>
            ) : paperPositions.map(pos => {
              const pnlPct = ((pos.currentPremium - pos.entryPremium) / pos.entryPremium * 100).toFixed(1);
              return (
                <div key={pos.id} className="card" style={{ padding:"14px 16px", borderColor:pos.color+"30", marginBottom:8 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10 }}>
                    <div>
                      <div style={{ fontFamily:"'Teko',sans-serif", fontSize:20, color:pos.color }}>{pos.lots}L · {pos.strike} {pos.type} {pos.currentPremium>=pos.target&&<span style={{ fontSize:11, color:"#00e09a" }}>🎯 TARGET!</span>}</div>
                      <div style={{ fontSize:10, color:"#4a6080", marginTop:3 }}>₹{pos.entryPremium.toFixed(1)} → ₹{pos.currentPremium.toFixed(1)} ({pnlPct}%)</div>
                      <div style={{ display:"flex", gap:10, marginTop:5, fontSize:10 }}>
                        <span style={{ color:"#ff4560" }}>SL ₹{pos.sl.toFixed(1)}</span>
                        <span style={{ color:"#f5a623" }}>Trail ₹{pos.trailSL?.toFixed(1)||"—"}</span>
                        <span style={{ color:"#00e09a" }}>Target ₹{pos.target.toFixed(1)}</span>
                      </div>
                    </div>
                    <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                      <div style={{ textAlign:"right" }}>
                        <div style={{ fontFamily:"'Teko',sans-serif", fontSize:22, color:pos.unrealizedPnl>=0?"#00e09a":"#ff4560" }}>{pos.unrealizedPnl>=0?"+":""}₹{pos.unrealizedPnl.toLocaleString()}</div>
                        <div style={{ fontSize:9, color:"#2a4060" }}>UNREALIZED</div>
                      </div>
                      <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                        <button className="btn" onClick={() => bookPartial(pos)} disabled={pos.unrealizedPnl<=0} style={{ background:"#0a1428", border:"1px solid #f5a62360", color:"#f5a623", padding:"5px 10px", fontSize:10 }}>50% BOOK</button>
                        <button className="btn" onClick={() => exitPaperPos(pos)} style={{ background:"#180a10", border:"1px solid #ff456060", color:"#ff4560", padding:"5px 10px", fontSize:10 }}>EXIT</button>
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop:8, height:4, background:"#0f1825", borderRadius:2, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${Math.min(100,Math.max(0,50+Number(pnlPct)))}%`, background:pos.unrealizedPnl>=0?"#00e09a":"#ff4560", transition:"width .5s" }}/>
                  </div>
                </div>
              );
            })}

            {paperTrades.length > 0 && (
              <div>
                <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:8 }}>TRADE HISTORY · {paperTrades.length}</div>
                <div className="card">
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                    <thead><tr style={{ borderBottom:"1px solid #162030" }}>{["Time","Strike","Type","Entry","Exit","P&L","Reason"].map(h => <th key={h} style={{ padding:"8px 12px", color:"#4a6080", textAlign:"left", fontSize:10 }}>{h}</th>)}</tr></thead>
                    <tbody>
                      {paperTrades.slice(0,15).map((t,i) => (
                        <tr key={t.id} style={{ borderBottom:"1px solid #0f1825", opacity:i===0?1:0.7 }}>
                          <td style={{ padding:"6px 12px", color:"#4a6080", fontSize:10 }}>{t.time}</td>
                          <td style={{ padding:"6px 12px", color:"#d4e4f4" }}>{t.strike}</td>
                          <td style={{ padding:"6px 12px", color:t.type==="CE"?"#00e09a":"#ff4560", fontWeight:700 }}>{t.type}</td>
                          <td style={{ padding:"6px 12px", color:"#4a6080" }}>₹{t.entry.toFixed(1)}</td>
                          <td style={{ padding:"6px 12px", color:"#4a6080" }}>₹{t.exit.toFixed(1)}</td>
                          <td style={{ padding:"6px 12px", color:t.pnl>=0?"#00e09a":"#ff4560", fontWeight:700 }}>{t.pnl>=0?"+":""}₹{t.pnl.toLocaleString()}</td>
                          <td style={{ padding:"6px 12px", color:"#4a6080", fontSize:10 }}>{t.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <button className="btn" onClick={() => { setPaperCapital(PAPER_CAPITAL); setPaperPositions([]); setPaperTrades([]); setPaperRealizedPnl(0); setPaperWins(0); setPaperLosses(0); setDailyLoss(0); setDailyLossHit(false); addLog("📝 Paper account reset — ₹1,00,000 restored","system"); }} style={{ background:"#0a1428", border:"1px solid #4a90d960", color:"#4a90d9", padding:"8px 16px", fontSize:11, alignSelf:"flex-start" }}>
              🔄 RESET PAPER ACCOUNT
            </button>
          </div>
        )}

        {/* CHAIN TAB */}
        {mainTab==="chain" && (
          <div className="fade" style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div className="card" style={{ padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10 }}>
              <div>
                <div style={{ fontFamily:"'Teko',sans-serif", fontSize:18, color:"#d4e4f4" }}>OPTION CHAIN · <span style={{ color:"#00e09a" }}>ATM {atm}</span></div>
                <div style={{ fontSize:9, color:"#4a6080" }}>Click CE/PE · Mode: <span style={{ color:paperMode?"#00e09a":"#ff4560" }}>{paperMode?"📝 PAPER":"🔴 LIVE"}</span></div>
              </div>
              {selected && (
                <div style={{ display:"flex", gap:9, alignItems:"center" }}>
                  <span style={{ fontSize:11, color:selected.type==="CE"?"#00e09a":"#ff4560" }}>{selected.strike} {selected.type} @ ₹{selected.premium.toFixed(1)}</span>
                  <button className="btn" onClick={enterFromChain} style={{ background:"#0a2518", border:"1px solid #00e09a60", color:"#00e09a", padding:"7px 14px", fontSize:11 }}>{paperMode?"📝":"✅"} BUY {lots}L</button>
                  <button className="btn" onClick={() => setSelected(null)} style={{ background:"#180a10", border:"1px solid #ff456060", color:"#ff4560", padding:"7px 10px", fontSize:11 }}>✕</button>
                </div>
              )}
            </div>
            <div className="card"><OptionChain spot={price} vix={vix} onSelect={setSelected} /></div>
          </div>
        )}

        {/* LIVE POSITIONS TAB */}
        {mainTab==="positions" && (
          <div className="fade" style={{ display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2 }}>LIVE POSITIONS · {positions.length}</div>
              <div style={{ fontSize:12, color:netPnl>=0?"#00e09a":"#ff4560" }}>Net P&L: {netPnl>=0?"+":""}₹{netPnl.toLocaleString()}</div>
            </div>
            {positions.length===0 ? (
              <div className="card" style={{ padding:"40px", textAlign:"center", color:"#2a4060" }}>No live positions. Switch to 🔴 LIVE mode and enter a trade.</div>
            ) : positions.map(pos => (
              <div key={pos.id} className="card" style={{ padding:"13px 16px", borderColor:pos.color+"30" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10 }}>
                  <div>
                    <div style={{ fontFamily:"'Teko',sans-serif", fontSize:18, color:pos.color }}>{pos.dir} {pos.lots}L · {pos.strike} {pos.type}</div>
                    <div style={{ fontSize:10, color:"#4a6080" }}>Entry ₹{pos.entryPremium.toFixed(1)} · Now ₹{pos.currentPremium.toFixed(1)}</div>
                  </div>
                  <div style={{ display:"flex", gap:14, alignItems:"center" }}>
                    <div style={{ fontFamily:"'Teko',sans-serif", fontSize:20, color:pos.unrealizedPnl>=0?"#00e09a":"#ff4560" }}>{pos.unrealizedPnl>=0?"+":""}₹{pos.unrealizedPnl.toLocaleString()}</div>
                    <button className="btn" onClick={() => exitPos(pos)} style={{ background:"#180a10", border:"1px solid #ff456060", color:"#ff4560", padding:"7px 14px", fontSize:11 }}>EXIT</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* LOG TAB */}
        {mainTab==="log" && (
          <div className="fade">
            <div className="card" style={{ padding:"14px 16px" }}>
              <div style={{ fontSize:9, color:"#2a4060", letterSpacing:2, marginBottom:12 }}>ACTIVITY LOG · {log.length} entries</div>
              {log.length===0 ? <div style={{ color:"#2a4060", fontSize:11 }}>No activity yet.</div> : (
                <div style={{ maxHeight:"65vh", overflowY:"auto" }}>
                  {log.map((l,i) => (
                    <div key={i} style={{ display:"flex", gap:12, padding:"5px 0", borderBottom:"1px solid #0f1825", opacity:i===0?1:0.55 }}>
                      <span style={{ color:"#2a4060", flexShrink:0, fontSize:10 }}>{l.t}</span>
                      <span style={{ color:l.type==="entry"?"#00e09a":l.type==="profit"?"#00d4aa":l.type==="loss"?"#ff4560":l.type==="system"?"#4a90d9":"#7a9ab8", fontSize:10 }}>
                        {l.type==="entry"?"→":l.type==="profit"?"✓":l.type==="loss"?"✗":"·"} {l.msg}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ marginTop:14, fontSize:9, color:"#162030", textAlign:"center", lineHeight:1.8 }}>
          ⚠️ EDUCATIONAL SIMULATOR · Synthetic price data · Not connected to live NSE · Not SEBI-registered advice
        </div>
      </div>
    </div>
  );
}
