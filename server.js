require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// ─── CORS ───
app.use(cors({ origin: true, credentials: true }));

// ─── Health checks ───
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    stripe: !!process.env.STRIPE_SECRET_KEY,
    paypal: !!process.env.PAYPAL_CLIENT_ID,
    paymob: !!process.env.PAYMOB_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY
  });
});

// ═════════════════════════════════════════════
//  STRIPE WEBHOOK (raw body BEFORE express.json)
// ═════════════════════════════════════════════

const stripe = (() => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.includes('your_stripe') || key === 'sk_test_placeholder') return null;
  return require('stripe')(key);
})();

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret || secret === 'whsec_your_webhook_secret') {
    if (process.env.NODE_ENV === 'production') return res.status(400).send('Webhook secret not configured');
    try {
      handleStripeEvent(JSON.parse(req.body.toString()));
      return res.json({ received: true, verified: false });
    } catch (e) { return res.status(400).send('Invalid payload'); }
  }

  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, secret); }
  catch (err) { return res.status(400).send(`Signature verification failed: ${err.message}`); }

  handleStripeEvent(event);
  res.json({ received: true, verified: true });
});

function handleStripeEvent(event) {
  console.log(`📨 Stripe: ${event.type}`);
  const map = {
    'checkout.session.completed': (data) => {
      const id = data.client_reference_id || data.metadata?.clientId;
      const tier = data.metadata?.tier || 'pro';
      if (id) { const u = getUsage(id); u.tier = tier; u.count = 0; }
    },
    'payment_intent.succeeded': (data) => {
      const id = data.metadata?.clientId;
      if (id) { const u = getUsage(id); u.tier = data.metadata?.tier || 'pro'; u.count = 0; }
    },
    'payment_intent.payment_failed': (data) => {
      console.error(`❌ Payment failed: ${data.id} - ${data.last_payment_error?.message}`);
    },
    'customer.subscription.deleted': (data) => {
      const id = data.metadata?.clientId;
      if (id) { const u = getUsage(id); u.tier = 'free'; u.count = 0; }
    }
  };
  const handler = map[event.type];
  if (handler) handler(event.data.object);
}

// ═════════════════════════════════════════════
//  GLOBAL MIDDLEWARE
// ═════════════════════════════════════════════

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ═════════════════════════════════════════════
//  AI PROVIDERS
// ═════════════════════════════════════════════

const AI_PROVIDERS = {
  gemini: {
    name: 'Google Gemini',
    apiKey: process.env.GEMINI_API_KEY,
    model: 'gemini-2.0-flash',
    icon: '✨',
    type: 'gemini'
  },
  openai: {
    name: 'ChatGPT (OpenAI)',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    icon: '🤖',
    type: 'openai'
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    apiKey: process.env.OPENROUTER_API_KEY,
    icon: '🌐',
    type: 'openai'
  }
};

const defaultProvider = 'openrouter';

function createAIClient(providerKey) {
  const cfg = AI_PROVIDERS[providerKey];
  if (!cfg) return null;
  if (!cfg.apiKey || cfg.apiKey.includes('your_') || cfg.apiKey.startsWith('sk_placeholder')) return null;

  if (cfg.type === 'gemini') {
    const genAI = new GoogleGenerativeAI(cfg.apiKey);
    return { type: 'gemini', model: genAI.getGenerativeModel({ model: cfg.model }) };
  }

  if (cfg.type === 'openai') {
    return {
      type: 'openai',
      model: cfg.model,
      client: new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })
    };
  }

  return null;
}

async function generateWithProvider(client, systemPrompt, userPrompt) {
  if (client.type === 'gemini') {
    const result = await client.model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }
      ],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2000 }
    });
    return result.response.text();
  }

  if (client.type === 'openai') {
    const completion = await client.client.chat.completions.create({
      model: client.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });
    return completion.choices[0].message.content;
  }

  throw new Error('Unknown AI provider type');
}

// ─── Usage tracking ───
const usage = {};
const ipUsageCount = {};
const LIMITS = { free: 5, pro: Infinity, vip: Infinity };

function getUsage(clientId, ip) {
  const primaryId = clientId || ip || 'anonymous';
  if (!usage[primaryId]) usage[primaryId] = { count: 0, tier: 'free', aiProvider: 'openrouter', ip };
  // Track by IP too as second layer
  if (ip && !ipUsageCount[ip]) ipUsageCount[ip] = { count: 0, tier: 'free' };
  return usage[primaryId];
}

function canUseFree(clientId, ip) {
  // Check client-based limit
  const primaryId = clientId || ip || 'anonymous';
  const u = usage[primaryId];
  if (!u || u.tier !== 'free') return true;
  if (u.count < LIMITS.free) return true;

  // Second layer: check IP-based limit (prevents clientId reset bypass)
  if (ip && ipUsageCount[ip]) {
    if (ipUsageCount[ip].count >= LIMITS.free + 3) return false; // slightly generous for IP
  }
  return true;
}

const STRICT_FORMAT = {
  ar: `\n\nقواعد صارمة يجب اتباعها:
- لا تكتب أي كلام تمهيدي مثل "بالطبع" أو "يمكنني مساعدتك" أو "سأقوم بكتابة" أو "بناءً على المعلومات"
- لا تكتب أي كلام ختامي مثل "مع تحياتي" أو "أتمنى لك التوفيق"
- لا تستخدم علامات زينة مكررة مثل --- أو *** أو ### أو ==
- لا تكتب كلمة "ملاحظة" أو "تنبيه" أو "نصيحة"
- اكتب المحتوى المطلوب فقط مباشرة بشكل نظيف ومرتب
- استخدم تنسيقًا بسيطًا بالقائمة أو الفقرات القصيرة فقط`,

  en: `\n\nStrict rules you MUST follow:
- DO NOT write any introductory phrases like "I'd be happy to" or "Based on the information" or "Certainly"
- DO NOT write any closing phrases like "Best regards" or "Good luck" or "Let me know"
- DO NOT use decorative characters like --- or *** or ### or ==
- DO NOT write "Note:" or "Tip:" or "Recommendation:"
- Write ONLY the requested content directly, clean and organized
- Use simple formatting with short paragraphs or bullet points only`
};

// ─── AI Prompts ───
const PROMPTS = {
  'cover-letter': {
    ar: 'أنت خبير توظيف في الخليج ومصر والوطن العربي. اكتب خطاب تقديم احترافي بالعربية.' + STRICT_FORMAT.ar,
    en: 'You are a hiring expert for Gulf, Egypt & Arab world. Write a professional cover letter in English.' + STRICT_FORMAT.en
  },
  'cv-optimizer': {
    ar: 'أنت خبير توظيف عربي. قم بتحسين السيرة الذاتية لتتناسب مع الوصف الوظيفي. أضف كلمات مفتاحية مناسبة.' + STRICT_FORMAT.ar,
    en: 'You are an Arab world hiring expert. Optimize the CV to match the job description.' + STRICT_FORMAT.en
  },
  'linkedin-message': {
    ar: 'أنت خبير تواصل مهني. اكتب رسالة لينكد إن احترافية.' + STRICT_FORMAT.ar,
    en: 'You are a professional networking expert. Write a professional LinkedIn message.' + STRICT_FORMAT.en
  },
  'proposal': {
    ar: 'أنت خبير عروض للفريلانسرز. اكتب عرض سعر احترافي مقنع.' + STRICT_FORMAT.ar,
    en: 'You are a freelance proposal expert. Write a persuasive professional proposal.' + STRICT_FORMAT.en
  },
  'client-message': {
    ar: 'أنت خبير تواصل مع العملاء. اكتب رسالة مهنية.' + STRICT_FORMAT.ar,
    en: 'You are a client communication expert. Write a professional message.' + STRICT_FORMAT.en
  },
  'content-writer': {
    ar: 'أنت كاتب محتوى محترف. اكتب محتوى تسويقي جذاب بالعربية.' + STRICT_FORMAT.ar,
    en: 'You are a professional content writer. Write engaging marketing content in English.' + STRICT_FORMAT.en
  }
};

function buildPrompt(tool, d) {
  const { name, jobTitle, company, skills, experience, details } = d;
  const m = {
    'cover-letter': `الاسم: ${name}\nالوظيفة: ${jobTitle || '—'}\nالشركة: ${company || '—'}\nالمهارات: ${skills || '—'}\nالتفاصيل: ${details || ''}`,
    'cv-optimizer': `الاسم: ${name}\nالمهارات: ${skills || '—'}\nالخبرة: ${experience || '—'}\nالوصف الوظيفي: ${details || '—'}`,
    'linkedin-message': `الاسم: ${name}\nالوظيفة: ${jobTitle || '—'}\nالشركة: ${company || '—'}\nالهدف: ${details || 'تواصل مهني'}`,
    'proposal': `المستقل: ${name}\nالمهارات: ${skills || '—'}\nالخبرة: ${experience || '—'}\nالمشروع: ${details || '—'}`,
    'client-message': `المرسل: ${name}\nالموقف: ${details || 'تواصل مع عميل'}`,
    'content-writer': `الموضوع: ${details || 'محتوى تسويقي'}\nالجمهور: ${company || 'عام'}\nالخدمات: ${skills || '—'}`
  };
  return m[tool] || '';
}

// ─── API: Generate ───
app.post('/api/generate', async (req, res) => {
  try {
    const { tool, language, name, jobTitle, company, skills, experience, details, clientId, aiProvider } = req.body;
    if (!tool || !language || !name) return res.status(400).json({ error: 'Missing fields' });

    const system = PROMPTS[tool]?.[language];
    if (!system) return res.status(400).json({ error: 'Unknown tool or language' });

    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const u = getUsage(clientId, ip);
    const provider = (u.tier === 'vip' && aiProvider) ? aiProvider : defaultProvider;

    if (u.tier === 'free' && u.count >= LIMITS.free) {
      return res.status(402).json({ error: 'free_limit_reached', message: 'انتهت الاستخدامات المجانية. اشترك للاستخدام غير المحدود.' });
    }

    const client = createAIClient(provider);
    if (!client) {
      return res.status(503).json({
        error: 'ai_unavailable',
        message: `${AI_PROVIDERS[provider]?.name || provider} غير مهيأ. أضف المفتاح في .env`
      });
    }

    const userPrompt = buildPrompt(tool, { name, jobTitle, company, skills, experience, details });
    const result = await generateWithProvider(client, system, userPrompt);

    if (u.tier === 'free') {
      u.count += 1;
      if (ip) {
        if (!ipUsageCount[ip]) ipUsageCount[ip] = { count: 0, tier: 'free' };
        ipUsageCount[ip].count += 1;
      }
    }

    res.json({
      result,
      usage: u.count,
      limit: LIMITS[u.tier],
      tier: u.tier,
      provider
    });

  } catch (error) {
    console.error('AI Error:', error);
    if (error.status === 429) return res.status(429).json({ error: 'API quota exceeded' });
    if (error.status === 401 || error.status === 403) return res.status(500).json({ error: 'Invalid API key' });
    res.status(500).json({ error: 'AI generation failed', details: error.message });
  }
});

// ─── API: Usage ───
app.post('/api/usage', (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const u = getUsage(req.body.clientId, ip);
  res.json({
    count: u.count, limit: LIMITS[u.tier], tier: u.tier,
    aiProvider: u.aiProvider,
    remaining: u.tier === 'free' ? Math.max(0, LIMITS.free - u.count) : Infinity
  });
});

app.post('/api/set-provider', (req, res) => {
  const { clientId, provider } = req.body;
  if (!AI_PROVIDERS[provider]) return res.status(400).json({ error: 'Invalid provider' });
  const u = getUsage(clientId || req.ip);
  if (u.tier !== 'vip') return res.status(403).json({ error: 'VIP only' });
  u.aiProvider = provider;
  res.json({ aiProvider: provider });
});

app.get('/api/providers', (req, res) => {
  const available = {};
  for (const [k, v] of Object.entries(AI_PROVIDERS)) {
    if (v.apiKey && !v.apiKey.includes('your_')) available[k] = { name: v.name, icon: v.icon };
  }
  res.json(available);
});

// ═════════════════════════════════════════════
//  PAYMENTS
// ═════════════════════════════════════════════

// ─── Stripe (Visa, Mastercard, Apple Pay, Mada, جميع البنوك) ───
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe غير مهيأ. أضف STRIPE_SECRET_KEY' });

  try {
    const { priceId, clientId } = req.body;
    const prices = {
      price_pro: { amount: 999, name: 'AI Career Pro - Pro', tier: 'pro' },
      price_vip: { amount: 1999, name: 'AI Career Pro - VIP', tier: 'vip' }
    };
    const p = prices[priceId];
    if (!p) return res.status(400).json({ error: 'Invalid price' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'link'],
      line_items: [{
        price_data: { currency: 'usd', product_data: { name: p.name }, unit_amount: p.amount },
        quantity: 1
      }],
      mode: 'subscription',
      subscription_data: { metadata: { tier: p.tier, clientId: clientId || req.ip } },
      success_url: `${req.headers.origin || 'http://localhost:3000'}/?success=true&tier=${p.tier}`,
      cancel_url: `${req.headers.origin || 'http://localhost:3000'}/?canceled=true`,
      client_reference_id: clientId || req.ip,
      metadata: { tier: p.tier, clientId: clientId || req.ip }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe Error:', error);
    res.status(500).json({ error: 'Stripe error', details: error.message });
  }
});

app.get('/api/verify-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const { session_id, clientId } = req.query;
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid' || session.mode === 'subscription') {
      const id = clientId || session.client_reference_id || session.metadata?.clientId;
      if (id) { const u = getUsage(id); u.tier = session.metadata?.tier || 'pro'; u.count = 0; }
    }
    res.json({ verified: true, status: session.payment_status, tier: session.metadata?.tier || 'pro' });
  } catch (e) {
    res.status(500).json({ error: 'Verification failed', details: e.message });
  }
});

// ─── Paymob (Vodafone Cash, Etisalat Cash, جميع بنوك مصر والوطن العربي) ───
const PAYMOB_API_BASE = 'https://accept.paymob.com/api';

let paymobToken = null;
let paymobTokenExpiry = 0;

async function getPaymobToken() {
  if (paymobToken && Date.now() < paymobTokenExpiry) return paymobToken;
  const res = await fetch(`${PAYMOB_API_BASE}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.PAYMOB_API_KEY })
  });
  const data = await res.json();
  paymobToken = data.token;
  paymobTokenExpiry = Date.now() + 3600000; // 1 hour
  return paymobToken;
}

app.post('/api/create-paymob-intent', async (req, res) => {
  try {
    const { tier, clientId, paymentMethod } = req.body;
    const amounts = { pro: 999, vip: 1999 };
    const amount = amounts[tier];
    if (!amount) return res.status(400).json({ error: 'Invalid tier' });

    const token = await getPaymobToken();

    // Create order
    const orderRes = await fetch(`${PAYMOB_API_BASE}/ecommerce/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_token: token,
        delivery_needed: 'false',
        amount_cents: amount,
        currency: 'EGP',
        items: [{ name: tier === 'vip' ? 'AI Career Pro VIP' : 'AI Career Pro', amount_cents: amount, quantity: 1 }]
      })
    });
    const order = await orderRes.json();

    // Get payment key
    const billingData = {
      apartment: '1', floor: '1', street: 'N/A', building: '1',
      phone_number: req.body.phone || '01000000000',
      city: 'Cairo', country: 'EG', first_name: req.body.name || 'User',
      last_name: '.', email: req.body.email || 'user@example.com'
    };

    const pkRes = await fetch(`${PAYMOB_API_BASE}/acceptance/payment_keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_token: token,
        amount_cents: amount,
        expiration: 3600,
        order_id: order.id,
        billing_data: billingData,
        currency: 'EGP',
        integration_id: process.env.PAYMOB_INTEGRATION_ID,
        lock_order_when_paid: 'true'
      })
    });
    const paymentKey = await pkRes.json();

    if (paymentMethod === 'wallet') {
      // Mobile wallet (Vodafone Cash, Etisalat Cash)
      const walletRes = await fetch(`${PAYMOB_API_BASE}/acceptance/payments/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: { identifier: req.body.phone || '01000000000', subtype: 'WALLET' },
          payment_token: paymentKey.token
        })
      });
      const walletData = await walletRes.json();
      res.json({
        method: 'wallet',
        redirect: false,
        pending: true,
        orderId: order.id,
        paymobId: walletData.id,
        message: 'تم إرسال طلب الدفع. أدخل كود التأكيد المرسل إلى هاتفك.'
      });
    } else {
      // Card payment via iframe
      const iframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${process.env.PAYMOB_IFRAME_ID}?payment_token=${paymentKey.token}`;
      res.json({
        method: 'card',
        redirect: true,
        url: iframeUrl,
        orderId: order.id
      });
    }

    // Save pending upgrade
    const id = clientId || req.ip;
    const u = getUsage(id);
    u.pendingTier = tier;
    u.pendingOrderId = order.id;

  } catch (error) {
    console.error('Paymob Error:', error);
    res.status(500).json({ error: 'Paymob error', details: error.message });
  }
});

// Paymob webhook callback
app.post('/api/webhook/paymob', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const data = JSON.parse(req.body.toString());
    const hmac = req.headers['hmac'];

    // Verify HMAC
    if (process.env.PAYMOB_HMAC) {
      const crypto = require('crypto');
      const calculated = crypto.createHmac('sha512', process.env.PAYMOB_HMAC)
        .update(JSON.stringify(data.obj))
        .digest('hex');
      if (hmac !== calculated) {
        return res.status(400).json({ error: 'HMAC verification failed' });
      }
    }

    if (data.type === 'TRANSACTION' && data.obj?.success === true) {
      const orderId = data.obj.order?.id || data.obj.order_id;
      const clientId = data.obj.custom?.clientId;

      if (clientId) {
        const u = getUsage(clientId);
        if (u.pendingTier) {
          u.tier = u.pendingTier;
          u.count = 0;
          delete u.pendingTier;
          delete u.pendingOrderId;
          console.log(`✅ [Paymob] ${clientId} upgraded to ${u.tier}`);
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Paymob webhook error:', e);
    res.status(400).send('Error');
  }
});

// ─── PayPal ───
const PAYPAL_API = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function getPayPalToken() {
  const cid = process.env.PAYPAL_CLIENT_ID;
  const sec = process.env.PAYPAL_SECRET;
  if (!cid || !sec || cid.includes('your_')) throw new Error('PayPal not configured');
  const auth = Buffer.from(`${cid}:${sec}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('PayPal auth failed');
  const data = await res.json();
  return data.access_token;
}

app.post('/api/create-paypal-order', async (req, res) => {
  try {
    const { tier, clientId } = req.body;
    const amounts = { pro: '9.99', vip: '19.99' };
    const amount = amounts[tier];
    if (!amount) return res.status(400).json({ error: 'Invalid tier' });

    const token = await getPayPalToken();
    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'USD', value: amount }, description: `AI Career Pro ${tier}`, custom_id: `${clientId || ''}:${tier}` }]
      })
    });
    const order = await orderRes.json();
    if (!orderRes.ok) throw new Error(order.message || 'PayPal error');
    res.json({ id: order.id, status: order.status });
  } catch (error) {
    console.error('PayPal Error:', error);
    res.status(500).json({ error: 'PayPal error', details: error.message });
  }
});

app.post('/api/capture-paypal-order', async (req, res) => {
  try {
    const { orderId, clientId, tier } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });
    const token = await getPayPalToken();
    const capRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    });
    const capture = await capRes.json();
    if (capture.status === 'COMPLETED') {
      const id = clientId || req.ip;
      const u = getUsage(id);
      u.tier = tier || 'pro';
      u.count = 0;
    }
    res.json(capture);
  } catch (error) {
    console.error('PayPal Capture Error:', error);
    res.status(500).json({ error: 'PayPal capture error', details: error.message });
  }
});

// ─── Error handlers ───
app.use('/api', (req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => {
  console.error('Unhandled:', err);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Server error' : err.message });
});

// ─── Start ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║       AI Career Pro - SERVER         ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  PORT:        ${PORT}`);
  console.log(`║  Default AI:  OpenRouter 🌐`);
  console.log(`║  Stripe:      ${stripe ? '✅' : '❌'}`);
  console.log(`║  PayPal:      ${process.env.PAYPAL_CLIENT_ID && !process.env.PAYPAL_CLIENT_ID.includes('your_') ? '✅' : '❌'}`);
  console.log(`║  Paymob:      ${process.env.PAYMOB_API_KEY && !process.env.PAYMOB_API_KEY.includes('your_') ? '✅' : '❌'}`);
  console.log(`║  Gemini:      ${process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('your_') ? '✅' : '❌'}`);
  console.log(`║  OpenAI:      ${process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your_') ? '✅' : '❌'}`);
  console.log(`║  OpenRouter:  ${process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.includes('your_') ? '✅' : '❌'}`);
  console.log('╚══════════════════════════════════════╝');
  console.log('   Webhooks:');
  console.log('     Stripe : POST /api/webhook/stripe');
  console.log('     Paymob : POST /api/webhook/paymob');
  console.log('   Health  : GET  /api/health');
  console.log('');
});
