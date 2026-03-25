// ─────────────────────────────────────────────────────────────
//  netlify/functions/chat.js
//  Backend proxy — يستقبل الطلب من frontend ويكلم Claude API
//  API Key موجود فقط هنا على السيرفر، مش في المتصفح أبداً
// ─────────────────────────────────────────────────────────────

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL   = "claude-sonnet-4-20250514";

// Headers مشتركة للـ CORS — بتسمح للـ frontend يكلم الـ function
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── Helper: رد سريع ──────────────────────────────────────────
function reply(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

// ── Handler الرئيسي ──────────────────────────────────────────
exports.handler = async function (event) {

  // ① Preflight CORS (المتصفح بيبعت OPTIONS قبل الـ POST)
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  // ② فقط POST مسموح
  if (event.httpMethod !== "POST") {
    return reply(405, { error: "Method Not Allowed" });
  }

  // ③ قراءة API Key من environment variable (مش من المتصفح)
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.error("[iLAW-fn] CLAUDE_API_KEY غير موجود في Environment Variables");
    return reply(500, {
      error: "مفتاح API غير مضبوط على السيرفر — أضف CLAUDE_API_KEY في Netlify Dashboard",
    });
  }

  // ④ تحليل الـ body القادم من frontend
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("[iLAW-fn] body تالف:", e.message);
    return reply(400, { error: "طلب غير صالح — JSON تالف" });
  }

  const { messages, system, max_tokens = 1500, temperature = 0.2 } = body;

  // ⑤ تحقق من وجود messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return reply(400, { error: "messages مطلوبة وتكون array غير فارغة" });
  }

  // ⑥ بناء payload لـ Claude API
  const payload = {
    model: CLAUDE_MODEL,
    max_tokens,
    temperature,
    messages,
    ...(system ? { system } : {}),
  };

  console.log("[iLAW-fn] ▶ إرسال إلى Claude API — عدد الرسائل:", messages.length);

  // ⑦ الاتصال بـ Claude API
  let claudeRes, claudeData;
  try {
    claudeRes = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type":        "application/json",
        "anthropic-version":   "2023-06-01",
        "x-api-key":           apiKey,          // ← المفتاح هنا فقط، على السيرفر
      },
      body: JSON.stringify(payload),
    });

    claudeData = await claudeRes.json();
  } catch (e) {
    console.error("[iLAW-fn] ✖ فشل الاتصال بـ Claude API:", e.message);
    return reply(502, { error: `فشل الاتصال بـ Claude API: ${e.message}` });
  }

  console.log("[iLAW-fn] ◀ رد Claude — status:", claudeRes.status);

  // ⑧ معالجة أخطاء Claude API بالتفصيل
  if (!claudeRes.ok) {
    const errMsg  = claudeData?.error?.message ?? claudeData?.error?.type ?? `HTTP ${claudeRes.status}`;
    const errType = claudeData?.error?.type    ?? "unknown_error";
    console.error("[iLAW-fn] ✖ Claude API error:", claudeRes.status, errMsg);

    const statusMap = {
      401: { status: 401, error: `مفتاح API غير صحيح أو منتهي (401): ${errMsg}` },
      403: { status: 403, error: `ليس لديك صلاحية استخدام هذا النموذج (403): ${errMsg}` },
      429: { status: 429, error: `تجاوزت حد الطلبات المسموح، انتظر قليلاً (429): ${errMsg}` },
      500: { status: 500, error: `خطأ داخلي في خادم Claude (500): ${errMsg}` },
      529: { status: 529, error: `Claude API مشغول حالياً، حاول بعد ثوانٍ (529): ${errMsg}` },
    };

    const mapped = statusMap[claudeRes.status];
    if (mapped) return reply(mapped.status, { error: mapped.error, type: errType });
    return reply(claudeRes.status, { error: `خطأ HTTP ${claudeRes.status}: ${errMsg}`, type: errType });
  }

  // ⑨ استخراج النص من رد Claude
  const text = (claudeData.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  console.log("[iLAW-fn] ✔ تم الرد بنجاح — الطول:", text.length, "حرف");

  // ⑩ إعادة الرد للـ frontend
  return reply(200, { text });
};
