const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5173;
const API_KEY = process.env.SILICONFLOW_API_KEY || "";
const TEXT_MODEL = process.env.SILICONFLOW_TEXT_MODEL || "MiniMaxAI/MiniMax-M2.5";
const VISION_MODEL = process.env.SILICONFLOW_VISION_MODEL || "Qwen/Qwen3.6-35B-A3B";
const ROOT = __dirname;
const NON_STREAM_TIMEOUT_MS = 20000;
const SILICONFLOW_CHAT_URL = "https://api.siliconflow.cn/v1/chat/completions";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".mp4": "video/mp4"
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });

    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}

function readAdsContext() {
  return fs.readFileSync(path.join(ROOT, "ads", "context.txt"), "utf-8").trim();
}

function buildSkipBehaviorText(skipRecords) {
  if (!skipRecords.length) {
    return "当前没有用户跳过记录。请明确说明样本不足，只输出低置信度、保守的偏好判断。";
  }

  return skipRecords
    .map((record, index) => `第${index + 1}次跳过：第${record.adNo}条广告，第${record.second}秒。`)
    .join("\n");
}

function buildVisionInsightsText(visionInsights) {
  if (!visionInsights.length) {
    return "本轮没有视觉模型结论。不要虚构画面细节，只能基于广告上下文和跳过行为保守推断。";
  }

  return visionInsights
    .map((insight, index) => `视觉结论${index + 1}：${insight}`)
    .join("\n");
}

function buildUserPreferencePrompt(contextText, skipRecords, visionInsights = []) {
  return `
你是广告偏好分析专家。请根据广告内容、用户跳过时机和视觉分析结论，推断用户更可能接受什么样的广告表达方式。

【广告上下文】
${contextText}

【用户跳过行为】
${buildSkipBehaviorText(skipRecords)}

【跳过画面分析】
${buildVisionInsightsText(visionInsights)}

【分析原则】
1. 只根据给定证据推断，不要虚构广告内容或用户属性。
2. 如果证据不足，请明确指出“不足以判断”的部分，并降低 confidence。
3. 重点总结用户更容易接受的广告风格，以及更可能触发跳过的风险因素。
4. 如果视觉结论与广告上下文冲突，以视觉结论为优先，同时说明冲突点。

【输出要求】
1. 只输出 JSON，不要输出 Markdown、代码块或额外解释。
2. JSON 结构必须为：
{
  "user_profile_summary": "一句话总结，不超过60字",
  "skip_behavior_insight": ["洞察1", "洞察2"],
  "preferred_ad_traits": ["用户更偏好的广告特征1", "特征2"],
  "disliked_ad_traits": ["更可能触发跳过的特征1", "特征2"],
  "evidence": [
    {
      "source": "skip_record|vision|context",
      "detail": "证据描述"
    }
  ],
  "ad_strategy_suggestion": ["建议1", "建议2", "建议3"],
  "confidence": 0.0
}
3. confidence 取值范围为 0 到 1。
4. 当没有跳过记录时，skip_behavior_insight 和 evidence 也要解释样本不足。`.trim();
}

function buildVisionPrompt(adNo, second) {
  return `
你是广告跳过原因分析助手。你会看到两帧画面：
- 图1：用户点击跳过前约 1 秒的画面
- 图2：用户点击跳过当秒的画面

请对比两帧，只总结用户为什么可能在这一秒想跳过。不要猜测画面之外的剧情。

请输出 3 行纯文本：
1. 前一秒画面：描述最显著的视觉元素、镜头密度、文字/人物/商品露出。
2. 跳过当秒画面：描述最显著的变化。
3. 可能触发跳过的原因：不超过 40 字。

补充信息：第${adNo}条广告，第${second}秒。`.trim();
}

function writeLocalSiliconFlowChunk(res, content, model) {
  const created = Math.floor(Date.now() / 1000);
  const payload = {
    id: "local",
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {
          content: String(content || "")
        },
        finish_reason: null
      }
    ]
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeLocalSiliconFlowDone(res) {
  res.write("data: [DONE]\n\n");
}

async function requestSiliconFlow({
  model,
  messages,
  temperature = 0.2,
  stream = false,
  timeoutMs = NON_STREAM_TIMEOUT_MS
}) {
  if (!API_KEY) {
    throw new Error("Missing SILICONFLOW_API_KEY");
  }

  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(SILICONFLOW_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature,
        stream,
        messages
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SiliconFlow request failed (${response.status}): ${text}`);
    }

    return response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function analyzeUser(skipRecords, visionInsights = []) {
  const prompt = buildUserPreferencePrompt(readAdsContext(), skipRecords, visionInsights);

  if (!API_KEY) {
    return {
      mocked: true,
      note: "Missing SILICONFLOW_API_KEY. Returned prompt preview only.",
      model: TEXT_MODEL,
      prompt_preview: prompt.slice(0, 1800)
    };
  }

  const response = await requestSiliconFlow({
    model: TEXT_MODEL,
    messages: [
      {
        role: "system",
        content: "你是严谨的广告偏好分析 AI，只允许输出合法 JSON。"
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  const data = await response.json();
  return {
    model: TEXT_MODEL,
    raw: data?.choices?.[0]?.message?.content || ""
  };
}

async function streamAnalyzeUser(res, skipRecords, visionInsights = []) {
  const prompt = buildUserPreferencePrompt(readAdsContext(), skipRecords, visionInsights);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();

  if (!API_KEY) {
    res.write(`data: ${JSON.stringify({ error: "Missing SILICONFLOW_API_KEY" })}\n\n`);
    res.end();
    return;
  }

  const response = await requestSiliconFlow({
    model: TEXT_MODEL,
    stream: true,
    timeoutMs: null,
    messages: [
      {
        role: "system",
        content: "你是严谨的广告偏好分析 AI，只允许输出合法 JSON。"
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    res.write(decoder.decode(value, { stream: true }));
  }

  res.end();
}

async function streamAnalyzeSkipVision(res, items) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();

  const safeItems = Array.isArray(items) ? items : [];

  if (!safeItems.length) {
    writeLocalSiliconFlowDone(res);
    res.end();
    return;
  }

  if (!API_KEY) {
    for (const item of safeItems) {
      const adNo = item?.adNo ?? "?";
      const second = item?.second ?? "?";
      writeLocalSiliconFlowChunk(
        res,
        `第${adNo}条广告第${second}秒：未配置 API Key，无法执行视觉分析。`,
        VISION_MODEL
      );
      writeLocalSiliconFlowDone(res);
    }
    res.end();
    return;
  }

  for (const item of safeItems) {
    const adNo = item?.adNo ?? null;
    const second = item?.second ?? null;
    const prevFrame = item?.prevFrame;
    const currFrame = item?.currFrame;

    if (!prevFrame || !currFrame) {
      writeLocalSiliconFlowChunk(
        res,
        "缺少前一秒或当前秒画面，已跳过视觉分析。",
        VISION_MODEL
      );
      writeLocalSiliconFlowDone(res);
      continue;
    }

    const response = await requestSiliconFlow({
      model: VISION_MODEL,
      stream: true,
      timeoutMs: null,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildVisionPrompt(adNo, second) },
            { type: "image_url", image_url: { url: prevFrame } },
            { type: "image_url", image_url: { url: currFrame } }
          ]
        }
      ]
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  }

  res.end();
}

async function analyzeSkipVisionPair({ adNo, second, prevFrame, currFrame }) {
  if (!API_KEY) {
    return `第${adNo}条广告第${second}秒：未配置 API Key，无法执行视觉分析。`;
  }

  const response = await requestSiliconFlow({
    model: VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildVisionPrompt(adNo, second) },
          { type: "image_url", image_url: { url: prevFrame } },
          { type: "image_url", image_url: { url: currFrame } }
        ]
      }
    ]
  });

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function runVisionSelfTest() {
  const tinyImg = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8VfWkAAAAASUVORK5CYII=";
  return analyzeSkipVisionPair({
    adNo: 0,
    second: 0,
    prevFrame: tinyImg,
    currFrame: tinyImg
  });
}

async function runTextSelfTest() {
  const result = await analyzeUser([{ adNo: 1, second: 2 }], [
    "广告1 第2秒：字幕和价格信息突然变多，画面压迫感增强。"
  ]);
  return result.raw || result.prompt_preview || "";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  if (req.url === "/api/model-config" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      apiKeyConfigured: Boolean(API_KEY),
      textModel: TEXT_MODEL,
      visionModel: VISION_MODEL
    });
  }

  if (req.url === "/api/analyze-user" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const skipRecords = Array.isArray(body.skipRecords) ? body.skipRecords : [];
      const visionInsights = Array.isArray(body.visionInsights) ? body.visionInsights : [];
      const result = await analyzeUser(skipRecords, visionInsights);
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  if (req.url === "/api/analyze-user-stream" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const skipRecords = Array.isArray(body.skipRecords) ? body.skipRecords : [];
      const visionInsights = Array.isArray(body.visionInsights) ? body.visionInsights : [];
      await streamAnalyzeUser(res, skipRecords, visionInsights);
      return;
    } catch (err) {
      const message = `流式分析失败：${String(err.message || err)}`;
      if (res.headersSent) {
        res.end(`\n${message}`);
      } else {
        sendText(res, 500, message);
      }
      return;
    }
  }

  if (req.url === "/api/analyze-skip-vision" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const results = [];

      for (const item of items) {
        if (!item?.prevFrame || !item?.currFrame) {
          results.push({
            adNo: item?.adNo ?? null,
            second: item?.second ?? null,
            insight: "缺少前一秒或当前秒画面，已跳过视觉分析。"
          });
          continue;
        }

        const insight = await analyzeSkipVisionPair(item);
        results.push({
          adNo: item.adNo,
          second: item.second,
          insight
        });
      }

      return sendJson(res, 200, { ok: true, model: VISION_MODEL, results });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  if (req.url === "/api/analyze-skip-vision-stream" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      await streamAnalyzeSkipVision(res, items);
      return;
    } catch (err) {
      const message = `视觉流式分析失败：${String(err.message || err)}`;
      if (res.headersSent) {
        res.end(`\n${message}`);
      } else {
        sendText(res, 500, message);
      }
      return;
    }
  }

  if (req.url === "/api/text-self-test" && req.method === "GET") {
    try {
      const content = await runTextSelfTest();
      return sendJson(res, 200, { ok: true, model: TEXT_MODEL, content });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  if (req.url === "/api/vision-self-test" && req.method === "GET") {
    try {
      const insight = await runVisionSelfTest();
      return sendJson(res, 200, { ok: true, model: VISION_MODEL, insight });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  let pathname = req.url;
  try {
    pathname = new URL(req.url, "http://local").pathname;
  } catch {
    pathname = req.url;
  }

  const cleanUrl = pathname === "/" ? "/index.html" : pathname;
  let decodedPath = cleanUrl;
  try {
    decodedPath = decodeURIComponent(cleanUrl);
  } catch {
    return sendText(res, 400, "Bad Request");
  }

  const rootPath = path.resolve(ROOT);
  const filePath = path.resolve(ROOT, "." + decodedPath);

  if (filePath !== rootPath && !filePath.startsWith(rootPath + path.sep)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      return sendText(res, 404, "Not Found");
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const cacheControl = ext === ".html" ? "no-store" : "public, max-age=31536000, immutable";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": cacheControl
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`SiliconFlow text model: ${TEXT_MODEL}`);
  console.log(`SiliconFlow vision model: ${VISION_MODEL}`);
});
