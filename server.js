require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors({ origin: true, credentials: true }));

// Save raw body for webhooks (must run before express.json)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook/')) {
    let data = [];
    req.on('data', chunk => data.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(data);
      next();
    });
  } else {
    next();
  }
});
app.use(express.json({ limit: '1mb' }));

// ═════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════

function maskKey(key) {
  if (!key || key.length < 8) return '(not set)';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

function cleanKey(key) {
  if (!key) return '';
  return key.toString().trim().replace(/\r/g, '').replace(/\n/g, '');
}

function isKeyValid(key) {
  return key && key.length > 3 && !key.includes('your_') && !key.includes('placeholder');
}

// ═════════════════════════════════════════════
//  CONFIG VALIDATION (runs at startup)
// ═════════════════════════════════════════════

const CONFIG = {
  stripe: {
    secretKey: cleanKey(process.env.STRIPE_SECRET_KEY),
    publishableKey: cleanKey(process.env.STRIPE_PUBLISHABLE_KEY),
    webhookSecret: cleanKey(process.env.STRIPE_WEBHOOK_SECRET),
    proPriceId: cleanKey(process.env.STRIPE_PRO_MONTHLY_PRICE_ID),
    vipPriceId: cleanKey(process.env.STRIPE_VIP_MONTHLY_PRICE_ID)
  },
  paypal: {
    clientId: cleanKey(process.env.PAYPAL_CLIENT_ID),
    secret: cleanKey(process.env.PAYPAL_SECRET),
    mode: process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox'
  },
  paymob: {
    apiKey: cleanKey(process.env.PAYMOB_API_KEY),
    integrationId: cleanKey(process.env.PAYMOB_INTEGRATION_ID),
    walletIntegrationId: cleanKey(process.env.PAYMOB_WALLET_INTEGRATION_ID),
    iframeId: cleanKey(process.env.PAYMOB_IFRAME_ID),
    hmac: cleanKey(process.env.PAYMOB_HMAC)
  },
  ai: {
    gemini: cleanKey(process.env.GEMINI_API_KEY),
    openai: cleanKey(process.env.OPENAI_API_KEY),
    openrouter: cleanKey(process.env.OPENROUTER_API_KEY)
  }
};

// ═════════════════════════════════════════════
//  STRIPE
// ═════════════════════════════════════════════

const stripe = (() => {
  if (!isKeyValid(CONFIG.stripe.secretKey)) {
    console.warn('⚠️  STRIPE_SECRET_KEY missing or invalid. Stripe disabled.');
    return null;
  }
  try {
    return require('stripe')(CONFIG.stripe.secretKey);
  } catch (e) {
    console.error('❌ Failed to initialize Stripe:', e.message);
    return null;
  }
})();

// Webhook
app.post('/api/webhook/stripe', (req, res) => {
  if (!stripe) return res.status(503).json({ success: false, provider: 'stripe', message: 'Stripe not configured' });

  const sig = req.headers['stripe-signature'];
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));

  if (!CONFIG.stripe.webhookSecret || CONFIG.stripe.webhookSecret.includes('your_')) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(400).json({ success: false, provider: 'stripe', message: 'Webhook secret not configured' });
    }
    try {
      handleStripeEvent(JSON.parse(rawBody.toString()));
      return res.json({ received: true, verified: false });
    } catch (e) { return res.status(400).send('Invalid payload'); }
  }

  let event;
  try { event = stripe.webhooks.constructEvent(rawBody, sig, CONFIG.stripe.webhookSecret); }
  catch (err) { return res.status(400).json({ success: false, provider: 'stripe', message: `Signature verification failed: ${err.message}` }); }

  handleStripeEvent(event);
  res.json({ received: true, verified: true });
});

function handleStripeEvent(event) {
  console.log(`📨 Stripe event: ${event.type}`);
  const handler = {
    'checkout.session.completed': (d) => {
      const id = d.metadata?.clientId || d.client_reference_id || d.id;
      if (id) upgradeUser(id, d.metadata?.tier || 'pro');
    },
    'invoice.paid': (d) => {
      const id = d.metadata?.clientId || d.subscription_details?.metadata?.clientId;
      if (id && d.status === 'paid') upgradeUser(id, d.metadata?.tier || 'pro');
    },
    'payment_intent.succeeded': (d) => {
      const id = d.metadata?.clientId || d.id;
      if (id) upgradeUser(id, d.metadata?.tier || 'pro');
    },
    'payment_intent.payment_failed': (d) => console.error(`❌ Payment failed: ${d.id} - ${d.last_payment_error?.message}`),
    'customer.subscription.deleted': (d) => {
      const id = d.metadata?.clientId;
      if (id) upgradeUser(id, 'free');
    },
    'customer.subscription.updated': (d) => {
      if (d.status === 'active' || d.status === 'trialing') {
        const id = d.metadata?.clientId;
        if (id) upgradeUser(id, d.metadata?.tier || 'pro');
      }
    }
  };
  if (handler[event.type]) handler[event.type](event.data.object);
}

// ─── Stripe checkout ───
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ success: false, provider: 'stripe', message: 'Stripe غير مهيأ. أضف STRIPE_SECRET_KEY في .env' });

  try {
    const { priceId, clientId } = req.body;
    if (!priceId) return res.status(400).json({ success: false, message: 'priceId مطلوب' });

    const prices = {
      price_pro: { amount: 999, name: 'AI Career Pro - Pro', tier: 'pro' },
      price_vip: { amount: 1999, name: 'AI Career Pro - VIP', tier: 'vip' }
    };
    const p = prices[priceId];
    if (!p) return res.status(400).json({ success: false, message: 'priceId غير صحيح' });

    let lineItems;
    const stripePriceId = p.tier === 'pro' ? CONFIG.stripe.proPriceId : CONFIG.stripe.vipPriceId;
    if (stripePriceId) {
      lineItems = [{ price: stripePriceId, quantity: 1 }];
    } else {
      lineItems = [{
        price_data: {
          currency: 'usd',
          product_data: { name: p.name },
          unit_amount: p.amount,
          recurring: { interval: 'month', interval_count: 1 }
        },
        quantity: 1
      }];
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'link'],
      line_items: lineItems,
      mode: 'subscription',
      subscription_data: { metadata: { tier: p.tier, clientId: clientId || req.ip } },
      success_url: `${req.headers.origin || 'http://localhost:3000'}/?success=true&tier=${p.tier}`,
      cancel_url: `${req.headers.origin || 'http://localhost:3000'}/?canceled=true`,
      client_reference_id: clientId || req.ip,
      metadata: { tier: p.tier, clientId: clientId || req.ip }
    });

    res.json({ success: true, url: session.url });
  } catch (error) {
    console.error('❌ Stripe Checkout Error:', error.message);
    res.status(500).json({ success: false, provider: 'stripe', message: getUserFriendlyStripeError(error) });
  }
});

app.get('/api/verify-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ success: false, provider: 'stripe', message: 'Stripe not configured' });
  try {
    const { session_id, clientId } = req.query;
    if (!session_id) return res.status(400).json({ success: false, message: 'Missing session_id' });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid' || session.mode === 'subscription') {
      upgradeUser(clientId || session.client_reference_id || session.metadata?.clientId, session.metadata?.tier || 'pro');
    }
    res.json({ success: true, status: session.payment_status, tier: session.metadata?.tier || 'pro' });
  } catch (e) {
    res.status(500).json({ success: false, provider: 'stripe', message: 'Verification failed: ' + e.message });
  }
});

function getUserFriendlyStripeError(err) {
  if (err.type === 'StripeCardError') return 'فشل الدفع. تحقق من بيانات البطاقة.';
  if (err.type === 'StripeInvalidRequestError') {
    if (err.message.includes('recurring')) return 'خطأ في إعدادات الاشتراك. تواصل مع الدعم الفني.';
    if (err.message.includes('price')) return 'خطأ في السعر. تواصل مع الدعم.';
    return 'طلب غير صحيح: ' + err.message;
  }
  if (err.type === 'StripeAuthenticationError') return 'خطأ في المصادقة مع Stripe. تحقق من STRIPE_SECRET_KEY.';
  if (err.type === 'StripeRateLimitError') return 'تم تجاوز حد الطلبات. حاول مرة أخرى لاحقاً.';
  if (err.type === 'StripeAPIError') return 'خطأ في Stripe. حاول مرة أخرى.';
  return 'حدث خطأ في Stripe: ' + err.message;
}

// ═════════════════════════════════════════════
//  PAYPAL
// ═════════════════════════════════════════════

const PAYPAL_API = CONFIG.paypal.mode === 'live'
  ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const paypalReady = isKeyValid(CONFIG.paypal.clientId) && isKeyValid(CONFIG.paypal.secret);

async function getPayPalToken() {
  if (!paypalReady) throw new Error('PayPal not configured. Set PAYPAL_CLIENT_ID and PAYPAL_SECRET in .env');
  const auth = Buffer.from(`${CONFIG.paypal.clientId}:${CONFIG.paypal.secret}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) throw new Error('PAYPAL_CLIENT_ID أو PAYPAL_SECRET غير صحيح. تحقق من القيم.');
    if (res.status === 404) throw new Error(`PayPal endpoint غير صحيح: ${PAYPAL_API}`);
    throw new Error(`PayPal auth failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('PayPal did not return an access token');
  return data.access_token;
}

// PayPal test endpoint
app.get('/api/paypal/test', async (req, res) => {
  if (!paypalReady) return res.json({ success: false, provider: 'paypal', message: 'PayPal غير مهيأ. تحقق من PAYPAL_CLIENT_ID و PAYPAL_SECRET في .env' });
  try {
    const token = await getPayPalToken();
    res.json({ success: true, provider: 'paypal', message: 'PayPal يعمل بشكل صحيح', mode: CONFIG.paypal.mode });
  } catch (e) {
    res.json({ success: false, provider: 'paypal', message: e.message });
  }
});

app.post('/api/create-paypal-order', async (req, res) => {
  try {
    const { tier, clientId } = req.body;
    const amounts = { pro: '9.99', vip: '19.99' };
    const amount = amounts[tier];
    if (!amount) return res.status(400).json({ success: false, message: 'Invalid tier' });

    const token = await getPayPalToken();
    const origin = req.headers.origin || 'https://ai-career-pro-production.up.railway.app';
    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'USD', value: amount }, description: `AI Career Pro ${tier}`, custom_id: `${clientId || ''}:${tier}` }],
        application_context: {
          return_url: `${origin}/api/paypal/return?tier=${tier}&clientId=${clientId || ''}`,
          cancel_url: `${origin}/?canceled=true`,
          user_action: 'PAY_NOW',
          brand_name: 'AI Career Pro'
        }
      })
    });
    const order = await orderRes.json();
    if (!orderRes.ok) throw new Error(order.message || 'PayPal error');
    const approveLink = order.links?.find(l => l.rel === 'payer-action')?.href
      || order.links?.find(l => l.rel === 'approve')?.href
      || `${PAYPAL_API.replace('api-m','www')}/checkoutnow?token=${order.id}`;
    res.json({ success: true, id: order.id, status: order.status, approvalUrl: approveLink });
  } catch (error) {
    console.error('❌ PayPal Order Error:', error.message);
    res.status(500).json({ success: false, provider: 'paypal', message: error.message });
  }
});

// PayPal return handler (after user approves on PayPal)
app.get('/api/paypal/return', async (req, res) => {
  try {
    const { token: orderId, tier, clientId, PayerID } = req.query;
    if (!orderId) return res.redirect('/?canceled=true');
    const capRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getPayPalToken()}` }
    });
    const capture = await capRes.json();
    if (capture.status === 'COMPLETED') {
      upgradeUser(clientId || req.ip, tier || 'pro');
      res.redirect('/?success=true&provider=paypal');
    } else {
      res.redirect('/?canceled=true');
    }
  } catch (e) {
    console.error('❌ PayPal return error:', e.message);
    res.redirect('/?canceled=true');
  }
});

app.post('/api/capture-paypal-order', async (req, res) => {
  try {
    const { orderId, clientId, tier } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'Missing orderId' });
    const token = await getPayPalToken();
    const capRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    });
    const capture = await capRes.json();
    if (capture.status === 'COMPLETED') {
      upgradeUser(clientId || req.ip, tier || 'pro');
    }
    res.json(capture);
  } catch (error) {
    console.error('❌ PayPal Capture Error:', error.message);
    res.status(500).json({ success: false, provider: 'paypal', message: error.message });
  }
});

// ═════════════════════════════════════════════
//  PAYMOB
// ═════════════════════════════════════════════

const PAYMOB_API_BASE = 'https://accept.paymob.com/api';
const paymobReady = isKeyValid(CONFIG.paymob.apiKey) && isKeyValid(CONFIG.paymob.integrationId);

let paymobToken = null;
let paymobTokenExpiry = 0;

async function getPaymobToken() {
  if (!paymobReady) throw new Error('Paymob not configured. Set PAYMOB_API_KEY and PAYMOB_INTEGRATION_ID.');
  if (paymobToken && Date.now() < paymobTokenExpiry) return paymobToken;
  const res = await fetch(`${PAYMOB_API_BASE}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: CONFIG.paymob.apiKey })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paymob auth failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('Paymob did not return a token. Check PAYMOB_API_KEY.');
  paymobToken = data.token;
  paymobTokenExpiry = Date.now() + 3600000;
  return paymobToken;
}

app.post('/api/create-paymob-intent', async (req, res) => {
  try {
    const { tier, clientId, paymentMethod } = req.body;
    const amounts = { pro: 999, vip: 1999 };
    const amount = amounts[tier];
    if (!amount) return res.status(400).json({ success: false, message: 'Invalid tier' });

    const token = await getPaymobToken();
    const orderRes = await fetch(`${PAYMOB_API_BASE}/ecommerce/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_token: token, delivery_needed: 'false', amount_cents: amount, currency: 'EGP',
        items: [{ name: tier === 'vip' ? 'AI Career Pro VIP' : 'AI Career Pro', amount_cents: amount, quantity: 1 }]
      })
    });
    const order = await orderRes.json();
    if (!orderRes.ok || !order.id) throw new Error(order.message || 'Paymob order creation failed');

    const billingData = {
      apartment: '1', floor: '1', street: 'N/A', building: '1',
      phone_number: req.body.phone || '01000000000', city: 'Cairo', country: 'EG',
      first_name: req.body.name || 'User', last_name: '.', email: req.body.email || 'user@example.com'
    };

    const isWallet = paymentMethod === 'vodafone_cash' || paymentMethod === 'etisalat_cash';
    const intentId = isWallet && CONFIG.paymob.walletIntegrationId
      ? CONFIG.paymob.walletIntegrationId
      : CONFIG.paymob.integrationId;
    // Paymob subtypes: VODAFONE, ETISALAT, ORANGE, WE (بدون _CASH)
    const walletSubtypes = { vodafone_cash: 'VODAFONE', etisalat_cash: 'ETISALAT' };

    const pkRes = await fetch(`${PAYMOB_API_BASE}/acceptance/payment_keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_token: token, amount_cents: amount, expiration: 3600, order_id: order.id,
        billing_data: billingData, currency: 'EGP', integration_id: intentId, lock_order_when_paid: 'true'
      })
    });
    const paymentKey = await pkRes.json();
    if (!pkRes.ok || !paymentKey.token) throw new Error(paymentKey.message || 'Paymob payment key failed');

    const u = getUsage(clientId || req.ip);
    u.pendingTier = tier;
    u.pendingOrderId = order.id;
    pendingOrders.set(order.id, { clientId: clientId || req.ip, tier });

    if (isWallet) {
      if (CONFIG.paymob.walletIntegrationId) {
        // Wallet Integration ID موجود → استخدم API المحفظة المباشر
        const subtype = walletSubtypes[paymentMethod] || 'VODAFONE';
        const phone = req.body.phone || '01000000000';
        const walletRes = await fetch(`${PAYMOB_API_BASE}/acceptance/payments/pay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { identifier: phone, subtype },
            payment_token: paymentKey.token
          })
        });
        const walletData = await walletRes.json();
        console.log('📨 Paymob wallet response:', JSON.stringify(walletData));

        if (walletData.pending) {
          if (walletData.redirect_url) {
            res.json({ success: true, method: paymentMethod, redirect: true, url: walletData.redirect_url, orderId: order.id });
          } else {
            res.json({
              success: true, method: paymentMethod, otp_required: true,
              orderId: order.id, paymobId: walletData.id,
              payment_token: paymentKey.token, phone, subtype,
              message: 'تم إرسال رمز التأكيد إلى هاتفك. أدخل الرمز لإتمام الدفع.'
            });
          }
        } else {
          return res.status(400).json({ success: false, provider: 'paymob', message: walletData.data?.message || JSON.stringify(walletData) });
        }
      } else {
        // Wallet Integration ID غير مضبوط → نستخدم iframe البطاقات (احتياطي)
        const iframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${CONFIG.paymob.iframeId}?payment_token=${paymentKey.token}`;
        res.json({ success: true, method: paymentMethod, redirect: true, url: iframeUrl, orderId: order.id });
      }
    } else {
      // Card / other — iframe
      const iframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${CONFIG.paymob.iframeId}?payment_token=${paymentKey.token}`;
      res.json({ success: true, method: 'card', redirect: true, url: iframeUrl, orderId: order.id });
    }
  } catch (error) {
    console.error('❌ Paymob Error:', error.message);
    res.status(500).json({ success: false, provider: 'paymob', message: error.message });
  }
});

// pendingOrders maps Paymob order_id -> { clientId, tier }
const pendingOrders = new Map();

// Paymob webhook — Paymob يرسله بعد تأكيد الدفع (بما في ذلك OTP للمحافظ)
app.post('/api/webhook/paymob', (req, res) => {
  try {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const data = JSON.parse(rawBody.toString());
    const hmac = req.headers['hmac'];

    if (CONFIG.paymob.hmac) {
      const calculated = crypto.createHmac('sha512', CONFIG.paymob.hmac).update(JSON.stringify(data.obj)).digest('hex');
      if (hmac !== calculated) {
        console.warn('⚠️ Paymob HMAC mismatch (accepting in dev mode)');
      }
    }

    if (data.type === 'TRANSACTION' && data.obj?.success === true) {
      const orderId = data.obj.order?.id;
      if (orderId && pendingOrders.has(orderId)) {
        const { clientId, tier } = pendingOrders.get(orderId);
        const u = getUsage(clientId);
        u.tier = tier;
        u.count = 0;
        console.log(`✅ Paymob: Upgraded ${maskKey(clientId)} to ${tier}`);
        pendingOrders.delete(orderId);
      } else if (orderId) {
        // Fallback: search through usage for matching pendingOrderId
        for (const [id, u] of Object.entries(usage)) {
          if (u.pendingOrderId == orderId && u.pendingTier) {
            u.tier = u.pendingTier;
            u.count = 0;
            console.log(`✅ Paymob: Upgraded ${maskKey(id)} to ${u.tier}`);
            delete u.pendingTier;
            delete u.pendingOrderId;
            break;
          }
        }
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('❌ Paymob webhook error:', e.message);
    res.status(400).send('Error');
  }
});

// Paymob OTP confirmation — المستخدم أدخل الرمز ونرسله لـ Paymob
app.post('/api/paymob/confirm-otp', async (req, res) => {
  try {
    const { otp, payment_token, phone, subtype, clientId, tier } = req.body;
    if (!otp || !payment_token || !phone || !subtype) {
      return res.status(400).json({ success: false, message: 'Missing OTP fields' });
    }

    const confirmRes = await fetch(`${PAYMOB_API_BASE}/acceptance/payments/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { identifier: phone, subtype, otp },
        payment_token
      })
    });
    const confirmData = await confirmRes.json();
    console.log('📨 Paymob OTP confirm:', JSON.stringify(confirmData));

    if (confirmData.success === true) {
      upgradeUser(clientId || req.ip, tier || 'pro');
      res.json({ success: true, message: '✅ تم تأكيد الدفع والترقية بنجاح!' });
    } else if (confirmData.pending && confirmData.redirect_url) {
      res.json({ success: true, method: 'wallet', redirect: true, url: confirmData.redirect_url });
    } else {
      res.json({ success: false, message: confirmData.data?.message || 'رمز التأكيد غير صحيح. حاول مرة أخرى.' });
    }
  } catch (error) {
    console.error('❌ Paymob OTP Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═════════════════════════════════════════════
//  GLOBAL MIDDLEWARE
// ═════════════════════════════════════════════

app.use(express.static('public'));

// ═════════════════════════════════════════════
//  AI PROVIDERS
// ═════════════════════════════════════════════

const AI_PROVIDERS = {
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    apiKey: CONFIG.ai.openrouter,
    icon: '🌐',
    type: 'openai'
  },
  gemini: {
    name: 'Google Gemini',
    apiKey: CONFIG.ai.gemini,
    model: 'gemini-2.0-flash',
    icon: '✨',
    type: 'gemini'
  },
  openai: {
    name: 'ChatGPT (OpenAI)',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: CONFIG.ai.openai,
    icon: '🤖',
    type: 'openai'
  }
};

const defaultProvider = 'openrouter';

function createAIClient(providerKey) {
  const cfg = AI_PROVIDERS[providerKey];
  if (!cfg || !isKeyValid(cfg.apiKey)) return null;

  if (cfg.type === 'gemini') {
    const genAI = new GoogleGenerativeAI(cfg.apiKey);
    return { type: 'gemini', model: genAI.getGenerativeModel({ model: cfg.model }), provider: providerKey };
  }

  if (cfg.type === 'openai') {
    return {
      type: 'openai',
      model: cfg.model,
      client: new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL }),
      provider: providerKey
    };
  }
  return null;
}

async function generateWithProvider(client, systemPrompt, userPrompt) {
  if (client.type === 'gemini') {
    const result = await client.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2000 }
    });
    return result.response.text();
  }

  if (client.type === 'openai') {
    const completion = await client.client.chat.completions.create({
      model: client.model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.7, max_tokens: 2000
    });
    return completion.choices[0].message.content;
  }
  throw new Error('Unknown AI provider type');
}

// ─── Usage tracking ───
const usage = {};
const LIMITS = { free: 5, pro: Infinity, vip: Infinity };

function getUsage(clientId, ip) {
  const primaryId = clientId || ip || 'anonymous';
  if (!usage[primaryId]) usage[primaryId] = { count: 0, tier: 'free', aiProvider: defaultProvider };
  return usage[primaryId];
}

function upgradeUser(id, tier) {
  if (!id) return;
  const u = getUsage(id);
  u.tier = tier || 'pro';
  u.count = 0;
  console.log(`✅ Upgraded ${maskKey(id)} to ${u.tier}`);
}

const STRICT_FORMAT = {
  ar: `\n\nقواعد صارمة: لا تكتب كلام تمهيدي أو ختامي. لا تستخدم --- أو *** أو ###. اكتب المحتوى المطلوب فقط بشكل نظيف.`,
  en: `\n\nStrict rules: No introductions or closings. No --- or *** or ###. Write ONLY the requested content.`
};

const PROMPTS = {
  'cover-letter': { ar: 'اكتب خطاب تقديم احترافي بالعربية.' + STRICT_FORMAT.ar, en: 'Write a professional cover letter.' + STRICT_FORMAT.en },
  'cv-optimizer': { ar: 'حسن السيرة الذاتية للوصف الوظيفي.' + STRICT_FORMAT.ar, en: 'Optimize the CV for the job.' + STRICT_FORMAT.en },
  'linkedin-message': { ar: 'اكتب رسالة لينكد إن احترافية.' + STRICT_FORMAT.ar, en: 'Write a LinkedIn message.' + STRICT_FORMAT.en },
  'proposal': { ar: 'اكتب عرض سعر مقنع.' + STRICT_FORMAT.ar, en: 'Write a persuasive proposal.' + STRICT_FORMAT.en },
  'client-message': { ar: 'اكتب رسالة مهنية للعميل.' + STRICT_FORMAT.ar, en: 'Write a professional client message.' + STRICT_FORMAT.en },
  'content-writer': { ar: 'اكتب محتوى تسويقي جذاب.' + STRICT_FORMAT.ar, en: 'Write engaging marketing content.' + STRICT_FORMAT.en }
};

function buildPrompt(tool, d) {
  const { name, jobTitle, company, skills, experience, details } = d;
  return {
    'cover-letter': `الاسم: ${name}\nالوظيفة: ${jobTitle || '—'}\nالشركة: ${company || '—'}\nالمهارات: ${skills || '—'}\nالتفاصيل: ${details || ''}`,
    'cv-optimizer': `الاسم: ${name}\nالمهارات: ${skills || '—'}\nالخبرة: ${experience || '—'}\nالوصف الوظيفي: ${details || '—'}`,
    'linkedin-message': `الاسم: ${name}\nالوظيفة: ${jobTitle || '—'}\nالشركة: ${company || '—'}\nالهدف: ${details || 'تواصل مهني'}`,
    'proposal': `المستقل: ${name}\nالمهارات: ${skills || '—'}\nالخبرة: ${experience || '—'}\nالمشروع: ${details || '—'}`,
    'client-message': `المرسل: ${name}\nالموقف: ${details || 'تواصل مع عميل'}`,
    'content-writer': `الموضوع: ${details || 'محتوى'}\nالجمهور: ${company || 'عام'}\nالخدمات: ${skills || '—'}`
  } [tool] || '';
}

// ─── API: Generate ───
app.post('/api/generate', async (req, res) => {
  try {
    const { tool, language, name, jobTitle, company, skills, experience, details, clientId, aiProvider } = req.body;
    if (!tool || !language || !name) return res.status(400).json({ success: false, message: 'Missing fields' });

    const system = PROMPTS[tool]?.[language];
    if (!system) return res.status(400).json({ success: false, message: 'Unknown tool or language' });

    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const u = getUsage(clientId, ip);
    const provider = (u.tier === 'vip' && aiProvider && AI_PROVIDERS[aiProvider]) ? aiProvider : defaultProvider;

    if (u.tier === 'free' && u.count >= LIMITS.free) {
      return res.status(402).json({ success: false, error: 'free_limit_reached', message: 'انتهت الاستخدامات المجانية. اشترك للاستخدام غير المحدود.' });
    }

    const client = createAIClient(provider);
    if (!client) {
      return res.status(503).json({ success: false, provider, message: `${AI_PROVIDERS[provider]?.name || provider} غير مهيأ. أضف المفتاح في .env` });
    }

    const userPrompt = buildPrompt(tool, { name, jobTitle, company, skills, experience, details });
    const result = await generateWithProvider(client, system, userPrompt);

    if (u.tier === 'free') u.count += 1;

    res.json({ success: true, result, usage: u.count, limit: LIMITS[u.tier], tier: u.tier, provider });
  } catch (error) {
    console.error('❌ AI Error:', providerName(error), error.message);
    if (error.status === 429) return res.status(429).json({ success: false, message: 'API quota exceeded', provider: providerName(error) });
    if (error.status === 401 || error.status === 403) return res.status(500).json({ success: false, message: 'مفتاح API غير صالح', provider: providerName(error) });
    res.status(500).json({ success: false, message: error.message, provider: providerName(error) });
  }
});

function providerName(err) {
  return err?.provider || 'unknown';
}

// ─── API: Usage ───
app.post('/api/usage', (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const u = getUsage(req.body.clientId, ip);
  res.json({ count: u.count, limit: LIMITS[u.tier], tier: u.tier, aiProvider: u.aiProvider, remaining: u.tier === 'free' ? Math.max(0, LIMITS.free - u.count) : Infinity });
});

app.post('/api/set-provider', (req, res) => {
  const { clientId, provider } = req.body;
  if (!AI_PROVIDERS[provider]) return res.status(400).json({ success: false, message: 'Invalid provider' });
  const u = getUsage(clientId || req.ip);
  if (u.tier !== 'vip') return res.status(403).json({ success: false, message: 'VIP only' });
  u.aiProvider = provider;
  res.json({ success: true, aiProvider: provider });
});

app.get('/api/providers', (req, res) => {
  const available = {};
  for (const [k, v] of Object.entries(AI_PROVIDERS)) {
    if (isKeyValid(v.apiKey)) available[k] = { name: v.name, icon: v.icon };
  }
  res.json(available);
});

// ═════════════════════════════════════════════
//  HEALTH & DEBUG
// ═════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    stripe: !!stripe,
    paypal: paypalReady,
    paymob: paymobReady,
    gemini: isKeyValid(CONFIG.ai.gemini),
    openai: isKeyValid(CONFIG.ai.openai),
    openrouter: isKeyValid(CONFIG.ai.openrouter)
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    stripe: !!stripe,
    paypal: paypalReady,
    paymob: paymobReady,
    gemini: isKeyValid(CONFIG.ai.gemini),
    openai: isKeyValid(CONFIG.ai.openai),
    openrouter: isKeyValid(CONFIG.ai.openrouter)
  });
});

// Debug config (shows only status, never real values)
app.get('/api/debug/config', (req, res) => {
  res.json({
    stripe: !!stripe,
    paypal: paypalReady,
    paymob: paymobReady,
    gemini: isKeyValid(CONFIG.ai.gemini),
    openai: isKeyValid(CONFIG.ai.openai),
    openrouter: isKeyValid(CONFIG.ai.openrouter),
    node_version: process.version,
    platform: process.platform,
    env: process.env.NODE_ENV || 'development'
  });
});

// ═════════════════════════════════════════════
//  ERROR HANDLER
// ═════════════════════════════════════════════

// 404
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: `API endpoint not found: ${req.method} ${req.path}` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message || err);
  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    provider: err?.provider || 'server'
  });
});

// ═════════════════════════════════════════════
//  STARTUP
// ═════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       AI Career Pro - v1.0.0             ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Environment: ${(process.env.NODE_ENV || 'development').padEnd(29)}║`);
  console.log(`║  Port:        ${String(PORT).padEnd(29)}║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  PROVIDERS                                ║');
  console.log(`║    AI Default : OpenRouter 🌐             ║`);
  console.log(`║    OpenRouter : ${isKeyValid(CONFIG.ai.openrouter) ? '✅' : '❌'}  ${maskKey(CONFIG.ai.openrouter).padEnd(26)}║`);
  console.log(`║    Gemini     : ${isKeyValid(CONFIG.ai.gemini) ? '✅' : '❌'}  ${maskKey(CONFIG.ai.gemini).padEnd(26)}║`);
  console.log(`║    OpenAI     : ${isKeyValid(CONFIG.ai.openai) ? '✅' : '❌'}  ${maskKey(CONFIG.ai.openai).padEnd(26)}║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  PAYMENTS                                 ║');
  console.log(`║    Stripe    : ${stripe ? '✅'.padEnd(31) : '❌'.padEnd(31)}║`);
  if (CONFIG.stripe.proPriceId) console.log(`║    Pro Price : ${CONFIG.stripe.proPriceId.padEnd(30)}║`);
  if (CONFIG.stripe.vipPriceId) console.log(`║    VIP Price : ${CONFIG.stripe.vipPriceId.padEnd(30)}║`);
  console.log(`║    PayPal    : ${paypalReady ? '✅'.padEnd(31) : '❌'.padEnd(31)}║`);
  console.log(`║    Paymob    : ${paymobReady ? '✅'.padEnd(31) : '❌'.padEnd(31)}║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  ENDPOINTS                                ║');
  console.log('║    Health   : GET /api/health             ║');
  console.log('║    Debug    : GET /api/debug/config       ║');
  console.log('║    PayPal   : GET /api/paypal/test        ║');
  console.log('║    Stripe   : POST /api/webhook/stripe    ║');
  console.log('║    Paymob   : POST /api/webhook/paymob    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
