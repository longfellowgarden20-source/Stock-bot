# Qwen3-Coder Self-Hosting Analysis for Stock-Bot

**Should you self-host Qwen3-Coder alongside Groq + Haiku?**

---

## **The Real Economics**

### **Current Setup (Haiku + Groq)**
```
Monthly cost:
- Haiku API: $3
- Groq API: $5
- Railway workers: $80
- Supabase: Free tier
Total: $88/mo

Per-trade cost: $0.04
Per reasoning call: $0.02
```

### **With Self-Hosted Qwen**
```
One-time cost:
- GPU hardware: $600-1600 (RTX 4070 - RTX 4090)
- Inference setup (vLLM/sglang): $0 (open source)

Monthly cost:
- Electricity (GPU idle): $20-50/mo
- GPU rental (cloud backup): $0 (optional)
- Haiku API: $3 (keep for fast tasks)
- Groq API: $5 (keep as fallback)
- Railway: $80
- Supabase: Free
Total: $108-135/mo

Per-trade cost: $0.04 (same, but GPU amortized)
Per reasoning call: $0 (from hardware cost)

Hardware amortization: $600 / 24 months = $25/mo
Effective monthly: $108-135/mo + $25 (amortization) = $133-160/mo
```

---

## **Wait — That's MORE Expensive**

**But there's a hidden benefit:** Qwen gets BETTER with scale.

### **If You Scale to 10 Agents (Future)**

```
Current (Groq only):
- 10 agents × 20 trades/month × $0.02 = $4/mo per agent
- Total: $40/mo + infrastructure

With self-hosted Qwen:
- 10 agents × reasoning for free (one GPU handles all)
- Groq only as fallback
- Electricity: $25-50/mo
- Haiku: $3
- Groq: $2 (backup only)
Total: $30-60/mo

Savings: $0-10/mo... but GPU still costs $25/mo amortized
= Net cost almost same, but WAY more capacity
```

---

## **The Real Question: Why Self-Host Qwen?**

### **Reason 1: Avoid Rate Limits**
- Groq free tier: 10,000 req/day
- Your agents today: ~20 reasoning calls/day (safe)
- Your agents tomorrow with universal factory: ~1000/day (will hit limit)
- **Self-hosted Qwen = unlimited reasoning calls**
- **Groq remains fallback**

### **Reason 2: Lower Cost at Scale**
- Today: Groq $5/mo for 20 calls/day = expensive per-call
- At scale: 1000 calls/day = Groq unaffordable
- Self-hosted Qwen = flat $25-50/mo no matter how many calls
- **Breakeven: ~500 reasoning calls/day**

### **Reason 3: Customization**
- Open source = fine-tune on your trading data
- Track Qwen's confidence calibration (like you do with Groq)
- Adapt model to your specific entry/exit patterns
- Proprietary APIs can't do this

---

## **Architecture: Qwen as Primary Reasoner**

**Current (Groq reasoning + Haiku output):**
```
Trade Signal
  ↓
Groq (reasoning, $0.02) — "Should we enter?"
  ↓
Haiku (output, $0.001) — "Generate trade"
  ↓
Trade
```

**New (Qwen reasoning + Groq fallback + Haiku output):**
```
Trade Signal
  ↓
Qwen local (reasoning, $0) — "Should we enter?" [FAST PATH]
  ↓
Haiku (output, $0.001) — "Generate trade"
  ↓
Trade

[FALLBACK if Qwen fails or overloaded]
  ↓
Groq (reasoning, $0.02) — Same prompt
  ↓
Haiku (output, $0.001)
```

**Cost change:**
- Fast path (90% of trades): $0.001 (Haiku only)
- Fallback (10% of trades): $0.021 (Groq + Haiku)
- **Average: $0.003/trade (vs $0.021 today)**
- **But add GPU cost: $25-50/mo**

---

## **When This Makes Sense**

### **Scenario 1: You Have Spare GPU (RTX 4070 sitting unused)**
✅ **DO IT**
- Hardware: Free (already owned)
- Electricity: $20-30/mo
- Setup time: 4-6 hours (one-time)
- Result: $0.003/trade instead of $0.04
- **ROI: Positive immediately**

### **Scenario 2: Universal Factory with 10+ Projects**
✅ **WORTH IT**
- 10 projects × 20 trades/month = 200 trades
- Current cost: $8/mo (Groq) + $3/mo (Haiku)
- With Qwen: $3 (Haiku) + $50 (GPU) + $5 (Groq backup)
- Savings: $3/mo, but capacity = unlimited
- At 1000 trades/month: saves $40/mo
- **Breakeven around month 8-12**

### **Scenario 3: You Have Cloud GPU Budget ($50-100/mo)**
✅ **WORTH IT (Better than Groq)**
- Paperspace/RunPod: $40-60/mo for RTX 4080
- Unlimited Qwen inference
- Plus Groq ($5) as backup
- Total: $60-65/mo
- **Same cost as current Groq, but unlimited capacity**

### **Scenario 4: Stock-Bot Alone (No Universal Factory)**
❌ **NOT WORTH IT**
- 20 trades/month
- Current cost: $8/mo
- With Qwen hardware: $25-50/mo + setup
- Payback period: 3-6 months minimum
- Risk: Hardware fails, maintenance burden
- **Skip it for trading-only setup**

---

## **The Setup (If You Do It)**

### **Step 1: Install vLLM (Open Source Inference)**
```bash
# On your server or GPU instance
pip install vllm

# Start Qwen3-Coder-30B (smaller, faster version)
vllm serve Qwen/Qwen3-Coder-30B \
  --tensor-parallel-size 1 \
  --gpu-memory-utilization 0.8
```

### **Step 2: Wire Into Reasoning Worker**
```python
# workers/reasoning_worker.py

async def decide_entry_with_qwen(ticker, signals, account):
    """
    Try local Qwen first (free).
    Fallback to Groq if Qwen fails or overloaded.
    """
    prompt = f"""
    Analyze entry for {ticker}:
    Signals: {signals}
    Market regime: {market_regime}
    
    Output JSON: {{"enter": bool, "conviction": int}}
    """
    
    try:
        # LOCAL QWEN (vLLM endpoint)
        reasoning = await call_local_qwen(
            prompt, 
            url="http://localhost:8000/v1/chat/completions"
        )
        log.info(f"Used Qwen for {ticker}")
        return reasoning
    
    except (TimeoutError, ConnectionError):
        # FALLBACK TO GROQ
        log.warning(f"Qwen unavailable, using Groq fallback")
        reasoning = await call_groq_extended_thinking(prompt)
        return reasoning
```

### **Step 3: Cost Tracking**
```python
# Track which model was used
qwen_decisions = 0  # Free
groq_fallbacks = 0  # $0.02 each

# Monthly cost
groq_cost = groq_fallbacks * 0.02
gpu_cost = 25 + (electricity / month)
total = groq_cost + gpu_cost

log.info(f"Qwen: {qwen_decisions}, Groq fallback: {groq_fallbacks}, Cost: ${total:.2f}")
```

---

## **Risk Assessment**

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| GPU fails | 2% | Complete outage | Groq fallback handles it |
| Qwen inference crashes | 5% | Slow response | Auto-restart vLLM, use Groq |
| Out of GPU memory | 3% | OOM errors | Reduce batch size, use smaller model |
| Electricity spike | 1% | Unexpected cost | Budget $50/mo, monitor usage |
| Setup complexity | 20% | Time waste | Use Docker, copy our config |

**All have fallbacks. Groq handles any failure.**

---

## **Recommendation by Scenario**

### **If You're Stock-Bot Only (Today)**
**Keep current setup (Haiku + Groq)**
- Cost: $8/mo + $80 infrastructure
- Complexity: Zero
- Quality: 95%+
- Speed: Instant
- Don't self-host yet

### **If You're Building Universal Factory (Next 3 Months)**
**Add self-hosted Qwen when you have:**
1. 10+ agents running regularly
2. $50-100/mo GPU budget
3. Spare time for setup (4-6 hours)

**Then:**
- Keep Haiku ($3/mo) for code gen
- Keep Groq ($5/mo) for fallback
- Add Qwen local ($50/mo GPU) for reasoning
- Total: $58/mo (vs $8 today, but 10x capacity)

### **If You Have Spare GPU Hardware**
**Do it immediately**
- Zero hardware cost
- Just electricity ($20-30/mo)
- Setup time: 4-6 hours
- Immediate ROI

---

## **The Honest Truth**

**You asked: "Wouldn't Qwen be an upgrade even if it just works alongside Groq?"**

**Answer:**
- ✅ **Yes, technically.** Qwen + Groq + Haiku = best quality + unlimited capacity
- ✅ **But only if you're scaling.** For stock-bot alone, not worth the complexity
- ✅ **Sweet spot: When you have 10+ agents** (universal factory at scale)
- ❌ **If you're just trading:** Keep Groq, skip the hardware investment

**The upgrade cost is real:**
- Hardware: $600-1600 upfront OR $50/mo cloud GPU
- Maintenance: Monitoring, updates, troubleshooting
- Complexity: vLLM setup, Docker, networking

**But the benefit is huge IF you scale:**
- Unlimited reasoning calls ($0 after GPU paid off)
- Better quality (Qwen learns your patterns)
- Full control (no vendor lock-in)

---

## **Next Steps**

**Phase 1 (Now): Skip self-hosting**
- Stock-bot uses Haiku + Groq (proven, simple)
- Keep it working

**Phase 2 (Month 3): Evaluate for universal factory**
- How many agents running?
- How many reasoning calls/day?
- Is Groq hitting rate limits?
- Then decide: self-host or pay cloud

**Phase 3 (Month 6+): Deploy Qwen if warranted**
- If universal factory has 10+ projects
- If reasoning calls exceed 500/day
- Then: Cloud GPU ($50/mo) + local Qwen fallback

---

## **Files to Keep Handy**

When you do self-host:
- `HYBRID_AGENT_ARCHITECTURE.md` (reasoning + output pattern)
- Docker config for vLLM
- Fallback logic (Qwen → Groq)
- Cost tracking dashboard

For now: Just document the plan, keep using Groq.
