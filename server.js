const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

const memory = []; // آخر 12 رسالة

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", (e) => reject(e));
  });
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const out = data?.output;
  if (!Array.isArray(out)) return "";
  let text = "";
  for (const item of out) {
    if (Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") text += c.text;
      }
    }
  }
  return text.trim();
}

async function callOpenAI(input) {
  const apiResp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.1-chat-latest",
      input,
      store: false,
      // ⚠️ لا نستخدم temperature (غير مدعوم أحيانًا على هذا الموديل)
    }),
  });

  if (!apiResp.ok) {
    const errText = await apiResp.text();
    throw new Error(errText);
  }

  const data = await apiResp.json();
  return extractOutputText(data);
}

function modePrompt(mode) {
  // Context Mode
  if (mode === "teach") {
    return "وضعك: تعليمي. اشرح بشكل واضح وبنقاط قصيرة، واذكر مصطلح إنجليزي مهم بين قوسين عند الحاجة.";
  }
  if (mode === "eco") {
    return "وضعك: بيئي/زراعي. ركّز على نصائح نباتية واقعية، تحذيرات آمنة، وخطوات عملية.";
  }
  if (mode === "coach") {
    return "وضعك: إرشادي. ردود داعمة وعملية، بدون علاج نفسي أو تشخيص طبي، وخليك لطيف ومباشر.";
  }
  return "وضعك: عام.";
}

// ===== Server =====
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // UI
  if (req.method === "GET" && pathname === "/") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      sendText(res, 500, "❌ UI file missing: public/index.html\n" + String(e));
    }
    return;
  }

  // Reset memory
  if (req.method === "GET" && pathname === "/reset") {
    memory.length = 0;
    sendText(res, 200, "✅ تم مسح ذاكرة الشجرة");
    return;
  }

  // API key required
  if (!process.env.OPENAI_API_KEY && (pathname === "/talk" || pathname === "/vision")) {
    sendText(res, 500, "❌ OPENAI_API_KEY مش موجود على السيرفر");
    return;
  }

  // TALK -> JSON response (reply + tag + reason?)
  if (req.method === "GET" && pathname === "/talk") {
    const msg = (parsed.query.msg || "").toString().trim();
    const mode = (parsed.query.mode || "general").toString();
    const explain = (parsed.query.explain || "0").toString() === "1";

    if (!msg) {
      sendJson(res, 200, { reply: "❌ اكتب رسالتك أولاً", tag: "error", why: "" });
      return;
    }

    const system = {
      role: "system",
      content:
        "أنت شجرة حكيمة وودودة اسمها Nivara. تحكي عربي أردني بسيط ولمسة شاعرية خفيفة. ممنوع تعطي نصائح خطرة أو تعليمات ضارة. إذا موضوع طبي/قانوني: نصيحة عامة + توجيه لمختص. اجعل الرد مختصر 6-10 أسطر.",
    };

    const modeLine = modePrompt(mode);

    // نخزن المستخدم
    memory.push({ role: "user", content: msg });
    while (memory.length > 12) memory.shift();

    // نطلب من الـAI يرجع JSON منظم
    const jsonInstruction = `
ارجع النتيجة بصيغة JSON فقط (بدون أي نص خارج JSON) بالشكل التالي:
{
  "reply": "نص الرد",
  "tag": "advice|warning|info|answer",
  "why": "سطر واحد يشرح سبب الرد (اختياري)"
}

قواعد:
- tag = advice إذا في خطوات/نصائح
- tag = warning إذا في تحذير سلامة/خطر/ضرورة مختص
- tag = info إذا معلومات عامة
- tag = answer إذا جواب مباشر بدون نصائح كثيرة
- "why" املأه فقط إذا المستخدم طلب explain = 1 وإلا خليه فارغ.
- حافظ على شخصية Nivara.
`;

    const input = [
      system,
      { role: "system", content: modeLine },
      ...memory,
      { role: "system", content: jsonInstruction + (explain ? "\nالمستخدم يريد explain=1، املأ why." : "\nexplain=0، خلي why فارغ.") },
    ];

    try {
      const raw = await callOpenAI(input);

      // محاولة parse JSON (مع fallback)
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { reply: raw, tag: "answer", why: "" };
      }

      // نخزن رد الشجرة كنص فقط بالذاكرة (مشان السياق)
      memory.push({ role: "assistant", content: data.reply || raw });
      while (memory.length > 12) memory.shift();

      sendJson(res, 200, {
        reply: data.reply || raw,
        tag: data.tag || "answer",
        why: explain ? (data.why || "") : "",
      });
    } catch (e) {
      sendJson(res, 500, { reply: "❌ " + String(e), tag: "error", why: "" });
    }
    return;
  }

  // VISION -> JSON response (reply + tag + why?)
  if (req.method === "POST" && pathname === "/vision") {
    try {
      const body = await readJsonBody(req);
      const dataUrl = (body.image || "").toString();
      const mode = (body.mode || "general").toString();
      const explain = String(body.explain || "0") === "1";

      if (!dataUrl.startsWith("data:image/")) {
        sendJson(res, 400, { reply: "❌ ارفع صورة صحيحة", tag: "error", why: "" });
        return;
      }

      const modeLine = modePrompt(mode);

      const prompt =
        "حلل الصورة: صف ما ترى بدقة. إذا الصورة لنبتة/شجرة وفيها مشكلة (اصفرار/ذبول/آفة/تعفن)، أعطِ سبب محتمل ونصيحة عامة آمنة قصيرة. لا تعطي تشخيص نهائي، وخليها إرشادات عامة.";

      const jsonInstruction = `
ارجع JSON فقط:
{
  "reply": "التحليل",
  "tag": "advice|warning|info|answer",
  "why": "سطر واحد يشرح سبب التحليل (اختياري)"
}
طبق نفس قواعد tag السابقة.
"why" فقط إذا explain=1 وإلا فارغ.
`;

      const input = [
        { role: "system", content: "أنت Nivara: شجرة حكيمة." },
        { role: "system", content: modeLine },
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl }, // ✅ Data URL
          ],
        },
        { role: "system", content: jsonInstruction + (explain ? "\nexplain=1 املأ why." : "\nexplain=0 خلي why فارغ.") },
      ];

      const raw = await callOpenAI(input);

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { reply: raw, tag: "info", why: "" };
      }

      sendJson(res, 200, {
        reply: data.reply || raw,
        tag: data.tag || "info",
        why: explain ? (data.why || "") : "",
      });
    } catch (e) {
      if (String(e).includes("Payload too large")) {
        sendJson(res, 413, { reply: "❌ حجم الصورة كبير. جرّب صورة أصغر.", tag: "warning", why: "" });
        return;
      }
      sendJson(res, 500, { reply: "❌ " + String(e), tag: "error", why: "" });
    }
    return;
  }

  // 404
  sendText(res, 404, "Not found");
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
