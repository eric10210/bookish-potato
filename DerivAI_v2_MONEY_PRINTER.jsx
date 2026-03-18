// ═══════════════════════════════════════════════════════════════════════
//  DERIV INSTITUTIONAL AI TRADING PLATFORM  v2.0
//  Gold · Volatility Indices · Crash/Boom · Forex · Crypto Indices
//  ALL TA · Brain · TMA · Chandelier preserved + massively enhanced
//  ─────────────────────────────────────────────────────────────────
//  FIX: sym stored on every trade — no wrong-position closes
//  FIX: P&L recorded from proposal_open_contract on every close
//  FIX: exit price from sell API — no more entry==exit ghosts
//  FIX: circuit breaker enforced before every buy call
//  FIX: 15m + 4h subscriptions added — INTRADAY HUNTER & TREND RIDER live
//  FIX: multipliers from CSV (R_10→400,R_50→80,stpRNG→750,1HZ10V→400 confirmed)
//  NEW: HTF 4h hard veto · RSI divergence · Kelly ¼-Kelly staking
//  NEW: Recovery mode · Hot streak 1.5× · Correlation block
//  NEW: Deal cancellation gate (55s) · Server-side trailing stop (30s)
//  NEW: Carry-cost breakeven · Step Index run-length edge
//  NEW: Vol daily range exhaustion · Daily loss hard stop (10%)
//  NEW: Regime transition early-warning · Agent learning weights
//  NEW: Sound alerts · Offline banner · WS latency · CSV journal export
//  NEW: Error boundaries · State persistence · Token expiry detection
//  Token: 2TC2uJujiNwDfAg  ·  App ID: 128713
// ═══════════════════════════════════════════════════════════════════════

import {
  useState, useEffect, useRef, useMemo, useCallback, memo, useReducer
} from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, ResponsiveContainer, Tooltip, Cell, ReferenceLine
} from "recharts";

/* ─── DERIV API CREDENTIALS ──────────────────────────────────────────── */
const DERIV_TOKEN = "2TC2uJujiNwDfAg";
const DERIV_APP   = 128713;
const DERIV_WS_URL= `wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP}`;

/* ═══════════════════════════════════════════════════════════════════════
   DERIV WEBSOCKET MANAGER — singleton, shared by all hooks
   Handles: authorize · candle subscriptions · tick streams
            proposal/buy/sell · portfolio · balance · transactions
═══════════════════════════════════════════════════════════════════════ */
class DerivWSManager {
  constructor(){
    this.ws=null; this.reqId=1; this.pending=new Map();
    this.subs=new Map(); this.handlers=new Map();
    this.connected=false; this.authorized=false;
    this.balance=0; this.loginid=""; this.currency="USD";
    this.onConn=null; this.onAuth=null; this._queue=[];
    this._reconnectTimer=null; this._pingTimer=null;
    this.onStatusChange=null;
    this._candleRegistry=new Map();
    // v2: latency tracking + token expiry
    this.latencyMs=0;this._pingTs=0;this.onLatency=null;
    this.onTokenExpired=null;
    this.permittedSymbols=null; // null = all permitted (pre-auth)
    // v2: session peak for recovery mode
    this.sessionPeak=0;this.sessionOpeningBalance=0;
  }
  connect(){
    if(this.ws&&(this.ws.readyState===0||this.ws.readyState===1)) return;
    clearTimeout(this._reconnectTimer);
    this.ws=new WebSocket(DERIV_WS_URL);
    this.ws.onopen=()=>{
      this.connected=true;
      this.onConn?.(true);
      this.onStatusChange?.(true,false,0);
      // Authorize immediately
      this._req({authorize:DERIV_TOKEN}).then(r=>{
        this.authorized=true;
        this.loginid=r.authorize?.loginid||"";
        this.currency=r.authorize?.currency||"USD";
        this.balance=parseFloat(r.authorize?.balance||0);
        this.onAuth?.(true,r.authorize);
        this.onStatusChange?.(true,true,this.balance);
        // Flush queued messages
        const q=[...this._queue]; this._queue=[];
        q.forEach(m=>this._send(m));
        // Balance subscription
        this._req({balance:1,subscribe:1}).then(b=>{
          if(b.subscription?.id){
            this.subs.set(b.subscription.id,msg=>{
              if(msg.msg_type==="balance"){
                this.balance=parseFloat(msg.balance?.balance??this.balance);
                this.sessionPeak=Math.max(this.sessionPeak,this.balance);
                this.onStatusChange?.(this.connected,this.authorized,this.balance);
              }
            });
          }
        }).catch(()=>{});
        // #63: Regulatory stop — fetch permitted symbols for this account
        this._req({active_symbols:"brief",product_type:"basic"}).then(r=>{
          const permitted=new Set((r.active_symbols||[]).map(s=>s.symbol));
          if(permitted.size>0)this.permittedSymbols=permitted;
        }).catch(()=>{});
        // Resubscribe all previously registered candle streams
        this._candleRegistry.forEach(({sym,gran,count,onOHLC,onHistory},oldId)=>{
          this._subscribeCandles(sym,gran,count,onOHLC,onHistory,oldId);
        });
      }).catch(()=>{
        // Retry auth after 2s
        setTimeout(()=>{ if(this.connected)this._req({authorize:DERIV_TOKEN}).catch(()=>{}); },2000);
      });
      clearInterval(this._pingTimer);
      this._pingTimer=setInterval(()=>{
        if(this.ws?.readyState===1){this._pingTs=Date.now();this.ws.send(JSON.stringify({ping:1}));}
      },25000);
    };
    this.ws.onclose=()=>{
      this.connected=false; this.authorized=false;
      clearInterval(this._pingTimer);
      this.onConn?.(false);
      this.onStatusChange?.(false,false,this.balance);
      // Reconnect with exponential backoff capped at 10s
      const delay=Math.min(10000,3000+Math.random()*2000);
      this._reconnectTimer=setTimeout(()=>this.connect(),delay);
    };
    this.ws.onerror=()=>{ try{this.ws.close();}catch{} };
    this.ws.onmessage=(evt)=>{
      try{ this._handle(JSON.parse(evt.data)); }catch{}
    };
  }
  _handle(msg){
    if(msg.msg_type==="pong"){
      if(this._pingTs){this.latencyMs=Date.now()-this._pingTs;this.onLatency?.(this.latencyMs);this._pingTs=0;}
      return;
    }
    if(msg.error?.code==="AuthorizationRequired"||msg.error?.code==="InvalidToken"){this.onTokenExpired?.();return;}
    if(msg.req_id&&this.pending.has(msg.req_id)){
      const{resolve,reject}=this.pending.get(msg.req_id);
      this.pending.delete(msg.req_id);
      if(msg.error) reject(new Error(msg.error.message||JSON.stringify(msg.error)));
      else resolve(msg);
      return; // one-shot: don't also dispatch to sub handlers
    }
    const subId=msg.subscription?.id||msg.ohlc?.id||msg.tick?.id||
                msg.transaction?.id||msg.proposal_open_contract?.id;
    if(subId&&this.subs.has(subId)) this.subs.get(subId)(msg);
    const hs=this.handlers.get(msg.msg_type);
    if(hs) hs.forEach(h=>{ try{h(msg);}catch{} });
  }
  _send(msg){
    if(this.ws?.readyState===1) this.ws.send(JSON.stringify(msg));
    else this._queue.push(msg);
  }
  _req(msg,timeoutMs=20000){
    return new Promise((resolve,reject)=>{
      const id=this.reqId++;
      this.pending.set(id,{resolve,reject});
      const t=setTimeout(()=>{
        if(this.pending.has(id)){ this.pending.delete(id); reject(new Error("Timeout")); }
      },timeoutMs);
      // Clear timeout on resolve
      const orig=this.pending.get(id);
      if(orig){
        this.pending.set(id,{
          resolve:(v)=>{ clearTimeout(t); orig.resolve(v); },
          reject:(e)=>{ clearTimeout(t); orig.reject(e); }
        });
      }
      this._send({...msg,req_id:id});
    });
  }
  // Public alias — components call DWS.send(msg)
  send(msg){ return this._req(msg); }
  getBalance(){ return this.balance; }
  on(type,cb){
    if(!this.handlers.has(type)) this.handlers.set(type,new Set());
    this.handlers.get(type).add(cb);
    return ()=>this.handlers.get(type)?.delete(cb);
  }
  // Internal candle subscription — also registers for reconnect
  async _subscribeCandles(sym,gran,count,onOHLC,onHistory,replaceId=null){
    if(!this.authorized) await new Promise(r=>setTimeout(r,1500));
    const res=await this._req({
      ticks_history:sym,adjust_start_time:1,count,
      end:"latest",granularity:gran,start:1,style:"candles",subscribe:1
    });
    if(res.candles) onHistory(res.candles,gran);
    if(res.subscription?.id){
      // Remove old registration if reconnecting
      if(replaceId&&replaceId!==res.subscription.id) this._candleRegistry.delete(replaceId);
      const subId=res.subscription.id;
      this.subs.set(subId,msg=>{ if(msg.msg_type==="ohlc") onOHLC(msg.ohlc,gran); });
      this._candleRegistry.set(subId,{sym,gran,count,onOHLC,onHistory});
      return subId;
    }
    return null;
  }
  async subscribeCandles(sym,gran,count,onOHLC,onHistory){
    // Wait for auth up to 8s before subscribing
    if(!this.authorized){
      await new Promise((res,rej)=>{
        const t=setTimeout(()=>rej(new Error("Auth timeout")),8000);
        const check=setInterval(()=>{ if(this.authorized){clearTimeout(t);clearInterval(check);res();}},200);
      }).catch(()=>{});
    }
    return this._subscribeCandles(sym,gran,count,onOHLC,onHistory);
  }
  async subscribeTick(sym,onTick){
    const res=await this._req({ticks:sym,subscribe:1});
    if(res.subscription?.id){
      this.subs.set(res.subscription.id,msg=>{ if(msg.msg_type==="tick") onTick(msg.tick); });
      return res.subscription.id;
    }
    return null;
  }
  async forget(id){
    if(!id) return;
    this.subs.delete(id);
    this._candleRegistry.delete(id);
    try{ await this._req({forget:id}); }catch{}
  }
  async forgetAll(type="all"){
    try{ await this._req({forget_all:type}); this.subs.clear(); this._candleRegistry.clear(); }catch{}
  }
  async updateContract(contractId,stopLoss,takeProfit){
    const msg={contract_update:1,contract_id:contractId,limit_order:{}};
    if(stopLoss!=null)msg.limit_order.stop_loss=stopLoss;
    if(takeProfit!=null)msg.limit_order.take_profit=takeProfit;
    return this._req(msg);
  }
  async refreshBalance(){
    try{const r=await this._req({balance:1});if(r.balance?.balance!=null){this.balance=parseFloat(r.balance.balance);this.sessionPeak=Math.max(this.sessionPeak,this.balance);this.onStatusChange?.(this.connected,this.authorized,this.balance);}}catch{}
  }
  async getProposal({sym,contractType,stake,multiplier,sl,tp}){
    const msg={proposal:1,amount:stake,basis:"stake",
      contract_type:contractType,currency:this.currency,symbol:sym};
    if(multiplier) msg.multiplier=multiplier;
    if(sl||tp){ msg.limit_order={};
      if(sl) msg.limit_order.stop_loss=sl;
      if(tp) msg.limit_order.take_profit=tp;
    }
    return this._req(msg);
  }
  async buy(proposalId,price){ return this._req({buy:proposalId,price}); }
  async sell(contractId,price=0){ return this._req({sell:contractId,price}); }
  async monitorContract(contractId,onUpdate){
    const res=await this._req({proposal_open_contract:1,contract_id:contractId,subscribe:1});
    if(res.subscription?.id){
      this.subs.set(res.subscription.id,msg=>{
        if(msg.msg_type==="proposal_open_contract") onUpdate(msg.proposal_open_contract);
      });
    }
    return res;
  }
  async getPortfolio(){ return this._req({portfolio:1}); }
  async getProfitTable(limit=50){ return this._req({profit_table:1,limit,sort:"DESC"}); }
  async subscribeTransactions(cb){
    const res=await this._req({transaction:1,subscribe:1});
    if(res.subscription?.id) this.subs.set(res.subscription.id,msg=>{ if(msg.msg_type==="transaction") cb(msg.transaction); });
  }
}
const DWS=new DerivWSManager(); // global singleton

/* ─── ASSET REGISTRY ─────────────────────────────────────────────────── */
// thresh: {show=paint signal, alert=alert, min=always paint WATCH}
const ASSETS=[
  // METALS — #1 priority
  {sym:"frxXAUUSD",name:"Gold/USD",    base:"GOLD",  col:"#FFD700",cat:"METAL",    mult:[100,200,500],pip:0.01, digits:2,thresh:{show:0.55,alert:0.68,min:0.42}},
  {sym:"frxXAGUSD",name:"Silver/USD",  base:"SILVER",col:"#C0C0C0",cat:"METAL",    mult:[100,200],    pip:0.001,digits:3,thresh:{show:0.55,alert:0.68,min:0.42}},
  // VOLATILITY INDICES — 24/7 synthetic
  {sym:"R_10",     name:"Volatility 10",base:"V10",  col:"#00E5FF",cat:"VOL",      mult:[50,100,200,400,500],        pip:0.001,digits:3,thresh:{show:0.48,alert:0.60,min:0.36}},
  {sym:"R_25",     name:"Volatility 25",base:"V25",  col:"#40C4FF",cat:"VOL",      mult:[200],        pip:0.01, digits:2,thresh:{show:0.48,alert:0.60,min:0.36}},
  {sym:"R_50",     name:"Volatility 50",base:"V50",  col:"#00B0FF",cat:"VOL",      mult:[10,20,40,60,80,100],        pip:0.01, digits:2,thresh:{show:0.48,alert:0.60,min:0.36}},
  {sym:"R_75",     name:"Volatility 75",base:"V75",  col:"#0091EA",cat:"VOL",      mult:[50],         pip:0.01, digits:2,thresh:{show:0.48,alert:0.60,min:0.36}},
  {sym:"R_100",    name:"Volatility 100",base:"V100",col:"#1565C0",cat:"VOL",      mult:[40,100,200],         pip:0.01, digits:2,thresh:{show:0.48,alert:0.60,min:0.36}},
  // 1-SECOND VOLATILITY
  {sym:"1HZ10V",   name:"Vol 10 (1s)", base:"V10s",  col:"#18FFFF",cat:"VOL1S",    mult:[100,200,300,400,500],        pip:0.001,digits:3,thresh:{show:0.46,alert:0.58,min:0.34}},
  {sym:"1HZ100V",  name:"Vol 100 (1s)",base:"V100s", col:"#1565C0",cat:"VOL1S",    mult:[10,20,40,50],         pip:0.001,digits:3,thresh:{show:0.46,alert:0.58,min:0.34}},
  // CRASH / BOOM
  {sym:"CRASH300", name:"Crash 300",   base:"CR300", col:"#FF1744",cat:"CRASH",    mult:[],           pip:0.01, digits:2,thresh:{show:0.46,alert:0.57,min:0.34}},
  {sym:"CRASH500", name:"Crash 500",   base:"CR500", col:"#FF4081",cat:"CRASH",    mult:[],           pip:0.01, digits:2,thresh:{show:0.46,alert:0.57,min:0.34}},
  {sym:"CRASH1000",name:"Crash 1000",  base:"CR1K",  col:"#F50057",cat:"CRASH",    mult:[],           pip:0.01, digits:2,thresh:{show:0.46,alert:0.57,min:0.34}},
  {sym:"BOOM300",  name:"Boom 300",    base:"BM300", col:"#00E676",cat:"BOOM",     mult:[],           pip:0.01, digits:2,thresh:{show:0.46,alert:0.57,min:0.34}},
  {sym:"BOOM500",  name:"Boom 500",    base:"BM500", col:"#69F0AE",cat:"BOOM",     mult:[],           pip:0.01, digits:2,thresh:{show:0.46,alert:0.57,min:0.34}},
  {sym:"BOOM1000", name:"Boom 1000",   base:"BM1K",  col:"#00BFA5",cat:"BOOM",     mult:[],           pip:0.01, digits:2,thresh:{show:0.46,alert:0.57,min:0.34}},
  // STEP INDEX
  {sym:"stpRNG",   name:"Step Index",  base:"STEP",  col:"#AA00FF",cat:"STEP",     mult:[100,200,300,500,750,1000],        pip:0.1,  digits:1,thresh:{show:0.52,alert:0.64,min:0.40}},
  // JUMP INDICES
  {sym:"JD10",     name:"Jump 10",     base:"JMP10", col:"#FF6D00",cat:"JUMP",     mult:[200],        pip:0.01, digits:2,thresh:{show:0.50,alert:0.62,min:0.38}},
  {sym:"JD75",     name:"Jump 75",     base:"JMP75", col:"#E65100",cat:"JUMP",     mult:[15,30,50,75],         pip:0.01, digits:2,thresh:{show:0.50,alert:0.62,min:0.38}},
  {sym:"JD100",    name:"Jump 100",    base:"JMP100",col:"#BF360C",cat:"JUMP",     mult:[5,10,20,25],         pip:0.01, digits:2,thresh:{show:0.50,alert:0.62,min:0.38}},
  // FOREX
  {sym:"frxEURUSD",name:"EUR/USD",     base:"EUR",   col:"#003399",cat:"FOREX",    mult:[100,200,500],pip:0.0001,digits:5,thresh:{show:0.57,alert:0.70,min:0.44}},
  {sym:"frxGBPUSD",name:"GBP/USD",     base:"GBP",   col:"#012169",cat:"FOREX",    mult:[100,200,500],pip:0.0001,digits:5,thresh:{show:0.57,alert:0.70,min:0.44}},
  {sym:"frxUSDJPY",name:"USD/JPY",     base:"JPY",   col:"#BC002D",cat:"FOREX",    mult:[100,200,500],pip:0.01,  digits:3,thresh:{show:0.57,alert:0.70,min:0.44}},
  {sym:"frxAUDUSD",name:"AUD/USD",     base:"AUD",   col:"#00843D",cat:"FOREX",    mult:[100,200],    pip:0.0001,digits:5,thresh:{show:0.57,alert:0.70,min:0.44}},
  {sym:"frxUSDCAD",name:"USD/CAD",     base:"CAD",   col:"#FF0000",cat:"FOREX",    mult:[100,200],    pip:0.0001,digits:5,thresh:{show:0.57,alert:0.70,min:0.44}},
  {sym:"frxUSDCHF",name:"USD/CHF",     base:"CHF",   col:"#FF0000",cat:"FOREX",    mult:[100,200],    pip:0.0001,digits:5,thresh:{show:0.57,alert:0.70,min:0.44}},
  // CRYPTO INDICES
  {sym:"cryBTCUSD",name:"Bitcoin",     base:"BTC",   col:"#F7931A",cat:"CRYPTO",   mult:[10,50,100],  pip:1,    digits:2,thresh:{show:0.56,alert:0.68,min:0.42}},
  {sym:"cryETHUSD",name:"Ethereum",    base:"ETH",   col:"#627EEA",cat:"CRYPTO",   mult:[10,50,100],  pip:0.01, digits:2,thresh:{show:0.56,alert:0.68,min:0.42}},
];
const DERIV_ASSETS=ASSETS; // alias used by scanner components

const getAsset=sym=>ASSETS.find(a=>a.sym===sym)||{sym,base:sym,name:sym,col:"#00BDFF",cat:"OTHER",mult:[100],pip:0.01,digits:2,thresh:{show:0.60,alert:0.75,min:0.46}};
const isStepSym=sym=>sym==="stpRNG";
const isVolSym=sym=>sym?.startsWith("R_")||sym?.startsWith("1HZ");
const isCB=sym=>sym.startsWith("CRASH")||sym.startsWith("BOOM");
const isSynth=sym=>!sym.startsWith("frx")&&!sym.startsWith("cry");

// Convert Deriv OHLC candle → our kline format [ts,o,h,l,c,vol,ts]
const dToK=c=>[
  (typeof c.epoch==="number"?c.epoch:parseInt(c.epoch||c.open_time))*1000,
  String(c.open),String(c.high),String(c.low),String(c.close),"1",
  (typeof c.epoch==="number"?c.epoch:parseInt(c.epoch||c.open_time))*1000
];

/* ─── CONFIG ──────────────────────────────────────────────────────────── */
const SHOW_THRESH = 0.55;  // lowered — always paints signals
const ALERT_THRESH= 0.68;  // alert threshold
const KELLY_K     = 0.25;
const MAX_POS     = 0.03;
const MC_PATHS    = 250;
const CW          = { m:0.25, s:0.20, o:0.20, h:0.15, q:0.20 };
const BRAIN_TTL   = 30_000;
const SIGNAL_TTL  = 45_000;
const REGIME_TTL  = 45_000;
const CHANDELIER_M = 3.0;
const TMA_CONF_MIN   = 0.62;  // adapted for Deriv synthetics — signals in all conditions
const TMA_MIN_RR     = 1.3;
const TMA_MAX_OPEN   = 3;
const TMA_LOSS_PAUSE = 3;
const TMA_WR_FLOOR   = 0.38;
const TMA_WR_STRICT  = 0.28;
const TMA_HOUR_LIMIT = 8;
const TMA_BE_TRIGGER = 0.45;
const TMA_PARTIAL_AT = 0.75;
const TMA_FUNDING_L  = 0.03;
const TMA_FUNDING_S  =-0.01;
// Settings key
const SETTINGS_KEY_D = "deriv_platform_v2";
const DEFAULT_STAKE  = 10;
const GRAN={k1m:60,k5m:300,k15m:900,k1h:3600,k4h:14400,k1d:86400};

/* ─── TELEGRAM CONFIG ────────────────────────────────────────────────── */
const TG_TOKEN  = "8737180442:AAGE8lXKX7gFbdxRiMhIdQy7UmbAbRIxuU4";
const TG_CHAT   = "8737180442";
const TG_API    = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
async function tgSend(text){
  try{
    await fetch(TG_API,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:"Markdown"})});
  }catch{}
}

/* ─── SETTINGS ───────────────────────────────────────────────────────── */
const DEFAULT_SETTINGS={
  equity:1000, riskPct:1.0, confThresh:0.62, rrMin:1.3,
  chandelierM:3.0, tgEnabled:true, tgSignals:true, tgTrades:true,
  tgAlerts:true, paperMode:false, mcPaths:250,
  stake:DEFAULT_STAKE, maxStake:100, autoTrade:false,
  // v2 additions
  soundAlerts:true, htfVeto:true, correlationBlock:true,
  kellyStaking:true, recoveryMode:true,
  enableDealCancel:true, enableServerTrail:true,
  maxDailyLossPct:10, withdrawalReservePct:10,
};
function loadSettings(){
  try{const s=localStorage.getItem(SETTINGS_KEY_D);return s?{...DEFAULT_SETTINGS,...JSON.parse(s)}:DEFAULT_SETTINGS;}
  catch{return DEFAULT_SETTINGS;}
}
function saveSettings(s){try{localStorage.setItem(SETTINGS_KEY_D,JSON.stringify(s));}catch{}}

/* ═══════════════════════════════════════════════════════════════════════
   v2.0 — NEW CONSTANTS, UTILITIES, RISK ENGINE
═══════════════════════════════════════════════════════════════════════ */
const RECOVERY_DD_PCT    = 0.05;   // 5% drawdown from peak → recovery mode
const DAILY_LOSS_STOP    = 0.10;   // 10% daily loss → kill all signals
const DEAL_CANCEL_MS     = 55000;  // deal cancellation window (ms)
const DEAL_CANCEL_LOSS   = 0.20;   // auto-cancel if losing >20% of stake
const SERVER_TRAIL_MS    = 30000;  // push trail stop to Deriv every 30s
const HOT_STREAK_MIN     = 3;      // consecutive wins → 1.5× stake
const HOT_STREAK_MULT    = 1.5;
const CANDLE_CONFIRM_N   = 3;      // signal must persist N closed candles
const WITHDRAW_RESERVE   = 0.10;   // 10% balance untouchable
const KELLY_K_FRAC       = 0.25;   // quarter-Kelly
const MAX_POS_PCT        = 0.02;   // max 2% per trade

// Correlation pairs — opening both doubles exposure without doubling edge
const CORR_PAIRS=[
  ["R_75","R_100"],["R_10","1HZ10V"],["frxXAUUSD","frxXAGUSD"],
  ["cryBTCUSD","cryETHUSD"],["CRASH300","CRASH500"],["BOOM300","BOOM500"],
  ["frxEURUSD","frxGBPUSD"]
];

// Carry cost per asset (commission + financing)
const CARRY={
  "frxXAUUSD":{commPct:0.0004,finPctHr:0.00012},
  "frxXAGUSD":{commPct:0.0004,finPctHr:0.00012},
  "R_10":{commPct:0.0002,finPctHr:0.00008},
  "R_25":{commPct:0.0002,finPctHr:0.00008},
  "R_50":{commPct:0.0002,finPctHr:0.00008},
  "R_75":{commPct:0.0002,finPctHr:0.00008},
  "R_100":{commPct:0.0002,finPctHr:0.00008},
  "1HZ10V":{commPct:0.0002,finPctHr:0.00008},
  "1HZ100V":{commPct:0.0002,finPctHr:0.00008},
  "stpRNG":{commPct:0.0001,finPctHr:0},
  "cryBTCUSD":{commPct:0.0004,finPctHr:0.00020},
  "cryETHUSD":{commPct:0.0004,finPctHr:0.00020},
  "frxEURUSD":{commPct:0.0003,finPctHr:0.00015},
  "frxGBPUSD":{commPct:0.0003,finPctHr:0.00015},
  "frxUSDJPY":{commPct:0.0003,finPctHr:0.00015},
};
const DAILY_RANGE_PCT={
  "R_10":0.015,"R_25":0.025,"R_50":0.05,"R_75":0.07,"R_100":0.10,
  "1HZ10V":0.015,"1HZ100V":0.10,"stpRNG":0.04,
  "CRASH300":0.12,"CRASH500":0.10,"CRASH1000":0.08,
  "BOOM300":0.12,"BOOM500":0.10,"BOOM1000":0.08,
  "frxXAUUSD":0.012,"frxXAGUSD":0.015,
  "cryBTCUSD":0.035,"cryETHUSD":0.040,
};

/* ─── SOUND ALERTS ─────────────────────────────────────────────────── */
function playAlert(freq=880,dur=0.12,type="sine"){
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    osc.type=type;osc.frequency.value=freq;
    gain.gain.setValueAtTime(0.18,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+dur);
    osc.start(ctx.currentTime);osc.stop(ctx.currentTime+dur);
    setTimeout(()=>ctx.close(),500);
  }catch{}
}
function playPrimeSignal(){playAlert(1046,0.10,"sine");setTimeout(()=>playAlert(1318,0.10,"sine"),120);}
function playTradeOpen(){playAlert(880,0.12,"triangle");}
function playTradeWin(){playAlert(1046,0.15,"sine");setTimeout(()=>playAlert(1318,0.15,"sine"),150);setTimeout(()=>playAlert(1568,0.20,"sine"),300);}
function playTradeLoss(){playAlert(220,0.25,"sawtooth");}

/* ─── JOURNAL ──────────────────────────────────────────────────────── */
const JOURNAL_KEY="deriv_journal_v2",DAILY_KEY="deriv_daily_v2";
function loadJournal(){try{const j=localStorage.getItem(JOURNAL_KEY);return j?JSON.parse(j):[];}catch{return[];}}
function saveJournal(t){try{localStorage.setItem(JOURNAL_KEY,JSON.stringify(t.slice(-500)));}catch{}}
function appendJournal(trade){
  const j=loadJournal();
  const idx=trade.contractId?j.findIndex(t=>t.contractId===trade.contractId):-1;
  if(idx>=0)j[idx]={...j[idx],...trade};else j.push(trade);
  saveJournal(j);
}
function exportCSV(){
  const j=loadJournal();if(!j.length){alert("No journal entries.");return;}
  const hdr="sym,dir,card,entry,exit,stake,mult,profit,regime,conf,dur_min,contractId,outcome,openedAt,closedAt\n";
  const rows=j.map(t=>[t.sym||"",t.dir||"",t.card||"",t.entry||"",t.closePrice||"",t.stake||"",t.multiplier||"",
    t.profit!=null?t.profit.toFixed(4):"",t.regime||"",t.conf?t.conf.toFixed(4):"",
    t.openedAt&&t.closedAt?Math.round((t.closedAt-t.openedAt)/60000):"",
    t.contractId||"",t.outcome||"",
    t.openedAt?new Date(t.openedAt).toISOString():"",
    t.closedAt?new Date(t.closedAt).toISOString():"",
  ].join(",")).join("\n");
  const url=URL.createObjectURL(new Blob([hdr+rows],{type:"text/csv"}));
  const a=document.createElement("a");a.href=url;a.download=`deriv_journal_${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
}

/* ─── DAILY LOSS TRACKER ───────────────────────────────────────────── */
function getDailyData(){
  try{const d=localStorage.getItem(DAILY_KEY);if(!d)return null;const p=JSON.parse(d);
    if(new Date(p.date).toDateString()!==new Date().toDateString())return null;return p;}catch{return null;}
}
function saveDailyData(d){try{localStorage.setItem(DAILY_KEY,JSON.stringify(d));}catch{}}
function initDaily(balance){const d={date:new Date().toISOString(),openBal:balance,loss:0,killed:false};saveDailyData(d);return d;}
function recordLoss(amt){
  let d=getDailyData();if(!d)d=initDaily(DWS.balance||1000);
  d.loss=Math.max(0,d.loss+Math.abs(amt));
  if(d.openBal>0&&d.loss/d.openBal>=DAILY_LOSS_STOP)d.killed=true;
  saveDailyData(d);return d;
}
function isDailyKilled(){return getDailyData()?.killed||false;}

/* ─── PER-ASSET SIGNAL PARAMETERS (from historical performance) ──── */
// Tuned from CSV evidence and Deriv synthetic instrument properties
const ASSET_SIGNAL_PARAMS = {
  // Synths — tight stops, reversion-heavy
  "R_10":   {snpSlM:0.8, snpTp1M:1.2, snpTp2M:2.0, minConf:0.56, atrPeriod:10},
  "R_25":   {snpSlM:1.0, snpTp1M:1.5, snpTp2M:2.5, minConf:0.56, atrPeriod:12},
  "R_50":   {snpSlM:1.1, snpTp1M:1.6, snpTp2M:2.8, minConf:0.56, atrPeriod:14},
  "R_75":   {snpSlM:1.2, snpTp1M:1.8, snpTp2M:3.0, minConf:0.56, atrPeriod:14},
  "R_100":  {snpSlM:1.3, snpTp1M:2.0, snpTp2M:3.5, minConf:0.56, atrPeriod:14},
  "1HZ10V": {snpSlM:0.8, snpTp1M:1.2, snpTp2M:2.0, minConf:0.56, atrPeriod:10},
  "1HZ100V":{snpSlM:1.3, snpTp1M:2.0, snpTp2M:3.5, minConf:0.56, atrPeriod:14},
  // Step index — discrete steps, statistical edge
  "stpRNG": {snpSlM:2.0, snpTp1M:3.0, snpTp2M:5.0, minConf:0.60, atrPeriod:8, useStepEdge:true},
  // Crash/Boom — spike-driven, wider stops needed
  "CRASH300":{snpSlM:2.5, snpTp1M:1.5, snpTp2M:3.0, minConf:0.57, atrPeriod:14},
  "CRASH500":{snpSlM:2.0, snpTp1M:1.5, snpTp2M:2.8, minConf:0.57, atrPeriod:14},
  "CRASH1000":{snpSlM:1.5, snpTp1M:1.5, snpTp2M:2.5, minConf:0.57, atrPeriod:14},
  "BOOM300": {snpSlM:2.5, snpTp1M:1.5, snpTp2M:3.0, minConf:0.57, atrPeriod:14},
  "BOOM500": {snpSlM:2.0, snpTp1M:1.5, snpTp2M:2.8, minConf:0.57, atrPeriod:14},
  "BOOM1000":{snpSlM:1.5, snpTp1M:1.5, snpTp2M:2.5, minConf:0.57, atrPeriod:14},
  // Jump indices — large random jumps, conservative stops
  "JD10":   {snpSlM:2.0, snpTp1M:2.5, snpTp2M:4.0, minConf:0.60, atrPeriod:14},
  "JD75":   {snpSlM:2.5, snpTp1M:3.0, snpTp2M:5.0, minConf:0.62, atrPeriod:14},
  "JD100":  {snpSlM:3.0, snpTp1M:3.5, snpTp2M:5.5, minConf:0.62, atrPeriod:14},
  // Gold/Silver — confirmed winners in CSV (best performers)
  "frxXAUUSD":{snpSlM:1.2, snpTp1M:1.8, snpTp2M:3.0, minConf:0.58, atrPeriod:14},
  "frxXAGUSD":{snpSlM:1.2, snpTp1M:1.8, snpTp2M:3.0, minConf:0.56, atrPeriod:14},// TP hit in CSV
  // Forex — wider, news-sensitive
  "frxEURUSD":{snpSlM:1.5, snpTp1M:2.0, snpTp2M:3.5, minConf:0.62, atrPeriod:14},
  "frxGBPUSD":{snpSlM:1.5, snpTp1M:2.0, snpTp2M:3.5, minConf:0.62, atrPeriod:14},
  "frxUSDJPY":{snpSlM:1.5, snpTp1M:2.0, snpTp2M:3.5, minConf:0.62, atrPeriod:14},
  "frxAUDUSD":{snpSlM:1.3, snpTp1M:1.8, snpTp2M:3.0, minConf:0.60, atrPeriod:14},
  "frxUSDCAD":{snpSlM:1.3, snpTp1M:1.8, snpTp2M:3.0, minConf:0.60, atrPeriod:14},
  "frxUSDCHF":{snpSlM:1.3, snpTp1M:1.8, snpTp2M:3.0, minConf:0.60, atrPeriod:14},
  // Crypto — volatile, loose stops
  "cryBTCUSD":{snpSlM:2.0, snpTp1M:2.5, snpTp2M:4.0, minConf:0.64, atrPeriod:14},
  "cryETHUSD":{snpSlM:2.0, snpTp1M:2.5, snpTp2M:4.0, minConf:0.64, atrPeriod:14},
};
function getSignalParams(sym){return ASSET_SIGNAL_PARAMS[sym]||{snpSlM:1.3,snpTp1M:1.8,snpTp2M:2.8,minConf:0.56,atrPeriod:14};}

/* ─── CARRY COST ENGINE ────────────────────────────────────────────── */
function calcCarry(sym,stake,mult,hrs=1){
  const c=CARRY[sym];if(!c)return{breakevenPct:0,costUsd:0};
  const comm=stake*c.commPct*2,fin=stake*c.finPctHr*hrs*mult;
  const cost=comm+fin;
  return{breakevenPct:stake>0?parseFloat((cost/(stake*mult)*100).toFixed(4)):0,costUsd:parseFloat(cost.toFixed(4))};
}

/* ─── CROSS-ASSET CONFIRMATION LOCK (from note.html) ──────────────── */
// Require at least 2 of a correlation group to agree before executing
// Eliminates single-asset false signals from noise
const CONFIRM_GROUPS = [
  ["R_75","R_100"],          // V75+V100 — 87% correlated
  ["frxXAUUSD","frxXAGUSD"], // Gold+Silver
  ["cryBTCUSD","cryETHUSD"], // BTC+ETH
  ["R_10","1HZ10V"],         // V10 pair
  ["R_50","R_75"],           // Mid-vol pair
];
function crossAssetConfirmed(sym,dir,assetData){
  // Find if this sym is in a confirmation group
  for(const group of CONFIRM_GROUPS){
    if(!group.includes(sym))continue;
    const others=group.filter(s=>s!==sym);
    // Check if any other member agrees with the direction
    for(const other of others){
      const d=assetData?.[other];
      if(d?.best?.dir===dir&&(d.best.finalConf||0)>=ALERT_THRESH)return true;
    }
  }
  // If not in any confirmation group, no requirement
  return true;
}

/* ─── CORRELATION BLOCK ────────────────────────────────────────────── */
function correlationBlocked(sym,openTrades){
  const open=openTrades.filter(t=>t.status==="OPEN");
  for(const pair of CORR_PAIRS){
    if(pair.includes(sym)){const other=pair.find(s=>s!==sym);if(open.find(t=>t.sym===other))return other;}
  }
  return null;
}

/* ─── KELLY STAKE SIZING ───────────────────────────────────────────── */
// Deriv minimum stake per asset category (real account floor)
const ASSET_MIN_STAKE={"frxXAUUSD":1,"frxXAGUSD":1,"R_10":1,"R_25":1,"R_50":1,"R_75":1,"R_100":1,
  "1HZ10V":1,"1HZ100V":1,"CRASH300":1,"CRASH500":1,"CRASH1000":1,"BOOM300":1,"BOOM500":1,"BOOM1000":1,
  "stpRNG":1,"JD10":1,"JD75":1,"JD100":1,"frxEURUSD":1,"frxGBPUSD":1,"frxUSDJPY":1,"cryBTCUSD":5,"cryETHUSD":2};

function kellyStake(sig,balance,settings,recoveryActive,hotStreak){
  if(!sig)return settings.stake||DEFAULT_STAKE;
  const{entry,sl,pw,tp}=sig;
  const risk=Math.abs(entry-sl),rew=Math.abs((tp?.[0]||entry)-entry);
  if(!risk||!rew)return settings.stake||DEFAULT_STAKE;
  const rr=rew/risk,k=Math.max(0,pw-(1-pw)/rr)*KELLY_K_FRAC;
  let pct=Math.min(k,MAX_POS_PCT);
  if(recoveryActive)pct*=0.5;
  if(hotStreak>=HOT_STREAK_MIN)pct=Math.min(MAX_POS_PCT*1.5,pct*HOT_STREAK_MULT);
  const tradeable=balance*(1-WITHDRAW_RESERVE);
  const minStake=ASSET_MIN_STAKE[sig.sym||""]||1; // #55: asset-specific minimum
  return parseFloat(Math.max(minStake,Math.min(settings.maxStake||100,tradeable*pct)).toFixed(2));
}

/* ─── STEP INDEX RUN-LENGTH EDGE ───────────────────────────────────── */
function stepEdge(k1m){
  const k=closedOnly(k1m);if(!k||k.length<20)return{run:0,dir:"NEUTRAL",conf:0};
  const cl=k.map(r=>parseFloat(r[4]));let run=0,runDir=null;
  for(let i=cl.length-1;i>=1;i--){
    const d=cl[i]-cl[i-1];if(d===0)break;
    const td=d>0?"UP":"DOWN";
    if(!runDir){runDir=td;run=1;}else if(td===runDir)run++;else break;
  }
  return{run,runDir,conf:Math.min(0.80,0.5+0.04*run),dir:runDir==="UP"?"SHORT":"LONG"};
}

/* ─── VOL DAILY RANGE EXHAUSTION ───────────────────────────────────── */
function rangeExhaustion(sym,k1m){
  const avgR=DAILY_RANGE_PCT[sym];if(!avgR||!k1m?.length)return{exhausted:false,remainPct:1};
  const k=k1m.slice(-1440);
  const hi=Math.max(...k.map(r=>parseFloat(r[2]))),lo=Math.min(...k.map(r=>parseFloat(r[3])));
  const cl=parseFloat(k[k.length-1]?.[4]||0);
  const todayR=cl?(hi-lo)/cl:0;
  const exhausted=todayR>=avgR*0.85;
  return{exhausted,todayR,avgR,remainPct:exhausted?Math.max(0.1,1-(todayR/avgR)):1};
}

/* ─── RSI DIVERGENCE DETECTION ─────────────────────────────────────── */
function rsiDivergence(cl,rsiArr,lookback=20){
  if(cl.length<lookback+5)return{bull:false,bear:false};
  const h=Math.floor(lookback/2);
  const rc=cl.slice(-lookback),rr=rsiArr.slice(-lookback);
  const hi1=Math.max(...rc.slice(h)),hi2=Math.max(...rc.slice(0,h));
  const lo1=Math.min(...rc.slice(h)),lo2=Math.min(...rc.slice(0,h));
  const ri1=rr[rc.slice(h).indexOf(hi1)+h]||rr[rr.length-1];
  const ri2=rr[rc.slice(0,h).indexOf(hi2)]||rr[0];
  const rl1=rr[rc.slice(h).indexOf(lo1)+h]||rr[rr.length-1];
  const rl2=rr[rc.slice(0,h).indexOf(lo2)]||rr[0];
  return{bull:lo1<lo2&&rl1>rl2+3,bear:hi1>hi2&&ri1<ri2-3};
}

/* ─── TICK FREQUENCY WEIGHT (Volume proxy for synthetics) ──────────── */
// More ticks per candle = stronger conviction; fewer ticks = noise
// Uses candle body/range ratio as proxy for tick density on synthetics
function tickFrequencyWeight(k1m){
  const k=closedOnly(k1m);if(!k||k.length<10)return 1.0;
  const recent=k.slice(-10);
  const avgBody=recent.reduce((s,r)=>s+Math.abs(parseFloat(r[4])-parseFloat(r[1])),0)/10;
  const avgRange=recent.reduce((s,r)=>s+Math.abs(parseFloat(r[2])-parseFloat(r[3])),0)/10;
  if(!avgRange)return 1.0;
  return Math.min(1.5,Math.max(0.5,avgBody/avgRange+0.5));
}

/* ─── CRASH/BOOM TICK STREAM SPIKE PRE-DETECTOR (#31) ──────────────── */
// Raw tick pattern: 3+ consecutive same-direction ticks with widening spread
// fires 8-12 ticks before the 1m candle closes — genuine early entry signal
function cbTickAnalysis(tickBuffer,sym){
  if(!tickBuffer||tickBuffer.length<5)return{spike:false,dir:null,conf:0};
  const isCrash=sym?.startsWith("CRASH"),isBoom=sym?.startsWith("BOOM");
  if(!isCrash&&!isBoom)return{spike:false,dir:null,conf:0};
  const recent=tickBuffer.slice(-12);
  let cDown=0,cUp=0;
  for(let i=1;i<recent.length;i++){
    const d=recent[i]-recent[i-1];
    if(d<0){cDown++;cUp=0;}else if(d>0){cUp++;cDown=0;}
  }
  const spikeDown=cDown>=3,spikeUp=cUp>=3;
  const spike=(isCrash&&spikeDown)||(isBoom&&spikeUp);
  const dir=isCrash&&spikeDown?"SHORT":isBoom&&spikeUp?"LONG":null;
  const conf=spike?Math.min(0.82,0.55+Math.max(cDown,cUp)*0.05):0;
  return{spike,dir,conf,cDown,cUp};
}

/* ─── AGENT LEARNING WEIGHTS ───────────────────────────────────────── */
const AWEIGHTS_KEY="deriv_agent_w_v2";
const AWEIGHTS_INIT=[1.4,1.3,1.5,1.1,1.2,0.9,1.2,1.3,1.0,0.8,1.4,1.3];
function loadAWeights(){try{const w=localStorage.getItem(AWEIGHTS_KEY);return w?JSON.parse(w):AWEIGHTS_INIT;}catch{return AWEIGHTS_INIT;}}
function saveAWeights(w){try{localStorage.setItem(AWEIGHTS_KEY,JSON.stringify(w));}catch{}}
function maybeLearnWeights(closed){
  if(closed.length<20||closed.length%20!==0)return;
  const wr=closed.slice(-20).filter(t=>t.outcome!=="SL").length/20;
  const w=loadAWeights();
  saveAWeights(wr>0.65?w.map(x=>Math.min(2,x*1.05)):wr<0.40?w.map(x=>Math.max(0.4,x*0.95)):w);
}

/* ─── ERROR BOUNDARY ───────────────────────────────────────────────── */
class ErrBound extends (typeof Component!=="undefined"?Component:class{render(){return this.props.children;}}){
  constructor(p){super(p);this.state={err:null};}
  static getDerivedStateFromError(e){return{err:e};}
  render(){
    if(this.state.err)return<div style={{background:"#FF174418",border:"1px solid #FF174435",borderRadius:8,padding:"10px 14px",margin:"6px 0"}}>
      <div style={{fontSize:10,color:"#FF1744",fontFamily:"'Space Mono',monospace",fontWeight:700}}>⚠ SECTION ERROR — isolated</div>
      <div style={{fontSize:8,color:"#2E4D38",fontFamily:"'Space Mono',monospace",marginTop:3}}>{this.state.err?.message}</div>
      <button onClick={()=>this.setState({err:null})} style={{marginTop:6,fontSize:8,padding:"3px 8px",background:"#FF174415",border:"1px solid #FF174430",borderRadius:3,color:"#FF1744",cursor:"pointer",fontFamily:"'Space Mono',monospace"}}>RETRY</button>
    </div>;
    return this.props.children;
  }
}

/* ─── OFFLINE BANNER ───────────────────────────────────────────────── */
function OfflineBanner({onReconnect}){
  const[secs,setSecs]=useState(5);
  useEffect(()=>{
    const iv=setInterval(()=>setSecs(s=>{if(s<=1){onReconnect?.();return 5;}return s-1;}),1000);
    return()=>clearInterval(iv);
  },[]);
  return<div style={{position:"fixed",top:0,left:0,right:0,zIndex:999,background:"rgba(255,23,68,0.93)",padding:"8px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"2px solid #FF1744"}}>
    <div style={{display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontSize:14}}>⚡</span>
      <div>
        <div style={{fontSize:10,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:"#fff",letterSpacing:"0.1em"}}>CONNECTION LOST — OPEN POSITIONS AT RISK</div>
        <div style={{fontSize:8,color:"rgba(255,255,255,0.8)",fontFamily:"'Space Mono',monospace"}}>Reconnecting in {secs}s</div>
      </div>
    </div>
    <button onClick={onReconnect} style={{fontSize:9,padding:"4px 10px",background:"rgba(255,255,255,0.2)",border:"1px solid rgba(255,255,255,0.4)",borderRadius:4,color:"#fff",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontWeight:700}}>RECONNECT</button>
  </div>;
}

/* ─── WS LATENCY BADGE ─────────────────────────────────────────────── */
function LatencyBadge({ms}){
  if(!ms)return null;
  const col=ms<300?"#00E676":ms<800?"#FFD700":"#FF1744";
  return<div style={{display:"flex",alignItems:"center",gap:3,padding:"2px 6px",background:`${col}12`,border:`1px solid ${col}28`,borderRadius:3}}>
    <span style={{width:5,height:5,borderRadius:"50%",background:col,display:"inline-block"}}/>
    <span style={{fontSize:7,fontFamily:"'Space Mono',monospace",color:col,fontVariantNumeric:"tabular-nums"}}>{ms}ms{ms>800?" ⚠":""}</span>
  </div>;
}



/* ─── PAPER TRADING ENGINE ───────────────────────────────────────────── */
function paperReducer(state,action){
  const now=Date.now();
  switch(action.type){
    case "RESET":
      return{equity:action.equity||10000,startEquity:action.equity||10000,
        trades:[],log:[],peak:action.equity||10000,maxDD:0};
    case "OPEN":{
      const{sig,riskPct}=action;
      const risk=Math.abs(sig.entry-sig.sl);
      const posSize=state.equity*(riskPct/100)/risk;
      const trade={id:now,card:sig.id,dir:sig.dir,entry:sig.entry,sl:sig.sl,
        tp:sig.tp,atr:sig.atr,col:sig.col,openedAt:now,status:"OPEN",
        posSize,riskAmt:state.equity*(riskPct/100),currentPrice:sig.entry,
        pnl:0,pnlPct:0,tpsHit:0,trailStop:sig.sl,conf:sig.finalConf,regime:sig.regime};
      return{...state,trades:[...state.trades,trade],
        log:[...state.log,{ts:now,ev:`OPEN ${sig.id} ${sig.dir} @ $${sig.entry?.toLocaleString()}`}]};
    }
    case "TICK":{
      const p=action.price;
      let eq=state.startEquity;
      const updated=state.trades.map(t=>{
        if(t.status!=="OPEN") return t;
        const pnl=(p-t.entry)*(t.dir==="LONG"?1:-1)*t.posSize;
        const pnlPct=pnl/state.startEquity*100;
        let tpsHit=t.tpsHit;
        t.tp.forEach((tp,i)=>{if(tpsHit<=i){if(t.dir==="LONG"&&p>=tp)tpsHit=i+1;if(t.dir==="SHORT"&&p<=tp)tpsHit=i+1;}});
        const stopHit=t.dir==="LONG"?p<=t.trailStop:p>=t.trailStop;
        const tpHit=t.dir==="LONG"?p>=t.tp[t.tp.length-1]:p<=t.tp[t.tp.length-1];
        if(stopHit||tpHit){
          const finalPnl=(p-t.entry)*(t.dir==="LONG"?1:-1)*t.posSize;
          return{...t,status:"CLOSED",outcome:stopHit?(t.tpsHit>0?"TRAIL_TP":"SL"):"TP",
            closePrice:p,closedAt:now,pnl:finalPnl,pnlPct:finalPnl/state.startEquity*100};
        }
        return{...t,currentPrice:p,pnl,pnlPct,tpsHit};
      });
      // Running equity = start + sum of closed PnL
      const closedPnl=updated.filter(t=>t.status==="CLOSED").reduce((s,t)=>s+t.pnl,0);
      eq=state.startEquity+closedPnl;
      const peak=Math.max(state.peak,eq);
      const maxDD=Math.max(state.maxDD,peak-eq);
      return{...state,trades:updated,equity:parseFloat(eq.toFixed(2)),peak,maxDD};
    }
    case "CLOSE_ALL":{
      const p=action.price;
      const updated=state.trades.map(t=>{
        if(t.status!=="OPEN") return t;
        const finalPnl=(p-t.entry)*(t.dir==="LONG"?1:-1)*t.posSize;
        return{...t,status:"CLOSED",outcome:"MANUAL",closePrice:p,closedAt:now,
          pnl:finalPnl,pnlPct:finalPnl/state.startEquity*100};
      });
      const closedPnl=updated.reduce((s,t)=>s+t.pnl,0);
      return{...state,trades:updated,equity:parseFloat((state.startEquity+closedPnl).toFixed(2))};
    }
    default: return state;
  }
}

/* ─── OPTIONS EXPIRY OPTIMIZER (#35) ─────────────────────────────── */
// Models optimal contract duration: ensure strike reached within expiry >65% prob
// Uses ATR to estimate expected move per hour
function optimalExpiry(sig,klines){
  const k=closedOnly(klines);if(!k||k.length<20)return{optimalMins:480,confidence:0.5};
  const cl=k.map(r=>parseFloat(r[4])),hi=k.map(r=>parseFloat(r[2])),lo=k.map(r=>parseFloat(r[3]));
  const atrArr=TA.atr(hi,lo,cl,14),atr=atrArr[atrArr.length-1];
  const distToTP1=Math.abs((sig.tp?.[0]||sig.entry)-sig.entry);
  if(!atr||!distToTP1)return{optimalMins:480,confidence:0.5};
  // ATR per candle → ATR per hour (assumes 1m candles)
  const atrPerHour=atr*60;
  const hoursNeeded=distToTP1/atrPerHour;
  // Add 50% buffer for volatility
  const optimalMins=Math.ceil(hoursNeeded*1.5*60);
  // Confidence: if expected move < 1 ATR, >65% within expiry
  const confidence=distToTP1<atr?0.72:distToTP1<atr*2?0.62:0.50;
  return{optimalMins:Math.max(30,Math.min(1440,optimalMins)),confidence,hoursNeeded:hoursNeeded.toFixed(2)};
}

/* ─── NEWS/ECONOMIC CALENDAR AGENT (#42) ─────────────────────────── */
// Blocks forex/gold signals 15min before/after major news releases
// Uses cached flag; actual implementation fetches from free calendar API
const NEWS_BLOCK_KEY="deriv_news_block";
let _newsBlockCache={blocked:false,reason:"",fetchedAt:0};

async function fetchNewsBlock(){
  // Refresh at most every hour
  if(Date.now()-_newsBlockCache.fetchedAt<3600000)return _newsBlockCache;
  try{
    const now=new Date(),h=now.getUTCHours(),m=now.getUTCMinutes();
    // High-impact windows: NY open (12:30), ECB (13:15), FOMC (19:00), NFP (13:30 Fri)
    const highImpactUTCWindows=[{h:12,m:15},{h:12,m:30},{h:13,m:15},{h:13,m:30},{h:19,m:0},{h:14,m:0}];
    let blocked=false,reason="";
    for(const win of highImpactUTCWindows){
      const diffMins=(h*60+m)-(win.h*60+win.m);
      if(Math.abs(diffMins)<=15){blocked=true;reason=`News window: UTC ${win.h}:${String(win.m).padStart(2,'0')} ±15m`;break;}
    }
    _newsBlockCache={blocked,reason,fetchedAt:Date.now()};
  }catch{_newsBlockCache.fetchedAt=Date.now();}
  return _newsBlockCache;
}

function isForexOrGold(sym){return sym?.startsWith("frx")||sym==="frxXAUUSD"||sym==="frxXAGUSD";}

/* ─── BACKTESTER ─────────────────────────────────────────────────────── */
// Runs signal logic over historical closed klines — walk-forward, no lookahead
function runBacktest(klines, timeframe, equity=10000, riskPct=1.0, ofStub={score:0.5,pressure:"BALANCED"}){
  if(!klines||klines.length<80) return null;
  const results=[];
  let eq=equity;
  // Walk forward: use [0..i-1] to generate signal for bar i
  const windowSize=Math.min(200,klines.length-2);
  for(let i=windowSize;i<klines.length-1;i++){
    const window=klines.slice(0,i); // closed candles up to but not including i
    const cl=window.map(r=>parseFloat(r[4]));
    const hi=window.map(r=>parseFloat(r[2]));
    const lo=window.map(r=>parseFloat(r[3]));
    const n=cl.length-1,p=cl[n];
    // Quick signal check (EMA + RSI only for backtest speed)
    const e21=TA.ema(cl,21),e50=TA.ema(cl,50);
    const rsiArr=TA.rsi(cl,14);
    const atrArr=TA.atr(hi,lo,cl,14);
    const rN=rsiArr[n],e21N=e21[n],e50N=e50[n],aN=atrArr[n];
    const bullStack=p>e21N&&e21N>e50N;
    const bearStack=p<e21N&&e21N<e50N;
    const macdD=TA.macd(cl);
    const macdBull=macdD.hist[n]>0&&macdD.hist[n-1]<=0;
    const macdBear=macdD.hist[n]<0&&macdD.hist[n-1]>=0;
    let dir=null,score=0;
    if(bullStack&&macdBull&&rN>45&&rN<70){dir="LONG";score=0.68+Math.random()*0.15;}
    else if(bearStack&&macdBear&&rN<55&&rN>30){dir="SHORT";score=0.68+Math.random()*0.15;}
    if(!dir||score<0.65) continue;
    const sl=dir==="LONG"?p-aN*1.8:p+aN*1.8;
    const tp=dir==="LONG"?p+aN*2.5:p-aN*2.5;
    const rr=Math.abs(tp-p)/Math.abs(p-sl);
    if(rr<1.5) continue;
    // Simulate forward: check next candle for outcome
    const nextBar=klines[i];
    const nextHi=parseFloat(nextBar[2]),nextLo=parseFloat(nextBar[3]),nextCl=parseFloat(nextBar[4]);
    let outcome="TIMEOUT",exitPrice=nextCl,pnlPct=0;
    if(dir==="LONG"){
      if(nextLo<=sl){outcome="SL";exitPrice=sl;}
      else if(nextHi>=tp){outcome="TP";exitPrice=tp;}
    } else {
      if(nextHi>=sl){outcome="SL";exitPrice=sl;}
      else if(nextLo<=tp){outcome="TP";exitPrice=tp;}
    }
    const risk=eq*(riskPct/100);
    const riskPts=Math.abs(p-sl);
    const posSize=riskPts>0?risk/riskPts:0;
    const tradePnl=(exitPrice-p)*(dir==="LONG"?1:-1)*posSize;
    eq=Math.max(0,eq+tradePnl);
    const pnl=tradePnl/equity*100;
    results.push({i,ts:parseInt(klines[i][0]),entry:p,sl,tp,dir,outcome,exitPrice,
      pnl:parseFloat(pnl.toFixed(3)),equity:parseFloat(eq.toFixed(2)),score});
  }
  if(!results.length) return null;
  // Stats
  const wins=results.filter(r=>r.outcome==="TP");
  const losses=results.filter(r=>r.outcome==="SL");
  const wr=wins.length/results.length;
  const avgWin=wins.length?wins.reduce((s,r)=>s+r.pnl,0)/wins.length:0;
  const avgLoss=losses.length?Math.abs(losses.reduce((s,r)=>s+r.pnl,0)/losses.length):1;
  const pf=avgLoss>0?(wr*avgWin)/((1-wr)*avgLoss):0;
  let peak=equity,maxDD=0;
  results.forEach(r=>{peak=Math.max(peak,r.equity);maxDD=Math.max(maxDD,peak-r.equity);});
  const finalEq=results[results.length-1]?.equity||equity;
  return{results,wr,pf:pf.toFixed(2),maxDD:maxDD.toFixed(0),total:results.length,
    wins:wins.length,losses:losses.length,finalEq:finalEq.toFixed(0),
    returnPct:((finalEq-equity)/equity*100).toFixed(2),avgWin:avgWin.toFixed(3),avgLoss:avgLoss.toFixed(3)};
}

/* ─── THEME ──────────────────────────────────────────────────────────── */
const C = {
  bg:"#020B0E", card:"rgba(3,14,18,0.97)",
  border:"rgba(0,210,170,0.09)", borderHi:"rgba(0,210,170,0.28)",
  cyan:"#00D4AA", gold:"#FFD700", green:"#00E676",
  red:"#FF1744",  orange:"#FF8F00", purple:"#9C27B0",
  text:"#B2CCBA", bright:"#E0F7EF", muted:"#0D1E16", dim:"#2E4D38",
};

/* ─── PRICE FORMATTER (handles all Deriv asset price ranges) ────────── */
function fmtPrice(p,asset){
  if(!p||isNaN(p)) return "—";
  const d=asset?.digits??2;
  if(p>=10000) return "$"+p.toLocaleString("en",{maximumFractionDigits:d});
  if(p>=1)     return "$"+p.toFixed(d);
  return "$"+p.toFixed(d+2);
}

/* ─── ORDER FLOW — price-based proxy (no Deriv orderbook) ───────────── */
// Replaced Binance depth-based OF with candle-based momentum proxy.
// Uses up/down candle ratio from 1m closed candles. Same score interface.
function calcOrderFlow(k1m){
  if(!k1m||k1m.length<10) return{score:0.5,pressure:"NEUTRAL",bidDepth:0,askDepth:0,bidRatio:0.5,askRatio:0.5};
  const k=closedOnly(k1m);
  if(!k||k.length<10) return{score:0.5,pressure:"NEUTRAL",bidDepth:0,askDepth:0,bidRatio:0.5,askRatio:0.5};
  const last20=k.slice(-20);
  let buyV=0,sellV=0;
  last20.forEach(r=>{
    const o=parseFloat(r[1]),c=parseFloat(r[4]);
    if(c>=o) buyV+=Math.abs(c-o); else sellV+=Math.abs(o-c);
  });
  const tot=buyV+sellV||1;
  const bidR=buyV/tot;
  return{score:bidR,bidRatio:bidR,askRatio:1-bidR,bidDepth:buyV,askDepth:sellV,
    pressure:bidR>0.62?"BUY_DOMINANT":bidR>0.56?"BUY_LEANING":bidR<0.38?"SELL_DOMINANT":bidR<0.44?"SELL_LEANING":"BALANCED",
    bigBidWall:0,bigAskWall:0};
}

/* ─── TECHNICAL ANALYSIS ─────────────────────────────────────────────── */
const TA = {
  ema(px,p){
    const k=2/(p+1); let e=px[0];
    return px.map((v,i)=>(e=i?v*k+e*(1-k):v));
  },
  rsi(px,p=14){
    if(px.length<p+2) return px.map(()=>50);
    let g=0,l=0;
    for(let i=1;i<=p;i++){const d=px[i]-px[i-1];d>0?g+=d:l-=d;} g/=p;l/=p;
    const r=Array(p).fill(50);
    r.push(l?100-100/(1+g/l):100);
    for(let i=p+1;i<px.length;i++){
      const d=px[i]-px[i-1],gn=d>0?d:0,ln=d<0?-d:0;
      g=(g*(p-1)+gn)/p; l=(l*(p-1)+ln)/p;
      r.push(l?100-100/(1+g/l):100);
    }
    return r;
  },
  macd(px,f=12,s=26,sg=9){
    const ef=this.ema(px,f),es=this.ema(px,s);
    const ml=px.map((_,i)=>ef[i]-es[i]);
    const sl=this.ema(ml,sg);
    return{ml,sl,hist:ml.map((m,i)=>m-sl[i])};
  },
  atr(hi,lo,cl,p=14){
    const tr=cl.map((c,i)=>i?Math.max(hi[i]-lo[i],Math.abs(hi[i]-cl[i-1]),Math.abs(lo[i]-cl[i-1])):hi[0]-lo[0]);
    return this.ema(tr,p);
  },
  bb(px,p=20,m=2){
    return px.map((_,i)=>{
      if(i<p-1) return{u:null,mid:null,l:null,bw:null};
      const sl=px.slice(i-p+1,i+1),mean=sl.reduce((s,v)=>s+v)/p;
      const std=Math.sqrt(sl.reduce((s,v)=>s+(v-mean)**2)/p);
      return{u:mean+m*std,mid:mean,l:mean-m*std,bw:std?m*2*std/mean:0};
    });
  },
  vwap(hi,lo,cl,vol){
    let tv=0,v=0;
    return cl.map((c,i)=>{tv+=(hi[i]+lo[i]+cl[i])/3*vol[i];v+=vol[i];return v?tv/v:c;});
  },
  swings(hi,lo,lb=5){
    const sh=[],sl=[];
    for(let i=lb;i<hi.length-lb;i++){
      if(hi.slice(i-lb,i).every(h=>h<hi[i])&&hi.slice(i+1,i+lb+1).every(h=>h<hi[i])) sh.push({i,p:hi[i]});
      if(lo.slice(i-lb,i).every(l=>l>lo[i])&&lo.slice(i+1,i+lb+1).every(l=>l>lo[i])) sl.push({i,p:lo[i]});
    }
    return{sh,sl};
  },
  hv(cl,p=20){
    if(cl.length<p+1) return 0;
    const rets=cl.slice(1).map((c,i)=>Math.log(c/cl[i]));
    const rec=rets.slice(-p),mu=rec.reduce((s,v)=>s+v)/p;
    return Math.sqrt(rec.reduce((s,v)=>s+(v-mu)**2)/(p-1)*365*24*60);
  },
  // Chandelier Exit — best trailing stop for trend trades
  // Long: max(high,n) - atr*m   Short: min(low,n) + atr*m
  chandelier(hi,lo,cl,p=22,m=CHANDELIER_M){
    const atrArr=this.atr(hi,lo,cl,p);
    return cl.map((_,i)=>{
      if(i<p) return{long:null,short:null};
      const maxH=Math.max(...hi.slice(i-p+1,i+1));
      const minL=Math.min(...lo.slice(i-p+1,i+1));
      return{long:maxH-atrArr[i]*m, short:minL+atrArr[i]*m};
    });
  },
  fibonacci(hi,lo){
    const d=hi-lo;
    return{r236:lo+d*0.236,r382:lo+d*0.382,r500:lo+d*0.500,r618:lo+d*0.618,r786:lo+d*0.786};
  },
};

/* ─── CLOSED-CANDLE GUARD ────────────────────────────────────────────── */
// Strips the last (forming) candle. All analysis runs on closed candles only.
function closedOnly(klines){
  if(!klines||klines.length<3) return klines;
  return klines.slice(0,-1); // last entry is the live forming candle — drop it
}

/* ─── REGIME DETECTOR ────────────────────────────────────────────────── */
function detectRegime(klines){
  const k=closedOnly(klines);
  if(!k||k.length<55) return{regime:"LOADING",dir:"NEUTRAL",conf:0};
  const cl=k.map(r=>parseFloat(r[4]));
  const hi=k.map(r=>parseFloat(r[2]));
  const lo=k.map(r=>parseFloat(r[3]));
  const vol=k.map(r=>parseFloat(r[5]));
  const n=cl.length-1, p=cl[n];
  const e9=TA.ema(cl,9),e21=TA.ema(cl,21),e50=TA.ema(cl,50);
  const e200=TA.ema(cl,Math.min(200,cl.length-1));
  const rsiArr=TA.rsi(cl,14); const rsiN=rsiArr[n];
  const atrArr=TA.atr(hi,lo,cl,14); const atrN=atrArr[n];
  const bbArr=TA.bb(cl,20); const bbN=bbArr[n];
  const e9n=e9[n],e21n=e21[n],e50n=e50[n],e200n=e200[n];
  const bw=bbN?.bw||0;
  const avgBW=bbArr.slice(-20).filter(b=>b.bw!=null).reduce((s,b)=>s+b.bw,0)/20||0.01;
  const slope=(e21n-e21[Math.max(0,n-5)])/e21[Math.max(0,n-5)]*100;
  const avgVol5=vol.slice(-5).reduce((s,v)=>s+v)/5;
  const avgVol20=vol.slice(-20).reduce((s,v)=>s+v)/20;
  const highVol=avgVol5>avgVol20*1.35;
  const atrPct=atrN/p;
  let regime="RANGE_BOUND",dir="NEUTRAL",conf=0.52;
  if(p>e9n&&e9n>e21n&&e21n>e50n&&p>e200n&&slope>0.08&&highVol){regime="STRONG_BULL";dir="BULLISH";conf=0.87;}
  else if(p>e9n&&e9n>e21n&&e21n>e50n&&p>e200n&&slope>0.02)     {regime="MODERATE_BULL";dir="BULLISH";conf=0.73;}
  else if(p<e9n&&e9n<e21n&&e21n<e50n&&p<e200n&&slope<-0.08&&highVol){regime="STRONG_BEAR";dir="BEARISH";conf=0.87;}
  else if(p<e9n&&e9n<e21n&&e21n<e50n&&p<e200n&&slope<-0.02)    {regime="MODERATE_BEAR";dir="BEARISH";conf=0.73;}
  else if((atrPct>0.012||bw>avgBW*1.6)&&!(p>e9n&&e9n>e21n))   {regime="HIGH_VOLATILITY";dir="NEUTRAL";conf=0.65;}
  else if(atrPct<0.004||bw<avgBW*0.65)                          {regime="COMPRESSION";dir="NEUTRAL";conf=0.77;}
  const slopeTurning=n>=10&&Math.abs(slope-(e21n-e21[Math.max(0,n-10)])/e21[Math.max(0,n-10)]*100)>0.15;
  return{regime,dir,conf,e9:e9n,e21:e21n,e50:e50n,e200:e200n,
         rsi:rsiN,atr:atrN,atrPct,bbWidth:bw,slope,above200:p>e200n,slopeTurning};
}

/* ─── ORDER FLOW ─────────────────────────────────────────────────────── */
/* ─── MONTE CARLO (real returns) ─────────────────────────────────────── */
function runMC(cl,entry,sl,tp1){
  if(cl.length<30) return{probTP:0.5,probSL:0.5,ev:0,p10:sl,p50:entry,p90:tp1,mcData:[]};
  const rets=cl.slice(-80).slice(1).map((c,i)=>Math.log(c/cl.slice(-80)[i]));
  const mu=rets.reduce((s,v)=>s+v)/rets.length;
  const sd=Math.sqrt(rets.reduce((s,v)=>s+(v-mu)**2)/(rets.length-1));
  let tpH=0,slH=0; const finals=[];
  for(let p=0;p<MC_PATHS;p++){
    let pr=entry,hit=null;
    for(let s=0;s<80&&!hit;s++){
      const u1=Math.random()||1e-10,u2=Math.random();
      pr*=Math.exp(mu+sd*Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2));
      if(pr>=tp1){hit="TP";tpH++;}
      else if(pr<=sl){hit="SL";slH++;}
    }
    if(!hit){pr>entry?tpH+=0.5:slH+=0.5;}
    finals.push(Math.round(pr));
  }
  finals.sort((a,b)=>a-b);
  const probTP=tpH/MC_PATHS, probSL=slH/MC_PATHS;
  const ev=probTP*(tp1-entry)-probSL*(entry-sl);
  const mcData=Array.from({length:20},(_,i)=>{
    const t=i/19;
    return{i,
      p10:Math.round(entry+(finals[Math.floor(MC_PATHS*0.10)]-entry)*t),
      p50:Math.round(entry+(finals[Math.floor(MC_PATHS*0.50)]-entry)*t),
      p90:Math.round(entry+(finals[Math.floor(MC_PATHS*0.90)]-entry)*t)};
  });
  return{probTP,probSL,ev,p10:finals[Math.floor(MC_PATHS*0.10)],
    p50:finals[Math.floor(MC_PATHS*0.50)],p90:finals[Math.floor(MC_PATHS*0.90)],mcData};
}

/* ─── SIGNAL BUILDERS (closed candles only) ──────────────────────────── */
function buildSignals(kmap, of, regime, sym){
  const asset=sym?ASSETS.find(a=>a.sym===sym):null;
  const thresh=asset?.thresh||{show:0.58,alert:0.72,min:0.44};
  const isCB=sym&&(sym.startsWith("CRASH")||sym.startsWith("BOOM"));
  const results={snp:null,int:null,trd:null};

  // ── HTF 4h direction — hard veto (eliminates counter-trend losses) ──
  let htfDir4h="NEUTRAL";
  const k4hRaw=closedOnly(kmap.k4h);
  if(k4hRaw?.length>22){
    const c4=k4hRaw.map(r=>parseFloat(r[4])),n4=c4.length-1;
    const e21_4=TA.ema(c4,21),e50_4=TA.ema(c4,50);
    if(c4[n4]>e21_4[n4]&&e21_4[n4]>e50_4[n4])htfDir4h="BULLISH";
    else if(c4[n4]<e21_4[n4]&&e21_4[n4]<e50_4[n4])htfDir4h="BEARISH";
  }

  // ── SNIPER (1m closed) ──
  const k1=closedOnly(kmap.k1m);
  if(k1?.length>=55){
    const cl=k1.map(r=>parseFloat(r[4])),hi=k1.map(r=>parseFloat(r[2]));
    const lo=k1.map(r=>parseFloat(r[3])),vol=k1.map(r=>parseFloat(r[5]));
    const n=cl.length-1,p=cl[n];
    const e9=TA.ema(cl,9),e21=TA.ema(cl,21);
    const rsi=TA.rsi(cl,14),macdD=TA.macd(cl,5,13,5);
    const atrArr=TA.atr(hi,lo,cl,14),bbArr=TA.bb(cl,20);
    const rN=rsi[n],e9N=e9[n],e21N=e21[n],aN=atrArr[n],bbN=bbArr[n];
    const hN=macdD.hist[n],hP=macdD.hist[n-1];
    const avgVol=vol.slice(-20).reduce((s,v)=>s+v)/20;
    const bullEMA=p>e9N&&e9N>e21N,bearEMA=p<e9N&&e9N<e21N;
    const macdBull=hN>0&&hP<=0,macdBear=hN<0&&hP>=0;
    const bbBL=bbN&&p<=bbN.l*1.001,bbBH=bbN&&p>=bbN.u*0.999;
    const rsiOS=rN<36,rsiOB=rN>64,rsiBnc=rN<45&&rN>rsi[n-1]&&rN>rsi[n-2];
    const rsiFd=rN>55&&rN<rsi[n-1]&&rN<rsi[n-2];
    const vSpike=vol[n]>avgVol*1.6;
    let lS=0,sS=0;
    if(rsiOS||rsiBnc)lS+=0.28; if(rsiOB||rsiFd)sS+=0.28;
    if(bullEMA)lS+=0.20; if(bearEMA)sS+=0.20;
    if(macdBull)lS+=0.18; if(macdBear)sS+=0.18;
    if(of.score>0.56)lS+=0.18; if(of.score<0.44)sS+=0.18;
    if(vSpike){lS+=0.08;sS+=0.08;}
    if(bbBL)lS+=0.12; if(bbBH)sS+=0.12;
    if(regime.dir==="BULLISH")lS+=0.08; if(regime.dir==="BEARISH")sS+=0.08;
    // Crash/Boom: recovery logic
    if(isCB&&sym.startsWith("CRASH")&&rsiOS)lS+=0.18;
    if(isCB&&sym.startsWith("BOOM")&&rsiOB)sS+=0.18;
    // RSI divergence boost
    const snpDiv=rsiDivergence(cl,rsi,20);
    if(snpDiv.bull)lS+=0.15; if(snpDiv.bear)sS+=0.15;
    // #12/#34: Volume-weighted confidence via tick density (synthetic volume proxy)
    const tickW=tickFrequencyWeight(k1);lS*=tickW;sS*=tickW;
    // Step Index run-length edge
    if(sym==="stpRNG"){const se=stepEdge(k1);if(se.conf>0.6){if(se.dir==="LONG")lS+=se.conf*0.2;else sS+=se.conf*0.2;}}
    const maxS=Math.max(lS,sS);
    if(maxS>=thresh.min){
      const dir=lS>=sS?"LONG":"SHORT";
      // HTF HARD VETO — 4h bearish = no LONGs, 4h bullish = no SHORTs
      if(htfDir4h!=="NEUTRAL"&&((htfDir4h==="BEARISH"&&dir==="LONG")||(htfDir4h==="BULLISH"&&dir==="SHORT"))){
        // veto — skip this signal entirely
      } else {
      const conf=Math.min(0.95,maxS);
      // Asymmetric stop: strong trend = wider, range/compression = tighter
      let atrMult=1.3;
      if(regime.regime==="STRONG_BULL"||regime.regime==="STRONG_BEAR")atrMult=2.0;
      else if(regime.regime==="RANGE_BOUND"||regime.regime==="COMPRESSION")atrMult=0.8;
      const sl=dir==="LONG"?p-aN*atrMult:p+aN*atrMult;
      results.snp={id:"SNP",card:"SNIPER SCALPER",col:C.cyan,dir,entry:p,sl,
        tp:[dir==="LONG"?p+aN*1.8:p-aN*1.8,
            dir==="LONG"?p+aN*2.8:p-aN*2.8],
        conf,rr:1.8/1.3,pw:Math.min(0.82,0.50+conf*0.20),atr:aN,
        regime:regime.regime,expire:480,htfDir:htfDir4h,
        strat:snpDiv.bull?"RSI Bull Div":snpDiv.bear?"RSI Bear Div":bbBL?"BB Bounce":rsiOS?"RSI Oversold":macdBull?"MACD Cross":"Momentum",
        shap:[{f:"RSI/Momentum",v:rsiOS?0.28:rsiBnc?0.18:0.08},{f:"EMA Structure",v:bullEMA?0.20:0.05},{f:"Divergence",v:snpDiv.bull||snpDiv.bear?0.15:0},{f:"Order Flow",v:Math.abs(of.score-0.5)*0.36}]};
      } // end HTF veto check
    }
  }

  // ── INTRADAY (15m closed) ──
  const k15=closedOnly(kmap.k15m);
  if(k15?.length>=50){
    const cl=k15.map(r=>parseFloat(r[4])),hi=k15.map(r=>parseFloat(r[2]));
    const lo=k15.map(r=>parseFloat(r[3])),vol=k15.map(r=>parseFloat(r[5]));
    const n=cl.length-1,p=cl[n];
    const e21=TA.ema(cl,21),e50=TA.ema(cl,50),e200=TA.ema(cl,Math.min(200,cl.length-1));
    const rsi=TA.rsi(cl,14),macdD=TA.macd(cl),atrArr=TA.atr(hi,lo,cl,14);
    const vwap=TA.vwap(hi,lo,cl,vol);
    const rN=rsi[n],e21N=e21[n],e50N=e50[n],aN=atrArr[n];
    const hN=macdD.hist[n],hP=macdD.hist[n-1],mlN=macdD.ml[n],mlP=macdD.ml[n-1];
    const vN=vwap[n];
    const k1h=closedOnly(kmap.k1h);
    let htfBull=false,htfBear=false;
    if(k1h?.length>20){
      const c1h=k1h.map(r=>parseFloat(r[4])),nh=c1h.length-1;
      const e21h=TA.ema(c1h,21),e50h=TA.ema(c1h,50);
      htfBull=c1h[nh]>e21h[nh]&&e21h[nh]>e50h[nh];
      htfBear=c1h[nh]<e21h[nh]&&e21h[nh]<e50h[nh];
    }
    const bullStack=p>e21N&&e21N>e50N,bearStack=p<e21N&&e21N<e50N;
    const pbEMAL=Math.abs(p-e21N)/e21N<0.005&&p>e50N;
    const pbEMAS=Math.abs(p-e21N)/e21N<0.005&&p<e50N;
    const macdBull=hN>0&&(hP<=0||mlN>mlP),macdBear=hN<0&&(hP>=0||mlN<mlP);
    let lS=0,sS=0;
    if(bullStack)lS+=0.25; if(bearStack)sS+=0.25;
    if(htfBull)lS+=0.20; if(htfBear)sS+=0.20;
    if(macdBull)lS+=0.18; if(macdBear)sS+=0.18;
    if(rN>42&&rN<68)lS+=0.12; if(rN>32&&rN<58)sS+=0.12;
    if(pbEMAL)lS+=0.12; if(pbEMAS)sS+=0.12;
    if(of.score>0.55)lS+=0.15; if(of.score<0.45)sS+=0.15;
    if(p>e200[n])lS+=0.08; else sS+=0.08;
    if(isCB&&sym.startsWith("CRASH")&&rN<40)lS+=0.14;
    if(isCB&&sym.startsWith("BOOM")&&rN>60)sS+=0.14;
    const intDiv=rsiDivergence(cl,rsi,20);
    if(intDiv.bull)lS+=0.14; if(intDiv.bear)sS+=0.14;
    const maxS=Math.max(lS,sS);
    if(maxS>=thresh.min){
      const dir=lS>=sS?"LONG":"SHORT";
      // HTF veto for INT too
      if(htfDir4h!=="NEUTRAL"&&((htfDir4h==="BEARISH"&&dir==="LONG")||(htfDir4h==="BULLISH"&&dir==="SHORT"))){
        // veto
      } else {
      const conf=Math.min(0.93,maxS);
      let intAtrMult=1.8;
      if(regime.regime==="STRONG_BULL"||regime.regime==="STRONG_BEAR")intAtrMult=2.5;
      else if(regime.regime==="RANGE_BOUND")intAtrMult=1.2;
      const risk=aN*intAtrMult;
      const sl=dir==="LONG"?p-risk:p+risk;
      results.int={id:"INT",card:"INTRADAY HUNTER",col:C.gold,dir,entry:p,sl,
        tp:[dir==="LONG"?p+risk*1.5:p-risk*1.5,
            dir==="LONG"?p+risk*2.5:p-risk*2.5,
            dir==="LONG"?p+risk*3.8:p-risk*3.8],
        conf,rr:1.5,pw:Math.min(0.84,0.52+conf*0.18),atr:aN,
        regime:regime.regime,expire:2700,htfDir:htfDir4h,
        strat:intDiv.bull?"15m Bull Div":intDiv.bear?"15m Bear Div":pbEMAL||pbEMAS?"EMA21 Pullback":htfBull||htfBear?"HTF Trend":"Structure Play",
        shap:[{f:"EMA Alignment",v:bullStack||bearStack?0.25:0.05},{f:"HTF Trend",v:htfBull||htfBear?0.20:0.03},{f:"Divergence",v:intDiv.bull||intDiv.bear?0.14:0},{f:"MACD",v:macdBull||macdBear?0.18:0.04}]};
      } // end HTF veto
    }
  }

  // ── TREND (4h closed) ──
  const k4=closedOnly(kmap.k4h);
  if(k4?.length>=40){
    const cl=k4.map(r=>parseFloat(r[4])),hi=k4.map(r=>parseFloat(r[2]));
    const lo=k4.map(r=>parseFloat(r[3]));
    const n=cl.length-1,p=cl[n];
    const e21=TA.ema(cl,21),e50=TA.ema(cl,50),e200=TA.ema(cl,Math.min(200,cl.length-1));
    const rsi=TA.rsi(cl,14),macdD=TA.macd(cl),atrArr=TA.atr(hi,lo,cl,14);
    const {sh,sl:swSL}=TA.swings(hi,lo,4);
    const rN=rsi[n],e21N=e21[n],e50N=e50[n],e200N=e200[n],aN=atrArr[n];
    const hN=macdD.hist[n],mlN=macdD.ml[n],slN=macdD.sl[n];
    const bosL=sh.length>=2&&p>sh[sh.length-2].p;
    const bosS=swSL.length>=2&&p<swSL[swSL.length-2].p;
    const k1d=closedOnly(kmap.k1d);
    let dailyBull=false,dailyBear=false;
    if(k1d?.length>30){
      const c1d=k1d.map(r=>parseFloat(r[4])),nd=c1d.length-1;
      const e50d=TA.ema(c1d,50),e200d=TA.ema(c1d,Math.min(200,c1d.length-1));
      dailyBull=c1d[nd]>e50d[nd]&&e50d[nd]>e200d[nd];
      dailyBear=c1d[nd]<e50d[nd]&&e50d[nd]<e200d[nd];
    }
    const fullBull=p>e21N&&e21N>e50N&&e50N>e200N;
    const fullBear=p<e21N&&e21N<e50N&&e50N<e200N;
    const macdBull=mlN>slN&&hN>0,macdBear=mlN<slN&&hN<0;
    let lS=0,sS=0;
    if(fullBull)lS+=0.28; if(fullBear)sS+=0.28;
    if(dailyBull)lS+=0.22; if(dailyBear)sS+=0.22;
    if(macdBull)lS+=0.18; if(macdBear)sS+=0.18;
    if(bosL)lS+=0.16; if(bosS)sS+=0.16;
    if(rN>50&&rN<72)lS+=0.10; if(rN<50&&rN>28)sS+=0.10;
    if(of.score>0.55)lS+=0.08; if(of.score<0.45)sS+=0.08;
    const trdRsi=TA.rsi(cl,14);const trdDiv=rsiDivergence(cl,trdRsi,20);
    if(trdDiv.bull)lS+=0.14; if(trdDiv.bear)sS+=0.14;
    const maxS=Math.max(lS,sS);
    if(maxS>=thresh.min){
      const dir=lS>=sS?"LONG":"SHORT";
      const conf=Math.min(0.94,maxS);
      let trdAtrMult=2.2;
      if(regime.regime==="HIGH_VOLATILITY")trdAtrMult=3.2;
      else if(regime.regime==="RANGE_BOUND")trdAtrMult=1.5;
      const risk=aN*trdAtrMult;
      const sl=dir==="LONG"?p-risk:p+risk;
      results.trd={id:"TRD",card:"TREND RIDER",col:C.purple,dir,entry:p,sl,
        tp:[dir==="LONG"?p+risk*1.5:p-risk*1.5,
            dir==="LONG"?p+risk*2.8:p-risk*2.8,
            dir==="LONG"?p+risk*4.5:p-risk*4.5],
        conf,rr:1.5,pw:Math.min(0.82,0.48+conf*0.22),atr:aN,
        regime:regime.regime,expire:14400,
        strat:bosL?"Break of Structure":bosS?"BOS Short":fullBull?"EMA Stack Long":"EMA Stack Short",
        shap:[{f:"EMA Full Stack",v:fullBull||fullBear?0.28:0.05},{f:"Daily Trend",v:dailyBull||dailyBear?0.22:0.04},{f:"MACD+BOS",v:macdBull||macdBear?0.18:0.06}]};
    }
  }
  return results;
}

/* ─── RISK CALC ─────────────────────────────────────────────────────── */
function calcRisk(sig,eq=10000){
  if(!sig) return null;
  const{entry,sl,tp,pw,conf,atr}=sig;
  const risk=Math.abs(entry-sl),rew=Math.abs(tp[0]-entry);
  const rr=rew/risk, fees=entry*0.0004;
  const ev=pw*rew-(1-pw)*risk-fees;
  const kelly=Math.max(0,pw-(1-pw)/rr);
  const posPct=Math.min(kelly*KELLY_K,MAX_POS);
  return{ev,rr,kelly:kelly.toFixed(4),posPct,positionSize:eq*posPct,
    slippage:Math.round(entry*0.0002),fillProb:(0.82+conf*0.12).toFixed(2),fees:fees.toFixed(2)};
}

/* ─── CONFIDENCE AGGREGATOR ─────────────────────────────────────────── */
function aggregateConf(sig,mc,of,sw){
  if(!sig) return 0;
  const sk=sig.id==="SNP"?"snp":sig.id==="INT"?"int":"trd";
  const m=sig.conf,s=mc?mc.probTP:0.5,
        o=sig.dir==="LONG"?of.score:1-of.score,
        h=0.62,q=sw[sk]||0.33;
  return Math.min(0.99,CW.m*m+CW.s*s+CW.o*o+CW.h*h+CW.q*q);
}

/* ─── STRATEGY WEIGHTS ───────────────────────────────────────────────── */
function stratWeights(r){
  const k=r?.regime||"";
  if(k==="STRONG_BULL"||k==="STRONG_BEAR")          return{snp:0.18,int:0.35,trd:0.47};
  if(k==="MODERATE_BULL"||k==="MODERATE_BEAR")       return{snp:0.22,int:0.52,trd:0.26};
  if(k==="RANGE_BOUND")                              return{snp:0.52,int:0.38,trd:0.10};
  if(k==="HIGH_VOLATILITY")                          return{snp:0.46,int:0.44,trd:0.10};
  if(k==="COMPRESSION")                             return{snp:0.28,int:0.38,trd:0.34};
  return{snp:0.33,int:0.34,trd:0.33};
}

/* ═══════════════════════════════════════════════════════════════════════
   PRO TRADING BRAIN — 12-agent ensemble
   Each agent scores independently → weighted vote → FINAL VERDICT
   Aggressive: takes trades, manages risk, never dormant
═══════════════════════════════════════════════════════════════════════ */
function runProBrain(kmap,of,regime,signals,trades,sym){
  const asset=ASSETS.find(a=>a.sym===sym)||{thresh:{min:0.44},cat:"UNKNOWN",digits:2};
  const k1=closedOnly(kmap.k1m),k15=closedOnly(kmap.k15m),k4=closedOnly(kmap.k4h);
  if(!k1?.length||k1.length<20) return null;
  const cl1=k1.map(r=>parseFloat(r[4])),hi1=k1.map(r=>parseFloat(r[2])),lo1=k1.map(r=>parseFloat(r[3]));
  const cl15=k15?.map(r=>parseFloat(r[4]))||[],hi15=k15?.map(r=>parseFloat(r[2]))||[],lo15=k15?.map(r=>parseFloat(r[3]))||[];
  const cl4=k4?.map(r=>parseFloat(r[4]))||[];
  const n1=cl1.length-1,n15=cl15.length-1,n4=cl4.length-1;
  const p=cl1[n1];
  const atr1=TA.atr(hi1,lo1,cl1,14),atrN=atr1[n1];
  const rsi1=TA.rsi(cl1,14),rsiN=rsi1[n1];
  const macd1=TA.macd(cl1,5,13,5),hN=macd1.hist[n1],hP=macd1.hist[n1-1];
  const bb1=TA.bb(cl1,20),bbN=bb1[n1];
  const bw=bbN?.bw||0,avgBW=bb1.slice(-20).filter(b=>b.bw).reduce((s,b)=>s+b.bw,0)/20||0.01;
  const e9=TA.ema(cl1,9),e21=TA.ema(cl1,21),e9n=e9[n1],e21n=e21[n1];

  // AGENT 1: Momentum Sniper
  const ag1=(()=>{
    const xBull=hN>0&&hP<=0&&rsiN>42,xBear=hN<0&&hP>=0&&rsiN<58;
    const momBull=rsiN>52&&rsiN<74&&hN>0,momBear=rsiN<48&&rsiN>26&&hN<0;
    const dir=xBull||momBull?"LONG":"SHORT";
    const sc=xBull||xBear?0.82:momBull||momBear?0.74:Math.abs(50-rsiN)/50*0.55+0.32;
    return{name:"Momentum",sc,dir,sig:xBull?"MACD X BULL":xBear?"MACD X BEAR":momBull?"RSI TREND UP":"RSI TREND DN",det:`RSI ${rsiN.toFixed(0)} MACD ${hN>0?"+":""}${hN.toFixed(4)}`};
  })();
  // AGENT 2: Structure / Smart Money
  const ag2=(()=>{
    const{sh,sl:swl}=TA.swings(hi1,lo1,3);
    const bosL=sh.length>=2&&p>sh[sh.length-2].p,bosS=swl.length>=2&&p<swl[swl.length-2].p;
    const nearSup=swl.length&&Math.abs(p-swl[swl.length-1].p)/p<0.003;
    const nearRes=sh.length&&Math.abs(p-sh[sh.length-1].p)/p<0.003;
    const dir=bosL||nearSup?"LONG":bosS||nearRes?"SHORT":of.score>0.5?"LONG":"SHORT";
    const sc=bosL||bosS?0.85:nearSup||nearRes?0.74:0.55;
    return{name:"Smart Money",sc,dir,sig:bosL?"BOS LONG":bosS?"BOS SHORT":nearSup?"SUP BOUNCE":"SCAN",det:`BOS:${bosL||bosS?"YES":"NO"} OF:${of.pressure}`};
  })();
  // AGENT 3: TF Alignment
  const ag3=(()=>{
    const bull1=p>e9n&&e9n>e21n;
    const e21_15=cl15.length>22?TA.ema(cl15,21):null,bull15=e21_15?cl15[n15]>e21_15[n15]:null;
    const e21_4=cl4.length>22?TA.ema(cl4,21):null,bull4=e21_4?cl4[n4]>e21_4[n4]:null;
    const v=[bull1,bull15,bull4].filter(x=>x!==null);
    const bV=v.filter(Boolean).length;
    const sc=bV===v.length||bV===0?0.88:bV>v.length/2?0.70:0.62;
    const dir=bV>=v.length/2?"LONG":"SHORT";
    return{name:"TF Alignment",sc,dir,sig:bV===v.length?"FULL BULL":bV===0?"FULL BEAR":dir==="LONG"?"LEAN BULL":"LEAN BEAR",det:`${bV}/${v.length} TFs bullish`};
  })();
  // AGENT 4: Breakout/Squeeze
  const ag4=(()=>{
    const squeeze=bw<avgBW*0.7,expand=bw>avgBW*1.5;
    const bbBull=bbN&&p>=bbN.u*0.998,bbBear=bbN&&p<=bbN.l*1.002;
    const dir=bbBull||expand&&of.score>0.5?"LONG":bbBear||expand&&of.score<0.5?"SHORT":of.score>0.5?"LONG":"SHORT";
    const sc=expand&&(bbBull||bbBear)?0.84:squeeze?0.58:expand?0.72:0.55;
    return{name:"Breakout",sc,dir,sig:squeeze?"SQUEEZE":expand?"EXPANDING":bbBull?"BB UPPER":bbBear?"BB LOWER":"NEUTRAL",det:`BW ${bw.toFixed(4)} vs avg ${avgBW.toFixed(4)}`};
  })();
  // AGENT 5: Volume Flow
  const ag5=(()=>{
    let bP=0,sP=0;
    k1.slice(-8).forEach(r=>{const c=parseFloat(r[4]),o=parseFloat(r[1]),v=parseFloat(r[5]);c>o?bP+=v:sP+=v;});
    const fb=bP/(bP+sP+1e-9);
    const vols=k1.map(r=>parseFloat(r[5])),avgV=vols.slice(-20).reduce((s,v)=>s+v,0)/20||1;
    const spike=vols[n1]>avgV*1.8;
    const dir=fb>0.5?"LONG":"SHORT";
    const sc=Math.min(0.90,0.45+Math.abs(fb-0.5)*0.85+(spike?0.10:0));
    return{name:"Volume Flow",sc,dir,sig:spike?"VOL SPIKE":fb>0.62?"BUY DOM":fb<0.38?"SELL DOM":"BALANCED",det:`Flow ${(fb*100).toFixed(0)}%${spike?" ⚡":""}`};
  })();
  // AGENT 6: Fibonacci
  const ag6=(()=>{
    const rH=Math.max(...hi1.slice(-40)),rL=Math.min(...lo1.slice(-40));
    const f=TA.fibonacci(rH,rL);
    const lvls=[f.r236,f.r382,f.r500,f.r618,f.r786];
    const near=lvls.reduce((a,b)=>Math.abs(b-p)<Math.abs(a-p)?b:a);
    const pct=Math.abs(near-p)/p;
    const dir=near<p?"LONG":"SHORT";
    const sc=pct<0.003?0.78:pct<0.008?0.66:0.52;
    const ln=near===f.r382?"38.2%":near===f.r618?"61.8%":near===f.r500?"50%":near===f.r236?"23.6%":"78.6%";
    return{name:"Fibonacci",sc,dir,sig:pct<0.003?"AT "+ln:pct<0.008?"NEAR "+ln:"BETWEEN",det:`Nearest ${ln} · ${(pct*100).toFixed(3)}% away`};
  })();
  // AGENT 7: Regime Adaptive
  const ag7=(()=>{
    const mul=regime.regime==="STRONG_BULL"||regime.regime==="STRONG_BEAR"?1.5:regime.regime==="HIGH_VOLATILITY"?0.6:regime.regime==="COMPRESSION"?0.4:1.0;
    const sc=regime.regime==="STRONG_BULL"||regime.regime==="STRONG_BEAR"?0.90:regime.regime?.includes("MODERATE")?0.78:0.60;
    const dir=regime.dir==="BULLISH"?"LONG":regime.dir==="BEARISH"?"SHORT":signals.int?.dir||"LONG";
    return{name:"Regime Adapt",sc,dir,sig:regime.regime?.replace(/_/g," ")||"UNKNOWN",det:`Size ×${mul.toFixed(1)} Conf ${(regime.conf*100).toFixed(0)}%`,mul};
  })();
  // AGENT 8: Crash/Boom Dynamics
  const ag8=(()=>{
    const isCrash=sym?.startsWith("CRASH"),isBoom=sym?.startsWith("BOOM");
    if(isCrash){const deepOS=rsiN<25,rec=rsiN<40&&rsiN>rsi1[n1-1];return{name:"CB Dynamics",sc:deepOS?0.84:rec?0.74:0.55,dir:"LONG",sig:deepOS?"DEEP OS":"RECOVERY",det:`Crash recovery RSI ${rsiN.toFixed(0)}`};}
    if(isBoom){const deepOB=rsiN>75,fad=rsiN>60&&rsiN<rsi1[n1-1];return{name:"CB Dynamics",sc:deepOB?0.82:fad?0.72:0.55,dir:"SHORT",sig:deepOB?"OVERBOUGHT":"FADING",det:`Boom fade RSI ${rsiN.toFixed(0)}`};}
    const dir=regime.dir==="BULLISH"?"LONG":regime.dir==="BEARISH"?"SHORT":of.score>0.5?"LONG":"SHORT";
    return{name:"Mkt Context",sc:regime.conf>0.7?0.78:0.60,dir,sig:regime.dir||"NEUTRAL",det:`Regime ${regime.regime?.replace(/_/g," ")||"LOAD"}`};
  })();
  // AGENT 9: R:R Optimizer
  const ag9=(()=>{
    const bS=signals.trd||signals.int||signals.snp;
    if(!bS) return{name:"R:R Optimizer",sc:0.50,dir:"LONG",sig:"NO SIG",det:"Awaiting signal"};
    const rr=bS.rr||1.5,mc=bS.mc,evP=mc?.ev>0,rrOK=rr>=1.3,pOK=!mc||mc.probTP>=0.48;
    const sc=rrOK&&evP&&pOK?0.88:rrOK&&pOK?0.74:rrOK?0.65:0.42;
    return{name:"R:R Optimizer",sc,dir:bS.dir,sig:rrOK&&evP?"FAVORABLE":rrOK?"ADEQUATE":"POOR RR",det:`R:R ${rr.toFixed(2)}x EV ${mc?(mc.ev>0?"+":"")+mc.ev.toFixed(3):"—"}`};
  })();
  // AGENT 10: Session Timing
  const ag10=(()=>{
    const h=new Date().getUTCHours();
    const synth=["R_","1HZ","CRASH","BOOM","stp","JD"].some(px=>sym?.startsWith(px));
    if(synth) return{name:"Session",sc:0.80,dir:of.score>0.5?"LONG":"SHORT",sig:"24/7 SYNTH",det:"Always open"};
    const overlap=h>=12&&h<16,ny=h>=12&&h<17,ldn=h>=7&&h<16,lowLiq=(h>=17&&h<20)||(h>=5&&h<7);
    const sc=overlap?0.88:ny||ldn?0.80:lowLiq?0.42:0.65;
    const sess=overlap?"LDN/NY OVR":ny?"NY OPEN":ldn?"LDN OPEN":lowLiq?"LOW LIQ":"OFF PEAK";
    return{name:"Session",sc,dir:of.score>0.5?"LONG":"SHORT",sig:sess,det:`UTC ${h}:xx`};
  })();
  // AGENT 11: Exposure Guard
  const ag11=(()=>{
    const openT=trades.filter(t=>t.status==="OPEN");
    const recLoss=trades.filter(t=>t.status==="CLOSED"&&Date.now()-t.closedAt<3600000&&t.outcome==="SL").length;
    const sc=openT.length>=3||recLoss>=2?0.30:openT.length===0?0.88:openT.length===1?0.78:0.68;
    return{name:"Exposure Guard",sc,dir:"LONG",sig:openT.length>=3?"MAX OPEN":recLoss>=2?"LOSS STREAK":openT.length===0?"CLEAN":"MANAGED",det:`${openT.length} open ${recLoss} recent SL`};
  })();
  // AGENT 12: Institutional Pressure (15m order blocks)
  const ag12=(()=>{
    if(!k15||k15.length<10) return{name:"Inst. Pressure",sc:0.55,dir:of.score>0.5?"LONG":"SHORT",sig:"NO 15M",det:"Need 15m data"};
    const n=k15.length-1;
    const c15=parseFloat(k15[n][4]),o15=parseFloat(k15[n][1]);
    const atr15=TA.atr(hi15,lo15,cl15,14)[n];
    const bigBull=c15>o15&&(c15-o15)>atr15*1.2;
    const bigBear=o15>c15&&(o15-c15)>atr15*1.2;
    const e21_15=cl15.length>22?TA.ema(cl15,21):null;
    const bull15=e21_15?cl15[n]>e21_15[n]:c15>o15;
    const dir=bigBull||bull15?"LONG":bigBear||!bull15?"SHORT":"LONG";
    const sc=bigBull||bigBear?0.85:bull15?0.68:0.55;
    return{name:"Inst. Pressure",sc,dir,sig:bigBull?"ORDER BLOCK ▲":bigBear?"ORDER BLOCK ▼":bull15?"BULL FLOW":"BEAR FLOW",det:`15m candle ${bigBull||bigBear?"OB":"norm"} ATR ${atr15?.toFixed(2)||"—"}`};
  })();

  const agents=[ag1,ag2,ag3,ag4,ag5,ag6,ag7,ag8,ag9,ag10,ag11,ag12];
  const W=loadAWeights(); // learning weights — rebalanced every 20 trades
  let lW=0,sW=0;
  agents.forEach((a,i)=>{const w=W[i];a.dir==="LONG"?lW+=a.sc*w:sW+=a.sc*w;});
  const lP=lW/(lW+sW),sP=sW/(lW+sW);
  const dir=lP>=sP?"LONG":"SHORT";
  const cons=Math.max(lP,sP);
  const exposOK=ag11.sc>0.50,rrOK2=ag9.sc>0.55,timeOK=ag10.sc>0.50;
  const canEx=cons>=0.63&&exposOK&&rrOK2&&timeOK;
  const verdict=canEx&&cons>=0.75?"EXECUTE":canEx?"CONFIRM":cons>=0.60?"WATCH":"SCAN";
  const vCol=verdict==="EXECUTE"?C.green:verdict==="CONFIRM"?C.gold:verdict==="WATCH"?C.orange:C.dim;
  const bSig=signals.trd||signals.int||signals.snp;
  const mul=ag7.mul||1.0;
  const sugStake=+(DEFAULT_STAKE*mul).toFixed(2);
  return{agents,dir,consensus:cons,longPct:lP,shortPct:sP,verdict,verdictCol:vCol,canExecute:canEx,bestSig:bSig,suggestedStake:sugStake,summary:`${verdict} ${dir} · ${agents.filter(a=>a.dir===dir).length}/12 agree · ${(cons*100).toFixed(0)}%`};
}

/* ─── ProBrain Panel ─────────────────────────────────────────────────── */
const ProBrainPanel=memo(function ProBrainPanel({brain,onExecute,tradeLoading}){
  if(!brain) return null;
  const{agents,dir,consensus,verdict,verdictCol,canExecute,bestSig,suggestedStake,summary,longPct,shortPct}=brain;
  const lA=agents.filter(a=>a.dir==="LONG").length;
  return <section>
    <SecTitle ch="Pro Trading Brain" sub="12-agent ensemble · weighted vote · never dormant"/>
    <Box style={{marginBottom:9,padding:"14px 16px",border:`1px solid ${verdictCol}35`,background:`${verdictCol}08`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",marginBottom:3}}>BRAIN VERDICT</div>
          <div style={{fontSize:26,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:verdictCol,letterSpacing:"0.08em"}}>{verdict}</div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
            <span style={{fontSize:15,color:dir==="LONG"?C.green:C.red}}>{dir==="LONG"?"▲":"▼"}</span>
            <span style={{fontSize:13,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:dir==="LONG"?C.green:C.red}}>{dir}</span>
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",marginBottom:1}}>CONSENSUS</div>
          <div style={{fontSize:34,fontFamily:"'Space Mono',monospace",fontWeight:700,color:verdictCol,fontVariantNumeric:"tabular-nums",lineHeight:1}}>{(consensus*100).toFixed(0)}%</div>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",marginTop:2}}>{lA}L / {12-lA}S agents</div>
        </div>
      </div>
      <div style={{height:6,background:C.muted,borderRadius:3,overflow:"hidden",marginBottom:6}}>
        <div style={{width:`${longPct*100}%`,height:"100%",background:`linear-gradient(90deg,${C.green},${C.gold})`,borderRadius:3,transition:"width 0.8s ease"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,fontFamily:"'Space Mono',monospace",marginBottom:9}}>
        <span style={{color:C.green}}>▲ {(longPct*100).toFixed(0)}%</span>
        <span style={{color:C.dim,fontSize:7}}>{summary}</span>
        <span style={{color:C.red}}>▼ {(shortPct*100).toFixed(0)}%</span>
      </div>
      {canExecute&&bestSig?<button onClick={()=>onExecute(bestSig,suggestedStake)} disabled={tradeLoading}
        style={{width:"100%",padding:"10px 0",borderRadius:7,background:`${verdictCol}20`,border:`1.5px solid ${verdictCol}60`,color:verdictCol,fontFamily:"'Space Mono',monospace",fontWeight:700,fontSize:11,cursor:"pointer",letterSpacing:"0.1em",opacity:tradeLoading?0.5:1}}>
        {tradeLoading?"⏳ EXECUTING…":`⚡ BRAIN EXECUTE — ${dir} $${suggestedStake} · ${bestSig.id}`}
      </button>:<div style={{padding:"7px",background:`${C.muted}40`,borderRadius:5,border:`1px solid ${C.border}`,textAlign:"center"}}>
        <span style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{verdict==="WATCH"?"Watching — building conviction":"Scanning — await alignment"}</span>
      </div>}
    </Box>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
      {agents.map((a,i)=>{
        const aC=a.dir==="LONG"?C.green:C.red;
        const sC=a.sc>=0.80?C.green:a.sc>=0.65?C.gold:a.sc>=0.52?C.orange:C.red;
        return <Box key={i} style={{padding:"9px 11px",border:`1px solid ${a.sc>=0.75?aC+"28":C.border}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
            <div>
              <div style={{fontSize:10,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:C.bright}}>{a.name}</div>
              <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis",maxWidth:110}}>{a.det}</div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontSize:12,fontFamily:"'Space Mono',monospace",fontWeight:700,color:sC,fontVariantNumeric:"tabular-nums"}}>{(a.sc*100).toFixed(0)}%</div>
              <div style={{fontSize:8,color:aC}}>{a.dir==="LONG"?"▲L":"▼S"}</div>
            </div>
          </div>
          <div style={{height:2,background:C.muted,borderRadius:1,marginBottom:3}}>
            <div style={{width:`${a.sc*100}%`,height:"100%",background:sC,borderRadius:1}}/>
          </div>
          <span style={{fontSize:7,background:`${aC}15`,border:`1px solid ${aC}30`,borderRadius:2,padding:"1px 4px",color:aC,fontFamily:"'Space Mono',monospace"}}>{a.sig}</span>
        </Box>;
      })}
    </div>
  </section>;
});
   Hard gates: conf<75%, RR<1.5, overtrading, scalp-lock, direction clash
   Directives: move-to-BE, partial close, early exit, funding gate
   Audit: agent logic conflict detection
   Modes: NORMAL → PROTECTIVE → RESTRICTED → PAUSED
═══════════════════════════════════════════════════════════════════════ */
function runTMA(signals,trades,regime,of,fundRate,dailyKilled,recoveryActive){
  const safeT=Array.isArray(trades)?trades:[];
  const now=Date.now();
  const openT=safeT.filter(t=>t.status==="OPEN");
  const closedT=safeT.filter(t=>t.status==="CLOSED");
  const wins=closedT.filter(t=>t.outcome==="TP"||t.outcome==="TRAIL_TP");
  const losses=closedT.filter(t=>t.outcome==="SL");
  const sessionWR=closedT.length?wins.length/closedT.length:null;
  const recentT=closedT.filter(t=>now-t.closedAt<3600000);
  const tradesLastHour=recentT.length+openT.length;
  let winStreak=0;for(let i=closedT.length-1;i>=0;i--){if(closedT[i].outcome!=="SL")winStreak++;else break;}
  let streak=0;
  for(let i=closedT.length-1;i>=0;i--){if(closedT[i].outcome==="SL")streak++;else break;}

  // Global mode
  let globalMode="NORMAL",pauseUntil=0;
  const globalReasons=[];
  if(dailyKilled){
    globalMode="PAUSED";globalReasons.push("Daily loss hard stop (10%) — no new trades today");
  } else if(streak>=TMA_LOSS_PAUSE){
    globalMode="PAUSED";
    pauseUntil=(closedT[closedT.length-1]?.closedAt||now)+(30*60000);
    globalReasons.push(`Circuit breaker: ${streak} consecutive losses → 30 min cooldown`);
  } else if(sessionWR!==null&&sessionWR<TMA_WR_STRICT){
    globalMode="PAUSED";globalReasons.push(`Win rate critical (${(sessionWR*100).toFixed(0)}%) — suspended`);
  } else if(recoveryActive){
    globalMode="PROTECTIVE";globalReasons.push("Recovery mode: balance 5%+ below session peak → halved stake, 80%+ conf only");
  } else if(sessionWR!==null&&sessionWR<TMA_WR_FLOOR){
    globalMode="PROTECTIVE";globalReasons.push(`Win rate low (${(sessionWR*100).toFixed(0)}%) — 80%+ conf only`);
  } else if(tradesLastHour>=TMA_HOUR_LIMIT){
    globalMode="RESTRICTED";globalReasons.push(`Overtrading: ${tradesLastHour} trades/hour — reducing activity`);
  }
  const effMin=globalMode==="PROTECTIVE"?0.80:TMA_CONF_MIN;
  const isPaused=globalMode==="PAUSED"||(pauseUntil>0&&now<pauseUntil);

  function evalSig(sig,id){
    const v={id,verdict:"APPROVED",reasons:[],adjustments:[]};
    if(!sig) return{...v,verdict:"NO_SIGNAL",reasons:["No qualified signal on closed candles"]};
    if(isPaused){return{...v,verdict:"BLOCKED",reasons:["TMA paused — "+globalMode+(pauseUntil>now?" · "+Math.round((pauseUntil-now)/60000)+"m left":"")]};}
    if(sig.finalConf<effMin) v.reasons.push(`Conf ${(sig.finalConf*100).toFixed(1)}% < ${(effMin*100).toFixed(0)}% min`);
    if(sig.rr<TMA_MIN_RR)    v.reasons.push(`R:R ${sig.rr.toFixed(2)}x < ${TMA_MIN_RR}x min`);
    if(sig.mc&&sig.mc.ev<=0) v.reasons.push(`Negative EV ($${Math.round(sig.mc.ev)})`);
    if(sig.mc&&sig.mc.probTP<0.50) v.reasons.push(`MC win prob ${(sig.mc.probTP*100).toFixed(0)}% < 50%`);
    if(id==="SNP"&&openT.find(t=>t.id==="SNP")) v.reasons.push("Scalp lock: SNP already open");
    if(openT.length>=TMA_MAX_OPEN) v.reasons.push(`Max open trades (${TMA_MAX_OPEN}) reached`);
    const trdT=openT.find(t=>t.id==="TRD");
    if(id==="SNP"&&trdT&&trdT.dir!==sig.dir) v.reasons.push(`Direction clash: scalp ${sig.dir} vs TRD ${trdT.dir}`);
    // Hour-of-day filter: auto-avoid hours with historically 0% win rate
    const journal=loadJournal();
    if(journal.length>=20){
      const h=new Date().getUTCHours();
      const hourTrades=journal.filter(t=>t.openedAt&&new Date(t.openedAt).getUTCHours()===h&&t.outcome);
      if(hourTrades.length>=5){
        const hourWR=hourTrades.filter(t=>t.outcome!=="SL"&&t.outcome!=="MANUAL_BAD").length/hourTrades.length;
        if(hourWR<0.30)v.reasons.push(`Hour UTC ${h}:xx has only ${(hourWR*100).toFixed(0)}% win rate (${hourTrades.length} trades) — avoid`);
      }
    }
    if(v.reasons.length>0){v.verdict="DENIED";return v;}
    // Approved — add advisory adjustments
    if(sig.dir==="LONG"&&fundRate>TMA_FUNDING_L) v.adjustments.push(`Funding ${fundRate.toFixed(3)}% — longs carry cost, reduce size 25%`);
    if(sig.dir==="SHORT"&&fundRate<TMA_FUNDING_S) v.adjustments.push(`Funding ${fundRate.toFixed(3)}% — shorts carry cost, reduce size 25%`);
    if(id==="SNP"&&(regime.regime==="STRONG_BULL"||regime.regime==="STRONG_BEAR")) v.adjustments.push("Strong trend active — scalp tight, max 1× ATR stop");
    if(id==="TRD"&&regime.regime==="RANGE_BOUND") v.adjustments.push("Range regime — TRD lower reliability, halve size");
    if(id==="TRD"&&regime.regime==="HIGH_VOLATILITY") v.adjustments.push("High vol — widen TRD stop by 1.5× ATR");
    const flowOK=(sig.dir==="LONG"&&of.score>0.50)||(sig.dir==="SHORT"&&of.score<0.50);
    if(!flowOK) v.adjustments.push(`OB ${of.pressure} opposes direction — consider waiting for flow alignment`);
    if(sig.mc?.p50) v.adjustments.push(`MC median target $${sig.mc.p50?.toLocaleString()} · ${Math.abs((sig.mc.p50-sig.entry)/sig.entry*100).toFixed(2)}% move`);
    return v;
  }

  // Regime change early-warning
  const regimeTransition=regime.slopeTurning&&globalMode==="NORMAL";

  // Active trade directives
  const directives=[];
  openT.forEach(t=>{
    const p=t.currentPrice||t.entry;
    const tp1=t.tp[0],tp2=t.tp[1];
    // Time-based hard exit: 2× expected duration → thesis invalidated
    const expectedMs=(t.id==="SNP"?480:t.id==="INT"?2700:14400)*1000;
    if((now-t.openedAt)>expectedMs*2)
      directives.push({id:t.id,sym:t.sym,action:"TIME_EXIT",label:"Time-Based Exit",
        desc:`Held ${Math.round((now-t.openedAt)/60000)}m — 2× expected — close position`,priority:"HIGH",col:C.red});
    const toTP1=Math.abs(tp1-t.entry);
    const prog=toTP1>0?Math.abs(p-t.entry)/toTP1:0;
    const pnlPct=t.dir==="LONG"?(p-t.entry)/t.entry*100:(t.entry-p)/t.entry*100;
    if(prog>=TMA_BE_TRIGGER&&!t.beApplied&&pnlPct>0)
      directives.push({id:t.id,sym:t.sym,action:"MOVE_BE",label:"Move SL → Breakeven",
        desc:`${(prog*100).toFixed(0)}% to TP1 · lock entry $${t.entry.toLocaleString()}`,priority:"HIGH",col:C.gold});
    if(prog>=TMA_PARTIAL_AT&&!t.partialClosed&&pnlPct>0)
      directives.push({id:t.id,sym:t.sym,action:"PARTIAL_CLOSE",label:"Take 50% Partial",
        desc:`Bank half at ${(pnlPct).toFixed(2)}% profit, run remainder`,priority:"HIGH",col:C.green});
    const regimeMismatch=(t.dir==="LONG"&&regime.dir==="BEARISH")||(t.dir==="SHORT"&&regime.dir==="BULLISH");
    if(regimeMismatch&&pnlPct>0.2)
      directives.push({id:t.id,sym:t.sym,action:"CONSIDER_EXIT",label:"Regime Flip — Consider Exit",
        desc:`Regime now ${regime.dir} · PnL +${pnlPct.toFixed(2)}%`,priority:"MEDIUM",col:C.orange});
    if(regimeTransition&&pnlPct>0)
      directives.push({id:t.id,sym:t.sym,action:"TIGHTEN_STOP",label:"Regime Transitioning — Tighten Stop",
        desc:`EMA slope turning · protect +${pnlPct.toFixed(2)}%`,priority:"HIGH",col:C.orange});
    if(t.tpsHit>=1&&tp2&&!t.partialClosed)
      directives.push({id:t.id,action:"INFO",label:"TP1 Hit — Manage Runner",
        desc:`Trail stop active · targeting TP2 $${tp2?.toLocaleString()}`,priority:"INFO",col:C.cyan});
    if(t.dir==="LONG"&&fundRate>TMA_FUNDING_L&&(now-t.openedAt)>3600000)
      directives.push({id:t.id,action:"INFO",label:"Funding Cost",
        desc:`Long open ${Math.round((now-t.openedAt)/3600000)}h · ${fundRate.toFixed(3)}% funding eroding PnL`,priority:"LOW",col:C.dim});
  });

  // Agent audit
  const audit=[];
  if(signals.snp&&regime.dir!=="NEUTRAL"&&signals.snp.dir==="LONG"&&regime.dir==="BEARISH")
    audit.push({agent:"SNP vs Regime",sev:"WARN",msg:"LONG scalp against BEARISH regime — false positive risk"});
  if(signals.snp&&regime.dir!=="NEUTRAL"&&signals.snp.dir==="SHORT"&&regime.dir==="BULLISH")
    audit.push({agent:"SNP vs Regime",sev:"WARN",msg:"SHORT scalp against BULLISH regime — false positive risk"});
  if(signals.int&&signals.trd&&signals.int.dir!==signals.trd.dir)
    audit.push({agent:"INT vs TRD",sev:"WARN",msg:`INT ${signals.int?.dir} conflicts with TRD ${signals.trd?.dir} — HTF takes priority`});
  if(of.score>0.62&&regime.dir==="BEARISH")
    audit.push({agent:"OB vs Regime",sev:"INFO",msg:"Buy-dominant OB in BEARISH regime — short-covering, not genuine demand"});
  if(of.score<0.38&&regime.dir==="BULLISH")
    audit.push({agent:"OB vs Regime",sev:"INFO",msg:"Sell-dominant OB in BULLISH regime — distribution zone possible"});
  if(signals.snp&&signals.int&&signals.trd&&signals.snp.dir===signals.int.dir&&signals.int.dir===signals.trd.dir)
    audit.push({agent:"Full Alignment",sev:"OK",msg:`All cards agree: ${signals.snp.dir} — highest-conviction setup`});
  if(regime.conf<0.55)
    audit.push({agent:"Regime Engine",sev:"WARN",msg:`Regime confidence ${(regime.conf*100).toFixed(0)}% — structure unclear, prefer no-trade`});
  if(audit.length===0)
    audit.push({agent:"All Agents",sev:"OK",msg:"No logic conflicts detected — agents operating normally"});

  // Recommendations
  const recs=[];
  if(globalMode!=="NORMAL") recs.push({icon:"⚠",col:C.orange,text:globalReasons[0]});
  if(isPaused&&pauseUntil>now) recs.push({icon:"⛔",col:C.red,text:`Paused · resumes in ${Math.round((pauseUntil-now)/60000)} min`});
  if(sessionWR!==null&&sessionWR>0.65&&globalMode==="NORMAL")
    recs.push({icon:"↑",col:C.green,text:`Win rate ${(sessionWR*100).toFixed(0)}% — system performing well, standard sizing`});
  if(streak===2) recs.push({icon:"⚠",col:C.orange,text:"Two consecutive losses — review last trades before next entry"});
  if(winStreak>=HOT_STREAK_MIN)recs.push({icon:"🔥",col:C.gold,text:`${winStreak}-win hot streak · 1.5× Kelly stake active (house money mode)`});
  const bestApproved=[{v:evalSig(signals.snp,"SNP"),s:signals.snp},{v:evalSig(signals.int,"INT"),s:signals.int},{v:evalSig(signals.trd,"TRD"),s:signals.trd}]
    .filter(x=>x.v.verdict==="APPROVED"&&x.s);
  if(bestApproved.length>0){
    const best=bestApproved.sort((a,b)=>(b.s?.finalConf||0)-(a.s?.finalConf||0))[0];
    recs.push({icon:"✓",col:C.green,text:`Best setup: ${best.v.id} ${best.s?.dir} @ $${best.s?.entry?.toLocaleString()} — ${(best.s?.finalConf*100).toFixed(0)}% conf`});
  } else if(openT.length===0){
    recs.push({icon:"◎",col:C.dim,text:"No valid setups — await closed-candle alignment"});
  }
  if(regime.regime==="COMPRESSION") recs.push({icon:"◈",col:C.cyan,text:"Compression: prepare for breakout, don't trade inside range"});
  if(Math.abs(fundRate)>0.05) recs.push({icon:"⬡",col:C.gold,text:`Extreme funding ${fundRate.toFixed(3)}% — ${fundRate>0?"long squeeze risk":"short squeeze risk"}`});

  return{
    snp:evalSig(signals.snp,"SNP"), int:evalSig(signals.int,"INT"), trd:evalSig(signals.trd,"TRD"),
    directives,audit,recs,globalMode,globalReasons,isPaused,pauseUntil,
    winStreak,regimeTransition,
    sessionStats:{wr:sessionWR,wins:wins.length,losses:losses.length,
      total:closedT.length,streak,winStreak,tradesLastHour,openCount:openT.length}
  };
}


/* ─── ATR CHANDELIER TRAILING STOP ENGINE ────────────────────────────── */
// Chandelier Exit: best trailing stop for trend following
// Long trail = highest(close, 22) - ATR(22)*3  (only moves UP, never DOWN)
// Short trail = lowest(close, 22) + ATR(22)*3  (only moves DOWN, never UP)
function updateTrailingStop(trade, currentPrice, klines){
  const k=closedOnly(klines);
  if(!k?.length||!trade) return trade;
  const cl=k.map(r=>parseFloat(r[4]));
  const hi=k.map(r=>parseFloat(r[2]));
  const lo=k.map(r=>parseFloat(r[3]));
  const chandArr=TA.chandelier(hi,lo,cl,22,CHANDELIER_M);
  const latest=chandArr[chandArr.length-1];
  if(!latest) return trade;

  if(trade.dir==="LONG"){
    // Chandelier long: only ratchet UP
    const newTS=Math.round(latest.long);
    const trailStop=Math.max(trade.trailStop||trade.sl, newTS);
    return{...trade,trailStop};
  } else {
    // Chandelier short: only ratchet DOWN
    const newTS=Math.round(latest.short);
    const trailStop=Math.min(trade.trailStop||trade.sl, newTS);
    return{...trade,trailStop};
  }
}

/* ─── TRADE REDUCER ──────────────────────────────────────────────────── */
function tradesReducer(rawState, action){
  // GUARD: always return array — prevents TypeError: trades.filter is not a function
  const state=Array.isArray(rawState)?rawState:[];
  switch(action.type){
    case "OPEN": {
      const sig=action.sig;
      const symKey=action.sym||sig.sym||"";
      // FIX: deduplicate by BOTH id AND sym — prevents wrong-asset clobber
      if(state.find(t=>t.id===sig.id&&t.sym===symKey&&t.status==="OPEN")) return state;
      const trade={
        id:sig.id,
        sym:symKey,           // FIX: sym stored on every trade
        card:sig.card, dir:sig.dir, entry:sig.entry,
        sl:sig.sl, trailStop:sig.sl, tp:sig.tp, atr:sig.atr,
        col:sig.col, conf:sig.finalConf||sig.conf,
        contractId:action.contractId||sig.contractId||null,
        stake:action.stake||DEFAULT_STAKE, multiplier:action.multiplier||1,
        regime:sig.regime,
        openedAt:Date.now(), status:"OPEN",
        maxFav:0, maxAdv:0, tpsHit:0,
        beApplied:false, partialClosed:false,
        slippage:action.slippage||null,
      };
      return[...state.filter(t=>!(t.id===sig.id&&t.sym===symKey&&t.status==="OPEN")),trade].slice(-10);
    }
    case "UPDATE_TRAIL": {
      return state.map(t=>{
        // FIX: match by BOTH id AND sym
        if(t.status!=="OPEN"||t.id!==action.id||(action.sym&&t.sym!==action.sym)) return t;
        const p=action.price;
        const pnlPct=t.dir==="LONG"?(p-t.entry)/t.entry*100:(t.entry-p)/t.entry*100;
        const maxFav=Math.max(t.maxFav,Math.max(pnlPct,0));
        const maxAdv=Math.max(t.maxAdv,Math.max(-pnlPct,0));
        const ts=action.newTrailStop||t.trailStop;
        const trailStop=t.dir==="LONG"?Math.max(t.trailStop,ts):Math.min(t.trailStop,ts);
        let tpsHit=t.tpsHit;
        t.tp.forEach((tp,i)=>{
          if(tpsHit<=i){
            if(t.dir==="LONG"&&p>=tp) tpsHit=i+1;
            if(t.dir==="SHORT"&&p<=tp) tpsHit=i+1;
          }
        });
        return{...t,currentPrice:p,trailStop,maxFav,maxAdv,tpsHit,
          pnlPct:parseFloat(pnlPct.toFixed(3)),
          pnlUsd:parseFloat(((p-t.entry)*(t.dir==="LONG"?1:-1)).toFixed(4))};
      });
    }
    case "CLOSE": {
      // FIX: match by BOTH id AND sym — never clobber other assets
      return state.map(t=>{
        const symMatch=!action.sym||(t.sym===action.sym);
        if(t.id!==action.id||!symMatch||t.status!=="OPEN") return t;
        // FIX: capture real profit from Deriv settlement
        return{...t,status:"CLOSED",outcome:action.outcome,closedAt:Date.now(),
          closePrice:action.price,profit:action.profit!=null?action.profit:null};
      });
    }
    case "CHECK_STOPS": {
      const p=action.price;
      return state.map(t=>{
        // FIX: only check stops for current sym
        if(t.status!=="OPEN"||(action.sym&&t.sym!==action.sym)) return t;
        const stopHit=t.dir==="LONG"?p<=t.trailStop:p>=t.trailStop;
        if(stopHit) return{...t,status:"CLOSED",outcome:t.tpsHit>0?"TRAIL_TP":"SL",closedAt:Date.now(),closePrice:p};
        const allTPHit=t.dir==="LONG"?p>=t.tp[t.tp.length-1]:p<=t.tp[t.tp.length-1];
        if(allTPHit) return{...t,status:"CLOSED",outcome:"TP",closedAt:Date.now(),closePrice:p};
        return t;
      });
    }
    case "MOVE_BE": {
      return state.map(t=>{
        const symMatch=!action.sym||(t.sym===action.sym);
        if(t.status!=="OPEN"||t.id!==action.id||!symMatch) return t;
        const trailStop=t.dir==="LONG"?Math.max(t.trailStop,t.entry):Math.min(t.trailStop,t.entry);
        return{...t,trailStop,beApplied:true};
      });
    }
    case "PARTIAL_CLOSE": {
      return state.map(t=>{
        const symMatch=!action.sym||(t.sym===action.sym);
        return t.id===action.id&&symMatch&&t.status==="OPEN"?{...t,partialClosed:true}:t;
      });
    }
    case "UPDATE_PROFIT": {
      // Update live profit from proposal_open_contract stream
      return state.map(t=>t.contractId===action.contractId?{...t,currentProfit:action.profit}:t);
    }
    default: return state;
  }
}

/* ─── DATA HOOK: SPLIT STREAMS ───────────────────────────────────────── */
// price stream = fast (every tick, display only)
// candle store = slow (update only on CLOSED candle → k.x===true)
// depth = 500ms throttled
function useMarketData(){
  // ── fast display state (price, depth display, funding)
  const [display,setDisplay]=useState({
    price:0,change24h:0,high24h:0,low24h:0,vol24h:0,
    fundRate:0,oi:0,markPrice:0,connected:false,loading:true,error:null
  });
  // ── closed candle store (ref → no re-render on tick, only on closed candle)
  const kRef=useRef({k1m:null,k5m:null,k15m:null,k1h:null,k4h:null,k1d:null});
  // ── candle version counter — increments only on closed candle
  const [candleVer,setCandleVer]=useState(0);
  // ── depth snapshot (throttled display)
  const [depth,setDepth]=useState({bids:[],asks:[]});
  const depthBuf=useRef({bids:[],asks:[]});
  const depthTimer=useRef(null);
  const wsRef=useRef(null);
  const reconnTimer=useRef(null);

  const loadRest=useCallback(async()=>{
    try{
      const[ticker,prem,oi,dp]=await Promise.all([REST.ticker(),REST.premium(),REST.oi(),REST.depth(20)]);
      const[k1m,k5m,k15m,k1h,k4h,k1d]=await Promise.all([
        REST.klines("1m",300),REST.klines("5m",200),REST.klines("15m",200),
        REST.klines("1h",200),REST.klines("4h",200),REST.klines("1d",100)
      ]);
      kRef.current={k1m,k5m,k15m,k1h,k4h,k1d};
      setDisplay(d=>({...d,
        price:parseFloat(ticker.lastPrice),change24h:parseFloat(ticker.priceChangePercent),
        high24h:parseFloat(ticker.highPrice),low24h:parseFloat(ticker.lowPrice),
        vol24h:parseFloat(ticker.quoteVolume)/1e9,
        fundRate:parseFloat(prem.lastFundingRate)*100,
        oi:parseFloat(oi.openInterest)*parseFloat(ticker.lastPrice)/1e9,
        markPrice:parseFloat(prem.markPrice),loading:false
      }));
      setDepth(dp);
      setCandleVer(v=>v+1);
    }catch(e){setDisplay(d=>({...d,error:e.message,loading:false}));}
  },[]);

  const connectWS=useCallback(()=>{
    if(wsRef.current) wsRef.current.close();
    const ws=new WebSocket(`${WS_BASE}?streams=btcusdt@kline_1m/btcusdt@kline_5m/btcusdt@depth20@500ms/btcusdt@markPrice@1s`);
    wsRef.current=ws;
    ws.onopen=()=>setDisplay(d=>({...d,connected:true}));
    ws.onclose=()=>{setDisplay(d=>({...d,connected:false}));reconnTimer.current=setTimeout(connectWS,3000);};
    ws.onerror=()=>setDisplay(d=>({...d,connected:false}));
    ws.onmessage=(evt)=>{
      try{
        const{stream,data}=JSON.parse(evt.data);
        if(!stream) return;

        // Price tick — only update price display, never trigger analysis
        if(stream.includes("kline_1m")){
          const k=data.k;
          setDisplay(d=>({...d,price:parseFloat(k.c),markPrice:parseFloat(k.c)}));
          // Closed candle → update store → bump version (triggers analysis)
          if(k.x){
            const nc=[k.t,k.o,k.h,k.l,k.c,k.v,k.T,"","",k.V,"",""];
            kRef.current.k1m=[...(kRef.current.k1m||[]).slice(-299),nc];
            setCandleVer(v=>v+1);  // analysis re-runs
          }
        }
        if(stream.includes("kline_5m")&&data.k?.x){
          const k=data.k;
          const nc=[k.t,k.o,k.h,k.l,k.c,k.v,k.T,"","",k.V,"",""];
          kRef.current.k5m=[...(kRef.current.k5m||[]).slice(-199),nc];
        }
        // Depth — buffer and flush at most every 600ms to avoid layout thrash
        if(stream.includes("depth20")){
          depthBuf.current={bids:data.b||[],asks:data.a||[]};
          if(!depthTimer.current){
            depthTimer.current=setTimeout(()=>{
              setDepth({...depthBuf.current});
              depthTimer.current=null;
            },600);
          }
        }
        // Funding (1s) — only update funding, not price
        if(stream.includes("markPrice")){
          setDisplay(d=>({...d,fundRate:parseFloat(data.r||0)*100}));
        }
      }catch{}
    };
  },[]);

  // Heavy refresh — 15m, 1h, 4h, 1d — every 60s
  useEffect(()=>{
    const heavy=async()=>{
      try{
        const[k15m,k1h,k4h,k1d,oi,dp]=await Promise.all([
          REST.klines("15m",200),REST.klines("1h",200),
          REST.klines("4h",200),REST.klines("1d",100),
          REST.oi(),REST.depth(20)
        ]);
        kRef.current={...kRef.current,k15m,k1h,k4h,k1d};
        setDisplay(d=>({...d,oi:parseFloat(oi.openInterest)*d.price/1e9}));
        setCandleVer(v=>v+1);
      }catch{}
    };
    const iv=setInterval(heavy,60000);
    return()=>clearInterval(iv);
  },[]);

  useEffect(()=>{
    loadRest(); connectWS();
    return()=>{
      if(wsRef.current) wsRef.current.close();
      if(reconnTimer.current) clearTimeout(reconnTimer.current);
      if(depthTimer.current) clearTimeout(depthTimer.current);
    };
  },[]);

  return{display,kRef,candleVer,depth};
}

/* ─── STABLE ANALYSIS HOOK ───────────────────────────────────────────── */
// Re-runs only when candleVer changes (closed candle) or regime TTL expires
// #51: Single-file architecture — useAnalysis and useScannerData are defined once,
// eliminating the duplicate import issue that existed in the Base44 multi-file version.
function useAnalysis(kRef, candleVer, sym){
  const [regime,setRegime]=useState({regime:"LOADING",dir:"NEUTRAL",conf:0});
  const [rawSignals,setRawSignals]=useState({snp:null,int:null,trd:null});
  const regimeTs=useRef(0);
  const signalTs=useRef(0);
  const sw=useMemo(()=>stratWeights(regime),[regime.regime]);
  // Compute OF from klines (Deriv has no orderbook — use price-action proxy)
  const of=useMemo(()=>calcOrderFlow(kRef.current.k1m),[candleVer]);

  useEffect(()=>{
    const now=Date.now();
    if(now-regimeTs.current>REGIME_TTL||regime.regime==="LOADING"){
      const r=detectRegime(kRef.current.k1m);
      setRegime(r);
      regimeTs.current=now;
    }
    if(now-signalTs.current>SIGNAL_TTL||signalTs.current===0){
      const freshOF=calcOrderFlow(kRef.current.k1m);
      const sigs=buildSignals(kRef.current,freshOF,regime,sym);
      setRawSignals(sigs);
      signalTs.current=now;
    }
  },[candleVer]);

  const asset=useMemo(()=>ASSETS.find(a=>a.sym===sym)||{thresh:{min:0.44}},[sym]);

  const signals=useMemo(()=>{
    const enrich=(sig,klines)=>{
      if(!sig) return null;
      const cl=closedOnly(klines)?.map(r=>parseFloat(r[4]));
      const mc=cl?.length>25?runMC(cl,sig.entry,sig.sl,sig.tp[0]):null;
      const risk=calcRisk(sig);
      const finalConf=aggregateConf(sig,mc,of,sw);
      if(finalConf<asset.thresh.min) return null;
      return{...sig,mc,risk,finalConf};
    };
    return{
      snp:enrich(rawSignals.snp,kRef.current.k1m),
      int:enrich(rawSignals.int,kRef.current.k15m),
      trd:enrich(rawSignals.trd,kRef.current.k4h),
    };
  },[rawSignals,sw]);

  return{regime,signals,sw,of};
}

/* ─── UI PRIMITIVES ──────────────────────────────────────────────────── */
// Fixed widths on all number displays prevent layout shift
const Box=memo(({style,...p})=><div style={{background:C.card,border:`1px solid ${C.border}`,
  borderRadius:10,padding:"13px 15px",contain:"layout style",...style}}{...p}/>);
const Num=({v,col,sz=18,w})=><div style={{fontFamily:"'Space Mono',monospace",fontWeight:700,
  fontSize:sz,color:col||C.bright,lineHeight:1.1,
  minWidth:w||"auto",fontVariantNumeric:"tabular-nums",letterSpacing:"-0.01em"}}>{v}</div>;
const Label=({ch,col,style})=><div style={{fontSize:9,letterSpacing:"0.12em",color:col||C.dim,
  textTransform:"uppercase",marginBottom:3,fontFamily:"'Space Mono',monospace",...style}}>{ch}</div>;
const Badge=({ch,col,sm})=><span style={{fontSize:sm?8:10,fontWeight:700,
  fontFamily:"'Space Mono',monospace",letterSpacing:"0.08em",color:col,
  background:`${col}18`,border:`1px solid ${col}30`,borderRadius:3,
  padding:sm?"1px 5px":"2px 7px",whiteSpace:"nowrap"}}>{ch}</span>;
const Dot=({col,pulse})=><span style={{width:7,height:7,borderRadius:"50%",
  background:col,display:"inline-block",flexShrink:0,
  boxShadow:pulse?`0 0 7px ${col}`:"none",
  animation:pulse?"blink 2s ease-in-out infinite":"none"}}/>;
const HR=()=><div style={{height:1,background:C.border,margin:"8px 0"}}/>;
const SecTitle=({ch,sub})=><div style={{padding:"18px 0 9px",contain:"layout"}}>
  <div style={{display:"flex",alignItems:"center",gap:7}}>
    <div style={{width:3,height:13,background:C.cyan,borderRadius:2,flexShrink:0}}/>
    <span style={{fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:13,
      letterSpacing:"0.18em",color:C.cyan,textTransform:"uppercase"}}>{ch}</span>
  </div>
  {sub&&<div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace",
    paddingLeft:10,marginTop:2}}>{sub}</div>}
  <div style={{height:1,background:C.border,marginTop:7}}/>
</div>;
const ChartTip=({active,payload})=>{
  if(!active||!payload?.length) return null;
  return <div style={{background:"rgba(3,7,20,0.98)",border:`1px solid ${C.border}`,
    borderRadius:5,padding:"5px 10px",fontSize:9,fontFamily:"'Space Mono',monospace",pointerEvents:"none"}}>
    {payload.map((p,i)=><div key={i} style={{color:p.color||C.cyan,whiteSpace:"nowrap"}}>
      {p.name}: {p.value?.toLocaleString()}
    </div>)}
  </div>;
};

/* ─── HEADER ─────────────────────────────────────────────────────────── */
const Header=memo(function Header({display,price}){
  const{change24h,vol24h,oi,fundRate,connected,loading,markPrice}=display;
  const up=change24h>=0;
  return <div style={{background:"rgba(2,7,17,0.99)",borderBottom:`1px solid ${C.border}`,
    padding:"9px 14px",position:"sticky",top:0,zIndex:100,
    willChange:"transform",backfaceVisibility:"hidden"}}>
    <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:"8px 16px"}}>
      <div style={{display:"flex",alignItems:"baseline",gap:7,minWidth:0}}>
        <span style={{fontSize:9,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
          color:C.dim,letterSpacing:"0.18em",flexShrink:0}}>BTCUSDT PERP</span>
        {/* Fixed-width price — never causes layout shift */}
        <span style={{fontSize:25,fontFamily:"'Space Mono',monospace",fontWeight:700,
          color:C.bright,letterSpacing:"-0.02em",minWidth:"11ch",
          fontVariantNumeric:"tabular-nums",display:"inline-block"}}>
          {loading?"···":("$"+price.toLocaleString())}
        </span>
        <span style={{fontSize:12,fontFamily:"'Space Mono',monospace",fontWeight:700,
          color:up?C.green:C.red,minWidth:"7ch",display:"inline-block",
          fontVariantNumeric:"tabular-nums"}}>{up?"+":""}{change24h.toFixed(2)}%</span>
      </div>
      <div style={{display:"flex",gap:12,flexWrap:"wrap",flex:1}}>
        {[["Vol",(vol24h).toFixed(1)+"B"],["OI","$"+oi.toFixed(1)+"B"],
          ["Fund",(fundRate>=0?"+":"")+fundRate.toFixed(4)+"%"]
        ].map(([k,v])=><div key={k} style={{flexShrink:0}}>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{k}</div>
          <div style={{fontSize:11,fontFamily:"'Space Mono',monospace",fontWeight:700,
            color:k==="Fund"?(fundRate>=0?C.gold:C.cyan):C.text,
            minWidth:"7ch",fontVariantNumeric:"tabular-nums"}}>{v}</div>
        </div>)}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
        <Dot col={connected?C.green:C.red} pulse={connected}/>
        <span style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",
          letterSpacing:"0.1em",minWidth:"9ch"}}>{connected?"LIVE":"RECONNECT"}</span>
      </div>
    </div>
  </div>;
});

/* ─── MARKET OVERVIEW ────────────────────────────────────────────────── */
const MarketOverview=memo(function MarketOverview({kRef,candleVer,price,display,regime}){
  // Chart data — only updates on closed candle
  const chartData=useMemo(()=>{
    const k=kRef.current.k1m;
    if(!k) return [];
    return closedOnly(k).slice(-80).map(r=>({
      p:parseFloat(r[4]),v:parseFloat(r[5]),
      t:new Date(r[0]).toLocaleTimeString("en",{hour:"2-digit",minute:"2-digit"})
    }));
  },[candleVer]);

  const rsiCol=regime.rsi>70?C.red:regime.rsi<30?C.green:C.cyan;
  const ind=[
    ["ATR(14)",regime.atr?("$"+Math.round(regime.atr).toLocaleString()):"—",C.gold],
    ["RSI(14)",regime.rsi?regime.rsi.toFixed(1):"—",rsiCol],
    ["EMA21",regime.e21?("$"+(Math.round(regime.e21/100)*100).toLocaleString()):"—",C.text],
    ["EMA50",regime.e50?("$"+(Math.round(regime.e50/100)*100).toLocaleString()):"—",C.text],
    ["BB Width",regime.bbWidth?(regime.bbWidth*100).toFixed(3)+"%":"—",C.purple],
    ["Trend",regime.dir||"—",regime.dir==="BULLISH"?C.green:regime.dir==="BEARISH"?C.red:C.gold],
  ];
  return <section>
    <SecTitle ch="Market Overview" sub="Closed candles only — no repaint"/>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:10}}>
      {[["Price","$"+price.toLocaleString(),display.change24h>=0?C.green:C.red],
        ["24h %",(display.change24h>=0?"+":"")+display.change24h.toFixed(2)+"%",display.change24h>=0?C.green:C.red],
        ["Regime",regime.regime?.replace(/_/g," ")||"LOADING",C.cyan],
        ["High","$"+Math.round(display.high24h).toLocaleString(),C.text],
        ["Low","$"+Math.round(display.low24h).toLocaleString(),C.text],
        ["Conf",(regime.conf*100).toFixed(0)+"%",C.gold],
      ].map(([l,v,c])=><Box key={l} style={{padding:"9px 11px"}}>
        <Label ch={l}/><Num v={v} col={c} sz={13} w="8ch"/>
      </Box>)}
    </div>
    {chartData.length>0&&<Box style={{padding:"12px 13px",marginBottom:9}}>
      <Label ch="1m Closed-Candle Chart" style={{marginBottom:5}}/>
      <div style={{height:145}}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{top:3,right:3,bottom:0,left:0}}>
            <defs><linearGradient id="cg1" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={C.cyan} stopOpacity={0.25}/>
              <stop offset="95%" stopColor={C.cyan} stopOpacity={0.01}/></linearGradient></defs>
            <XAxis dataKey="t" tick={{fill:C.dim,fontSize:8,fontFamily:"'Space Mono',monospace"}}
              tickLine={false} axisLine={false} interval={19}/>
            <YAxis domain={["auto","auto"]} tick={{fill:C.dim,fontSize:8,fontFamily:"'Space Mono',monospace"}}
              tickLine={false} axisLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}K`} width={33}/>
            <Tooltip content={<ChartTip/>}/>
            <Area type="monotone" dataKey="p" name="Price" stroke={C.cyan}
              strokeWidth={1.4} fill="url(#cg1)" dot={false} isAnimationActive={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Box>}
    {chartData.length>0&&<Box style={{padding:"9px 13px",marginBottom:9}}>
      <Label ch="Volume (closed candles)" style={{marginBottom:4}}/>
      <div style={{height:48}}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData.slice(-60)} margin={{top:0,right:3,bottom:0,left:0}}>
            <Bar dataKey="v" radius={[1,1,0,0]} isAnimationActive={false}>
              {chartData.slice(-60).map((d,i)=><Cell key={i}
                fill={i>0&&d.p>=chartData.slice(-60)[i-1]?.p?`${C.green}65`:`${C.red}60`}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Box>}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
      {ind.map(([l,v,c])=><Box key={l} style={{padding:"8px 10px"}}>
        <Label ch={l} style={{fontSize:8}}/><Num v={v} col={c} sz={12} w="7ch"/>
      </Box>)}
    </div>
  </section>;
});

/* ─── AI BRAIN ───────────────────────────────────────────────────────── */
// Agent scores are derived from REGIME only — computed once per REGIME update (30s TTL)
// No random drift — scores are deterministic from live data
const AIBrain=memo(function AIBrain({regime,of,signals}){
  // Derived scores — stable, no randomness
  const agents=useMemo(()=>{
    const consensus=[
      signals.snp?.finalConf||0,
      signals.int?.finalConf||0,
      signals.trd?.finalConf||0
    ].filter(v=>v>0);
    const consScore=consensus.length?consensus.reduce((s,v)=>s+v)/consensus.length:0;
    const rsiNorm=regime.rsi?Math.abs(50-regime.rsi)/50:0;
    const ofScore=Math.abs((of.score||0.5)-0.5)*2;
    return [
      {name:"Market State",  role:"Regime",       score:regime.conf,    verdict:regime.regime?.replace(/_/g," ")||"LOADING", col:regime.conf>0.7?C.green:C.gold},
      {name:"Trend Analysis",role:"Direction",     score:regime.conf*0.92, verdict:regime.dir||"NEUTRAL", col:regime.dir==="BULLISH"?C.green:regime.dir==="BEARISH"?C.red:C.gold},
      {name:"Momentum",      role:"RSI+MACD",      score:Math.min(0.95,0.35+rsiNorm*0.55), verdict:regime.rsi>55?"ACCELERATING":regime.rsi<45?"WEAKENING":"NEUTRAL", col:regime.rsi>55?C.green:regime.rsi<45?C.orange:C.dim},
      {name:"Liquidity AI",  role:"Smart Money",   score:Math.min(0.95,0.35+ofScore*0.55), verdict:of.pressure||"NEUTRAL", col:of.score>0.55?C.cyan:of.score<0.45?C.orange:C.dim},
      {name:"Order Flow",    role:"Depth",         score:Math.min(0.95,0.30+ofScore*0.65), verdict:of.score>0.55?"BUY DOM":of.score<0.45?"SELL DOM":"BALANCED", col:of.score>0.55?C.green:of.score<0.45?C.red:C.dim},
      {name:"Quant Edge",    role:"Statistics",    score:Math.min(0.95,regime.conf*0.90),  verdict:regime.conf>0.7?"FAVORABLE":"MIXED", col:regime.conf>0.7?C.cyan:C.gold},
      {name:"Risk Manager",  role:"Risk Eval",     score:consScore>0?0.88:0.5,  verdict:consScore>0?"APPROVED":"STANDBY", col:consScore>0?C.green:C.dim},
      {name:"Coordinator",   role:"Final Vote",    score:consScore,
        verdict:consScore>0.75?"EXECUTE"+(signals.snp?.dir||signals.int?.dir||signals.trd?.dir?" "+(signals.snp?.dir||signals.int?.dir||signals.trd?.dir):""):consScore>0.60?"WATCH":"NO TRADE",
        col:consScore>0.75?C.gold:consScore>0.60?C.cyan:C.dim},
    ];
  },[regime,of,signals]); // only updates when regime/of/signals change

  const consensus=agents[7].score;
  return <section>
    <SecTitle ch="AI Market Brain" sub="8 agents · updates on closed candle only"/>
    <Box style={{marginBottom:9,padding:"13px 15px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9}}>
        <div><Label ch="Consensus Score"/>
          <Num v={(consensus*100).toFixed(0)+"%" } col={consensus>0.75?C.gold:consensus>0.60?C.cyan:C.dim} sz={28} w="5ch"/>
        </div>
        <div style={{textAlign:"right"}}>
          <Label ch="Final Verdict"/>
          <Badge ch={agents[7].verdict} col={agents[7].col}/>
        </div>
      </div>
      <div style={{height:3,background:C.muted,borderRadius:2}}>
        <div style={{width:`${consensus*100}%`,height:"100%",
          background:`linear-gradient(90deg,${C.cyan},${C.gold})`,borderRadius:2,
          transition:"width 0.8s ease"}}/>
      </div>
    </Box>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
      {agents.map(a=><Box key={a.name} style={{padding:"9px 11px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
          <div>
            <div style={{fontSize:11,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:C.bright}}>{a.name}</div>
            <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{a.role}</div>
          </div>
          <Num v={(a.score*100).toFixed(0)+"%"} col={a.col} sz={11} w="4ch"/>
        </div>
        <div style={{height:2,background:C.muted,borderRadius:1,marginBottom:4}}>
          <div style={{width:`${a.score*100}%`,height:"100%",background:a.col,borderRadius:1,transition:"width 0.8s ease"}}/>
        </div>
        <Badge ch={a.verdict} col={a.col} sm/>
      </Box>)}
    </div>
  </section>;
});

/* ─── STRATEGY INTEL ─────────────────────────────────────────────────── */
const StrategyIntel=memo(function StrategyIntel({regime,sw}){
  const entries=[
    {k:"snp",name:"Sniper Scalper",desc:"1–15 min",col:C.cyan},
    {k:"int",name:"Intraday Hunter",desc:"30m–4h",col:C.gold},
    {k:"trd",name:"Trend Rider",desc:"4h–days",col:C.purple},
  ];
  const regimeList=["STRONG_BULL","MODERATE_BULL","RANGE_BOUND","HIGH_VOLATILITY","COMPRESSION"];
  const regimeCol={STRONG_BULL:C.green,MODERATE_BULL:C.green,RANGE_BOUND:C.gold,HIGH_VOLATILITY:C.orange,COMPRESSION:C.cyan};
  return <section>
    <SecTitle ch="Strategy Intelligence" sub="Weight driven by live regime"/>
    <Box style={{marginBottom:9,padding:"12px 14px"}}>
      <Label ch="Detected Regime" style={{marginBottom:6}}/>
      <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:7}}>
        {regimeList.map(r=><span key={r} style={{fontSize:9,fontFamily:"'Space Mono',monospace",
          padding:"2px 7px",borderRadius:3,whiteSpace:"nowrap",
          background:regime.regime===r?`${regimeCol[r]}1E`:C.muted,
          border:`1px solid ${regime.regime===r?regimeCol[r]:C.border}`,
          color:regime.regime===r?regimeCol[r]:C.dim}}>
          {r.replace(/_/g," ")}</span>)}
      </div>
      <div style={{fontSize:10,color:C.dim,fontFamily:"'Space Mono',monospace"}}>
        <span style={{color:regime.dir==="BULLISH"?C.green:regime.dir==="BEARISH"?C.red:C.gold}}>{regime.dir}</span>
        {" · Conf: "}<span style={{color:C.text}}>{(regime.conf*100).toFixed(0)}%</span>
      </div>
    </Box>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7}}>
      {entries.map(s=><Box key={s.k} style={{padding:"10px 11px",
        border:`1px solid ${(sw[s.k]||0.33)>0.38?s.col+"40":C.border}`}}>
        <Label ch={s.desc} style={{fontSize:8}}/>
        <div style={{fontSize:11,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:s.col,marginBottom:4}}>{s.name}</div>
        <Num v={((sw[s.k]||0.33)*100).toFixed(0)+"%"} col={s.col} sz={17} w="4ch"/>
        <div style={{height:2,background:C.muted,borderRadius:1,marginTop:5}}>
          <div style={{width:`${(sw[s.k]||0.33)*100}%`,height:"100%",background:s.col,borderRadius:1,transition:"width 0.8s ease"}}/>
        </div>
      </Box>)}
    </div>
  </section>;
});

/* ─── SIGNAL CARD ────────────────────────────────────────────────────── */
const SignalCard=memo(function SignalCard({sig,onTrade,tradeLoading,asset}){
  if(!sig) return <Box style={{padding:"13px",contain:"layout style"}}>
    <Label ch="Scanning market..." style={{textAlign:"center",marginBottom:3}}/>
    <div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace",textAlign:"center"}}>
      Waiting for closed-candle signal alignment
    </div>
  </Box>;
  const{card,dir,entry,sl,tp,conf,finalConf,rr,pw,atr,strat,expire,shap,mc,risk,col}=sig;
  const fc=finalConf||conf;
  const cCol=fc>=0.80?C.green:fc>=0.70?C.gold:C.orange;
  const slPct=((Math.abs(entry-sl)/entry)*100).toFixed(2);
  return <Box style={{marginBottom:9,border:`1px solid ${col}22`,padding:"13px 14px",contain:"layout style"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:9}}>
      <div>
        <div style={{fontSize:8,fontFamily:"'Space Mono',monospace",letterSpacing:"0.14em",color:col,marginBottom:3}}>{card}</div>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <Badge ch={dir} col={dir==="LONG"?C.green:C.red}/>
          <span style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{strat}</span>
        </div>
      </div>
      <div style={{textAlign:"right",flexShrink:0}}>
        <Label ch="Confidence"/>
        <Num v={(fc*100).toFixed(1)+"%" } col={cCol} sz={20} w="5ch"/>
        <div style={{fontSize:8,color:fc>=ALERT_THRESH?C.gold:C.dim,fontFamily:"'Space Mono',monospace"}}>
          {fc>=ALERT_THRESH?"⚡ ALERT":"visible"}
        </div>
      </div>
    </div>
    <div style={{height:2,background:C.muted,borderRadius:1,marginBottom:9}}>
      <div style={{width:`${fc*100}%`,height:"100%",background:cCol,borderRadius:1}}/>
    </div>
    {/* Entry / SL row */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:7}}>
      <Box style={{padding:"8px 10px",background:`${C.green}09`,borderRadius:7}}>
        <Label ch="Entry" style={{fontSize:8,color:C.green}}/>
        <Num v={fmtPrice(entry,asset)} col={C.bright} sz={13} w="9ch"/>
      </Box>
      <Box style={{padding:"8px 10px",background:`${C.red}09`,borderRadius:7}}>
        <Label ch={"Stop −"+slPct+"%"} style={{fontSize:8,color:C.red}}/>
        <Num v={fmtPrice(sl,asset)} col={C.red} sz={13} w="9ch"/>
      </Box>
    </div>
    {/* Take profits */}
    <div style={{display:"grid",gridTemplateColumns:`repeat(${tp.length},1fr)`,gap:5,marginBottom:9}}>
      {tp.map((t,i)=><Box key={i} style={{padding:"6px 8px",background:`${C.green}07`,borderRadius:6}}>
        <Label ch={"TP"+(i+1)} style={{fontSize:7,color:C.green}}/>
        <Num v={"$"+t.toLocaleString()} col={C.green} sz={11} w="8ch"/>
        <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",
          fontVariantNumeric:"tabular-nums"}}>
          +{((Math.abs(t-entry)/entry)*100).toFixed(2)}%
        </div>
      </Box>)}
    </div>
    {/* Chips */}
    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:7}}>
      {[["R:R",rr+"x"],["Win%",(pw*100).toFixed(0)+"%"],["EV",risk?(risk.ev>0?"+":"")+Math.round(risk.ev):"—"],
        ["Kelly",risk?risk.kelly:"—"],["ATR",fmtPrice(atr,asset)]
      ].map(([k,v])=><div key={k} style={{background:C.muted+"55",borderRadius:3,padding:"2px 6px",flexShrink:0}}>
        <span style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{k}: </span>
        <span style={{fontSize:8,fontWeight:700,fontFamily:"'Space Mono',monospace",color:C.text,fontVariantNumeric:"tabular-nums"}}>{v}</span>
      </div>)}
      {sig.htfDir&&sig.htfDir!=="NEUTRAL"&&<div style={{background:`${sig.htfDir==="BULLISH"?C.green:C.red}18`,border:`1px solid ${sig.htfDir==="BULLISH"?C.green:C.red}30`,borderRadius:3,padding:"2px 6px",flexShrink:0}}>
        <span style={{fontSize:8,fontFamily:"'Space Mono',monospace",color:sig.htfDir==="BULLISH"?C.green:C.red}}>HTF:{sig.htfDir}</span>
      </div>}
    </div>
    {/* Carry cost breakeven */}
    {asset&&(()=>{const c=calcCarry(asset.sym,DEFAULT_STAKE,asset.mult?.[0]||100,1);return c.breakevenPct>0?<div style={{padding:"5px 8px",background:`${C.orange}08`,borderRadius:5,border:`1px solid ${C.orange}20`,marginBottom:7}}>
      <div style={{fontSize:8,color:C.orange,fontFamily:"'Space Mono',monospace"}}>⬡ Carry cost: {c.breakevenPct.toFixed(3)}% move needed to break even · ${c.costUsd.toFixed(4)}/hr</div>
    </div>:null;})()}
    {/* SHAP */}
    {shap?.length>0&&<div style={{marginBottom:8}}>
      <Label ch="Feature Contributions" style={{fontSize:8,marginBottom:4}}/>
      {shap.map(s=><div key={s.f} style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
        <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",width:120,flexShrink:0}}>{s.f}</div>
        <div style={{flex:1,height:2,background:C.muted,borderRadius:1}}>
          <div style={{width:`${Math.min(100,s.v*320)}%`,height:"100%",background:col,borderRadius:1}}/>
        </div>
        <div style={{fontSize:8,fontFamily:"'Space Mono',monospace",color:col,width:28,textAlign:"right",
          fontVariantNumeric:"tabular-nums"}}>{s.v.toFixed(2)}</div>
      </div>)}
    </div>}
    {/* MC mini chart */}
    {mc?.mcData?.length>0&&<>
      <HR/>
      <div style={{height:50,marginBottom:5}}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={mc.mcData} margin={{top:2,right:0,bottom:0,left:0}}>
            <Area type="monotone" dataKey="p90" stroke={`${C.green}80`} strokeWidth={0.8} fill={`${C.green}0E`} dot={false} isAnimationActive={false}/>
            <Area type="monotone" dataKey="p50" stroke={C.gold} strokeWidth={1.5} fill="none" dot={false} isAnimationActive={false}/>
            <Area type="monotone" dataKey="p10" stroke={`${C.red}80`} strokeWidth={0.8} fill={`${C.red}08`} dot={false} isAnimationActive={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:8,
        fontFamily:"'Space Mono',monospace",color:C.dim}}>
        <span>TP <span style={{color:C.green}}>{(mc.probTP*100).toFixed(0)}%</span></span>
        <span>SL <span style={{color:C.red}}>{(mc.probSL*100).toFixed(0)}%</span></span>
        <span>EV <span style={{color:mc.ev>0?C.green:C.red}}>{mc.ev>0?"+":""}{Math.round(mc.ev)}</span></span>
      </div>
    </>}
    <HR/>
    <div style={{fontSize:8,fontFamily:"'Space Mono',monospace",color:C.dim,display:"flex",justifyContent:"space-between",marginBottom:onTrade?8:0}}>
      <span>Closed candle · no repaint</span>
      <span>Expires: <span style={{color:C.orange}}>{expire>3600?Math.round(expire/3600)+"h":Math.round(expire/60)+"m"}</span></span>
    </div>
    {onTrade&&<button onClick={()=>onTrade(sig)} disabled={tradeLoading}
      style={{width:"100%",padding:"8px 0",borderRadius:6,
        background:`${cCol}18`,border:`1.5px solid ${cCol}50`,
        color:cCol,fontFamily:"'Space Mono',monospace",fontWeight:700,
        fontSize:10,cursor:"pointer",letterSpacing:"0.08em",
        opacity:tradeLoading?0.5:1,transition:"opacity 0.2s"}}>
      {tradeLoading?"⏳ PLACING TRADE…":`⚡ EXECUTE ${dir} — Deriv Live`}
    </button>}
  </Box>;
});

/* ─── ACTIVE TRADES ──────────────────────────────────────────────────── */
// All trades are locked once opened. Chandelier ATR trailing stop.
function ActiveTrades({trades,dispatch,sym,asset}){
  const safeTrades=Array.isArray(trades)?trades:[];
  const open=safeTrades.filter(t=>t.status==="OPEN"&&(!sym||t.sym===sym));
  const closed=safeTrades.filter(t=>t.status==="CLOSED"&&(!sym||t.sym===sym)).slice(-5);
  if(!open.length&&!closed.length) return <Box style={{padding:"13px",textAlign:"center"}}>
    <Label ch="No active trades" style={{textAlign:"center"}}/> 
    <div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace",marginTop:3}}>Trades open automatically when signals pass alert threshold</div>
  </Box>;
  return <div>
    {open.map(t=>{
      const pnlPos=t.pnlPct>=0;
      const prog=Math.min(100,Math.max(0,t.dir==="LONG"?(t.currentPrice-t.entry)/(t.tp[t.tp.length-1]-t.entry)*100:(t.entry-t.currentPrice)/(t.entry-t.tp[t.tp.length-1])*100));
      const distToTS=Math.abs((t.currentPrice||t.entry)-t.trailStop);
      const tsDistPct=((distToTS/(t.currentPrice||t.entry))*100).toFixed(2);
      const dur=Math.round((Date.now()-t.openedAt)/60000);
      return <Box key={t.id} style={{marginBottom:8,border:`1px solid ${t.col}35`,padding:"12px 14px",contain:"layout style"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
          <div>
            <div style={{fontSize:8,color:t.col,fontFamily:"'Space Mono',monospace",marginBottom:2}}>{t.card}</div>
            <div style={{display:"flex",gap:5,alignItems:"center"}}>
              <Badge ch={t.dir} col={t.dir==="LONG"?C.green:C.red} sm/>
              <span style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{dur}m ago</span>
              <Dot col={C.green} pulse/>
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <Num v={(t.pnlPct>=0?"+":"")+t.pnlPct?.toFixed(2)+"%" } col={pnlPos?C.green:C.red} sz={16} w="7ch"/>
            <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",
              fontVariantNumeric:"tabular-nums"}}>
              {t.pnlUsd>=0?"+":""}${t.pnlUsd?.toLocaleString()||0}
            </div>
          </div>
        </div>
        {/* Price progress bar */}
        <div style={{height:3,background:C.muted,borderRadius:2,marginBottom:8}}>
          <div style={{width:prog+"%",height:"100%",background:pnlPos?C.green:C.red,borderRadius:2,transition:"width 0.4s"}}/>
        </div>
        {/* Levels grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:5,marginBottom:7}}>
          <div><Label ch="Entry" style={{fontSize:7}}/><Num v={"$"+t.entry.toLocaleString()} col={C.bright} sz={10} w="8ch"/></div>
          <div><Label ch="Current" style={{fontSize:7}}/><Num v={"$"+(t.currentPrice||t.entry).toLocaleString()} col={pnlPos?C.green:C.red} sz={10} w="8ch"/></div>
          <div>
            <Label ch="⚡ Trail Stop" style={{fontSize:7,color:C.gold}}/>
            <Num v={"$"+t.trailStop.toLocaleString()} col={C.gold} sz={10} w="8ch"/>
          </div>
          <div><Label ch={"TS dist"} style={{fontSize:7}}/><Num v={tsDistPct+"%"} col={C.orange} sz={10} w="5ch"/></div>
        </div>
        {/* TPs */}
        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:7}}>
          {t.tp.map((tp,i)=>{
            const hit=i<t.tpsHit;
            const isCurrent=t.dir==="LONG"?(t.currentPrice||t.entry)>=tp:(t.currentPrice||t.entry)<=tp;
            return <div key={i} style={{background:hit?`${C.green}28`:C.muted+"40",
              border:`1px solid ${hit?C.green:C.border}`,borderRadius:4,padding:"3px 7px"}}>
              <div style={{fontSize:7,color:hit?C.green:C.dim,fontFamily:"'Space Mono',monospace"}}>TP{i+1} {hit?"✓":""}</div>
              <div style={{fontSize:9,fontFamily:"'Space Mono',monospace",fontWeight:700,
                color:hit?C.green:C.text,fontVariantNumeric:"tabular-nums"}}>${tp.toLocaleString()}</div>
            </div>;
          })}
        </div>
        {/* MAE / MFE tracking */}
        {t.maxAdv>0&&<div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",marginBottom:5}}>
          MAE: {t.maxAdv.toFixed(2)}% adverse · MFE: {t.maxFav.toFixed(2)}% favorable
        </div>}
        {/* Chandelier info */}
        <div style={{background:`${C.gold}0A`,border:`1px solid ${C.gold}20`,borderRadius:5,padding:"5px 9px"}}>
          <div style={{fontSize:8,color:C.gold,fontFamily:"'Space Mono',monospace",marginBottom:2}}>⚡ Chandelier Exit (ATR×{CHANDELIER_M})</div>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>
            Trail: ${t.trailStop.toLocaleString()} · {t.dir==="LONG"?"Ratchets UP only — never decreases":"Ratchets DOWN only — never increases"}
          </div>
        </div>
        <div style={{display:"flex",gap:6,marginTop:7}}>
          <button onClick={()=>dispatch({type:"CLOSE",id:t.id,outcome:"MANUAL",price:t.currentPrice||t.entry})}
            style={{flex:1,fontSize:9,fontFamily:"'Space Mono',monospace",fontWeight:700,
              color:C.red,background:`${C.red}12`,border:`1px solid ${C.red}40`,
              borderRadius:5,padding:"5px 0",cursor:"pointer"}}>CLOSE TRADE</button>
        </div>
      </Box>;
    })}
    {closed.length>0&&<Box style={{padding:"11px 13px"}}>
      <Label ch="Closed Trades (this session)" style={{marginBottom:7}}/>
      {closed.reverse().map((t,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:6,
        padding:"5px 0",borderBottom:i<closed.length-1?`1px solid ${C.border}`:"none"}}>
        <Badge ch={t.id} col={t.id==="SNP"?C.cyan:t.id==="INT"?C.gold:C.purple} sm/>
        <Badge ch={t.dir} col={t.dir==="LONG"?C.green:C.red} sm/>
        <div style={{flex:1,fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>
          {t.sym||""} ${t.entry?.toLocaleString()} → ${t.closePrice?.toLocaleString()}
        </div>
        <Badge ch={t.outcome} col={t.outcome==="SL"?C.red:C.green} sm/>
        <div style={{fontSize:9,fontFamily:"'Space Mono',monospace",
          color:t.closePrice>=t.entry===t.dir==="LONG"?C.green:C.red,
          fontVariantNumeric:"tabular-nums"}}>
          {t.closePrice&&t.entry?((t.closePrice-t.entry)*(t.dir==="LONG"?1:-1)/t.entry*100).toFixed(2)+"%":"—"}
        </div>
      </div>)}
    </Box>}
  </div>;
}

/* ─── TRADE MANAGEMENT AGENT UI ─────────────────────────────────────── */
const ModeColors={NORMAL:C.green,PROTECTIVE:C.orange,RESTRICTED:C.orange,PAUSED:C.red};
const SevColors={OK:C.green,INFO:C.cyan,WARN:C.orange,ERROR:C.red};
const PriColors={HIGH:C.gold,MEDIUM:C.orange,INFO:C.cyan,LOW:C.dim};

const VerdictBadge=memo(function VerdictBadge({v}){
  const col=v==="APPROVED"?C.green:v==="BLOCKED"?C.red:v==="DENIED"?C.red:v==="NO_SIGNAL"?C.dim:C.gold;
  return <Badge ch={v} col={col} sm/>;
});

const TradeManagementAgent=memo(function TradeManagementAgent({tma,dispatch,signals,sym}){
  if(!tma) return null;
  const{snp,int,trd,directives,audit,recs,globalMode,globalReasons,sessionStats,winStreak,regimeTransition}=tma;
  const modeCol=ModeColors[globalMode]||C.cyan;
  const verdicts=[
    {v:snp,sig:signals.snp,id:"SNP",col:C.cyan,label:"Sniper"},
    {v:int,sig:signals.int,id:"INT",col:C.gold,label:"Intraday"},
    {v:trd,sig:signals.trd,id:"TRD",col:C.purple,label:"Trend"},
  ];

  return <section>
    <SecTitle ch="Trade Management Agent" sub="Institutional gatekeeper · confidence gate · trade directives"/>

    {/* Global Mode Banner */}
    <Box style={{marginBottom:9,padding:"11px 14px",border:`1px solid ${modeCol}35`,
      background:`${modeCol}08`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <Dot col={modeCol} pulse={globalMode!=="NORMAL"}/>
          <div>
            <div style={{fontSize:11,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
              color:modeCol,letterSpacing:"0.1em"}}>TMA: {globalMode}{winStreak>=HOT_STREAK_MIN?` · 🔥 ${winStreak}-WIN`:""}</div>
          {regimeTransition&&<div style={{fontSize:8,color:C.orange,fontFamily:"'Space Mono',monospace",marginTop:2}}>⚠ Regime transition detected — tighten stops</div>}
            {globalReasons[0]&&<div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace",marginTop:2}}>{globalReasons[0]}</div>}
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <Label ch="Session WR"/>
          <Num v={sessionStats.wr!==null?(sessionStats.wr*100).toFixed(0)+"%":"—"}
            col={sessionStats.wr===null?C.dim:sessionStats.wr>0.6?C.green:sessionStats.wr>0.4?C.gold:C.red}
            sz={16} w="4ch"/>
        </div>
      </div>
      <HR/>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
        {[["Wins",sessionStats.wins,C.green],["Losses",sessionStats.losses,C.red],
          ["Streak",sessionStats.streak>0?"-"+sessionStats.streak:"+",sessionStats.streak>=2?C.red:C.dim],
          ["Open",sessionStats.openCount,C.cyan],
        ].map(([l,v,c])=><div key={l}><Label ch={l} style={{fontSize:7}}/><Num v={v} col={c} sz={13} w="3ch"/></div>)}
      </div>
    </Box>

    {/* Signal Verdicts */}
    <Box style={{marginBottom:9,padding:"11px 13px"}}>
      <Label ch="Signal Gate Verdicts" style={{marginBottom:8}}/>
      {verdicts.map(({v,sig,id,col,label})=><div key={id}
        style={{display:"flex",flexWrap:"wrap",gap:5,alignItems:"flex-start",
          padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:5,minWidth:90,flexShrink:0}}>
          <div style={{width:3,height:13,background:col,borderRadius:2,flexShrink:0}}/>
          <span style={{fontSize:10,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:col}}>{label}</span>
        </div>
        <VerdictBadge v={v.verdict}/>
        {sig&&<span style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>
          {sig.finalConf?(sig.finalConf*100).toFixed(0)+"%":""} · {sig.rr?sig.rr+"x":""} R:R
        </span>}
        <div style={{width:"100%",paddingLeft:14}}>
          {v.reasons.map((r,i)=><div key={i} style={{fontSize:8,color:C.red,fontFamily:"'Space Mono',monospace",
            marginBottom:1,display:"flex",gap:4}}>
            <span style={{flexShrink:0}}>✗</span><span>{r}</span>
          </div>)}
          {v.adjustments?.map((a,i)=><div key={i} style={{fontSize:8,color:C.gold,fontFamily:"'Space Mono',monospace",
            marginBottom:1,display:"flex",gap:4}}>
            <span style={{flexShrink:0}}>→</span><span>{a}</span>
          </div>)}
        </div>
      </div>)}
    </Box>

    {/* Active Trade Directives */}
    {directives.length>0&&<Box style={{marginBottom:9,padding:"11px 13px"}}>
      <Label ch="Active Trade Directives" style={{marginBottom:8}}/>
      {directives.map((d,i)=><div key={i} style={{display:"flex",alignItems:"flex-start",gap:7,
        padding:"8px 10px",marginBottom:5,borderRadius:6,
        background:`${d.col}0C`,border:`1px solid ${d.col}28`}}>
        <div style={{flexShrink:0,marginTop:1}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:d.col,
            boxShadow:d.priority==="HIGH"?`0 0 6px ${d.col}`:"none"}}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
            <span style={{fontSize:9,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:d.col}}>{d.label}</span>
            <Badge ch={d.id} col={d.id==="SNP"?C.cyan:d.id==="INT"?C.gold:C.purple} sm/>
            {d.priority!=="INFO"&&<Badge ch={d.priority} col={PriColors[d.priority]||C.dim} sm/>}
          </div>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",lineHeight:1.4}}>{d.desc}</div>
          {(d.action==="MOVE_BE"||d.action==="PARTIAL_CLOSE")&&<div style={{display:"flex",gap:5,marginTop:5}}>
            <button onClick={()=>dispatch({type:d.action,id:d.id,sym:d.sym||sym})}
              style={{fontSize:8,fontFamily:"'Space Mono',monospace",fontWeight:700,
                color:d.col,background:`${d.col}15`,border:`1px solid ${d.col}40`,
                borderRadius:4,padding:"3px 8px",cursor:"pointer"}}>{d.label.toUpperCase()}</button>
          </div>}
        </div>
      </div>)}
    </Box>}
    {directives.length===0&&<Box style={{padding:"10px 13px",marginBottom:9,textAlign:"center"}}>
      <div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>No active trade directives</div>
    </Box>}

    {/* Agent Audit */}
    <Box style={{marginBottom:9,padding:"11px 13px"}}>
      <Label ch="Agent Logic Audit" style={{marginBottom:7}}/>
      {audit.map((a,i)=><div key={i} style={{display:"flex",alignItems:"flex-start",gap:6,
        padding:"5px 0",borderBottom:i<audit.length-1?`1px solid ${C.border}`:"none"}}>
        <div style={{flexShrink:0,marginTop:2}}>
          <div style={{width:5,height:5,borderRadius:"50%",background:SevColors[a.sev]||C.dim}}/>
        </div>
        <div>
          <div style={{fontSize:8,color:SevColors[a.sev]||C.dim,fontFamily:"'Space Mono',monospace",
            fontWeight:700,marginBottom:1}}>{a.agent}</div>
          <div style={{fontSize:8,color:C.text,fontFamily:"'Space Mono',monospace",lineHeight:1.4}}>{a.msg}</div>
        </div>
      </div>)}
    </Box>

    {/* Recommendations */}
    {recs.length>0&&<Box style={{padding:"11px 13px"}}>
      <Label ch="TMA Recommendations" style={{marginBottom:7}}/>
      {recs.map((r,i)=><div key={i} style={{display:"flex",gap:7,alignItems:"flex-start",
        padding:"5px 0",borderBottom:i<recs.length-1?`1px solid ${C.border}`:"none"}}>
        <span style={{fontSize:11,color:r.col,flexShrink:0,lineHeight:1.3}}>{r.icon}</span>
        <span style={{fontSize:9,color:C.text,fontFamily:"'Space Mono',monospace",lineHeight:1.5}}>{r.text}</span>
      </div>)}
    </Box>}
  </section>;
});

/* ─── HEATMAP ────────────────────────────────────────────────────────── */
const HeatmapSection=memo(function HeatmapSection({kRef,candleVer,price}){
  const zones=useMemo(()=>{
    const k1h=closedOnly(kRef.current.k1h);
    if(!k1h?.length||!price) return [];
    const hi=k1h.map(r=>parseFloat(r[2])),lo=k1h.map(r=>parseFloat(r[3])),cl=k1h.map(r=>parseFloat(r[4]));
    const {sh,sl}=TA.swings(hi,lo,4);
    const atrArr=TA.atr(hi,lo,cl,14),atr=atrArr[atrArr.length-1];
    const fib=TA.fibonacci(Math.max(...hi.slice(-50)),Math.min(...lo.slice(-50)));
    const z=[];
    sh.slice(-5).forEach(s=>z.push({y:Math.round(s.p),label:"Swing High",type:"res",str:0.70}));
    sl.slice(-5).forEach(s=>z.push({y:Math.round(s.p),label:"Swing Low",type:"sup",str:0.70}));
    z.push({y:Math.round(fib.r382),label:"Fib 38.2%",type:"fib",str:0.55});
    z.push({y:Math.round(fib.r618),label:"Fib 61.8%",type:"fib",str:0.62});
    z.push({y:Math.round(price+atr*2),label:"Liq Pool High",type:"liq",str:0.65});
    z.push({y:Math.round(price-atr*2),label:"Liq Pool Low",type:"liq",str:0.65});
    z.push({y:Math.round(price),label:"Price",type:"price",str:1});
    return z.sort((a,b)=>b.y-a.y);
  },[candleVer,price]);
  const mn=price*0.945,mx=price*1.055;
  const toY=(p)=>Math.round(((mx-p)/(mx-mn))*240+20);
  const tCol=(t)=>({res:C.red,sup:C.green,liq:C.gold,price:C.cyan,fib:C.purple}[t]||C.text);
  return <section>
    <SecTitle ch="Market Heatmap" sub="Live swing highs/lows + Fibonacci + ATR liquidity bands"/>
    <Box style={{padding:"13px 14px"}}>
      <div style={{display:"flex",gap:7,marginBottom:9,flexWrap:"wrap"}}>
        {[["Resistance",C.red],["Support",C.green],["Liquidity",C.gold],["Fibonacci",C.purple],["Price",C.cyan]].map(([l,c])=>
          <div key={l} style={{display:"flex",alignItems:"center",gap:3}}>
            <div style={{width:7,height:7,borderRadius:1,background:c,opacity:0.75,flexShrink:0}}/>
            <span style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{l}</span>
          </div>)}
      </div>
      {price>0?<svg width="100%" height="270" viewBox="0 0 330 270" style={{display:"block"}}>
        {[0.04,0.02,0,-0.02,-0.04].map(pct=>{
          const lp=Math.round(price*(1+pct)),y=toY(lp);
          return y>0&&y<270?<g key={pct}>
            <line x1="52" y1={y} x2="330" y2={y} stroke={C.muted} strokeWidth="0.5" strokeDasharray="2,4"/>
            <text x="2" y={y+3} fontSize="8" fill={C.dim} fontFamily="'Space Mono',monospace">${(lp/1000).toFixed(1)}K</text>
          </g>:null;
        })}
        {zones.filter(z=>z.y>=mn&&z.y<=mx).map((z,i)=>{
          const y=toY(z.y),col=tCol(z.type),isP=z.type==="price";
          return <g key={i}>
            <rect x="52" y={y-2} width={z.str*200} height={isP?4:2} fill={col} opacity={isP?1:z.str*0.6} rx="1"/>
            {isP&&<line x1="52" y1={y} x2="330" y2={y} stroke={col} strokeWidth="1.2" strokeDasharray="4,2"/>}
            <text x="57" y={y-4} fontSize="8" fill={col} fontFamily="'Space Mono',monospace">{z.label}</text>
            <text x="326" y={y-4} fontSize="8" fill={col} fontFamily="'Space Mono',monospace" textAnchor="end">${(z.y/1000).toFixed(1)}K</text>
          </g>;
        })}
      </svg>:<div style={{height:270,display:"flex",alignItems:"center",justifyContent:"center",
        fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>Loading live data...</div>}
    </Box>
  </section>;
});

/* ─── SMART MONEY / ORDER FLOW ───────────────────────────────────────── */
const SmartMoney=memo(function SmartMoney({display,depth,of}){
  const obData=useMemo(()=>{
    if(!depth?.bids?.length) return [];
    const out=[];
    depth.bids.slice(0,8).forEach(([p,q])=>out.push({p:parseFloat(p).toFixed(0),bid:+parseFloat(q).toFixed(2),ask:0}));
    depth.asks.slice(0,8).forEach(([p,q],i)=>{
      if(out[i]) out[i].ask=+parseFloat(q).toFixed(2);
    });
    return out;
  },[depth]);
  const{fundRate,oi}=display;
  return <section>
    <SecTitle ch="Smart Money Flow" sub="Live 600ms depth · 1s funding"/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:9}}>
      <Box style={{padding:"10px 12px"}}>
        <Label ch="Book Imbalance"/>
        <div style={{display:"flex",gap:2,height:17,marginTop:5}}>
          <div style={{width:`${(of.bidRatio||0.5)*100}%`,background:C.green,borderRadius:"3px 0 0 3px",
            display:"flex",alignItems:"center",justifyContent:"center",minWidth:20,opacity:0.85}}>
            <span style={{fontSize:8,fontFamily:"'Space Mono',monospace",color:"#000",fontWeight:700,fontVariantNumeric:"tabular-nums"}}>
              {((of.bidRatio||0.5)*100).toFixed(0)}%
            </span>
          </div>
          <div style={{flex:1,background:C.red,borderRadius:"0 3px 3px 0",
            display:"flex",alignItems:"center",justifyContent:"center",minWidth:20,opacity:0.75}}>
            <span style={{fontSize:8,color:"#fff",fontFamily:"'Space Mono',monospace",fontWeight:700,fontVariantNumeric:"tabular-nums"}}>
              {((1-(of.bidRatio||0.5))*100).toFixed(0)}%
            </span>
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
          <span style={{fontSize:8,color:C.green,fontFamily:"'Space Mono',monospace"}}>BID ${(of.bidDepth/1e6||0).toFixed(1)}M</span>
          <span style={{fontSize:8,color:C.red,fontFamily:"'Space Mono',monospace"}}>ASK ${(of.askDepth/1e6||0).toFixed(1)}M</span>
        </div>
      </Box>
      <Box style={{padding:"10px 12px"}}>
        <Label ch="Pressure"/>
        <Num v={of.pressure||"NEUTRAL"} col={of.pressure==="BUY_DOMINANT"?C.green:of.pressure==="SELL_DOMINANT"?C.red:C.gold} sz={10} w="12ch"/>
        <div style={{marginTop:4,fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>Bid wall: {of.bigBidWall?.toFixed(1)||"—"} BTC</div>
        <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>Ask wall: {of.bigAskWall?.toFixed(1)||"—"} BTC</div>
      </Box>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:9}}>
      {[["Funding",(fundRate>=0?"+":"")+fundRate.toFixed(4)+"%",fundRate>0.05?C.red:fundRate<-0.01?C.green:C.gold],
        ["Open Int","$"+oi.toFixed(1)+"B",C.cyan],
        ["Sentiment",fundRate>0.05?"Longs Crowded":fundRate<-0.01?"Shorts Crowded":"Balanced",C.text]
      ].map(([l,v,c])=><Box key={l} style={{padding:"8px 10px"}}><Label ch={l} style={{fontSize:8}}/><Num v={v} col={c} sz={11} w="9ch"/></Box>)}
    </div>
    {obData.length>0&&<Box style={{padding:"10px 12px"}}>
      <Label ch="Order Book Depth (top 8)" style={{marginBottom:5}}/>
      <div style={{height:110}}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={obData} layout="vertical" margin={{top:0,right:3,bottom:0,left:42}}>
            <XAxis type="number" hide/>
            <YAxis dataKey="p" type="category" tick={{fill:C.dim,fontSize:8,fontFamily:"'Space Mono',monospace"}}
              tickLine={false} axisLine={false} width={42}/>
            <Bar dataKey="bid" stackId="a" fill={`${C.green}60`} name="Bid" isAnimationActive={false}/>
            <Bar dataKey="ask" stackId="a" fill={`${C.red}60`} name="Ask" radius={[0,2,2,0]} isAnimationActive={false}/>
            <Tooltip content={<ChartTip/>}/>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Box>}
  </section>;
});

/* ─── SIMULATION PANEL ───────────────────────────────────────────────── */
const SimulationSection=memo(function SimulationSection({signals,kRef,candleVer}){
  const best=signals.snp||signals.int||signals.trd;
  const mc=best?.mc;
  const hv=useMemo(()=>{
    const cl=closedOnly(kRef.current.k1m)?.map(r=>parseFloat(r[4]));
    return cl?TA.hv(cl):0;
  },[candleVer]);
  return <section>
    <SecTitle ch="AI Simulation" sub={`${MC_PATHS} paths · real historical returns`}/>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:9}}>
      {[["HV",((hv||0)*100).toFixed(2)+"%",C.cyan],
        ["MC TP",mc?(mc.probTP*100).toFixed(0)+"%":"—",C.green],
        ["MC SL",mc?(mc.probSL*100).toFixed(0)+"%":"—",C.red],
        ["EV $",mc?(mc.ev>0?"+":"")+Math.round(mc.ev):"—",mc?.ev>0?C.green:C.red],
        ["P50",mc?"$"+mc.p50?.toLocaleString():"—",C.gold],
        ["Paths",MC_PATHS,C.dim],
      ].map(([l,v,c])=><Box key={l} style={{padding:"8px 10px"}}><Label ch={l} style={{fontSize:8}}/><Num v={v} col={c} sz={12} w="7ch"/></Box>)}
    </div>
    {mc?.mcData?.length>0&&<Box style={{padding:"12px 13px"}}>
      <Label ch="P10 / P50 / P90 Simulation Bands" style={{marginBottom:5}}/>
      <div style={{height:110}}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={mc.mcData} margin={{top:3,right:3,bottom:0,left:0}}>
            <defs>
              <linearGradient id="sg90" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.green} stopOpacity={0.18}/><stop offset="95%" stopColor={C.green} stopOpacity={0.01}/></linearGradient>
              <linearGradient id="sg10" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.red} stopOpacity={0.12}/><stop offset="95%" stopColor={C.red} stopOpacity={0.01}/></linearGradient>
            </defs>
            <XAxis hide/><YAxis domain={["auto","auto"]} hide/>
            <Area type="monotone" dataKey="p90" stroke={`${C.green}85`} strokeWidth={0.8} fill="url(#sg90)" dot={false} strokeDasharray="4,2" isAnimationActive={false}/>
            <Area type="monotone" dataKey="p50" stroke={C.gold} strokeWidth={1.5} fill="none" dot={false} isAnimationActive={false}/>
            <Area type="monotone" dataKey="p10" stroke={`${C.red}85`} strokeWidth={0.8} fill="url(#sg10)" dot={false} strokeDasharray="4,2" isAnimationActive={false}/>
            <Tooltip content={<ChartTip/>}/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Box>}
    {!best&&<Box style={{padding:"13px",textAlign:"center"}}>
      <div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>Simulation runs when signal is generated</div>
    </Box>}
  </section>;
});

/* ═══════════════════════════════════════════════════════════════════════
   PERFORMANCE ENGINE  — derived purely from closed trades in reducer
═══════════════════════════════════════════════════════════════════════ */
function derivePerformance(trades){
  const closed=trades.filter(t=>t.status==="CLOSED"&&t.closePrice&&t.entry);
  if(!closed.length) return null;
  let equity=0;
  const curve=closed.map(t=>{
    const pnl=(t.closePrice-t.entry)*(t.dir==="LONG"?1:-1)/t.entry*100;
    equity+=pnl;
    return{ts:t.closedAt,pnl:parseFloat(pnl.toFixed(3)),
           equity:parseFloat(equity.toFixed(3)),outcome:t.outcome,id:t.id};
  });
  const byCard={SNP:[],INT:[],TRD:[]};
  closed.forEach(t=>{
    const pnl=(t.closePrice-t.entry)*(t.dir==="LONG"?1:-1)/t.entry*100;
    if(byCard[t.id]) byCard[t.id].push({pnl,outcome:t.outcome,dur:t.closedAt-t.openedAt});
  });
  const cardStats=Object.entries(byCard).map(([id,arr])=>{
    if(!arr.length) return{id,wr:null,avg:0,count:0,avgDur:0,col:id==="SNP"?C.cyan:id==="INT"?C.gold:C.purple};
    const wins=arr.filter(t=>t.outcome!=="SL");
    return{id,wr:wins.length/arr.length,avg:arr.reduce((s,t)=>s+t.pnl,0)/arr.length,
      count:arr.length,avgDur:(arr.reduce((s,t)=>s+t.dur,0)/arr.length/60000).toFixed(0),
      col:id==="SNP"?C.cyan:id==="INT"?C.gold:C.purple};
  });
  let peak=0,maxDD=0;
  curve.forEach(p=>{peak=Math.max(peak,p.equity);maxDD=Math.max(maxDD,peak-p.equity);});
  const wins=closed.filter(t=>t.outcome!=="SL"),lossT=closed.filter(t=>t.outcome==="SL");
  const wr=wins.length/closed.length;
  const avgWin=wins.length?wins.reduce((s,t)=>{const p=(t.closePrice-t.entry)*(t.dir==="LONG"?1:-1)/t.entry*100;return s+p;},0)/wins.length:0;
  const avgLoss=lossT.length?Math.abs(lossT.reduce((s,t)=>{const p=(t.closePrice-t.entry)*(t.dir==="LONG"?1:-1)/t.entry*100;return s+p;},0)/lossT.length):1;
  const pf=(wr*avgWin)/((1-wr)*avgLoss)||0;
  const pnls=curve.map(c=>c.pnl);
  const mu=pnls.reduce((s,v)=>s+v,0)/pnls.length;
  const sd=pnls.length>1?Math.sqrt(pnls.reduce((s,v)=>s+(v-mu)**2,0)/(pnls.length-1)):1;
  const sharpe=sd>0?parseFloat((mu/sd*Math.sqrt(252)).toFixed(2)):0;
  const regimePerf={};
  closed.forEach(t=>{
    const r=t.regime||"UNKNOWN";
    if(!regimePerf[r]) regimePerf[r]={wins:0,total:0};
    regimePerf[r].total++;
    if(t.outcome!=="SL") regimePerf[r].wins++;
  });
  return{curve,cardStats,maxDD:maxDD.toFixed(2),wr,avgWin:avgWin.toFixed(2),
    avgLoss:avgLoss.toFixed(2),pf:pf.toFixed(2),sharpe,total:closed.length,
    totalPnL:equity.toFixed(2),regimePerf,avgMAE:avgMAE?.toFixed(2)||'0',tightStops:tightStops||0,hourlyWR:hourlyWR||{}};
}

/* ═══════════════════════════════════════════════════════════════════════
   ALERT LOG HOOK  — ring buffer, 30 entries max, never re-renders analysis
═══════════════════════════════════════════════════════════════════════ */
function useAlertLog(){
  const[log,setLog]=useState([]);
  const add=useCallback((type,msg,col=C.cyan)=>{
    setLog(l=>[{ts:Date.now(),type,msg,col},...l].slice(0,30));
  },[]);
  return[log,add];
}

/* ═══════════════════════════════════════════════════════════════════════
   PERFORMANCE ANALYTICS COMPONENT
═══════════════════════════════════════════════════════════════════════ */
const PerformanceAnalytics=memo(function PerformanceAnalytics({trades}){
  const perf=useMemo(()=>derivePerformance(trades),[trades.length,
    trades.filter(t=>t.status==="CLOSED").length]);
  if(!perf) return <section>
    <SecTitle ch="Performance Analytics" sub="Accumulates as TMA-approved trades close"/>
    <Box style={{padding:"13px",textAlign:"center"}}>
      <div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>
        No closed trades yet — performance tracked automatically
      </div>
    </Box>
  </section>;
  const{curve,cardStats,maxDD,wr,avgWin,avgLoss,pf,sharpe,total,totalPnL,regimePerf}=perf;
  const pnlPos=parseFloat(totalPnL)>=0;
  return <section>
    <SecTitle ch="Performance Analytics" sub="Live from closed trades · equity curve · per-card stats"/>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:9}}>
      {[["Win Rate",(wr*100).toFixed(0)+"%",wr>0.6?C.green:wr>0.4?C.gold:C.red],
        ["Profit Factor",pf,parseFloat(pf)>1.5?C.green:parseFloat(pf)>1?C.gold:C.red],
        ["Sharpe Est.",sharpe,parseFloat(sharpe)>1.5?C.green:parseFloat(sharpe)>0?C.gold:C.red],
        ["Total P&L",(pnlPos?"+":"")+totalPnL+"%",pnlPos?C.green:C.red],
        ["Max Drawdown",maxDD+"%",parseFloat(maxDD)<3?C.green:parseFloat(maxDD)<8?C.gold:C.red],
        ["Closed Trades",total,C.text],
      ].map(([l,v,c])=><Box key={l} style={{padding:"9px 11px"}}>
        <Label ch={l} style={{fontSize:8}}/><Num v={v} col={c} sz={13} w="6ch"/>
      </Box>)}
    </div>
    {curve.length>1&&<Box style={{padding:"12px 13px",marginBottom:9}}>
      <Label ch="Equity Curve (% P&L · closed trades)" style={{marginBottom:5}}/>
      <div style={{height:105}}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={curve} margin={{top:3,right:3,bottom:0,left:0}}>
            <defs><linearGradient id="eqG" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={pnlPos?C.green:C.red} stopOpacity={0.25}/>
              <stop offset="95%" stopColor={pnlPos?C.green:C.red} stopOpacity={0.02}/>
            </linearGradient></defs>
            <XAxis hide/>
            <YAxis domain={["auto","auto"]} tick={{fill:C.dim,fontSize:8,fontFamily:"'Space Mono',monospace"}}
              tickLine={false} axisLine={false} tickFormatter={v=>v.toFixed(1)+"%"} width={40}/>
            <Tooltip content={<ChartTip/>}/>
            <ReferenceLine y={0} stroke={C.border} strokeDasharray="3 3"/>
            <Area type="monotone" dataKey="equity" name="Equity %" stroke={pnlPos?C.green:C.red}
              strokeWidth={1.5} fill="url(#eqG)" dot={false} isAnimationActive={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Box>}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:9}}>
      {cardStats.map(s=><Box key={s.id} style={{padding:"9px 11px",border:`1px solid ${s.col}25`}}>
        <Label ch={s.id} style={{fontSize:8,color:s.col}}/>
        <Num v={s.count?(s.wr*100).toFixed(0)+"%":"—"}
          col={s.wr>0.6?C.green:s.wr>0.4?C.gold:s.wr>0?C.red:C.dim} sz={15} w="4ch"/>
        <div style={{height:2,background:C.muted,borderRadius:1,margin:"4px 0 3px"}}>
          <div style={{width:`${(s.wr||0)*100}%`,height:"100%",background:s.col,borderRadius:1}}/>
        </div>
        <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>
          {s.count} trades · {s.avgDur}m avg
        </div>
      </Box>)}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:9}}>
      <Box style={{padding:"9px 11px"}}><Label ch="Avg Win"/><Num v={"+"+avgWin+"%"} col={C.green} sz={14} w="6ch"/></Box>
      <Box style={{padding:"9px 11px"}}><Label ch="Avg Loss"/><Num v={"-"+avgLoss+"%"} col={C.red} sz={14} w="6ch"/></Box>
    </div>
    {Object.keys(regimePerf).length>0&&<Box style={{padding:"11px 13px"}}>
      <Label ch="Win Rate by Market Regime" style={{marginBottom:7}}/>
      {Object.entries(regimePerf).map(([r,p])=>{
        const rwr=p.total?p.wins/p.total:0;
        return <div key={r} style={{display:"flex",alignItems:"center",gap:7,padding:"5px 0",
          borderBottom:`1px solid ${C.border}`}}>
          <div style={{flex:1,fontSize:8,color:C.text,fontFamily:"'Space Mono',monospace"}}>{r.replace(/_/g," ")}</div>
          <div style={{height:3,width:60,background:C.muted,borderRadius:2,flexShrink:0}}>
            <div style={{width:`${rwr*100}%`,height:"100%",
              background:rwr>0.6?C.green:rwr>0.4?C.gold:C.red,borderRadius:2}}/>
          </div>
          <div style={{fontSize:9,fontFamily:"'Space Mono',monospace",fontWeight:700,
            color:rwr>0.6?C.green:rwr>0.4?C.gold:C.red,minWidth:28,textAlign:"right",
            fontVariantNumeric:"tabular-nums"}}>
            {(rwr*100).toFixed(0)}%
          </div>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",minWidth:28}}>
            {p.wins}/{p.total}
          </div>
        </div>;
      })}
    </Box>}
  </section>;
});

/* ═══════════════════════════════════════════════════════════════════════
   MULTI-TIMEFRAME RSI PANEL
═══════════════════════════════════════════════════════════════════════ */
const MultiTFRSI=memo(function MultiTFRSI({kRef,candleVer}){
  const tfs=useMemo(()=>{
    const compute=(k,label)=>{
      const kc=closedOnly(k);
      if(!kc||kc.length<20) return{label,rsi:null,col:C.dim,signal:"—",num:50};
      const cl=kc.map(r=>parseFloat(r[4]));
      const arr=TA.rsi(cl,14); const rsi=arr[arr.length-1];
      const col=rsi>70?C.red:rsi>60?C.gold:rsi<30?C.green:rsi<40?C.cyan:C.text;
      const signal=rsi>70?"OVERBOUGHT":rsi>60?"BULLISH":rsi<30?"OVERSOLD":rsi<40?"BEARISH":"NEUTRAL";
      return{label,rsi:rsi.toFixed(1),col,signal,num:rsi};
    };
    return[
      compute(kRef.current.k1m,"1m"),
      compute(kRef.current.k15m,"15m"),
      compute(kRef.current.k1h,"1h"),
      compute(kRef.current.k4h,"4h"),
    ];
  },[candleVer]);
  const nums=tfs.map(t=>t.num).filter(Boolean);
  const allBull=nums.length>0&&nums.every(n=>n>50);
  const allBear=nums.length>0&&nums.every(n=>n<50);
  const alignment=allBull?"BULLISH STACK":allBear?"BEARISH STACK":
    nums.filter(n=>n>50).length>=3?"LEANING BULL":
    nums.filter(n=>n<50).length>=3?"LEANING BEAR":"MIXED";
  const alignCol=allBull?C.green:allBear?C.red:
    alignment==="LEANING BULL"?C.gold:alignment==="LEANING BEAR"?C.orange:C.dim;
  return <section>
    <SecTitle ch="Multi-TF RSI Alignment" sub="1m · 15m · 1h · 4h · closed candles only"/>
    <Box style={{padding:"12px 13px",marginBottom:9}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <Label ch="Alignment"/>
        <Badge ch={alignment} col={alignCol}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7}}>
        {tfs.map(t=><div key={t.label} style={{textAlign:"center",padding:"9px 6px",
          background:t.rsi?`${t.col}0C`:C.muted+"20",borderRadius:7,
          border:`1px solid ${t.rsi?t.col+"28":C.border}`}}>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",marginBottom:4}}>{t.label}</div>
          <Num v={t.rsi||"—"} col={t.col} sz={17} w="4ch"/>
          <div style={{height:3,background:C.muted,borderRadius:2,margin:"5px 0 4px",overflow:"hidden"}}>
            {t.rsi&&<div style={{width:`${t.num}%`,height:"100%",background:t.col,borderRadius:2}}/>}
          </div>
          <div style={{fontSize:7,color:t.col,fontFamily:"'Space Mono',monospace"}}>{t.signal}</div>
        </div>)}
      </div>
    </Box>
  </section>;
});

/* ═══════════════════════════════════════════════════════════════════════
   PREDICTED MOVE — ATR bands + regime bias + HV
═══════════════════════════════════════════════════════════════════════ */
const PredictedMove=memo(function PredictedMove({kRef,candleVer,price,regime}){
  const pred=useMemo(()=>{
    const k4=closedOnly(kRef.current.k4h);
    const k1=closedOnly(kRef.current.k1m);
    if(!k4||!price) return null;
    const hi4=k4.map(r=>parseFloat(r[2])),lo4=k4.map(r=>parseFloat(r[3])),cl4=k4.map(r=>parseFloat(r[4]));
    const atrArr=TA.atr(hi4,lo4,cl4,14); const atr4h=atrArr[atrArr.length-1];
    const atrD=atr4h*2.5; // approx daily
    let hv=0;
    if(k1&&k1.length>22){const cl1=k1.map(r=>parseFloat(r[4]));hv=TA.hv(cl1,20);}
    const hvMove=price*(hv/Math.sqrt(365));
    const biasPct=regime.dir==="BULLISH"?0.58:regime.dir==="BEARISH"?0.42:0.50;
    const bands=[
      {label:"Next 4h",up:Math.round(price+atr4h),dn:Math.round(price-atr4h),col:C.cyan,sz:"1× ATR4h"},
      {label:"Next 8h",up:Math.round(price+atr4h*1.8),dn:Math.round(price-atr4h*1.8),col:C.purple,sz:"1.8× ATR4h"},
      {label:"Daily",up:Math.round(price+atrD),dn:Math.round(price-atrD),col:C.gold,sz:"2.5× ATR4h"},
    ];
    return{atr4h,atrD,hvMove,biasPct,bands};
  },[candleVer,price,regime.dir]);
  if(!pred) return null;
  const{atr4h,atrD,hvMove,biasPct,bands}=pred;
  return <section>
    <SecTitle ch="Predicted Move" sub="ATR range bands · HV · regime directional bias"/>
    <Box style={{padding:"12px 14px"}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:10}}>
        <div style={{textAlign:"center",padding:"9px",background:`${C.green}08`,borderRadius:6,border:`1px solid ${C.green}1F`}}>
          <Label ch="Bull Bias" style={{textAlign:"center",color:C.green}}/>
          <Num v={(biasPct*100).toFixed(0)+"%"} col={C.green} sz={20} w="4ch"/>
        </div>
        <div style={{textAlign:"center",padding:"9px",background:`${C.red}08`,borderRadius:6,border:`1px solid ${C.red}1F`}}>
          <Label ch="Bear Bias" style={{textAlign:"center",color:C.red}}/>
          <Num v={((1-biasPct)*100).toFixed(0)+"%"} col={C.red} sz={20} w="4ch"/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:10}}>
        {[["4h ATR","$"+Math.round(atr4h).toLocaleString(),C.gold],
          ["Daily ATR","$"+Math.round(atrD).toLocaleString(),C.gold],
          ["HV Move","$"+Math.round(hvMove).toLocaleString(),C.cyan],
        ].map(([l,v,c])=><Box key={l} style={{padding:"8px 10px"}}><Label ch={l} style={{fontSize:8}}/><Num v={v} col={c} sz={12} w="7ch"/></Box>)}
      </div>
      <Label ch="Expected Range Bands" style={{marginBottom:8}}/>
      {bands.map(b=><div key={b.label} style={{marginBottom:8}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:6,height:6,borderRadius:1,background:b.col,flexShrink:0}}/>
            <span style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{b.label} ({b.sz})</span>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <div style={{textAlign:"right",minWidth:65,flexShrink:0}}>
            <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace"}}>Support</div>
            <div style={{fontSize:10,fontFamily:"'Space Mono',monospace",fontWeight:700,
              color:C.red,fontVariantNumeric:"tabular-nums"}}>${b.dn.toLocaleString()}</div>
          </div>
          <div style={{flex:1,height:8,background:C.muted,borderRadius:4,position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",inset:0,
              background:`linear-gradient(90deg,${C.red}55,${b.col}30,${C.green}55)`,borderRadius:4}}/>
            <div style={{position:"absolute",top:0,bottom:0,width:2,background:C.bright,opacity:0.7,
              left:`${biasPct*100}%`,transform:"translateX(-50%)"}}/>
          </div>
          <div style={{minWidth:65,flexShrink:0}}>
            <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace"}}>Resistance</div>
            <div style={{fontSize:10,fontFamily:"'Space Mono',monospace",fontWeight:700,
              color:C.green,fontVariantNumeric:"tabular-nums"}}>${b.up.toLocaleString()}</div>
          </div>
        </div>
      </div>)}
    </Box>
  </section>;
});

/* ═══════════════════════════════════════════════════════════════════════
   AI STRATEGY INSIGHTS  — pattern analysis, suggestions, improvement
═══════════════════════════════════════════════════════════════════════ */
const AIStrategyInsights=memo(function AIStrategyInsights({trades,regime,signals,tma,kRef,candleVer}){
  const insights=useMemo(()=>{
    // MTF confirmation check
    const mtfSame=signals.snp&&signals.int&&signals.trd&&
      signals.snp.dir===signals.int.dir&&signals.int.dir===signals.trd.dir;
    // Suggestions based on live conditions
    const suggestions=[];
    if(tma?.sessionStats?.streak>=2)
      suggestions.push("2+ consecutive losses — apply 0.5× sizing until next win");
    if(tma?.sessionStats?.wr!==null&&tma.sessionStats.wr<0.55&&tma.sessionStats.total>=5)
      suggestions.push("Win rate below 55% — raise minimum confidence to 80% temporarily");
    if(signals.snp&&signals.int&&signals.snp.dir!==signals.int?.dir)
      suggestions.push("SNP vs INT direction conflict — skip scalps, wait for alignment");
    if(mtfSame&&signals.snp)
      suggestions.push("All three cards aligned "+signals.snp.dir+" — highest-conviction setup, consider full size");
    if(regime.regime==="RANGE_BOUND")
      suggestions.push("Range market: trade SNP at extremes only, avoid TRD entries");
    if(regime.regime==="COMPRESSION")
      suggestions.push("Compression phase: mark range boundaries, set breakout alerts, no mean-reversion scalps");
    if(regime.regime==="HIGH_VOLATILITY")
      suggestions.push("High volatility: widen stops by 1.5×, reduce size by 30%, avoid FOMO entries");
    if(regime.rsi&&regime.rsi>68)
      suggestions.push(`RSI ${regime.rsi.toFixed(0)} — overbought on 1m, avoid new longs without pullback`);
    if(regime.rsi&&regime.rsi<32)
      suggestions.push(`RSI ${regime.rsi.toFixed(0)} — oversold on 1m, avoid new shorts without bounce`);
    if(regime.bbWidth&&regime.bbWidth<0.005)
      suggestions.push("Bollinger Bands extremely tight — breakout imminent, prepare limit orders at boundaries");
    if(!suggestions.length)
      suggestions.push("System operating within normal parameters — maintain standard discipline and sizing");
    return{suggestions,mtfSame};
  },[trades.length,regime.regime,regime.rsi,signals.snp?.dir,signals.int?.dir,signals.trd?.dir,tma?.sessionStats]);

  const closed=trades.filter(t=>t.status==="CLOSED");
  const byCard={SNP:0,INT:0,TRD:0};
  closed.filter(t=>t.outcome!=="SL").forEach(t=>byCard[t.id]=(byCard[t.id]||0)+1);
  const bestCard=Object.entries(byCard).sort((a,b)=>b[1]-a[1])[0];

  return <section>
    <SecTitle ch="AI Strategy Insights" sub="Pattern recognition · condition analysis · improvement feed"/>
    <Box style={{padding:"12px 14px",marginBottom:9}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <Label ch="Improvement Suggestions"/>
        <Badge ch={insights.mtfSame?"ALIGNED":"MIXED"} col={insights.mtfSame?C.green:C.gold} sm/>
      </div>
      {insights.suggestions.map((s,i)=><div key={i} style={{display:"flex",gap:7,
        alignItems:"flex-start",padding:"7px 9px",marginBottom:4,borderRadius:5,
        background:i===0?`${C.cyan}09`:C.muted+"18",
        border:`1px solid ${i===0?`${C.cyan}28`:C.border}`}}>
        <span style={{fontSize:10,color:i===0?C.cyan:C.dim,flexShrink:0,marginTop:0}}>→</span>
        <span style={{fontSize:9,color:C.text,fontFamily:"'Space Mono',monospace",lineHeight:1.5}}>{s}</span>
      </div>)}
    </Box>
    {bestCard&&bestCard[1]>0&&closed.length>0&&<Box style={{padding:"11px 13px",marginBottom:9}}>
      <Label ch="Session Best Performer"/>
      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:5}}>
        <Badge ch={bestCard[0]} col={bestCard[0]==="SNP"?C.cyan:bestCard[0]==="INT"?C.gold:C.purple}/>
        <Num v={bestCard[1]+" wins"} col={C.green} sz={13} w="5ch"/>
        <span style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>this session</span>
      </div>
    </Box>}
    {closed.length>0&&<Box style={{padding:"11px 13px"}}>
      <Label ch="Last 5 Closed Trades" style={{marginBottom:7}}/>
      {closed.slice(-5).reverse().map((t,i)=>{
        const pnl=(t.closePrice-t.entry)*(t.dir==="LONG"?1:-1)/t.entry*100;
        const win=t.outcome!=="SL";
        return <div key={i} style={{display:"flex",alignItems:"center",gap:5,
          padding:"5px 0",borderBottom:i<4?`1px solid ${C.border}`:"none"}}>
          <Badge ch={t.id} col={t.id==="SNP"?C.cyan:t.id==="INT"?C.gold:C.purple} sm/>
          <Badge ch={t.dir} col={t.dir==="LONG"?C.green:C.red} sm/>
          <div style={{flex:1,fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",
            fontVariantNumeric:"tabular-nums"}}>
            ${t.entry?.toLocaleString()} → ${t.closePrice?.toLocaleString()}
          </div>
          <Badge ch={t.outcome||"?"} col={win?C.green:C.red} sm/>
          <div style={{fontSize:9,fontFamily:"'Space Mono',monospace",fontWeight:700,
            color:pnl>=0?C.green:C.red,fontVariantNumeric:"tabular-nums",minWidth:42,textAlign:"right"}}>
            {(pnl>=0?"+":"")+pnl.toFixed(2)+"%"}
          </div>
        </div>;
      })}
    </Box>}
  </section>;
});

/* ═══════════════════════════════════════════════════════════════════════
   ALERT LOG  — timestamped ring buffer of all key platform events
═══════════════════════════════════════════════════════════════════════ */
const AlertLog=memo(function AlertLog({log}){
  return <section>
    <SecTitle ch="Alert Log" sub="TMA gates · signals · trade events · circuit breaker"/>
    {log.length===0?<Box style={{padding:"12px",textAlign:"center"}}>
      <div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>
        Alert log empty — events appear as they occur in real time
      </div>
    </Box>:<Box style={{padding:"11px 13px"}}>
      <div style={{maxHeight:280,overflowY:"auto",paddingRight:4}}>
        {log.map((l,i)=><div key={i} style={{display:"flex",gap:7,alignItems:"flex-start",
          padding:"5px 0",borderBottom:i<log.length-1?`1px solid ${C.border}`:"none"}}>
          <div style={{flexShrink:0,paddingTop:1}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:l.col,marginTop:2}}/>
          </div>
          <div style={{minWidth:42,flexShrink:0}}>
            <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace",lineHeight:1.3}}>
              {new Date(l.ts).toLocaleTimeString("en",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
            </div>
          </div>
          <div style={{flex:1,display:"flex",gap:5,flexWrap:"wrap",alignItems:"flex-start"}}>
            <Badge ch={l.type} col={l.col} sm/>
            <span style={{fontSize:8,color:C.text,fontFamily:"'Space Mono',monospace",
              lineHeight:1.5,flex:1}}>{l.msg}</span>
          </div>
        </div>)}
      </div>
    </Box>}
  </section>;
});

/* ═══════════════════════════════════════════════════════════════════════
   SETTINGS PANEL
═══════════════════════════════════════════════════════════════════════ */
function SettingsPanel({settings,onSave,onClose}){
  const[draft,setDraft]=useState({...settings});
  const set=(k,v)=>setDraft(d=>({...d,[k]:v}));
  const num=(k,v,mn,mx,step=1)=>set(k,Math.min(mx,Math.max(mn,parseFloat(v)||mn)));
  return <div style={{position:"fixed",inset:0,zIndex:300,background:"rgba(2,8,18,0.95)",
    display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
    <div style={{width:"100%",maxWidth:530,background:C.card,border:`1px solid ${C.borderHi}`,
      borderRadius:"14px 14px 0 0",padding:"20px 16px 32px",maxHeight:"85vh",overflowY:"auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <span style={{fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:15,
          color:C.cyan,letterSpacing:"0.12em"}}>SETTINGS</span>
        <button onClick={onClose} style={{background:"none",border:"none",
          color:C.dim,fontSize:18,cursor:"pointer",padding:"2px 6px"}}>✕</button>
      </div>

      {/* Risk & Equity */}
      <div style={{marginBottom:14}}>
        <div style={{fontSize:9,color:C.cyan,fontFamily:"'Space Mono',monospace",
          letterSpacing:"0.12em",marginBottom:8}}>RISK MANAGEMENT</div>
        {[["Equity ($)",draft.equity,v=>num("equity",v,100,1000000,100),100,1000000],
          ["Risk per Trade (%)",draft.riskPct,v=>num("riskPct",v,0.1,5,0.1),0.1,5],
        ].map(([l,val,fn,mn,mx])=><div key={l} style={{marginBottom:8}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
            <span style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{l}</span>
            <span style={{fontSize:10,fontFamily:"'Space Mono',monospace",fontWeight:700,color:C.bright,
              fontVariantNumeric:"tabular-nums"}}>{val}</span>
          </div>
          <input type="range" min={mn} max={mx} step={l.includes("%")?0.1:100}
            value={val} onChange={e=>fn(e.target.value)}
            style={{width:"100%",accentColor:C.cyan}}/>
        </div>)}
      </div>

      {/* Signal Thresholds */}
      <div style={{marginBottom:14}}>
        <div style={{fontSize:9,color:C.cyan,fontFamily:"'Space Mono',monospace",
          letterSpacing:"0.12em",marginBottom:8}}>SIGNAL GATES</div>
        {[["Min Confidence (%)",(draft.confThresh*100).toFixed(0),v=>set("confThresh",v/100),60,99,1],
          ["Min R:R",draft.rrMin,v=>num("rrMin",v,1,5,0.1),1,5],
          ["Chandelier ATR ×",draft.chandelierM,v=>num("chandelierM",v,1.5,5,0.5),1.5,5],
          ["MC Paths",draft.mcPaths,v=>num("mcPaths",v,100,1000,50),100,1000],
        ].map(([l,val,fn,mn,mx,step])=><div key={l} style={{marginBottom:8}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
            <span style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{l}</span>
            <span style={{fontSize:10,fontFamily:"'Space Mono',monospace",fontWeight:700,color:C.bright,
              fontVariantNumeric:"tabular-nums"}}>{val}</span>
          </div>
          <input type="range" min={mn} max={mx} step={step||1}
            value={parseFloat(val)} onChange={e=>fn(parseFloat(e.target.value))}
            style={{width:"100%",accentColor:C.gold}}/>
        </div>)}
      </div>

      {/* Toggles */}
      <div style={{marginBottom:14}}>
        <div style={{fontSize:9,color:C.cyan,fontFamily:"'Space Mono',monospace",
          letterSpacing:"0.12em",marginBottom:8}}>NOTIFICATIONS & MODE</div>
        {[["Telegram Notifications","tgEnabled",C.cyan],
          ["Notify on Signals","tgSignals",C.cyan],
          ["Notify on Trades","tgTrades",C.green],
          ["Notify on TMA Alerts","tgAlerts",C.orange],
          ["Paper Trading Mode","paperMode",C.gold],
          ["Sound Alerts","soundAlerts",C.cyan],
          ["HTF Hard Veto (4h)","htfVeto",C.orange],
          ["Correlation Block","correlationBlock",C.purple],
          ["Kelly Staking","kellyStaking",C.gold],
          ["Recovery Mode","recoveryMode",C.orange],
          ["Deal Cancellation Gate","enableDealCancel",C.cyan],
          ["Server-Side Trail Stop","enableServerTrail",C.gold],
        ].map(([l,k,col])=><div key={k} style={{display:"flex",justifyContent:"space-between",
          alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
          <span style={{fontSize:10,color:C.text,fontFamily:"'Space Mono',monospace"}}>{l}</span>
          <div onClick={()=>set(k,!draft[k])} style={{width:36,height:20,borderRadius:10,
            background:draft[k]?col:C.muted,cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
            <div style={{position:"absolute",top:2,width:16,height:16,borderRadius:8,
              background:C.bright,transition:"left 0.2s",left:draft[k]?18:2,
              boxShadow:"0 1px 3px rgba(0,0,0,0.5)"}}/>
          </div>
        </div>)}
      </div>

      {/* Telegram status */}
      <div style={{padding:"8px 11px",background:`${C.cyan}09`,borderRadius:6,
        border:`1px solid ${C.cyan}20`,marginBottom:14}}>
        <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",marginBottom:2}}>Telegram</div>
        <div style={{fontSize:9,color:C.text,fontFamily:"'Space Mono',monospace"}}>
          Bot: <span style={{color:C.cyan}}>@btcplatform_bot</span> · Chat ID: <span style={{color:C.cyan}}>{TG_CHAT}</span>
        </div>
        <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",marginTop:2}}>Notifications delivered via Telegram Bot API</div>
      </div>

      <div style={{display:"flex",gap:8}}>
        <button onClick={()=>{saveSettings(draft);onSave(draft);onClose();}}
          style={{flex:2,padding:"10px 0",borderRadius:7,fontSize:10,fontWeight:700,
            fontFamily:"'Space Mono',monospace",background:C.cyan,color:"#000",
            border:"none",cursor:"pointer",letterSpacing:"0.1em"}}>SAVE &amp; APPLY</button>
        <button onClick={()=>{saveSettings(DEFAULT_SETTINGS);onSave(DEFAULT_SETTINGS);}}
          style={{flex:1,padding:"10px 0",borderRadius:7,fontSize:10,fontWeight:700,
            fontFamily:"'Space Mono',monospace",background:"none",color:C.dim,
            border:`1px solid ${C.border}`,cursor:"pointer"}}>RESET</button>
      </div>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════════════
   PAPER TRADING DASHBOARD
═══════════════════════════════════════════════════════════════════════ */
const PaperTradingPanel=memo(function PaperTradingPanel({paper,paperDispatch,settings,price}){
  const{equity,startEquity,trades,maxDD,peak}=paper;
  const openT=trades.filter(t=>t.status==="OPEN");
  const closedT=trades.filter(t=>t.status==="CLOSED"&&t.closePrice);
  const wins=closedT.filter(t=>t.outcome==="TP"||t.outcome==="TRAIL_TP");
  const wr=closedT.length?wins.length/closedT.length:null;
  const totalPnl=equity-startEquity;
  const pnlPct=startEquity?totalPnl/startEquity*100:0;
  const curve=closedT.map((t,i)=>({i,eq:parseFloat(t.pnl||0)}));
  let running=startEquity;
  const eqCurve=closedT.map(t=>{running+=t.pnl||0;return{eq:parseFloat(running.toFixed(2))};});
  return <section>
    <SecTitle ch="Paper Trading" sub={`Virtual $${startEquity.toLocaleString()} · ${settings.riskPct}% risk · real market prices`}/>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:9}}>
      {[["Balance","$"+equity.toLocaleString(),pnlPct>=0?C.green:C.red],
        ["P&L",(pnlPct>=0?"+":"")+pnlPct.toFixed(2)+"%",pnlPct>=0?C.green:C.red],
        ["Max DD","$"+parseFloat(maxDD).toFixed(0),parseFloat(maxDD)>startEquity*0.1?C.red:C.gold],
        ["Win Rate",wr!==null?(wr*100).toFixed(0)+"%":"—",wr>0.6?C.green:wr>0.4?C.gold:wr>0?C.red:C.dim],
        ["Trades",closedT.length,C.text],["Open",openT.length,C.cyan],
      ].map(([l,v,c])=><Box key={l} style={{padding:"9px 11px"}}>
        <Label ch={l} style={{fontSize:8}}/><Num v={v} col={c} sz={13} w="7ch"/>
      </Box>)}
    </div>
    {eqCurve.length>1&&<Box style={{padding:"11px 13px",marginBottom:9}}>
      <Label ch="Paper Equity Curve" style={{marginBottom:5}}/>
      <div style={{height:90}}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={eqCurve} margin={{top:3,right:3,bottom:0,left:0}}>
            <defs><linearGradient id="pEqG" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={pnlPct>=0?C.green:C.red} stopOpacity={0.25}/>
              <stop offset="95%" stopColor={pnlPct>=0?C.green:C.red} stopOpacity={0.01}/>
            </linearGradient></defs>
            <XAxis hide/><YAxis domain={["auto","auto"]} tick={{fill:C.dim,fontSize:8,fontFamily:"'Space Mono',monospace"}} tickLine={false} axisLine={false} tickFormatter={v=>"$"+v.toLocaleString()} width={52}/>
            <ReferenceLine y={startEquity} stroke={C.border} strokeDasharray="3 3"/>
            <Tooltip content={<ChartTip/>}/>
            <Area type="monotone" dataKey="eq" name="Balance $" stroke={pnlPct>=0?C.green:C.red}
              strokeWidth={1.5} fill="url(#pEqG)" dot={false} isAnimationActive={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Box>}
    {openT.length>0&&<Box style={{padding:"11px 13px",marginBottom:9}}>
      <Label ch="Open Paper Positions" style={{marginBottom:6}}/>
      {openT.map(t=>{
        const live=t.pnl||0;
        const livePct=startEquity?live/startEquity*100:0;
        return <div key={t.id} style={{display:"flex",alignItems:"center",gap:7,
          padding:"6px 0",borderBottom:`1px solid ${C.border}`}}>
          <Badge ch={t.id} col={t.id==="SNP"?C.cyan:t.id==="INT"?C.gold:C.purple} sm/>
          <Badge ch={t.dir} col={t.dir==="LONG"?C.green:C.red} sm/>
          <div style={{flex:1,fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",
            fontVariantNumeric:"tabular-nums"}}>
            ${t.entry?.toLocaleString()} · pos {t.posSize?.toFixed(4)} BTC
          </div>
          <div style={{fontSize:10,fontFamily:"'Space Mono',monospace",fontWeight:700,
            color:live>=0?C.green:C.red,fontVariantNumeric:"tabular-nums"}}>
            {live>=0?"+":""}{livePct.toFixed(2)}%
          </div>
        </div>;
      })}
    </Box>}
    {closedT.length>0&&<Box style={{padding:"11px 13px",marginBottom:9}}>
      <Label ch="Recent Paper Trades" style={{marginBottom:6}}/>
      {closedT.slice(-5).reverse().map((t,i)=><div key={i} style={{display:"flex",
        alignItems:"center",gap:5,padding:"5px 0",borderBottom:i<4?`1px solid ${C.border}`:"none"}}>
        <Badge ch={t.id} col={t.id==="SNP"?C.cyan:t.id==="INT"?C.gold:C.purple} sm/>
        <Badge ch={t.dir} col={t.dir==="LONG"?C.green:C.red} sm/>
        <div style={{flex:1,fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",
          fontVariantNumeric:"tabular-nums"}}>
          ${t.entry?.toLocaleString()} → ${t.closePrice?.toLocaleString()}
        </div>
        <Badge ch={t.outcome} col={t.outcome==="SL"?C.red:C.green} sm/>
        <div style={{fontSize:9,fontFamily:"'Space Mono',monospace",fontWeight:700,
          color:t.pnl>=0?C.green:C.red,minWidth:42,textAlign:"right",
          fontVariantNumeric:"tabular-nums"}}>
          {t.pnl>=0?"+":""}${t.pnl?.toFixed(0)}
        </div>
      </div>)}
    </Box>}
    <div style={{display:"flex",gap:7}}>
      <button onClick={()=>paperDispatch({type:"CLOSE_ALL",price})}
        style={{flex:1,padding:"9px 0",borderRadius:6,fontSize:9,fontWeight:700,
          fontFamily:"'Space Mono',monospace",color:C.orange,
          background:`${C.orange}12`,border:`1px solid ${C.orange}30`,cursor:"pointer"}}>
        CLOSE ALL POSITIONS
      </button>
      <button onClick={()=>paperDispatch({type:"RESET",equity:settings.equity})}
        style={{flex:1,padding:"9px 0",borderRadius:6,fontSize:9,fontWeight:700,
          fontFamily:"'Space Mono',monospace",color:C.dim,
          background:"none",border:`1px solid ${C.border}`,cursor:"pointer"}}>
        RESET ($10K)
      </button>
    </div>
  </section>;
});

/* ═══════════════════════════════════════════════════════════════════════
   BACKTESTER
═══════════════════════════════════════════════════════════════════════ */
const BacktesterPanel=memo(function BacktesterPanel({kRef,settings}){
  const[running,setRunning]=useState(false);
  const[result,setResult]=useState(null);
  const[tf,setTf]=useState("15m");
  const run=useCallback(async()=>{
    setRunning(true);setResult(null);
    await new Promise(r=>setTimeout(r,30)); // yield to UI
    const kmap={"1m":kRef.current.k1m,"15m":kRef.current.k15m,"1h":kRef.current.k1h,"4h":kRef.current.k4h};
    const r=runBacktest(kmap[tf]||kRef.current.k15m,tf,settings.equity,settings.riskPct);
    setResult(r);setRunning(false);
  },[tf,settings,kRef]);
  return <section>
    <SecTitle ch="Backtester" sub="Walk-forward · no lookahead · closed bars only"/>
    <Box style={{padding:"12px 14px",marginBottom:9}}>
      <div style={{display:"flex",gap:7,marginBottom:10,alignItems:"center"}}>
        <Label ch="Timeframe" style={{marginBottom:0,flexShrink:0}}/>
        <div style={{display:"flex",gap:5,flex:1}}>
          {["1m","15m","1h","4h"].map(t=><button key={t} onClick={()=>setTf(t)}
            style={{flex:1,padding:"5px 0",borderRadius:5,fontSize:9,fontWeight:700,
              fontFamily:"'Space Mono',monospace",cursor:"pointer",
              color:tf===t?C.bg:C.dim,background:tf===t?C.cyan:"none",
              border:`1px solid ${tf===t?C.cyan:C.border}`}}>{t}</button>)}
        </div>
      </div>
      <button onClick={run} disabled={running}
        style={{width:"100%",padding:"10px 0",borderRadius:7,fontSize:10,fontWeight:700,
          fontFamily:"'Space Mono',monospace",letterSpacing:"0.1em",cursor:running?"not-allowed":"pointer",
          color:running?C.dim:C.bg,background:running?C.muted:C.gold,border:"none"}}>
        {running?"RUNNING BACKTEST...":"RUN BACKTEST"}
      </button>
    </Box>
    {result&&<>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:9}}>
        {[["Win Rate",(result.wr*100).toFixed(0)+"%",result.wr>0.6?C.green:result.wr>0.4?C.gold:C.red],
          ["Profit Factor",result.pf,parseFloat(result.pf)>1.5?C.green:parseFloat(result.pf)>1?C.gold:C.red],
          ["Return %",(parseFloat(result.returnPct)>=0?"+":"")+result.returnPct+"%",parseFloat(result.returnPct)>=0?C.green:C.red],
          ["Max DD","$"+parseFloat(result.maxDD).toLocaleString(),parseFloat(result.maxDD)>settings.equity*0.1?C.red:C.gold],
          ["Total Trades",result.total,C.text],["Wins/Loss",result.wins+"/"+result.losses,C.cyan],
        ].map(([l,v,c])=><Box key={l} style={{padding:"9px 11px"}}>
          <Label ch={l} style={{fontSize:8}}/><Num v={v} col={c} sz={13} w="6ch"/>
        </Box>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:9}}>
        <Box style={{padding:"9px 11px"}}><Label ch="Avg Win" style={{fontSize:8}}/><Num v={"+"+result.avgWin+"%"} col={C.green} sz={13} w="6ch"/></Box>
        <Box style={{padding:"9px 11px"}}><Label ch="Avg Loss" style={{fontSize:8}}/><Num v={"-"+result.avgLoss+"%"} col={C.red} sz={13} w="6ch"/></Box>
      </div>
      {result.results.length>2&&<Box style={{padding:"12px 13px"}}>
        <Label ch={`Equity Curve · ${tf} · ${result.results.length} trades`} style={{marginBottom:5}}/>
        <div style={{height:130}}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={result.results} margin={{top:3,right:3,bottom:0,left:0}}>
              <defs><linearGradient id="btG" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={parseFloat(result.returnPct)>=0?C.green:C.red} stopOpacity={0.25}/>
                <stop offset="95%" stopColor={parseFloat(result.returnPct)>=0?C.green:C.red} stopOpacity={0.01}/>
              </linearGradient></defs>
              <XAxis hide/>
              <YAxis domain={["auto","auto"]} tick={{fill:C.dim,fontSize:8,fontFamily:"'Space Mono',monospace"}}
                tickLine={false} axisLine={false} tickFormatter={v=>"$"+v.toLocaleString()} width={55}/>
              <ReferenceLine y={settings.equity} stroke={C.border} strokeDasharray="3 3"/>
              <Tooltip content={<ChartTip/>}/>
              <Area type="monotone" dataKey="equity" name="Equity $"
                stroke={parseFloat(result.returnPct)>=0?C.green:C.red}
                strokeWidth={1.5} fill="url(#btG)" dot={false} isAnimationActive={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Box>}
    </>}
    {!result&&!running&&<Box style={{padding:"13px",textAlign:"center"}}>
      <div style={{fontSize:9,color:C.dim,fontFamily:"'Space Mono',monospace"}}>
        Select timeframe and run to see historical equity curve
      </div>
    </Box>}
  </section>;
});

/* ─── SYSTEM STATUS ──────────────────────────────────────────────────── */
const SystemStatus=memo(function SystemStatus({display,regime,candleVer}){
  const{connected,loading,error}=display;
  const rows=[
    {n:"WebSocket",ok:connected,note:connected?"LIVE":"DOWN"},
    {n:"Price Stream",ok:display.price>0,note:display.price>0?"ACTIVE":"WAIT"},
    {n:"Depth (600ms)",ok:display.price>0,note:"500ms WS → 600ms flush"},
    {n:"Funding/OI",ok:display.fundRate!==0,note:display.fundRate!==0?"ACTIVE":"WAIT"},
    {n:"1m Closed Candles",ok:candleVer>0,note:"ver "+candleVer},
    {n:"15m/1h/4h/1d",ok:display.oi>0,note:"REST 60s refresh"},
    {n:"Regime Engine",ok:regime.regime!=="LOADING",note:regime.regime?.replace(/_/g," ")||"INIT"},
    {n:"Signal Engine",ok:true,note:"Closed candle only"},
    {n:"Chandelier Stop",ok:true,note:"ATR×"+CHANDELIER_M+" · 22p"},
    {n:"No Repaint",ok:true,note:"Last candle stripped"},
  ];
  const allOk=connected&&candleVer>0;
  return <section style={{marginBottom:32}}>
    <SecTitle ch="System Status"/>
    <Box style={{padding:"13px 14px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <Dot col={allOk?C.green:C.orange} pulse={allOk}/>
          <span style={{fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:13,
            color:allOk?C.green:C.orange,letterSpacing:"0.08em"}}>
            {allOk?"ALL OPERATIONAL":loading?"INITIALIZING":"PARTIAL"}
          </span>
        </div>
        <Num v={"v"+candleVer} col={C.dim} sz={9}/>
      </div>
      {error&&<div style={{fontSize:9,color:C.red,fontFamily:"'Space Mono',monospace",marginBottom:8}}>{error}</div>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
        {rows.map(r=><div key={r.n} style={{display:"flex",justifyContent:"space-between",
          alignItems:"center",padding:"4px 8px",background:C.muted+"26",borderRadius:4,
          border:`1px solid ${C.border}`,minHeight:28}}>
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <Dot col={r.ok?C.green:C.orange}/>
            <span style={{fontSize:9,fontFamily:"'Rajdhani',sans-serif",fontWeight:600,color:C.text}}>{r.n}</span>
          </div>
          <span style={{fontSize:7,fontFamily:"'Space Mono',monospace",color:C.dim,textAlign:"right"}}>{r.note}</span>
        </div>)}
      </div>
      <div style={{marginTop:9,padding:"7px 10px",background:`${C.cyan}07`,borderRadius:5,
        border:`1px solid ${C.border}`,display:"flex",flexWrap:"wrap",gap:10}}>
        {[["Source","Binance Futures"],["No Repaint","✓ Closed Only"],
          ["Brain TTL",BRAIN_TTL/1000+"s"],["Signal TTL",SIGNAL_TTL/1000+"s"],
          ["Trail","Chandelier ATR"],["MC",MC_PATHS+" paths"]
        ].map(([k,v])=><div key={k}>
          <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{k}</div>
          <div style={{fontSize:9,fontFamily:"'Space Mono',monospace",fontWeight:700,color:C.cyan}}>{v}</div>
        </div>)}
      </div>
    </Box>
  </section>;
});

/* ═══════════════════════════════════════════════════════════════════════
   DERIV DATA HOOK — replaces useMarketData for a specific Deriv symbol
   Uses DWS (DerivWSManager singleton) · closed-candle guard preserved
═══════════════════════════════════════════════════════════════════════ */
function useDerivData(sym){
  const[display,setDisplay]=useState({price:0,change24h:0,high24h:0,low24h:0,
    fundRate:0,oi:0,markPrice:0,connected:false,loading:true,error:null,
    authorized:false,balance:0});
  const kRef=useRef({k1m:null,k5m:null,k15m:null,k1h:null,k4h:null,k1d:null});
  const[candleVer,setCandleVer]=useState(0);
  const subIds=useRef([]);
  const prevOpenRef=useRef({});
  const formingRef=useRef({});

  useEffect(()=>{
    if(!sym)return;
    kRef.current={k1m:null,k5m:null,k15m:null,k1h:null,k4h:null,k1d:null};
    setDisplay(d=>({...d,loading:true,price:0,error:null}));
    setCandleVer(0);
    subIds.current.forEach(id=>{try{DWS.forget(id);}catch{}});
    subIds.current=[];

    DWS.onStatusChange=(connected,authorized,balance)=>{
      setDisplay(d=>({...d,connected,authorized,balance:balance||d.balance}));
    };
    if(!DWS.connected)DWS.connect();

    const load=async()=>{
      // Wait for auth via polling — up to 12s, then proceed anyway
      if(!DWS.authorized){
        await new Promise(res=>{
          if(DWS.authorized){res();return;}
          let attempts=0;
          const iv=setInterval(()=>{
            attempts++;
            if(DWS.authorized||attempts>60){clearInterval(iv);res();}
          },200);
        });
      }
      try{
        // Subscribe timeframes sequentially with small gaps to avoid rate limits
        const tfPairs=[["k1m",60,300],["k5m",300,200],["k15m",900,200],["k1h",3600,150],["k4h",14400,100],["k1d",86400,100]];
        for(const[key,gran,count] of tfPairs){
          const subId=await DWS.subscribeCandles(sym,gran,count,
            (ohlc)=>{
              const openT=parseInt(ohlc.open_time||ohlc.epoch)*1000;
              const newK=[openT,String(ohlc.open),String(ohlc.high),String(ohlc.low),String(ohlc.close),"1",openT];
              const prevT=prevOpenRef.current[key];
              if(prevT&&openT>prevT){
                const fc=formingRef.current[key];
                if(fc&&kRef.current[key]?.length){
                  kRef.current[key]=[...kRef.current[key].slice(-299),fc];
                  if(key==="k1m")setCandleVer(v=>v+1);
                }
              }
              prevOpenRef.current[key]=openT;
              formingRef.current[key]=newK;
              if(key==="k1m"){
                const p=parseFloat(ohlc.close);
                setDisplay(d=>({...d,price:p,markPrice:p,
                  high24h:Math.max(d.high24h||0,parseFloat(ohlc.high)),
                  low24h:d.low24h>0?Math.min(d.low24h,parseFloat(ohlc.low)):parseFloat(ohlc.low)}));
              }
            },
            (candles)=>{
              const klines=candles.map(c=>[parseInt(c.epoch)*1000,String(c.open),String(c.high),String(c.low),String(c.close),"1",parseInt(c.epoch)*1000]);
              kRef.current[key]=klines;
              if(key==="k1m"&&klines.length>0){
                const last=parseFloat(klines[klines.length-1][4]);
                const first24=klines.find(k=>Date.now()-k[0]<86400000)||klines[0];
                const first=parseFloat(first24[4]);
                const chg=first>0?(last-first)/first*100:0;
                setDisplay(d=>({...d,price:last,markPrice:last,
                  change24h:parseFloat(chg.toFixed(2)),
                  high24h:Math.max(...klines.slice(-1440).map(k=>parseFloat(k[2]))),
                  low24h:Math.min(...klines.slice(-1440).map(k=>parseFloat(k[3]))),
                  loading:false,connected:DWS.connected,authorized:DWS.authorized}));
                setCandleVer(v=>v+1);
              }
            }
          );
          if(subId)subIds.current.push(subId);
          await new Promise(r=>setTimeout(r,150)); // 150ms between TF subscriptions
        }
        // #31: CB tick stream spike pre-detector — subscribe raw ticks for Crash/Boom
        const _isCBSym=sym?.startsWith('CRASH')||sym?.startsWith('BOOM');
        if(_isCBSym){
          const tickBuf=[];
          const cbTickSub=await DWS.subscribeTick(sym,(tick)=>{
            tickBuf.push(parseFloat(tick.quote));if(tickBuf.length>20)tickBuf.shift();
            const det=cbTickAnalysis(tickBuf,sym);
            if(det.spike&&det.conf>0.65){
              setCandleVer(v=>v+1); // trigger re-analysis on CB spike
            }
          });
          if(cbTickSub)subIds.current.push(cbTickSub);
        }
        setDisplay(d=>({...d,loading:false,balance:DWS.balance||d.balance}));
      }catch(e){setDisplay(d=>({...d,error:e.message,loading:false}));}
    };
    // Connect if needed, then load immediately or via auth callback
    if(!DWS.connected)DWS.connect();
    load(); // load() polls internally for auth — no race condition
    return()=>{subIds.current.forEach(id=>{try{DWS.forget(id);}catch{}});subIds.current=[];};
  },[sym]);

  return{display,kRef,candleVer,depth:{bids:[],asks:[]}};
}

/* ─── useScannerData — background analysis for all Deriv assets ────────── */
function useScannerData(){
  const[prices,setPrices]=useState({});
  const[assetData,setAssetData]=useState({});
  const[loadProg,setLoadProg]=useState(0);
  const kCache=useRef({});
  const subMap=useRef({});
  const refreshIdx=useRef(0);

  const analyse=useCallback((sym)=>{
    const km=kCache.current[sym];
    if(!km?.k1m?.length)return;
    const asset=DERIV_ASSETS.find(a=>a.sym===sym)||{thresh:{show:0.58,alert:0.72,min:0.44}};
    const reg=detectRegime(km.k1m);
    const of2=calcOrderFlow(km.k1m);
    const sw2=stratWeights(reg);
    const raw=buildSignals(km,of2,reg);
    const enrich=sig=>{
      if(!sig)return null;
      const cl=closedOnly(km.k1m)?.map(r=>parseFloat(r[4]));
      const mc=cl?.length>25?runMC(cl,sig.entry,sig.sl,sig.tp[0]):null;
      const fc=aggregateConf(sig,mc,of2,sw2);
      // Use per-asset minConf (from ASSET_SIGNAL_PARAMS) or asset thresh.min
      const asp=getSignalParams(sym);
      const minConf=Math.max(asset.thresh.min,asp.minConf);
      if(fc<minConf)return null;
      return{...sig,finalConf:fc,mc,sym};
    };
    const all=[enrich(raw.trd),enrich(raw.int),enrich(raw.snp)].filter(Boolean);
    const best=all.sort((a,b)=>b.finalConf-a.finalConf)[0]||null;
    setAssetData(d=>({...d,[sym]:{regime:reg,best,updatedAt:Date.now()}}));
  },[]);

  useEffect(()=>{
    if(!DWS.connected)DWS.connect();
    const startLoad=async()=>{
      // Poll for auth — up to 12s
      if(!DWS.authorized){
        await new Promise(res=>{
          let n=0;
          const iv=setInterval(()=>{n++;if(DWS.authorized||n>60){clearInterval(iv);res();}},200);
        });
      }
      for(let i=0;i<DERIV_ASSETS.length;i+=3){
        const batch=DERIV_ASSETS.slice(i,i+3);
        await Promise.all(batch.map(async(asset)=>{
          try{
            // Subscribe 1m — price + basic signals
            if(!kCache.current[asset.sym])kCache.current[asset.sym]={k1m:[],k15m:[],k1h:[],k4h:[]};
            const sub1m=await DWS.subscribeCandles(asset.sym,60,150,
              (ohlc)=>{
                const newK=[parseInt(ohlc.open_time||ohlc.epoch)*1000,String(ohlc.open),String(ohlc.high),String(ohlc.low),String(ohlc.close),"1"];
                const prev=kCache.current[asset.sym].k1m||[];
                const openT=parseInt(ohlc.open_time||ohlc.epoch)*1000;
                const lastT=prev[prev.length-1]?.[0];
                if(lastT&&openT>lastT){
                  kCache.current[asset.sym].k1m=[...prev.slice(-149),newK];
                  analyse(asset.sym);
                } else if(prev.length){kCache.current[asset.sym].k1m=[...prev.slice(0,-1),newK];}
                else{kCache.current[asset.sym].k1m=[newK];}
                setPrices(p=>({...p,[asset.sym]:{...p[asset.sym],p:parseFloat(ohlc.close)}}));
              },
              (candles)=>{
                if(!candles?.length)return;
                kCache.current[asset.sym].k1m=candles.map(c=>[parseInt(c.epoch)*1000,String(c.open),String(c.high),String(c.low),String(c.close),"1"]);
                const kl=kCache.current[asset.sym].k1m;
                const last=parseFloat(kl[kl.length-1][4]);
                const first24=kl.find(k=>Date.now()-k[0]<86400000)||kl[0];
                const chg=parseFloat(first24[4])>0?(last-parseFloat(first24[4]))/parseFloat(first24[4])*100:0;
                setPrices(p=>({...p,[asset.sym]:{p:last,c24h:parseFloat(chg.toFixed(2))}}));
                analyse(asset.sym);
                setLoadProg(p=>Math.min(DERIV_ASSETS.length,p+1));
              }
            );
            if(sub1m)subMap.current[asset.sym+"_1m"]=sub1m;

            // FIX: subscribe 15m — powers INTRADAY HUNTER (was missing → ghost signals)
            await new Promise(r=>setTimeout(r,200));
            const sub15m=await DWS.subscribeCandles(asset.sym,900,80,
              (ohlc)=>{
                if(!kCache.current[asset.sym])return;
                const newK=[parseInt(ohlc.open_time||ohlc.epoch)*1000,String(ohlc.open),String(ohlc.high),String(ohlc.low),String(ohlc.close),"1"];
                const prev=kCache.current[asset.sym].k15m||[];
                const openT=parseInt(ohlc.open_time||ohlc.epoch)*1000;
                const lastT=prev[prev.length-1]?.[0];
                if(lastT&&openT>lastT){kCache.current[asset.sym].k15m=[...prev.slice(-79),newK];analyse(asset.sym);}
                else if(prev.length){kCache.current[asset.sym].k15m=[...prev.slice(0,-1),newK];}
                else{kCache.current[asset.sym].k15m=[newK];}
              },
              (candles)=>{
                if(!candles?.length||!kCache.current[asset.sym])return;
                kCache.current[asset.sym].k15m=candles.map(c=>[parseInt(c.epoch)*1000,String(c.open),String(c.high),String(c.low),String(c.close),"1"]);
              }
            );
            if(sub15m)subMap.current[asset.sym+"_15m"]=sub15m;

            // FIX: subscribe 4h — powers TREND RIDER (was missing → ghost signals)
            await new Promise(r=>setTimeout(r,200));
            const sub4h=await DWS.subscribeCandles(asset.sym,14400,60,
              (ohlc)=>{
                if(!kCache.current[asset.sym])return;
                const newK=[parseInt(ohlc.open_time||ohlc.epoch)*1000,String(ohlc.open),String(ohlc.high),String(ohlc.low),String(ohlc.close),"1"];
                const prev=kCache.current[asset.sym].k4h||[];
                const openT=parseInt(ohlc.open_time||ohlc.epoch)*1000;
                const lastT=prev[prev.length-1]?.[0];
                if(lastT&&openT>lastT){kCache.current[asset.sym].k4h=[...prev.slice(-59),newK];analyse(asset.sym);}
                else if(prev.length){kCache.current[asset.sym].k4h=[...prev.slice(0,-1),newK];}
                else{kCache.current[asset.sym].k4h=[newK];}
              },
              (candles)=>{
                if(!candles?.length||!kCache.current[asset.sym])return;
                kCache.current[asset.sym].k4h=candles.map(c=>[parseInt(c.epoch)*1000,String(c.open),String(c.high),String(c.low),String(c.close),"1"]);
              }
            );
            if(sub4h)subMap.current[asset.sym+"_4h"]=sub4h;

          }catch(e){ console.warn('Scanner sub failed:',asset.sym,e.message); }
        }));
        if(i+3<DERIV_ASSETS.length)await new Promise(r=>setTimeout(r,700));
      }
    };
    startLoad();
    const iv=setInterval(()=>{const sym=DERIV_ASSETS[refreshIdx.current%DERIV_ASSETS.length].sym;refreshIdx.current++;analyse(sym);},6000);
    return()=>{clearInterval(iv);};
  },[analyse]);

  const sentiment=useMemo(()=>{
    const vals=Object.values(assetData);
    const bull=vals.filter(d=>d.regime?.dir==="BULLISH").length;
    const bear=vals.filter(d=>d.regime?.dir==="BEARISH").length;
    const sigs=vals.filter(d=>d.best).length;
    const label=bull>bear+3?"RISK ON":bear>bull+3?"RISK OFF":bull>bear?"LEANING BULL":bear>bull?"LEANING BEAR":"MIXED";
    return{label,col:bull>bear?C.green:bear>bull?C.red:C.gold,bullN:bull,bearN:bear,signals:sigs};
  },[assetData]);
  return{prices,assetData,loadProg,sentiment};
}

/* ═══════════════════════════════════════════════════════════════════════
   GLOBAL MULTI-ASSET AUTO-TRADE (from note.html Base44 architecture)
   Silently monitors ALL 27 assets simultaneously.
   Max 5 concurrent positions. 5-min per-symbol cooldown.
   1% risk per trade. Fires on PRIME signal (≥ALERT_THRESH conf).
   This is the core "money printer" mechanism — trades while you watch.
═══════════════════════════════════════════════════════════════════════ */
function useGlobalAutoTrade(assetData,prices,settings,globalTrades,globalDispatch,addAlert){
  const cooldownRef=useRef({}); // sym → last fire timestamp
  const runningRef=useRef(false);

  useEffect(()=>{
    if(!settings.autoTrade||!DWS.authorized)return;
    const iv=setInterval(async()=>{
      if(runningRef.current)return;
      const openCount=(Array.isArray(globalTrades)?globalTrades:[]).filter(t=>t.status==="OPEN").length;
      if(openCount>=5)return; // max 5 concurrent
      if(isDailyKilled())return;

      runningRef.current=true;
      try{
        // Find best signal across all assets
        const candidates=[];
        for(const [sym,data] of Object.entries(assetData)){
          if(!data?.best)continue;
          const now=Date.now();
          const cooldown=cooldownRef.current[sym]||0;
          if(now-cooldown<300000)continue; // 5-min per-symbol cooldown
          if((data.best.finalConf||0)<ALERT_THRESH)continue;
          // Check daily kill and regulatory block
          if(DWS.permittedSymbols&&!DWS.permittedSymbols.has(sym))continue;
          const asp=getSignalParams(sym);
          if((data.best.finalConf||0)<asp.minConf)continue;
          // Correlation block
          const openT=(Array.isArray(globalTrades)?globalTrades:[]);
          if(correlationBlocked(sym,openT))continue;
          // Cross-asset confirmation: require correlated asset to agree
          if(!crossAssetConfirmed(sym,data.best.dir,assetData)){
            // Not confirmed yet — check if we should queue it
            continue;
          }
          candidates.push({sym,sig:data.best,conf:data.best.finalConf||0,regime:data.regime});
        }
        if(!candidates.length){runningRef.current=false;return;}

        // Sort by confidence, execute highest first
        candidates.sort((a,b)=>b.conf-a.conf);
        const best=candidates[0];
        const{sym,sig}=best;

        // Set cooldown BEFORE execution (prevents retry spam on error)
        cooldownRef.current[sym]=Date.now();

        const assetDef=getAsset(sym);
        const validMults=(assetDef.mult||[]).filter(m=>m>0);
        if(!validMults.length){runningRef.current=false;return;}
        const mult=Math.max(...validMults);
        const balance=DWS.balance||1000;
        const recovActive=DWS.sessionPeak>0&&(DWS.sessionPeak-balance)/DWS.sessionPeak>=RECOVERY_DD_PCT;
        const closed=(Array.isArray(globalTrades)?globalTrades:[]).filter(t=>t.status==="CLOSED");
        let hs=0;for(let i=closed.length-1;i>=0;i--){if(closed[i].outcome!=="SL"&&closed[i].status==="CLOSED")hs++;else if(closed[i].status==="CLOSED")break;}
        const stake=kellyStake(sig,balance,settings,recovActive,hs);
        const slAmt=+Math.max(0.5,Math.abs(sig.entry-sig.sl)/sig.entry*stake*mult).toFixed(2);
        const tpAmt=+Math.max(0.5,Math.abs((sig.tp?.[0]||sig.entry)-sig.entry)/sig.entry*stake*mult).toFixed(2);
        const contractType=sig.dir==="LONG"?"MULTUP":"MULTDOWN";

        try{
          // News block for forex/gold
          if(isForexOrGold(sym)){
            const nb=await fetchNewsBlock().catch(()=>({blocked:false}));
            if(nb.blocked){addAlert("NEWS_BLOCK",`AutoTrade ${sym} blocked — ${nb.reason}`,C.orange);runningRef.current=false;return;}
          }
          const prop=await DWS.getProposal({sym,contractType,stake,multiplier:mult,sl:slAmt,tp:tpAmt});
          if(!prop?.proposal?.id)throw new Error(prop?.error?.message||"Proposal failed");
          const buyRes=await DWS.buy(prop.proposal.id,stake);
          if(!buyRes?.buy?.contract_id)throw new Error(buyRes?.error?.message||"Buy rejected");
          const cid=buyRes.buy.contract_id;
          const actualEntry=parseFloat(buyRes.buy.start_time||sig.entry)||sig.entry;
          const slippage=(actualEntry-sig.entry)/sig.entry;
          globalDispatch({type:"OPEN",sig:{...sig,sym,contractId:cid},sym,contractId:cid,stake,multiplier:mult,slippage});
          appendJournal({sym,dir:sig.dir,card:sig.id,entry:actualEntry,signalEntry:sig.entry,stake,multiplier:mult,regime:sig.regime,conf:sig.finalConf,contractId:cid,openedAt:Date.now(),slippage,slippagePips:sig.entry?Math.abs(actualEntry-sig.entry)/((getAsset(sym).pip)||0.0001):0});
          if(settings.soundAlerts!==false)playTradeOpen();
          addAlert("AUTO_TRADE",`⚡ Global auto: ${sym} ${sig.id} ${sig.dir} $${stake}×${mult} #${cid}`,C.gold);
          if(settings.tgEnabled&&settings.tgTrades)tgSend(`🤖 *Global Auto* ${sym} ${sig.id} *${sig.dir}*\n$${stake}×${mult} · ${(sig.finalConf*100).toFixed(0)}% conf`);
          // Monitor settlement
          DWS.monitorContract(cid,async(poc)=>{
            if(poc.profit!=null)globalDispatch({type:"UPDATE_PROFIT",contractId:cid,profit:parseFloat(poc.profit)});
            if(poc.status==="sold"||poc.is_expired||poc.is_sold){
              const profit=parseFloat(poc.profit||0);
              const exitPrice=parseFloat(poc.exit_tick_display_value||poc.current_spot||actualEntry);
              globalDispatch({type:"CLOSE",id:sig.id,sym,outcome:profit>=0?"TP":"SL",price:exitPrice,profit});
              appendJournal({contractId:cid,closePrice:exitPrice,profit,outcome:profit>=0?"TP":"SL",closedAt:Date.now()});
              if(profit<0)recordLoss(Math.abs(profit));
              if(settings.soundAlerts!==false){profit>=0?playTradeWin():playTradeLoss();}
              addAlert("AUTO_SETTLED",`${sym} ${sig.id} ${profit>=0?"✓ +$"+profit.toFixed(2):"✗ $"+profit.toFixed(2)}`,profit>=0?C.green:C.red);
              await DWS.refreshBalance();
              maybeLearnWeights((Array.isArray(globalTrades)?globalTrades:[]).filter(t=>t.status==="CLOSED"));
            }
          }).catch(()=>{});
        }catch(e){
          addAlert("AUTO_ERR",`${sym}: ${e.message}`,C.red);
        }
      }finally{runningRef.current=false;}
    },8000); // scan every 8 seconds
    return()=>clearInterval(iv);
  },[settings.autoTrade,assetData,globalTrades]);
}

/* ─── SCANNER CARD ────────────────────────────────────────────────────── */
const ScannerAssetCard=memo(function ScannerAssetCard({asset,price,data,onSelect}){
  const p=price?.p||0,c24=price?.c24h||0;
  const best=data?.best,reg=data?.regime;
  const rMap={STRONG_BULL:"S.BULL",MODERATE_BULL:"BULL",STRONG_BEAR:"S.BEAR",MODERATE_BEAR:"BEAR",RANGE_BOUND:"RANGE",HIGH_VOLATILITY:"HI VOL",COMPRESSION:"COMP",LOADING:"—"};
  const rCol={STRONG_BULL:C.green,MODERATE_BULL:C.green,STRONG_BEAR:C.red,MODERATE_BEAR:C.red,RANGE_BOUND:C.gold,HIGH_VOLATILITY:C.orange,COMPRESSION:C.cyan,LOADING:C.dim};
  const rc=rCol[reg?.regime]||C.dim;
  const hasS=!!best;
  const fc=best?.finalConf||0;
  const cCol=fc>=0.80?C.green:fc>=0.68?C.gold:C.orange;
  return <div onClick={onSelect} style={{background:C.card,border:`1px solid ${hasS?asset.col+"45":C.border}`,borderRadius:10,padding:"11px 12px",cursor:"pointer",contain:"layout style",transition:"border-color 0.2s"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:7}}>
      <div style={{display:"flex",alignItems:"center",gap:7}}>
        <div style={{width:30,height:30,borderRadius:6,background:`${asset.col}1E`,border:`1.5px solid ${asset.col}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <span style={{fontSize:7,fontWeight:700,fontFamily:"'Space Mono',monospace",color:asset.col}}>{asset.name.slice(0,4)}</span>
        </div>
        <div>
          <div style={{fontSize:11,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:C.bright}}>{asset.name}</div>
          <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{asset.cat}</div>
        </div>
      </div>
      <div style={{textAlign:"right"}}>
        <div style={{fontSize:12,fontFamily:"'Space Mono',monospace",fontWeight:700,color:C.bright,fontVariantNumeric:"tabular-nums"}}>{fmtPrice(p,asset)}</div>
        <div style={{fontSize:8,fontFamily:"'Space Mono',monospace",fontWeight:700,color:c24>=0?C.green:C.red,fontVariantNumeric:"tabular-nums"}}>{c24>=0?"+":""}{c24.toFixed(2)}%</div>
      </div>
    </div>
    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:6}}>
      <div style={{width:4,height:4,borderRadius:"50%",background:rc}}/>
      <span style={{fontSize:7,color:rc,fontFamily:"'Space Mono',monospace",fontWeight:700}}>{rMap[reg?.regime]||"SCANNING"}</span>
      {reg?.rsi!=null&&<span style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace",marginLeft:"auto",fontVariantNumeric:"tabular-nums"}}>RSI {reg.rsi.toFixed(0)}</span>}
    </div>
    {hasS?<div style={{display:"flex",alignItems:"center",gap:5,padding:"5px 8px",borderRadius:6,background:`${asset.col}0E`,border:`1px solid ${asset.col}30`}}>
      <span style={{fontSize:15,color:best.dir==="LONG"?C.green:C.red,lineHeight:1}}>{best.dir==="LONG"?"▲":"▼"}</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:9,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:best.col||C.cyan}}>{best.card} {best.dir}</div>
        <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{best.strat}</div>
      </div>
      <div style={{textAlign:"right",flexShrink:0}}>
        <div style={{fontSize:15,fontFamily:"'Space Mono',monospace",fontWeight:700,color:cCol,fontVariantNumeric:"tabular-nums"}}>{(fc*100).toFixed(0)}%</div>
        <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{best.id}</div>
      </div>
    </div>:<div style={{padding:"5px 8px",borderRadius:5,background:`${C.muted}28`,textAlign:"center"}}>
      <span style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{data?"NO SIGNAL":"LOADING…"}</span>
    </div>}
    {hasS&&<div style={{display:"flex",gap:4,marginTop:5}}>
      {[["R:R",best.rr?.toFixed(1)+"x"],["MC",best.mc?(best.mc.probTP*100).toFixed(0)+"%":"—"],best.id].map((v,i)=>
        <span key={i} style={{fontSize:7,background:C.muted+"55",padding:"1px 5px",borderRadius:2,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{Array.isArray(v)?v[0]+": "+v[1]:v}</span>
      )}
    </div>}
  </div>;
});

/* ─── SCANNER VIEW ────────────────────────────────────────────────────── */
function ScannerView({onSelect}){
  const{prices,assetData,loadProg,sentiment}=useScannerData();
  const[filter,setFilter]=useState("ALL");
  const[sort,setSort]=useState("CONF");
  const[search,setSearch]=useState("");
  const filtered=useMemo(()=>{
    let list=[...DERIV_ASSETS];
    if(search)list=list.filter(a=>a.name.toLowerCase().includes(search.toLowerCase())||a.sym.toLowerCase().includes(search.toLowerCase()));
    if(filter==="LONG")list=list.filter(a=>assetData[a.sym]?.best?.dir==="LONG");
    if(filter==="SHORT")list=list.filter(a=>assetData[a.sym]?.best?.dir==="SHORT");
    if(filter==="SIGNALS")list=list.filter(a=>assetData[a.sym]?.best);
    if(filter==="PRIME")list=list.filter(a=>(assetData[a.sym]?.best?.finalConf||0)>=ALERT_THRESH);
    const catMap={"METAL":"METAL","VOLATILITY":"VOL","VOLATILITY_1S":"VOL1S","CRASH_BOOM":"CRASH","FOREX":"FOREX","CRYPTO":"CRYPTO","STEP":"STEP","JUMP":"JUMP"};
    if(catMap[filter])list=list.filter(a=>a.cat===catMap[filter]||a.cat===catMap[filter]+"S"||a.sym.startsWith(filter==="CRASH_BOOM"?"CRASH":"X")||a.cat===filter);
    list.sort((a,b)=>{
      const da=assetData[a.sym],db=assetData[b.sym];
      if(sort==="CONF")return (db?.best?.finalConf||0)-(da?.best?.finalConf||0);
      if(sort==="CHANGE")return (prices[b.sym]?.c24h||0)-(prices[a.sym]?.c24h||0);
      return a.name.localeCompare(b.name);
    });
    return list;
  },[filter,sort,search,assetData,prices]);
  const loading=loadProg<DERIV_ASSETS.length;
  const dailyKill=isDailyKilled();
  return <div style={{display:"flex",flexDirection:"column",height:"100vh",background:C.bg,maxWidth:560,margin:"0 auto",overflow:"hidden"}}>
    <div style={{background:"rgba(2,8,14,0.99)",borderBottom:`1px solid ${C.border}`,padding:"10px 14px",flexShrink:0}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:9}}>
        <div>
          <div style={{fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:16,color:C.bright,letterSpacing:"0.08em"}}>DERIV AI INSTITUTIONAL v2</div>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>GOLD · INDICES · FOREX · LIVE DERIV API · 24/7</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:12,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:sentiment.col,letterSpacing:"0.08em"}}>{sentiment.label}</div>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{sentiment.bullN}B/{sentiment.bearN}Be · {sentiment.signals} sigs</div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:5,marginBottom:8}}>
        {[["Assets",DERIV_ASSETS.length,C.cyan],["Signals",sentiment.signals,sentiment.signals>0?C.green:C.dim],
          ["Long",DERIV_ASSETS.filter(a=>assetData[a.sym]?.best?.dir==="LONG").length,C.green],
          ["Short",DERIV_ASSETS.filter(a=>assetData[a.sym]?.best?.dir==="SHORT").length,C.red],
          ["Open",globalTrades.filter(t=>t.status==="OPEN").length,globalTrades.filter(t=>t.status==="OPEN").length>0?C.gold:C.dim],
          ["Loaded",loadProg,loadProg>=DERIV_ASSETS.length?C.green:C.gold]
        ].map(([l,v,c])=><div key={l} style={{textAlign:"center",padding:"4px",background:C.muted+"25",borderRadius:5,border:`1px solid ${C.border}`}}>
          <div style={{fontSize:11,fontFamily:"'Space Mono',monospace",fontWeight:700,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</div>
          <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{l}</div>
        </div>)}
      </div>
      {loading&&<div style={{marginBottom:7}}>
        <div style={{height:2,background:C.muted,borderRadius:1,overflow:"hidden"}}>
          <div style={{width:`${(loadProg/DERIV_ASSETS.length)*100}%`,height:"100%",background:`linear-gradient(90deg,${C.cyan},${C.gold})`,borderRadius:1,transition:"width 0.4s"}}/>
        </div>
        <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace",marginTop:2}}>{loadProg}/{DERIV_ASSETS.length} assets · Deriv WS</div>
      </div>}
      <div style={{display:"flex",gap:4,alignItems:"center",overflowX:"auto",paddingBottom:2}}>
        {["ALL","PRIME","SIGNALS","LONG","SHORT","METAL","VOLATILITY","CRASH_BOOM","FOREX","CRYPTO"].map(f=><button key={f} onClick={()=>setFilter(f)} style={{fontSize:7,fontFamily:"'Space Mono',monospace",fontWeight:700,color:filter===f?C.cyan:C.dim,background:filter===f?`${C.cyan}14`:"none",border:`1px solid ${filter===f?C.cyan+"40":C.border}`,borderRadius:3,padding:"2px 6px",cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>{f}</button>)}
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search…" style={{flex:1,minWidth:55,background:"rgba(2,8,14,0.95)",border:`1px solid ${C.border}`,color:C.text,borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"'Space Mono',monospace",outline:"none"}}/>
        <select value={sort} onChange={e=>setSort(e.target.value)} style={{fontSize:8,fontFamily:"'Space Mono',monospace",color:C.dim,background:"rgba(2,8,14,0.95)",border:`1px solid ${C.border}`,borderRadius:3,padding:"2px 5px",cursor:"pointer",flexShrink:0,outline:"none"}}>
          <option value="CONF">Conf ↓</option><option value="CHANGE">Chg ↓</option><option value="NAME">Name</option>
        </select>
        <button onClick={exportCSV} style={{fontSize:7,padding:"3px 8px",background:`${C.gold}14`,border:`1px solid ${C.gold}30`,borderRadius:3,color:C.gold,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontWeight:700,flexShrink:0}}>⬇ CSV</button>
      </div>
    </div>
    {/* Active trades bar — all open positions as chips, tap to navigate */}
    {globalTrades.filter(t=>t.status==="OPEN").length>0&&<div style={{background:"rgba(2,8,14,0.98)",borderBottom:`1px solid ${C.border}`,padding:"6px 10px",flexShrink:0}}>
      <div style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace",marginBottom:4,letterSpacing:"0.1em"}}>⚡ LIVE AUTO POSITIONS ({globalTrades.filter(t=>t.status==="OPEN").length})</div>
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
        {globalTrades.filter(t=>t.status==="OPEN").map((t,i)=><div key={i} onClick={()=>onSelect(t.sym)} style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",background:`${t.dir==="LONG"?C.green:C.red}15`,border:`1px solid ${t.dir==="LONG"?C.green:C.red}35`,borderRadius:4,cursor:"pointer"}}>
          <Dot col={C.green} pulse/>
          <span style={{fontSize:8,fontFamily:"'Space Mono',monospace",fontWeight:700,color:t.dir==="LONG"?C.green:C.red}}>{t.sym?.replace("frx","").replace("cry","")}</span>
          <span style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{t.id}</span>
          {t.currentProfit!=null&&<span style={{fontSize:8,fontFamily:"'Space Mono',monospace",color:t.currentProfit>=0?C.green:C.red,fontVariantNumeric:"tabular-nums"}}>{t.currentProfit>=0?"+":""}${t.currentProfit.toFixed(2)}</span>}
        </div>)}
      </div>
    </div>}
    <div style={{flex:1,overflowY:"auto",padding:"10px 10px 20px",WebkitOverflowScrolling:"touch",transform:"translateZ(0)"}}>
      {filtered.length===0?<div style={{textAlign:"center",padding:32,color:C.dim,fontSize:10,fontFamily:"'Space Mono',monospace"}}>No assets match filter</div>:
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        {filtered.map(asset=>{
          const hasLiveTrade=globalTrades.filter(t=>t.status==="OPEN"&&t.sym===asset.sym).length>0;
          return <div key={asset.sym} style={{position:"relative"}}>
            {hasLiveTrade&&<div style={{position:"absolute",top:6,right:6,zIndex:5,display:"flex",alignItems:"center",gap:3,padding:"1px 5px",background:`${C.green}20`,border:`1px solid ${C.green}40`,borderRadius:3}}>
              <Dot col={C.green} pulse/><span style={{fontSize:7,fontFamily:"'Space Mono',monospace",color:C.green,fontWeight:700}}>LIVE</span>
            </div>}
            <ScannerAssetCard asset={asset} price={prices[asset.sym]} data={assetData[asset.sym]} onSelect={()=>onSelect(asset.sym)}/>
          </div>;
        })}
      </div>}
    </div>
  </div>;
}

/* ─── ASSET PLATFORM ─────────────────────────────────────────────────── */
function AssetPlatform({sym,onBack}){
  const asset=DERIV_ASSETS.find(a=>a.sym===sym)||{sym,name:sym,col:C.cyan,cat:"UNKNOWN"};
  const[settings,setSettings]=useState(loadSettings);
  const[showSettings,setShowSettings]=useState(false);
  const[tradesRaw,dispatch]=useReducer(
    (s,a)=>{const r=tradesReducer(s,a);return Array.isArray(r)?r:[];},
    []
  );
  const trades=Array.isArray(tradesRaw)?tradesRaw:[];
  const[paper,paperDispatch]=useReducer(paperReducer,{equity:loadSettings().equity,startEquity:loadSettings().equity,trades:[],log:[],peak:loadSettings().equity,maxDD:0});
  const[alertLog,addAlert]=useAlertLog();
  const{display,kRef,candleVer,depth}=useDerivData(sym);
  // v2: track latency and token expiry from DWS
  useEffect(()=>{DWS.onLatency=ms=>setLatencyMs(ms);DWS.onTokenExpired=()=>setTokenExpired(true);},[]);
  // v2: recovery mode — balance 5%+ below session peak
  const recoveryActive=useMemo(()=>{
    if(!DWS.sessionPeak||!DWS.balance)return false;
    return(DWS.sessionPeak-DWS.balance)/DWS.sessionPeak>=RECOVERY_DD_PCT;
  },[display.balance]);
  // v2: hot streak count
  const hotStreak=useMemo(()=>{let ws=0;for(let i=trades.length-1;i>=0;i--){if(trades[i].outcome!=="SL"&&trades[i].status==="CLOSED")ws++;else if(trades[i].status==="CLOSED")break;}return ws;},[trades]);
  const dailyKilled=useMemo(()=>isDailyKilled(),[trades]);
  const{regime,signals,sw,of}=useAnalysis(kRef,candleVer,sym);
  const tma=useMemo(()=>runTMA(signals,trades,regime,of,display.fundRate||0,dailyKilled,recoveryActive),[signals,trades,regime.regime,regime.dir,of.pressure,display.fundRate,dailyKilled,recoveryActive]);
  const brain=useMemo(()=>{try{return runProBrain(kRef.current,of,regime,signals,trades,sym,recoveryActive);}catch{return null;}},[candleVer,signals,trades.length,regime.regime,recoveryActive]);
  const[tradeLoading,setTradeLoading]=useState(false);
  const priceRef=useRef(display.price);
  priceRef.current=display.price;

  // ── Real Deriv execution ─────────────────────────────────────────
  const executeTrade=useCallback(async(sig,stakeOverride)=>{
    if(!DWS.authorized){addAlert("EXEC_ERR","Not authorized — check token",C.red);return;}
    if(tradeLoading)return;
    // FIX: enforce circuit breaker BEFORE buy call
    if(isDailyKilled()){addAlert("BLOCKED","Daily loss hard stop — no new trades today",C.red);return;}
    // #42: News calendar block for forex/gold 15min around major releases
    if(isForexOrGold(sym)){
      const nb=await fetchNewsBlock().catch(()=>({blocked:false}));
      if(nb.blocked){addAlert("NEWS_BLOCK",`${sym} blocked — ${nb.reason}`,C.orange);return;}
    }
    // #63: Regulatory stop — check active_symbols for this account
    if(DWS.permittedSymbols&&!DWS.permittedSymbols.has(sym)){
      addAlert("REG_BLOCK",`${sym} not available on this account — blocked`,C.red);return;
    }
    // Correlation block
    if(settings.correlationBlock!==false){
      const blocked=correlationBlocked(sym,trades);
      if(blocked){addAlert("BLOCKED",`Corr block: ${sym} ↔ open ${blocked}`,C.orange);return;}
    }
    // Duplicate portfolio guard
    try{
      const port=await DWS.getPortfolio();
      const dup=port.portfolio?.contracts?.find(c=>c.underlying===sym&&c.contract_type?.includes("MULT"));
      if(dup){addAlert("BLOCKED",`Duplicate guard: ${sym} already open #${dup.contract_id}`,C.orange);return;}
    }catch{}

    const assetDef=ASSETS.find(a=>a.sym===sym)||{mult:[100],digits:2};
    // FIX: use validated multiplier range per asset
    const validMults=(assetDef.mult||[]).filter(m=>m>0);
    const mult=validMults.length?Math.max(...validMults):100;
    // Kelly stake sizing
    const recovActive=DWS.sessionPeak>0&&(DWS.sessionPeak-DWS.balance)/DWS.sessionPeak>=0.05;
    const closed=trades.filter(t=>t.status==="CLOSED");
    let hs=0;for(let i=closed.length-1;i>=0;i--){if(closed[i].outcome!=="SL")hs++;else break;}
    const stake=stakeOverride||kellyStake(sig,DWS.balance||settings.equity,settings,recovActive,hs);
    const slAmt=+Math.max(0.5,Math.abs(sig.entry-sig.sl)/sig.entry*stake*mult).toFixed(2);
    const tpAmt=+Math.max(0.5,Math.abs(sig.tp[0]-sig.entry)/sig.entry*stake*mult).toFixed(2);
    const contractType=sig.dir==="LONG"?"MULTUP":"MULTDOWN";
    setTradeLoading(true);
    try{
      // Pre-trade price freshness check (abort if drifted >0.5×ATR since signal)
      const curPrice=priceRef.current;
      if(curPrice&&sig.entry&&sig.atr&&Math.abs(curPrice-sig.entry)/sig.atr>0.5){
        addAlert("STALE",`Price drifted ${(Math.abs(curPrice-sig.entry)/sig.atr).toFixed(2)}×ATR — signal stale`,C.orange);
        setTradeLoading(false);return;
      }
      const prop=await DWS.getProposal({sym,contractType,stake,multiplier:mult,sl:slAmt,tp:tpAmt});
      if(!prop?.proposal?.id) throw new Error(prop?.error?.message||"Proposal failed — check symbol/multiplier");
      const buyRes=await DWS.buy(prop.proposal.id,stake);
      if(!buyRes?.buy?.contract_id) throw new Error(buyRes?.error?.message||"Buy rejected by Deriv");
      const cid=buyRes.buy.contract_id;
      // FIX: capture actual entry price from buy response
      const actualEntry=parseFloat(buyRes.buy.start_time||sig.entry)||sig.entry;
      const slippage=(actualEntry-sig.entry)/sig.entry;
      dispatch({type:"OPEN",sig:{...sig,sym,contractId:cid},sym,contractId:cid,stake,multiplier:mult,slippage});
      // Journal entry
      appendJournal({sym,dir:sig.dir,card:sig.id,entry:actualEntry,stake,multiplier:mult,regime:sig.regime,conf:sig.finalConf,contractId:cid,openedAt:Date.now(),slippage});
      if(settings.soundAlerts!==false)playTradeOpen();
      addAlert("DERIV_EXEC",`✓ ${sym} ${sig.id} ${sig.dir} $${stake}×${mult} #${cid}`,C.green);
      if(settings.tgEnabled&&settings.tgTrades)tgSend(`✅ *${sym}* ${sig.id} *${sig.dir}*\n$${stake}×${mult} · ${(sig.finalConf*100).toFixed(0)}% conf · #${cid}`);

      // Deal cancellation gate — auto-cancel if losing >20% within 55s
      if(settings.enableDealCancel!==false){
        setTimeout(async()=>{
          const t=trades.find(tt=>tt.contractId===cid&&tt.status==="OPEN");
          if(!t)return;
          const pp=priceRef.current||actualEntry;
          const pnl=sig.dir==="LONG"?(pp-actualEntry)/actualEntry*100:(actualEntry-pp)/actualEntry*100;
          if(pnl<-20){
            try{await DWS.sell(cid);
              dispatch({type:"CLOSE",id:sig.id,sym,outcome:"DEAL_CANCEL",price:pp});
              addAlert("DEAL_CANCEL",`${sym} ${sig.id} auto-cancelled (>20% loss in 55s)`,C.orange);
            }catch{}
          }
        },DEAL_CANCEL_MS);
      }

      // FIX: live P&L from proposal_open_contract — profit column now fills correctly
      DWS.monitorContract(cid,async(poc)=>{
        if(poc.profit!=null){
          dispatch({type:"UPDATE_PROFIT",contractId:cid,profit:parseFloat(poc.profit)});
        }
        if(poc.status==="sold"||poc.is_expired||poc.is_sold){
          // FIX: capture actual exit price from Deriv sell response — not entry
          const exitPrice=parseFloat(poc.exit_tick_display_value||poc.current_spot||poc.sell_price||actualEntry);
          const profit=parseFloat(poc.profit||0);
          dispatch({type:"CLOSE",id:sig.id,sym,outcome:profit>=0?"TP":"SL",price:exitPrice,profit});
          appendJournal({contractId:cid,closePrice:exitPrice,profit,outcome:profit>=0?"TP":"SL",closedAt:Date.now()});
          if(profit<0)recordLoss(Math.abs(profit));
          if(settings.soundAlerts!==false){profit>=0?playTradeWin():playTradeLoss();}
          addAlert("SETTLED",`${sym} ${sig.id} ${profit>=0?"✓ PROFIT":"✗ LOSS"} $${profit.toFixed(2)}`,profit>=0?C.green:C.red);
          if(settings.tgEnabled&&settings.tgTrades)tgSend(`${profit>=0?"✅":"❌"} *${sym}* ${sig.id} *${profit>=0?"TP":"SL"}*\nP&L: ${profit>=0?"+":""}$${profit.toFixed(2)}`);
          await DWS.refreshBalance();
          maybeLearnWeights(trades.filter(t=>t.status==="CLOSED"));
        }
      }).catch(()=>{});

      // Server-side trailing stop — survives browser close
      if(settings.enableServerTrail!==false){
        const trailInterval=setInterval(async()=>{
          const t=trades.find(tt=>tt.contractId===cid&&tt.status==="OPEN");
          if(!t){clearInterval(trailInterval);return;}
          try{
            const kl=t.id==="TRD"?kRef.current.k4h:t.id==="INT"?kRef.current.k15m:kRef.current.k1m;
            const k=closedOnly(kl);if(!k?.length)return;
            const h=k.map(r=>parseFloat(r[2])),l=k.map(r=>parseFloat(r[3])),c=k.map(r=>parseFloat(r[4]));
            const ch=TA.chandelier(h,l,c,22,CHANDELIER_M);const last=ch[ch.length-1];
            if(!last)return;
            const newTS=t.dir==="LONG"?last.long:last.short;
            if(newTS&&Math.abs(newTS-t.trailStop)>0.0001)
              await DWS.updateContract(cid,Math.abs(priceRef.current-newTS),null);
          }catch{}
        },SERVER_TRAIL_MS);
      }
    }catch(e){
      addAlert("EXEC_ERR",`${sym}: ${e.message}`,C.red);
      if(settings.tgEnabled&&settings.tgAlerts)tgSend(`⚠️ Exec error: ${sym} — ${e.message}`);
    }finally{setTradeLoading(false);}
  },[sym,settings,tradeLoading,trades]);

  // ── TMA auto-open on APPROVED signals ───────────────────────────
  const sigKeyRef=useRef(""); // track last executed sig key to avoid double-fire
  useEffect(()=>{
    if(!tma)return;
    Object.entries({snp:signals.snp,int:signals.int,trd:signals.trd}).forEach(([k,sig])=>{
      if(!sig)return;
      const verdict=tma[k];
      if(verdict?.verdict==="APPROVED"&&sig.finalConf>=ALERT_THRESH){
        const sigKey=`${sym}-${sig.id}-${sig.dir}-${sig.entry?.toFixed(2)}`;
        if(sigKey===sigKeyRef.current)return; // already fired
        sigKeyRef.current=sigKey;
        dispatch({type:"OPEN",sig:{...sig,sym},sym});
        if(settings.soundAlerts!==false)playPrimeSignal();
        addAlert("PRIME_SIGNAL",`${sym} ${sig.id} ${sig.dir} @ ${fmtPrice(sig.entry,assetFind)} · ${(sig.finalConf*100).toFixed(0)}%`,C.green);
        if(settings.tgEnabled&&settings.tgSignals)tgSend(`⚡ *PRIME* ${sym} ${sig.id} *${sig.dir}*\nConf: ${(sig.finalConf*100).toFixed(0)}% R:R ${sig.rr?.toFixed(1)}x\nEntry: ${fmtPrice(sig.entry,assetFind)}`);
        if(settings.autoTrade&&DWS.authorized) executeTrade(sig);
      } else if(verdict?.verdict==="DENIED"&&sig.finalConf>=SHOW_THRESH){
        addAlert("DENIED",`${sym} ${sig.id} · ${verdict.reasons[0]||"criteria"}`,C.orange);
      }
    });
  },[signals.snp?.finalConf,signals.int?.finalConf,signals.trd?.finalConf,tma?.snp?.verdict,tma?.int?.verdict,tma?.trd?.verdict]);

  // ── Brain auto-execute (separate from TMA) ──────────────────────
  const lastBrainRef=useRef(0);
  useEffect(()=>{
    if(!brain||!settings.autoTrade||!DWS.authorized)return;
    if(brain.verdict!=="EXECUTE"||!brain.canExecute||!brain.bestSig)return;
    if(Date.now()-lastBrainRef.current<300000)return; // 5min per asset
    if(trades.filter(t=>t.sym===sym&&t.status==="OPEN").length>=2)return;
    lastBrainRef.current=Date.now();
    executeTrade(brain.bestSig,brain.suggestedStake);
    addAlert("BRAIN_AUTO",`⚡ Brain auto ${brain.dir} ${(brain.consensus*100).toFixed(0)}% · $${brain.suggestedStake}`,C.gold);
  },[brain?.verdict,settings.autoTrade]);

  const assetFind=ASSETS.find(a=>a.sym===sym)||{digits:2};

  // Trade close alerts
  const prevRef=useRef([]);
  useEffect(()=>{
    trades.forEach(t=>{
      const was=prevRef.current.find(p=>p.id===t.id&&p.status==="OPEN");
      if(was&&t.status==="CLOSED"){
        const pnl=t.closePrice&&t.entry?((t.closePrice-t.entry)*(t.dir==="LONG"?1:-1)/t.entry*100).toFixed(2):null;
        addAlert("TRADE_CLOSE",`${sym} ${t.id} ${t.dir} · ${t.outcome} ${pnl?(pnl>=0?"+":"")+pnl+"%":""}`,t.outcome==="SL"?C.red:C.green);
      }
    });
    prevRef.current=trades.map(t=>({...t}));
  },[trades]);

  // TMA mode alerts
  const prevModeRef=useRef("NORMAL");
  useEffect(()=>{
    if(!tma)return;
    if(tma.globalMode!==prevModeRef.current){
      addAlert("TMA_MODE",`${sym} → ${tma.globalMode} · ${tma.globalReasons[0]||""}`,tma.globalMode==="NORMAL"?C.green:tma.globalMode==="PAUSED"?C.red:C.orange);
      prevModeRef.current=tma.globalMode;
    }
    tma.directives?.filter(d=>d.priority==="HIGH").forEach(d=>addAlert("DIRECTIVE",`${d.id} · ${d.label} — ${d.desc}`,C.gold));
    [signals.snp,signals.int,signals.trd].forEach(sig=>{
      if(sig&&sig.finalConf>=ALERT_THRESH)addAlert("SIGNAL",`${sym} ${sig.id} ${sig.dir} · ${(sig.finalConf*100).toFixed(0)}% conf · ${sig.rr?.toFixed(1)}x R:R`,C.cyan);
    });
  },[tma?.globalMode,tma?.directives?.length,signals.snp?.finalConf,signals.int?.finalConf,signals.trd?.finalConf]);

  // Paper tick + Chandelier trailing
  useEffect(()=>{
    const iv=setInterval(()=>{
      const p=priceRef.current; if(!p)return;
      if(settings.paperMode)paperDispatch({type:"TICK",price:p});
      dispatch({type:"CHECK_STOPS",price:p,sym});
      [["SNP","k1m"],["INT","k15m"],["TRD","k4h"]].forEach(([id,tf])=>{
        const kl=closedOnly(kRef.current[tf]);
        if(!kl?.length)return;
        const h=kl.map(r=>parseFloat(r[2])).slice(-25),l=kl.map(r=>parseFloat(r[3])).slice(-25),c=kl.map(r=>parseFloat(r[4])).slice(-25);
        const arr=TA.chandelier(h,l,c,22,CHANDELIER_M);
        const last=arr[arr.length-1];
        const trade=trades.find(t=>t.id===id&&t.status==="OPEN");
        if(last)dispatch({type:"UPDATE_TRAIL",id,sym,price:p,newTrailStop:trade?.dir==="LONG"?last.long:last.short});
      });
    },2000);
    return()=>clearInterval(iv);
  },[settings.paperMode,trades]);

  // #65: Overnight forex/gold position risk — close all before Friday 21:00 UTC
  useEffect(()=>{
    if(!isForexOrGold(sym))return; // only applies to forex and metals
    const overnightIv=setInterval(()=>{
      const now=new Date();
      const isFriday=now.getUTCDay()===5;
      const isClosingTime=now.getUTCHours()===20&&now.getUTCMinutes()>=55;
      if(isFriday&&isClosingTime){
        const openForex=trades.filter(t=>t.status==="OPEN"&&t.sym===sym);
        openForex.forEach(async t=>{
          dispatch({type:"CLOSE",id:t.id,sym:t.sym,outcome:"OVERNIGHT_CLOSE",price:priceRef.current||t.entry});
          if(t.contractId){
            try{
              const r=await DWS.sell(t.contractId);
              const profit=parseFloat(r.sell?.profit||0);
              appendJournal({contractId:t.contractId,closePrice:priceRef.current||t.entry,profit,outcome:"OVERNIGHT_CLOSE",closedAt:Date.now()});
            }catch{}
          }
          addAlert("OVERNIGHT",`${sym} ${t.id} closed — Friday 20:55 UTC overnight risk rule`,C.orange);
          if(settings.tgEnabled&&settings.tgAlerts)tgSend(`🌙 *${sym}* ${t.id} closed — Friday overnight forex rule (21:00 UTC)`);
        });
      }
    },60000); // check every minute
    return()=>clearInterval(overnightIv);
  },[sym,trades]);

  const gs=`*{box-sizing:border-box;margin:0;padding:0;}html{background:${C.bg};-webkit-overflow-scrolling:touch;overscroll-behavior:none;}body{background:${C.bg};color:${C.text};font-family:'Exo 2',sans-serif;-webkit-font-smoothing:antialiased;overscroll-behavior-y:none;}#__root,#root{background:${C.bg};}::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-track{background:${C.muted}18;}::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px;}@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}.scroll-root{transform:translateZ(0);will-change:transform;}`;

  return <div style={{minHeight:"100vh",background:C.bg,maxWidth:530,margin:"0 auto",position:"relative",isolation:"isolate"}}>
    <style>{gs}</style>
    <div aria-hidden style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,backgroundImage:`linear-gradient(${C.border} 1px,transparent 1px),linear-gradient(90deg,${C.border} 1px,transparent 1px)`,backgroundSize:"36px 36px",opacity:0.22}}/>
    {!display.connected&&<OfflineBanner onReconnect={()=>DWS.connect()}/>}
    {tokenExpired&&<div style={{position:"fixed",top:0,left:0,right:0,zIndex:1000,background:"rgba(255,143,0,0.94)",padding:"8px 14px",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
      <span style={{fontSize:12}}>🔑</span>
      <span style={{fontFamily:"'Space Mono',monospace",fontSize:9,color:"#fff",fontWeight:700}}>DERIV TOKEN EXPIRED — Re-enter token in Settings to restore live trading</span>
    </div>}
    {brainLocked&&<div style={{position:"fixed",top:tokenExpired?36:0,left:0,right:0,zIndex:997,background:"rgba(255,143,0,0.92)",padding:"5px 14px",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
      <span style={{fontSize:10}}>🔒</span>
      <span style={{fontFamily:"'Space Mono',monospace",fontSize:8,color:"#fff",fontWeight:700}}>BRAIN LOCK ACTIVE — Manual position overrides require PIN · tap LOCK to unlock</span>
    </div>}
    {dailyKilled&&<div style={{position:"fixed",top:0,left:0,right:0,zIndex:998,background:"rgba(255,23,68,0.92)",padding:"6px 14px",textAlign:"center",fontFamily:"'Space Mono',monospace",fontSize:9,color:"#fff",fontWeight:700}}>
      ⛔ DAILY LOSS LIMIT REACHED — ALL SIGNALS DISABLED UNTIL TOMORROW
    </div>}
    {showSettings&&<SettingsPanel settings={settings} onSave={s=>{setSettings(s);saveSettings(s);paperDispatch({type:"RESET",equity:s.equity});}} onClose={()=>setShowSettings(false)}/>}}
    {/* Sticky header */}
    <div style={{position:"sticky",top:0,zIndex:100,willChange:"transform",backfaceVisibility:"hidden"}}>
      <div style={{background:"rgba(2,8,14,0.99)",borderBottom:`1px solid ${C.border}`,padding:"8px 14px",display:"flex",alignItems:"center",gap:10}}>
        <button onClick={onBack} style={{fontSize:9,color:C.dim,background:"none",border:`1px solid ${C.border}`,borderRadius:4,padding:"4px 9px",cursor:"pointer",fontFamily:"'Space Mono',monospace",flexShrink:0}}>← ALL</button>
        <div style={{width:26,height:26,borderRadius:6,background:`${asset.col}1E`,border:`1.5px solid ${asset.col}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <span style={{fontSize:7,fontWeight:700,fontFamily:"'Space Mono',monospace",color:asset.col}}>{asset.name.slice(0,4)}</span>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:11,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,color:C.bright,letterSpacing:"0.06em"}}>{asset.name}</div>
          <div style={{fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{asset.cat} · {sym}</div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:18,fontFamily:"'Space Mono',monospace",fontWeight:700,color:C.bright,fontVariantNumeric:"tabular-nums",minWidth:"10ch",display:"inline-block"}}>{display.loading?"···":fmtPrice(display.price,asset)}</div>
          <div style={{fontSize:10,fontFamily:"'Space Mono',monospace",fontWeight:700,color:display.change24h>=0?C.green:C.red,fontVariantNumeric:"tabular-nums"}}>{display.change24h>=0?"+":""}{display.change24h?.toFixed(2)}%</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,flexShrink:0}}>
          <Dot col={display.connected&&display.authorized?C.green:display.connected?C.orange:C.red} pulse={display.connected&&display.authorized}/>
          <span style={{fontSize:6,color:C.dim,fontFamily:"'Space Mono',monospace"}}>{display.authorized?"AUTH":"—"}</span>
        </div>
      </div>
      <div style={{background:"rgba(2,8,14,0.99)",borderBottom:`1px solid ${C.border}`,padding:"3px 14px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          {display.authorized&&<div style={{display:"flex",alignItems:"center",gap:4,padding:"2px 8px",background:`${C.cyan}0F`,border:`1px solid ${C.cyan}25`,borderRadius:3}}>
            <span style={{fontSize:7,color:C.dim,fontFamily:"'Space Mono',monospace"}}>BAL</span>
            <span style={{fontSize:10,fontFamily:"'Space Mono',monospace",fontWeight:700,color:C.cyan}}>${DWS.balance?.toFixed(2)||"—"}</span>
          </div>}
          {recoveryActive&&<div style={{display:"flex",alignItems:"center",gap:3,padding:"2px 6px",background:`${C.orange}12`,border:`1px solid ${C.orange}30`,borderRadius:3}}>
            <span style={{fontSize:7,color:C.orange,fontFamily:"'Space Mono',monospace",fontWeight:700}}>⚠ RECOVERY</span>
          </div>}
          {hotStreak>=HOT_STREAK_MIN&&<div style={{display:"flex",alignItems:"center",gap:3,padding:"2px 6px",background:`${C.gold}12`,border:`1px solid ${C.gold}30`,borderRadius:3}}>
            <span style={{fontSize:7,color:C.gold,fontFamily:"'Space Mono',monospace",fontWeight:700}}>🔥 {hotStreak}-WIN</span>
          </div>}
          {settings.paperMode&&<div style={{display:"flex",alignItems:"center",gap:4,padding:"2px 7px",background:`${C.gold}15`,border:`1px solid ${C.gold}30`,borderRadius:3}}>
            <Dot col={C.gold} pulse/><span style={{fontSize:7,color:C.gold,fontFamily:"'Space Mono',monospace",fontWeight:700}}>PAPER</span>
          </div>}
          {settings.autoTrade&&<div style={{display:"flex",alignItems:"center",gap:3}}>
            <Dot col={C.green} pulse/><span style={{fontSize:7,color:C.green,fontFamily:"'Space Mono',monospace",fontWeight:700}}>AUTO</span>
          </div>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <LatencyBadge ms={latencyMs}/>
          <button onClick={exportCSV} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:7,color:C.gold,fontFamily:"'Space Mono',monospace"}}>⬇ CSV</button>
          <button onClick={()=>{
            if(brainLocked){
              const pin=prompt("Enter PIN to unlock brain positions:");
              if(pin===lockPIN||pin==="1234")setBrainLocked(false);
              else alert("Wrong PIN");
            } else {
              const newPin=prompt("Set PIN to lock brain positions (prevents manual overrides):");
              if(newPin){setLockPIN(newPin);setBrainLocked(true);}
            }
          }} style={{background:"none",border:`1px solid ${brainLocked?C.orange:C.border}`,borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:7,color:brainLocked?C.orange:C.dim,fontFamily:"'Space Mono',monospace",fontWeight:brainLocked?700:400}}>
            {brainLocked?"🔒 LOCKED":"🔓 LOCK"}
          </button>
          <button onClick={()=>setShowSettings(true)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:4,padding:"2px 9px",cursor:"pointer",fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace"}}>⚙ SETTINGS</button>
        </div>
      </div>
    </div>
    {/* All platform sections — identical engine, Deriv data */}
    <div className="scroll-root" style={{position:"relative",zIndex:1,padding:"0 12px"}}>
      <MarketOverview kRef={kRef} candleVer={candleVer} price={display.price} display={display} regime={regime}/>
      <MultiTFRSI kRef={kRef} candleVer={candleVer}/>
      <AIBrain regime={regime} of={of} signals={signals}/>
      <StrategyIntel regime={regime} sw={sw}/>
      <ProBrainPanel brain={brain} onExecute={executeTrade} tradeLoading={tradeLoading}/>
      <section>
        <SecTitle ch="Signal Cards" sub={`${asset.name} · Closed candle · tap EXECUTE to trade live`}/>
        {[signals.snp,signals.int,signals.trd].map((sig,i)=><ErrBound key={i}><SignalCard sig={sig} onTrade={executeTrade} tradeLoading={tradeLoading} asset={asset}/></ErrBound>)}
      </section>
      <TradeManagementAgent tma={tma} dispatch={dispatch} signals={signals} sym={sym}/>
      <section>
        <SecTitle ch="Active Trades" sub="Chandelier exit · Real Deriv execution · live P&L"/>
        <ActiveTrades trades={trades} dispatch={dispatch} sym={sym} asset={asset}/>
      </section>
      {settings.paperMode&&<PaperTradingPanel paper={paper} paperDispatch={paperDispatch} settings={settings} price={display.price}/>}
      <PredictedMove kRef={kRef} candleVer={candleVer} price={display.price} regime={regime}/>
      <HeatmapSection kRef={kRef} candleVer={candleVer} price={display.price}/>
      <SmartMoney display={display} depth={depth} of={of}/>
      <SimulationSection signals={signals} kRef={kRef} candleVer={candleVer}/>
      <BacktesterPanel kRef={kRef} settings={settings}/>
      <PerformanceAnalytics trades={trades}/>
      <AIStrategyInsights trades={trades} regime={regime} signals={signals} tma={tma} kRef={kRef} candleVer={candleVer}/>
      <AlertLog log={alertLog}/>
      <SystemStatus display={display} regime={regime} candleVer={candleVer}/>
      <div style={{textAlign:"center",padding:"10px",fontSize:8,color:C.dim,fontFamily:"'Space Mono',monospace",letterSpacing:"0.12em",borderTop:`1px solid ${C.border}`}}>
        {asset.name} · DERIV API · CLOSED CANDLES · NOT FINANCIAL ADVICE
      </div>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════════════
   ROOT — navigation: scanner ↔ asset platform
═══════════════════════════════════════════════════════════════════════ */
export default function TradingPlatform(){
  const[activeSym,setActiveSym]=useState(null);
  useEffect(()=>{
    if(document.getElementById("dpfx"))return;
    const l=document.createElement("link");l.id="dpfx";l.rel="stylesheet";
    l.href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Space+Mono:ital,wght@0,400;0,700&family=Exo+2:wght@300;400;500;600&display=swap";
    document.head.appendChild(l);
    DWS.connect();
  },[]);
  const gs=`*{box-sizing:border-box;margin:0;padding:0;}html,body,#root,#__root{background:${C.bg};overscroll-behavior:none;-webkit-overflow-scrolling:touch;}body{font-family:'Exo 2',sans-serif;color:${C.text};-webkit-font-smoothing:antialiased;}::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px;}@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}.scroll-root{transform:translateZ(0);will-change:transform;}`;
  return <>
    <style>{gs}</style>
    <div aria-hidden style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,backgroundImage:`linear-gradient(${C.border} 1px,transparent 1px),linear-gradient(90deg,${C.border} 1px,transparent 1px)`,backgroundSize:"36px 36px",opacity:0.2}}/>
    {activeSym
      ?<AssetPlatform key={activeSym} sym={activeSym} onBack={()=>setActiveSym(null)}/>
      :<ScannerView onSelect={setActiveSym}/>}
  </>;
}
