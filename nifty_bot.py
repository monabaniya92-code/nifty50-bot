# ============================================================
# NIFTY 50 LIVE TRADING BOT — Python Backend
# ============================================================
# INSTALL KARO: pip install kiteconnect requests schedule
# ============================================================

import time
import requests
import schedule
import logging
from datetime import datetime
from kiteconnect import KiteConnect

# ============================================================
# ⚠️ APNI DETAILS YAHAN BHARO
# ============================================================
KITE_API_KEY     = "75dt81t2xckh34ui"        # Kite API Key
KITE_API_SECRET  = "hl9oljtyyc1oukzcwyqzezes3ohw1iek"     # Kite API Secret
TELEGRAM_TOKEN   = "8778674129:AAg11eqDkTcj71gcivBnizgpri2gw3b5dt8xNsQ4kbDw" # Telegram Bot Token
TELEGRAM_CHAT_ID = "6862991532"        # Telegram Chat ID

# ============================================================
# SETTINGS
# ============================================================
PAPER_MODE       = True    # True=Paper, False=Live
LOT_SIZE         = 75
MAX_LOTS         = 1
DAILY_LOSS_LIMIT = 2000
AUTO_SL_PCT      = 0.35
TARGET_PCT       = 1.0
MARKET_OPEN      = "09:20"
MARKET_CLOSE     = "15:15"

# ============================================================
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
log = logging.getLogger(__name__)
kite = KiteConnect(api_key=KITE_API_KEY)
daily_pnl = 0
open_position = None
is_trading_stopped = False
price_history = []

def send_telegram(message):
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        requests.post(url, data={"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "HTML"}, timeout=10)
    except Exception as e:
        log.error(f"Telegram error: {e}")

def login():
    url = kite.login_url()
    print(f"\nStep 1: Browser mein ye URL kholo:\n{url}\n")
    token = input("Login ke baad request_token paste karo: ").strip()
    try:
        data = kite.generate_session(token, api_secret=KITE_API_SECRET)
        kite.set_access_token(data["access_token"])
        log.info("Login successful!")
        send_telegram("✅ Nifty Bot Started! Zerodha connected.")
        return True
    except Exception as e:
        log.error(f"Login failed: {e}")
        return False

def get_nifty_price():
    try:
        return kite.ltp(["NSE:NIFTY 50"])["NSE:NIFTY 50"]["last_price"]
    except:
        return None

def get_atm(price):
    return round(price / 50) * 50

def calc_signals(prices):
    if len(prices) < 26:
        return None
    def ema(d, p):
        k = 2/(p+1); e = sum(d[:p])/p
        for x in d[p:]: e = x*k + e*(1-k)
        return e
    e9, e21, e50 = ema(prices,9), ema(prices,21), ema(prices,min(50,len(prices)))
    g = l = 0
    for i in range(-14,0):
        d = prices[i]-prices[i-1]
        if d>0: g+=d
        else: l-=d
    rsi = 100 - 100/(1+g/(l or 0.001))
    macd = ema(prices,12)-ema(prices,26)
    bull = bear = 0
    if e9>e21: bull+=2
    else: bear+=2
    if prices[-1]>e50: bull+=2
    else: bear+=2
    if rsi<35: bull+=3
    elif rsi>65: bear+=3
    if macd>0: bull+=2
    else: bear+=2
    if bull>bear+2: return {"dir":"BULLISH","type":"CE","conf":min(95,55+bull*3),"rsi":rsi}
    if bear>bull+2: return {"dir":"BEARISH","type":"PE","conf":min(95,55+bear*3),"rsi":rsi}
    return None

def get_premium(strike, opt):
    try:
        sym = f"NFO:NIFTY26MAY{strike}{opt}"
        return kite.ltp([sym])[sym]["last_price"]
    except:
        return None

def place_order(strike, opt, txn, lots=1):
    qty = lots * LOT_SIZE
    if PAPER_MODE:
        log.info(f"PAPER: {txn} {strike}{opt} x{qty}")
        return {"order_id": f"PAPER_{int(time.time())}"}
    try:
        oid = kite.place_order(variety=kite.VARIETY_REGULAR, exchange=kite.EXCHANGE_NFO,
            tradingsymbol=f"NIFTY26MAY{strike}{opt}", transaction_type=txn,
            quantity=qty, order_type=kite.ORDER_TYPE_MARKET, product=kite.PRODUCT_MIS)
        return {"order_id": oid}
    except Exception as e:
        send_telegram(f"❌ Order failed: {e}")
        return None

def exit_trade(exit_prem, reason):
    global open_position, daily_pnl, is_trading_stopped
    if not open_position: return
    pnl = (exit_prem - open_position["entry"]) * LOT_SIZE * open_position["lots"]
    daily_pnl += pnl
    place_order(open_position["strike"], open_position["type"], "SELL", open_position["lots"])
    send_telegram(f"{'✅' if pnl>=0 else '❌'} EXIT {open_position['strike']}{open_position['type']}\nP&L: ₹{pnl:.0f} | Daily: ₹{daily_pnl:.0f}\n{reason}")
    open_position = None
    if daily_pnl <= -DAILY_LOSS_LIMIT:
        is_trading_stopped = True
        send_telegram(f"⛔ Daily loss ₹{DAILY_LOSS_LIMIT} hit! Trading stopped.")

def check_and_trade():
    global open_position
    if is_trading_stopped: return
    now = datetime.now().strftime("%H:%M")
    if now < MARKET_OPEN or now > MARKET_CLOSE: return
    if open_position:
        prem = get_premium(open_position["strike"], open_position["type"])
        if prem:
            if prem <= open_position["sl"]: exit_trade(prem, "🔴 Stop Loss")
            elif prem >= open_position["target"]: exit_trade(prem, "✅ Target Hit!")
        return
    price = get_nifty_price()
    if not price: return
    price_history.append(price)
    if len(price_history) > 100: price_history.pop(0)
    if len(price_history) < 30: return
    sig = calc_signals(price_history)
    if not sig or sig["conf"] < 65: return
    atm = get_atm(price)
    prem = get_premium(atm, sig["type"])
    if not prem: return
    sl, tgt = prem*(1-AUTO_SL_PCT), prem*(1+TARGET_PCT)
    send_telegram(f"🚨 SIGNAL {'📝PAPER' if PAPER_MODE else '🔴LIVE'}\n{sig['dir']} {atm}{sig['type']}\n💰 Premium: ₹{prem:.1f}\n🛑 SL: ₹{sl:.1f}\n✅ Target: ₹{tgt:.1f}\n📈 RSI: {sig['rsi']:.1f} | Conf: {sig['conf']}%")
    order = place_order(atm, sig["type"], "BUY", MAX_LOTS)
    if order:
        open_position = {"strike":atm,"type":sig["type"],"entry":prem,"sl":sl,"target":tgt,"lots":MAX_LOTS}

def auto_square_off():
    if open_position:
        prem = get_premium(open_position["strike"], open_position["type"])
        if prem: exit_trade(prem, "⏰ Auto Square Off 3:15 PM")
    send_telegram("📊 Market closed. Good night! 🌙")

def daily_report():
    global daily_pnl, is_trading_stopped, price_history
    send_telegram(f"📊 DAILY REPORT\nP&L: ₹{daily_pnl:.0f}\nMode: {'Paper' if PAPER_MODE else 'Live'}\nGood night! 🌙")
    daily_pnl = 0; is_trading_stopped = False; price_history = []

def main():
    print("="*50)
    print(f"NIFTY BOT — {'PAPER' if PAPER_MODE else 'LIVE'} MODE")
    print("="*50)
    if not login(): return
    schedule.every(1).minutes.do(check_and_trade)
    schedule.every().day.at("15:15").do(auto_square_off)
    schedule.every().day.at("15:45").do(daily_report)
    log.info("Bot running! Signals check every minute.")
    while True:
        schedule.run_pending()
        time.sleep(30)

if __name__ == "__main__":
    main()
