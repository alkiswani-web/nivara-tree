const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

// ذاكرة محادثة بسيطة على السيرفر (آخر 12 رسالة)
const memory = [];

// ===== Helpers =====
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
    const content = item?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
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
      temperature: 0.6,
      store: false,
    }),
  });

  if (!apiResp.ok) {
    const errText = await apiResp.text();
    throw new Error(errText);
  }

  const data = await apiResp.json();
  return extractOutputText(data);
}

function dataUrlToImageUrl(dataUrl) {
  // data:image/png;base64,AAAA...
  // نرجعها كما هي (Data URL) لأن الـAPI يقبل image_url كـ data URL
  if (typeof dataUrl !== "string") return "";
  if (!dataUrl.startsWith("data:image/")) return "";
  return dataUrl;
}

// ===== Server =====
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ---- UI ----
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

  // ---- Reset memory ----
  if (req.method === "GET" && pathname === "/reset") {
    memory.length = 0;
    sendText(res, 200, "✅ تم مسح ذاكرة الشجرة");
    return;
  }

  // لازم المفتاح لأي AI route
  if (!process.env.OPENAI_API_KEY && (pathname === "/talk" || pathname === "/vision")) {
    sendText(res, 500, "❌ OPENAI_API_KEY مش موجود. حطّه قبل تشغيل السيرفر.");
    return;
  }

  // ---- Talk (Text) ----
  if (req.method === "GET" && pathname === "/talk") {
    const msg = (parsed.query.msg || "").toString().trim();

    if (!msg) {
      sendText(res, 200, "❌ اكتب رسالتك أولاً");
      return;
    }

    const system = {
      role: "system",
      content:
        "أنت شجرة حكيمة وودودة اسمها Nivara. تحكي عربي أردني بسيط ولمسة شاعرية خفيفة. الرد 5-10 سطور. اسأل سؤال متابعة واحد فقط إذا لازم.",
    };

    memory.push({ role: "user", content: msg });
    while (memory.length > 12) memory.shift();

    const input = [system, ...memory];

    try {
      const reply =
        (await callOpenAI(input)) || "❌ ما قدرت أطلع رد. جرّب مرة ثانية.";
      memory.push({ role: "assistant", content: reply });
      while (memory.length > 12) memory.shift();

      sendText(res, 200, reply);
    } catch (e) {
      sendText(res, 500, "❌ " + String(e));
    }
    return;
  }

  // ---- Vision (Image) ----
  if (req.method === "POST" && pathname === "/vision") {
    try {
      const body = await readJsonBody(req);
      const dataUrl = (body.image || "").toString();

      const imageUrl = dataUrlToImageUrl(dataUrl);
      if (!imageUrl) {
        sendText(res, 400, "❌ الصورة لازم تكون Data URL مثل: data:image/...;base64,...");
        return;
      }

      const prompt =
        "حلل الصورة: صف ما ترى بدقة. إذا الصورة لنبتة/شجرة وفيها مشكلة (اصفرار، ذبول، آفة)، أعطِ سبب محتمل ونصيحة عامة قصيرة. احكي بأسلوب Nivara وبعربي بسيط.";

      const input = [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            // ✅ الطريقة الصحيحة: image_url (Data URL)
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ];

      const reply =
        (await callOpenAI(input)) || "❌ ما قدرت أحلل الصورة. جرّب صورة أوضح.";

      sendText(res, 200, reply);
    } catch (e) {
      if (String(e).includes("Payload too large")) {
        sendText(res, 413, "❌ حجم الصورة كبير. جرّب صورة أصغر.");
        return;
      }
      sendText(res, 500, "❌ " + String(e));
    }
    return;
  }

  // ---- 404 ----
  sendText(res, 404, "Not found");
});

// ✅ خلي البورت نفس اللي شغال عندك (3002)
server.listen(3002, () => {
  console.log("Server running on http://localhost:3002");
});
