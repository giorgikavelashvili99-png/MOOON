// AI ჩატის სერვერი — Google Gemini API (უფასო დონე). გასაღები ინახება მხოლოდ აქ
// (გარემოს ცვლადში), ბრაუზერში არასდროს ჩანს. დამოკიდებულებები არ სჭირდება (Node 18+).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // მაგ: https://moonfull4k.xyz (თუ Index.html სხვაგან ჰოსტდება)
const MAX_TOKENS = 8192;          // მოდელის ფიქრიც ამ ლიმიტში ითვლება, ამიტომ დიდი მარაგი გვჭირდება
const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;          // ერთი შეტყობინების მაქსიმალური სიგრძე
const RATE_LIMIT = 20;           // მოთხოვნა ...
const RATE_WINDOW_MS = 60_000;   // ... წუთში, ერთ IP-ზე

// სარეზერვო მოდელები: თუ მთავარის უფასო ლიმიტი ამოიწურა, სერვერი თავისით გადადის მსუბუქ მოდელებზე
const FALLBACKS = (process.env.GEMINI_FALLBACKS ||
  "gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-latest,gemini-flash-lite-latest")
  .split(",").map(s => s.trim()).filter(Boolean);
const MODELS = [MODEL, ...FALLBACKS.filter(m => m !== MODEL)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEBUG = process.env.GEMINI_DEBUG === "1"; // 1 = ტექნიკური მიზეზიც გამოჩნდება ჩატში (მხოლოდ გამართვისთვის)
function errMsg(text) {
  try { const j = JSON.parse(text); if (j.error && j.error.message) return String(j.error.message).slice(0, 220); } catch {}
  return String(text || "").slice(0, 220);
}
function retryDelayMs(text) {
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(text || "");
  return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
}
const SEARCH = process.env.GEMINI_SEARCH !== "0"; // Google ძებნა ახალი ინფორმაციისთვის (გამოსართავად: GEMINI_SEARCH=0)

// მოდელს ყოველ მოთხოვნაზე ვეუბნებით დღევანდელ თარიღს, რომ "2024 წელზე" არ დარჩეს
function systemPrompt(tz) {
  let zone = "Asia/Tbilisi";
  if (typeof tz === "string" && tz.length < 60) {
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); zone = tz; } catch {}
  }
  const now = new Date();
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now);
  const year = iso.slice(0, 4);
  return [
    "შენ ხარ MOON AI (ვერსია MOON 1.0), მშვიდი და გასაგები ასისტენტი. თუ გკითხავენ, ვინ შეგქმნა ან რომელ მოდელს ეფუძნები, უპასუხე, რომ MOON AI ხარ და ტექნიკური დეტალები არ იცი. არასოდეს დაასახელო სხვა კომპანია ან მოდელი და არაფერი მოიგონო",
    "დღევანდელი თარიღია " + iso + " (" + weekday + "), დროის სარტყელი: " + zone + ". ახლა " + year + " წელია. არასოდეს თქვა, რომ 2024 ან უფრო ადრეა. შენი სწავლების მონაცემები ძველია, ამიტომ ახალ ამბებზე, ფასებზე, ვერსიებზე და ყველაფერზე, რაც შეიძლებოდა შეცვლილიყო, გამოიყენე ძებნა. თუ ახალი ინფორმაცია ვერ დაადასტურე, პირდაპირ თქვი, რომ ის შეიძლება მოძველებული იყოს.",
    "უპასუხე იმ ენაზე, რომლითაც მომხმარებელი წერს (ნაგულისხმევად ქართულად). იყავი ზუსტი, მკაფიო და არაზედმეტად ვრცელი. ქართული დაწერე გრამატიკულად სწორად და ბუნებრივად, სიტყვა-სიტყვით თარგმანის გარეშე.",
    "სტილი: პასუხი დაწერე დასრულებულად და ლამაზად ჩამოყალიბებულად: ჯერ პირდაპირ და მოკლედ უპასუხე კითხვას, მერე საჭიროებისას დაამატე დეტალები. გრძელ პასუხებში გამოიყენე მოკლე სათაურები (## ...), სიები, **მუქი** მთავარი სიტყვები და შედარებისას ცხრილი. ზედმეტი შესავალი და გამეორება არ გამოიყენო.",
    "ფაილები და კოდი: თუ მომხმარებელი გვერდს, აპლიკაციას, სკრიპტს ან ფაილს ითხოვს (ან კოდი 15 ხაზზე გრძელია), მთლიანი კოდი ჩასვი ერთ ბლოკში და ფაილის სახელი ღობეზე მიუთითე, მაგალითად ```html Index.html ან ```python main.py. ფაილი ნაწილებად არ დაყო. ბლოკის გარეთ ორ-სამ წინადადებაში ახსენი, რას აკეთებს. კოდი ტექსტში აღარ გაიმეორო. მოკლე ილუსტრაციის კოდს (15 ხაზამდე) ფაილის სახელი არ სჭირდება.",
    "შენ შეგიძლია სურათების დახატვაც: ამისთვის მომხმარებელმა უნდა დააჭიროს ველის მარცხენა მხარეს სურათის ღილაკს ან დაწეროს „დამიხატე ...“. არასოდეს თქვა, რომ სურათის გენერირება შეუძლებელია.",
    "ფორმატი: Markdown. არ გამოიყენო LaTeX და $ ფორმულები. ისრებისთვის გამოიყენე → სიმბოლო."
  ].join("\n");
}

// ---------- სარეზერვო მომწოდებლები (Llama / Qwen და სხვ.) ----------
// Gemini-ს ლიმიტი რომ ამოიწურება, სერვერი თავისით გადადის შემდეგზე. გასაღები საჭიროა მხოლოდ იმისთვის, რომელსაც ჩართავ.
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const list = (v, d) => (v || d).split(",").map(x => x.trim()).filter(Boolean);
// Ollama: ღრუბლოვანი (ollama.com + OLLAMA_API_KEY) ან შენი საკუთარი კომპიუტერი (OLLAMA_URL=https://შენი-მისამართი/v1/chat/completions)
const OLLAMA_KEY = process.env.OLLAMA_API_KEY || "";
const OLLAMA_URL = process.env.OLLAMA_URL || (OLLAMA_KEY ? "https://ollama.com/v1/chat/completions" : "");
let ollamaCache = { at: 0, models: [] };
async function ollamaModels() {
  const fixed = list(process.env.OLLAMA_MODELS, "");
  if (fixed.length) return fixed;
  if (Date.now() - ollamaCache.at < 3600_000 && ollamaCache.models.length) return ollamaCache.models;
  try {
    const base = OLLAMA_URL.replace(/\/v1\/chat\/completions.*$/, "");
    const r = await fetch(base + "/api/tags", { headers: OLLAMA_KEY ? { authorization: "Bearer " + OLLAMA_KEY } : {} });
    const j = await r.json();
    const names = (j.models || []).map(m => m.name || m.model).filter(Boolean);
    const size = n => { const m = /(\d+(?:\.\d+)?)b/i.exec(n); return m ? parseFloat(m[1]) : 0; };
    const big = arr => arr.slice().sort((a, b) => size(b) - size(a)); // დიდი მოდელი ქართულს უკეთ წერს
    const pick = [...big(names.filter(n => /qwen|llama/i.test(n))), ...big(names)].filter((n, i, a) => a.indexOf(n) === i).slice(0, 3);
    if (pick.length) ollamaCache = { at: Date.now(), models: pick };
  } catch (e) { note("ollama-tags", 0); }
  return ollamaCache.models;
}
const PROVIDERS = [
  { name: "groq", url: process.env.GROQ_URL || "https://api.groq.com/openai/v1/chat/completions", key: GROQ_KEY,
    models: list(process.env.GROQ_MODELS, "openai/gpt-oss-120b,llama-3.3-70b-versatile,qwen/qwen3.8-27b,llama-3.1-8b-instant") },
  { name: "ollama", url: OLLAMA_URL, key: OLLAMA_KEY || (OLLAMA_URL ? "local" : ""), getModels: ollamaModels },
  { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", key: OPENROUTER_KEY,
    models: list(process.env.OPENROUTER_MODELS, "nvidia/nemotron-3.5-super-vl:free,xingchen-agi/xing4.0-29b-a4b:free") }
].filter(p => p.key);
// რიგი იცვლება ცვლადით, მაგ: FALLBACK_ORDER=ollama,groq,openrouter (პირველი ის, ვინც ქართულს უკეთ წერს)
const ORDER = list(process.env.FALLBACK_ORDER, "groq,ollama,openrouter");
PROVIDERS.sort((x, y) => { const i = ORDER.indexOf(x.name), j = ORDER.indexOf(y.name); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
const HAS_ANY_KEY = () => !!API_KEY || PROVIDERS.length > 0;
const NO_SEARCH_NOTE = "\nქართულად წერე მოკლე, მარტივ და გრამატიკულად სწორ წინადადებებში; იშვიათ ან გაურკვეველ სიტყვებს ერიდე და ისეთი სიტყვა არ მოიგონო, რომელშიც დარწმუნებული არ ხარ. სანამ პასუხს დაწერ, გაიაზრე კითხვა სრულად (მაგალითად, „რა ენები იცი“ ადამიანურ ენებს გულისხმობს, თუ პროგრამირებაზე არ ეკითხებიან), და დაწერილი წინადადებები ბრუნვებისა და ზმნის ფორმების მხრივ გადაამოწმე.\nამ რეჟიმში ინტერნეტ-ძებნა არ გაქვს. თუ ახალ ფაქტს გეკითხებიან, უპასუხე იმით, რაც იცი, და პირდაპირ თქვი, რომ ინფორმაცია შეიძლება მოძველებული იყოს.";

async function openAiChain(system, messages, signal) {
  for (const prov of PROVIDERS) {
    for (const model of (prov.getModels ? await prov.getModels() : prov.models)) {
      try {
        const r = await fetch(prov.url, {
          method: "POST", signal,
          headers: { "content-type": "application/json", ...(prov.key !== "local" ? { authorization: "Bearer " + prov.key } : {}) },
          body: JSON.stringify({
            model, stream: true, max_tokens: 4096, temperature: 0.3, // დაბალი ტემპერატურა = ნაკლები მოგონილი სიტყვა
            ...(/gpt-oss/i.test(model) ? { reasoning_effort: "high" } : {}), // მეტი დაფიქრება = უფრო გასწორებული ტექსტი
            messages: [{ role: "system", content: system + NO_SEARCH_NOTE }, ...messages.map(m => ({ role: m.role, content: m.content }))]
          })
        });
        if (r.ok && r.body) return { r, prov: prov.name, model };
        console.error(prov.name, model, r.status, (await r.text().catch(() => "")).slice(0, 400)); note(prov.name, r.status);
      } catch (e) { if (signal.aborted) return null; console.error(prov.name, model, "კავშირის შეცდომა"); }
    }
  }
  return null;
}

// OpenAI-ფორმატის ნაკადს ვაქცევთ Index.html-ის ფორმატად; <think>...</think> ტექსტს ვმალავთ
async function pipeOpenAi(res, alt, ctrl) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
  let emitted = false, inThink = false, pend = "";
  const out = t => { if (!t) return; emitted = true; res.write("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } }) + "\n\n"); };
  const feed = t => {
    pend += t;
    for (;;) {
      if (inThink) {
        const i = pend.indexOf("</think>");
        if (i < 0) { pend = pend.slice(-8); return; }
        pend = pend.slice(i + 8).replace(/^\s+/, ""); inThink = false;
      } else {
        const i = pend.indexOf("<think>");
        if (i >= 0) { out(pend.slice(0, i)); pend = pend.slice(i + 7); inThink = true; continue; }
        const keep = /<(t(h(i(n(k)?)?)?)?)?$/.exec(pend);
        const cut = keep ? pend.length - keep[0].length : pend.length;
        out(pend.slice(0, cut)); pend = pend.slice(cut); return;
      }
    }
  };
  try {
    const dec = new TextDecoder(); let buf = "";
    const handle = ln => {
      if (!ln.startsWith("data:")) return;
      const d = ln.slice(5).trim();
      if (!d || d === "[DONE]") return;
      try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (typeof t === "string") feed(t); } catch {}
    };
    for await (const chunk of alt.r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(handle);
    }
    handle(buf);
    if (!inThink && pend) out(pend);
  } catch {}
  if (!emitted && !ctrl.signal.aborted) {
    res.write("data: " + JSON.stringify({ type: "error", message: "პასუხი ვერ მივიღე. სცადე თავიდან." }) + "\n\n");
  }
  res.end();
}

// ბოლო შეცდომები (მხოლოდ სტატუსის კოდი), რომ /health-ზე დიაგნოსტიკა გამოჩნდეს; გასაღებები და ტექსტი აქ არ ხვდება
const recent = [];
let lastUsed = "";
const note = (who, status) => { recent.push({ who, status, at: new Date().toISOString() }); if (recent.length > 8) recent.shift(); };

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    if (!arr.some(t => now - t < RATE_WINDOW_MS)) hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

function cors(res, req) {
  if (ALLOWED_ORIGIN && req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    const content = m.content.slice(0, MAX_CHARS);
    if (!content.trim()) continue;
    out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}

async function chat(req, res) {
  cors(res, req);
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return json(res, 429, { error: "ძალიან ბევრი მოთხოვნაა. ერთი წუთით მოიცადე." });
  if (!HAS_ANY_KEY()) return json(res, 500, { error: "სერვისი ახლა მიუწვდომელია." });

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { error: "არასწორი მოთხოვნა." }); }

  const messages = cleanMessages(body.messages);
  if (!messages) return json(res, 400, { error: "შეტყობინებები არასწორია." });

  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());

  const url = (process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com") + "/v1beta/models/" +
    encodeURIComponent(MODEL) + ":streamGenerateContent?alt=sse";
  const system = systemPrompt(body.tz);
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const call = (model, withSearch) => fetch(
    (process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com") + "/v1beta/models/" + encodeURIComponent(model) + ":streamGenerateContent?alt=sse",
    {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { maxOutputTokens: MAX_TOKENS }
      })
    }
  );

  // მოდელებს რიგრიგობით ვცდით: ლიმიტი ამოიწურა (429), გადატვირთულია (5xx) ან ძებნა არ გავიდა (400) — შემდეგი ვარიანტი
  let opened = null, fail = { status: 0, daily: false, zero: false, retryMs: 0, detail: "" };
  try {
    for (let round = 0; round < 2 && !opened && API_KEY; round++) {
      let waitMs = 0;
      for (const model of MODELS) {
        let useSearch = SEARCH;
        for (let k = 0; k < 2 && !opened; k++) {
          const r = await call(model, useSearch);
          if (r.ok) { opened = { up: r, model, usedSearch: useSearch }; break; }
          const text = await r.text().catch(() => "");
          note("gemini", r.status);
          console.error("Gemini", model, useSearch ? "(ძებნით)" : "(ძებნის გარეშე)", r.status, text.slice(0, 1200));
          fail = {
            status: fail.status === 429 ? 429 : r.status, // 429 უფრო მნიშვნელოვანია, ვიდრე ბოლო მოდელის 404
            daily: fail.daily || /PerDay|per day/i.test(text),
            zero: fail.zero || /limit:\s*0\b/.test(text),
            retryMs: Math.max(fail.retryMs || 0, retryDelayMs(text)),
            detail: fail.detail || (model + " " + r.status + ": " + errMsg(text))
          };
          if (r.status === 429) waitMs = Math.max(waitMs, fail.retryMs);
          if (r.status === 400 && useSearch) { useSearch = false; continue; } // იგივე მოდელი, ძებნის გარეშე
          break;
        }
        if (opened) break;
      }
      // მოკლე წუთობრივი ლიმიტი: ცოტას დაველოდოთ და მეორე წრე ვცადოთ
      if (!opened && round === 0 && waitMs > 0 && waitMs <= 12000 && !fail.daily && !ctrl.signal.aborted) await sleep(waitMs + 400);
      else break;
    }
  } catch (e) {
    if (ctrl.signal.aborted) return;
    return json(res, 502, { error: "კავშირი ვერ მოხერხდა. სცადე თავიდან." });
  }

  if (!opened && !ctrl.signal.aborted) {
    const alt = await openAiChain(system, messages, ctrl.signal);
    if (alt) { console.error("გამოყენებულია სარეზერვო:", alt.prov, alt.model); lastUsed = alt.prov + ":" + alt.model; return pipeOpenAi(res, alt, ctrl); }
  }
  if (!opened) {
    // მომხმარებელს მომწოდებლის სახელს ან ტექნიკურ დეტალებს არ ვაჩვენებთ; ისინი მხოლოდ სერვერის ლოგშია
    let msg = "ახლა პასუხის მიღება ვერ მოხერხდა. სცადე რამდენიმე წუთში.";
    if (fail.status === 429) msg = fail.daily ? "დღევანდელი ლიმიტი ამოიწურა. სცადე მოგვიანებით." : "ახლა ძალიან დატვირთულია. სცადე რამდენიმე წამში.";
    if (DEBUG && fail.detail) msg += " [" + fail.detail + "]";
    return json(res, 502, { error: msg });
  }
  const up = opened.up, model = opened.model, usedSearch = opened.usedSearch;
  if (model !== MODEL) console.error("გამოყენებულია სარეზერვო მოდელი:", model);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no"
  });

  // Gemini-ს ნაკადს ვაქცევთ იმ ფორმატად, რომელსაც Index.html კითხულობს
  const sources = new Map(); // ძებნის წყაროები (uri -> სათაური)
  let st = { emitted: false, reason: "", error: "" };
  const send = text => {
    st.emitted = true;
    res.write("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } }) + "\n\n");
  };
  const handle = line => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    try {
      const j = JSON.parse(data);
      if (j.error) { st.error = String(j.error.message || "error").slice(0, 300); return; }
      if (j.promptFeedback && j.promptFeedback.blockReason) st.reason = "BLOCKED_" + j.promptFeedback.blockReason;
      const cand = (j.candidates || [])[0];
      if (!cand) return;
      if (cand.finishReason && cand.finishReason !== "STOP") st.reason = cand.finishReason;
      for (const p of cand.content?.parts || []) if (typeof p.text === "string" && p.text && !p.thought) send(p.text);
      for (const c of cand.groundingMetadata?.groundingChunks || []) {
        const w = c && c.web;
        if (w && typeof w.uri === "string" && /^https?:\/\//.test(w.uri) && !sources.has(w.uri)) {
          sources.set(w.uri, String(w.title || w.uri).slice(0, 120));
        }
      }
    } catch {}
  };
  const pump = async stream => {
    st = { emitted: false, reason: "", error: "" };
    try {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(handle);
      }
      handle(buf);
    } catch {}
  };

  await pump(up);

  // თუ ძებნით პასუხი ცარიელი დაბრუნდა, ავტომატურად ვცადოთ ძებნის გარეშე
  if (!st.emitted && usedSearch && !ctrl.signal.aborted) {
    console.error("ცარიელი პასუხი ძებნით:", st.reason || "-", st.error || "-", "→ ვცდით ძებნის გარეშე");
    try {
      const up2 = await call(model, false);
      if (up2.ok) await pump(up2);
      else console.error("Gemini (ძებნის გარეშე) შეცდომა", up2.status, await up2.text().catch(() => ""));
    } catch {}
  }

  if (!st.emitted) {
    console.error("ცარიელი პასუხი:", st.reason || "-", st.error || "-");
    let message = "AI-მ ცარიელი პასუხი დააბრუნა. სცადე თავიდან.";
    if (st.reason === "MAX_TOKENS") message = "პასუხი ძალიან გრძელი გამოვიდა და ვერ დასრულდა. სცადე უფრო მოკლე კითხვა.";
    else if (/SAFETY|BLOCK|PROHIBITED|RECITATION|SPII/i.test(st.reason)) message = "ამ კითხვაზე პასუხს ვერ გაგცემ. სცადე სხვაგვარად ჩამოაყალიბე.";
    else if (st.error) message = "AI სერვისმა შეცდომა დააბრუნა. სცადე რამდენიმე წუთში.";
    if (!res.writableEnded) res.write("data: " + JSON.stringify({ type: "error", message }) + "\n\n");
  }

  if (sources.size && st.emitted) {
    const list = [...sources].slice(0, 5).map(([uri, title]) => ({ uri, title }));
    res.write("data: " + JSON.stringify({ type: "sources", sources: list }) + "\n\n");
  }
  res.end();
}

const INDEX = path.join(__dirname, "Index.html");

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS" && url === "/api/chat") {
    cors(res, req);
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/api/chat") return chat(req, res);

  if (req.method === "GET" && url === "/health") {
    return json(res, 200, { ok: true, version: "fallback-3", lastFallback: lastUsed,
      keys: { gemini: !!API_KEY, groq: !!GROQ_KEY, ollama: !!OLLAMA_URL, openrouter: !!OPENROUTER_KEY }, recentErrors: recent });
  }

  if (req.method === "GET" && (url === "/" || url === "/Index.html" || url === "/index.html")) {
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); return res.end("Index.html not found"); }
      // no-cache: ბრაუზერი ყოველთვის უახლეს ვერსიას იღებს განახლების შემდეგ
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("AI ჩატი გაშვებულია: http://localhost:" + PORT);
  if (!HAS_ANY_KEY()) console.warn("გაფრთხილება: არც ერთი API გასაღები არ არის დაყენებული.");
});
