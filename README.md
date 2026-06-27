# AI Career Pro

منصة ذكاء اصطناعي للباحثين عن عمل والفريلانسرز — توليد خطابات التقديم، تحسين السيرة الذاتية، رسائل لينكد إن، عروض الأسعار، والمزيد.

AI-powered content generation tools for Arabic-speaking job seekers and freelancers.

## الميزات / Features

- **6 أدوات AI**: خطاب تقديم، تحسين CV، رسائل LinkedIn، Proposal، رسائل عملاء، كتابة محتوى
- **3 مزودي AI**: OpenRouter (افتراضي)، Google Gemini، OpenAI ChatGPT (VIP فقط)
- **ثنائي اللغة**: عربي + إنجليزي
- **3 بوابات دفع**: Stripe (بطاقات)، PayPal، Paymob (Vodafone Cash, Etisalat Cash)
- **4 باقات**: مجاني (5 استخدامات)، Pro ($9.99/شهر)، VIP ($19.99/شهر)، مؤسسات ($29.99/شهر)

## المتطلبات / Requirements

- Node.js 18+
- npm

## التثبيت / Installation

```bash
# Clone the repo
git clone https://github.com/medomaree11/ai-career-pro.git
cd ai-career-pro

# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your API keys (see below)
```

## الإعداد / Configuration

### 1. AI Providers
| المتغير | الوصف | الرابط |
|---------|-------|--------|
| `GEMINI_API_KEY` | Google Gemini | https://aistudio.google.com |
| `OPENAI_API_KEY` | OpenAI ChatGPT | https://platform.openai.com |
| `OPENROUTER_API_KEY` | OpenRouter | https://openrouter.ai |

### 2. Stripe (فيزا / ماستركارد)
1. سجل في https://dashboard.stripe.com
2. احصل على **Secret Key** (sk_test_...) و **Publishable Key** (pk_test_...)
3. أنشئ منتجين اشتراك (Pro $9.99 و VIP $19.99) واحصل على Price IDs
4. أضف القيم في `.env`

### 3. Paymob (Vodafone Cash, Etisalat Cash)
1. سجل في https://accept.paymob.com
2. احصل على **API Key** من Account → Profile
3. أنشئ **Integration**:
   - بطاقات بنكية: Online Card (Integration ID)
   - محافظ: Mobile Wallet (Wallet Integration ID)
4. أنشئ **iframe** من integrations وخذ Iframe ID
5. أضف **HMAC** من Account → Profile → HMAC
6. أضف كل القيم في `.env`

### 4. PayPal
1. سجل في https://developer.paypal.com
2. أنشئ تطبيق واحصل على Client ID و Secret
3. اضبط `PAYPAL_MODE=sandbox` للاختبار أو `live` للإنتاج

## التشغيل / Running

```bash
# Development
npm start
# أو
node server.js

# Testing
node test-services.js
```

السيرفر يعمل على `http://localhost:3000`

## النشر / Deployment

### Railway (موصى به)
1. ارفع المشروع إلى GitHub
2. في Railway: New Project → Deploy from GitHub repo
3. أضف جميع متغيرات `.env` في Railway Dashboard
4. Railway يكتشف `railway.json` تلقائياً

### Vercel
1. ارفع المشروع إلى GitHub
2. استورد في Vercel
3. أضف متغيرات البيئة
4. Vercel يستخدم `vercel.json`

### Render
1. ارفع المشروع إلى GitHub
2. استورد في Render كـ Web Service
3. أضف متغيرات البيئة
4. Render يستخدم `render.yaml`

## API Endpoints

| Method | Endpoint | الوصف |
|--------|----------|-------|
| POST | `/api/generate` | توليد محتوى بالذكاء الاصطناعي |
| POST | `/api/usage` | الاستعلام عن الاستخدام المتبقي |
| POST | `/api/set-provider` | تغيير مزود AI (VIP فقط) |
| GET | `/api/providers` | قائمة مزودي AI المتاحين |
| POST | `/api/create-checkout` | إنشاء جلسة دفع Stripe |
| GET | `/api/verify-session` | التحقق من جلسة Stripe |
| POST | `/api/webhook/stripe` | Webhook أحداث Stripe |
| GET | `/api/paypal/test` | اختبار اتصال PayPal |
| POST | `/api/create-paypal-order` | إنشاء طلب PayPal |
| GET | `/api/paypal/return` | معالج العودة من PayPal |
| POST | `/api/capture-paypal-order` | تأكيد الدفع PayPal |
| POST | `/api/webhook/paypal` | Webhook أحداث PayPal |
| POST | `/api/create-paymob-intent` | إنشاء نية دفع Paymob |
| POST | `/api/paymob/confirm-otp` | تأكيد OTP لمحافظ الهاتف |
| POST | `/api/webhook/paymob` | Webhook أحداث Paymob |
| GET | `/api/health` | فحص صحة السيرفر |
| GET | `/api/debug/config` | حالة الإعدادات (debug) |

## هيكل المشروع / Project Structure

```
ai-career-pro/
├── public/           # Frontend (static files)
│   ├── index.html    # الصفحة الرئيسية
│   ├── css/style.css # التنسيقات
│   └── js/app.js     # منطق الواجهة
├── server.js         # Backend (Express server)
├── .env              # المتغيرات البيئية (API keys)
├── .env.example      # قالب المتغيرات البيئية
├── test-services.js  # اختبار الخدمات
├── package.json
├── vercel.json       # إعدادات Vercel
├── render.yaml       # إعدادات Render
└── railway.json      # إعدادات Railway
```

## الترخيص / License

MIT
