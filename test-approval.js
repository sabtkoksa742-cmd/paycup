// ملف اختبار محاكاة callback من تليجرام
// استخدم هذا للاختبار بدون الحاجة لإعداد webhook حقيقي

const http = require('http');

// احصل على sessionID من المتغير أو استخدم قيمة افتراضية للاختبار
const sessionID = process.argv[2] || 'test-session-id';
const action = process.argv[3] || 'approve'; // approve أو reject

console.log(`\n🧪 محاكاة callback من تليجرام`);
console.log(`SessionID: ${sessionID}`);
console.log(`Action: ${action}\n`);

// بيانات callback من تليجرام (محاكاة)
const callbackData = {
  update_id: 123456789,
  callback_query: {
    id: '987654321',
    from: {
      id: 123456,
      is_bot: false,
      first_name: 'Test',
      username: 'testuser'
    },
    chat_instance: '1234567890',
    message: {
      message_id: 999,
      chat: {
        id: 8108427825
      }
    },
    data: `${action}_${sessionID}`
  }
};

// إرسال البيانات إلى السيرفر
const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/webhook/telegram',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`✅ استجابة السيرفر (${res.statusCode}):`);
    console.log(data);
    console.log('\n');
    
    if (res.statusCode === 200) {
      console.log('✅ تم إرسال callback بنجاح!');
    }
  });
});

req.on('error', (error) => {
  console.error('❌ خطأ في الاتصال:', error.message);
  console.log('\n⚠️ تأكد من تشغيل السيرفر على http://localhost:3000');
});

req.write(JSON.stringify(callbackData));
req.end();
