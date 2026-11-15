// Yuna.AI — Telegram webhook (Vercel serverless). Пишет всё из группы «Важное» в память на GitHub
// и сразу отвечает, когда обращаются к Юне. Env: TELEGRAM_TOKEN, GH_TOKEN (fine-grained: Contents RW на agents-town-data + Models read).
const crypto = require("crypto");
const CHAT_ID = -5515794879;
const REPO = process.env.DATA_REPO || "JasurMukham/agents-town-data";
const MODELS = ["openai/gpt-4.1-mini", "openai/gpt-4o-mini"];
const TZ = "Asia/Tashkent";

const tg = (m, body) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${m}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

async function gh(path, opt = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}`, {
    ...opt, headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "yuna-bot", ...(opt.headers || {}) } });
  if (r.status === 404) return null;
  const j = await r.json(); if (!r.ok) { const e = new Error(j.message || r.status); e.status = r.status; throw e } return j;
}
const b64d = s => Buffer.from(s, "base64").toString("utf8");
const b64e = s => Buffer.from(s, "utf8").toString("base64");
async function readText(path) { const f = await gh(path); return f ? { text: b64d(f.content), sha: f.sha } : { text: null, sha: null } }
// read-modify-write с повтором при конфликте
async function update(path, fn, msg) {
  for (let i = 0; i < 4; i++) {
    const { text, sha } = await readText(path);
    const next = fn(text);
    if (next == null || next === text) return text;
    try { await gh(path, { method: "PUT", body: JSON.stringify({ message: msg, content: b64e(next), ...(sha ? { sha } : {}) }) }); return next }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e }
  }
  throw new Error("conflict: " + path);
}

const fmt = (ts, o) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, ...o }).format(new Date(ts * 1000));
const ym = ts => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date(ts * 1000)); return p.slice(0, 7) };
const who = f => f ? [f.first_name, f.last_name].filter(Boolean).join(" ") || f.username || String(f.id) : "?";
function describe(m) {
  let t = m.text || m.caption || "";
  if (m.photo) t = "[фото] " + t; if (m.document) t = `[файл: ${m.document.file_name || "файл"}] ` + t;
  if (m.voice) t = "[голосовое] " + t; if (m.video) t = "[видео] " + t; if (m.sticker) t = `[стикер ${m.sticker.emoji || ""}] ` + t;
  return t.replace(/\s*\n\s*/g, " ⏎ ").trim();
}

// обращение: любая форма «Юна» как отдельное слово, Yuna/Yuno, @бот или ответ на сообщение бота
const NAME_RE = /(^|[^a-zа-яё])(юн(а|у|е|ой|ою|ы|очк[а-яё]*|к[а-яё]*|чик[а-яё]*|ечк[а-яё]*|усик[а-яё]*|ч[а-яё]*)?|yun[ao]\w*)(?![a-zа-яё])/i;
function addressed(m, me) {
  const t = (m.text || m.caption || "");
  if (m.reply_to_message && m.reply_to_message.from && m.reply_to_message.from.username === me) return true;
  if (me && t.toLowerCase().includes("@" + me.toLowerCase())) return true;
  return NAME_RE.test(t);
}

async function ask(messages) {
  for (const model of MODELS) {
    try {
      const r = await fetch("https://models.github.ai/inference/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0.3, response_format: { type: "json_object" } }) });
      if (!r.ok) continue;
      const j = await r.json(); return JSON.parse(j.choices[0].message.content);
    } catch (e) { }
  }
  return null;
}

async function handle(u) {
  const m = u.message || u.edited_message; if (!m || m.chat.id !== CHAT_ID) return;
  const me = process.env.BOT_USERNAME || "super_YunaAI_bot";
  if (m.from && m.from.username === me) return;
  const line = `- ${fmt(m.date, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} ${who(m.from)}${u.edited_message ? " (правка)" : ""}: ${describe(m)} (#${m.message_id})`;
  const memPath = `yuna/memory/${ym(m.date)}.md`;
  await update(memPath, t => (t || `# Память Yuna.AI — группа «Важное», ${ym(m.date)}\n\n`) + line + "\n", "Yuna.AI: память группы");
  if (u.edited_message || !addressed(m, me)) return;

  const [tasksF, yunaF, memF] = await Promise.all([readText("yuna/tasks.json"), readText("reports/yuna.json"), readText(memPath)]);
  let tasks = { tasks: [] }; try { if (tasksF.text) tasks = JSON.parse(tasksF.text) } catch (e) { }
  let owners = ""; try {
    const list = await gh("owners"); for (const f of (list || []).filter(x => x.name.endsWith(".json"))) {
      const o = JSON.parse((await readText("owners/" + f.name)).text);
      owners += `${o.display_name || f.name}: ` + (o.offices || []).map(of => `${of.name} [${(of.agents || []).map(a => `${a.name} (id ${a.id})`).join(", ")}]`).join("; ") + "\n";
    } } catch (e) { }
  let yuna = {}; try { yuna = JSON.parse(yunaF.text || "{}") } catch (e) { }
  const open = (tasks.tasks || []).filter(t => t.status === "open");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const sys = `Ты — Yuna.AI, помощница Жасура и его друга Амира в их Telegram-группе «Важное». Отвечай по-русски, коротко (1–4 строки), тепло, от первого лица в женском роде. Слово «коллеги» не используй. Ничего не выдумывай: про проекты знаешь только то, что ниже. Сегодня ${today} (Ташкент).
Ты ведёшь список задач. Если тебя просят запомнить/записать/напомнить — добавь задачу. Если говорят, что сделано или отменить — закрой подходящую по id. Если спрашивают про задачи — перечисли открытые. На приветствие — ответь и кратко скажи, что умеешь.
Верни СТРОГО JSON: {"reply":"текст ответа","add":[{"text":"суть","owner":"Жасур|Амир|Юна|имя агента","project":"или null","due":"YYYY-MM-DD или null"}],"done":["id"],"cancel":["id"]}.
Здания и агенты городка:\n${owners || "(нет данных)"}\nПоследняя вечерняя сводка:\n${yuna.summary || "(ещё не было)"}\nОткрытые задачи:\n${open.map(t => `${t.id}: ${t.owner}: ${t.text}${t.due ? " до " + t.due : ""}`).join("\n") || "(нет)"}\nПоследние сообщения группы:\n${(memF.text || "").trim().split("\n").slice(-25).join("\n")}`;
  const res = await ask([{ role: "system", content: sys }, { role: "user", content: `${who(m.from)}: ${m.text || m.caption || describe(m)}` }]);
  let reply = res && res.reply ? String(res.reply) : "Записала! Разберу подробно в вечерней сводке в 20:52.";
  if (res && ((res.add || []).length || (res.done || []).length || (res.cancel || []).length)) {
    await update("yuna/tasks.json", t => {
      let d = { tasks: [] }; try { if (t) d = JSON.parse(t) } catch (e) { }
      let n = d.tasks.reduce((mx, x) => Math.max(mx, parseInt(String(x.id).slice(1)) || 0), 0);
      const now = new Date().toISOString();
      for (const a of res.add || []) if (a && a.text) d.tasks.push({ id: "t" + (++n), text: a.text, by: who(m.from), owner: a.owner || null, project: a.project || null, due: a.due || null, status: "open", created_at: now, done_at: null, msg_id: m.message_id });
      for (const [ids, st] of [[res.done || [], "done"], [res.cancel || [], "cancelled"]]) for (const id of ids) { const x = d.tasks.find(t => t.id === id && t.status === "open"); if (x) { x.status = st; x.done_at = now } }
      return JSON.stringify(d, null, 1);
    }, "Yuna.AI: задачи из группы");
    try { const t2 = JSON.parse((await readText("yuna/tasks.json")).text); const op = t2.tasks.filter(t => t.status === "open").map(t => `${t.owner || "—"}: ${t.text}${t.due ? " до " + t.due : ""}`);
      await update("reports/yuna.json", t => { let r = {}; try { r = JSON.parse(t || "{}") } catch (e) { } r.tasks = op; return JSON.stringify(r, null, 1) }, "Yuna.AI: открытые задачи"); } catch (e) { }
  }
  await tg("sendMessage", { chat_id: CHAT_ID, text: reply.slice(0, 4000), reply_to_message_id: m.message_id, allow_sending_without_reply: true });
  await update(memPath, t => (t || "") + `- ${fmt(Math.floor(Date.now() / 1000), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} Yuna.AI: ${reply.replace(/\s*\n\s*/g, " ⏎ ")}\n`, "Yuna.AI: память группы");
}

module.exports = async (req, res) => {
  const secret = crypto.createHash("sha256").update(String(process.env.TELEGRAM_TOKEN || "")).digest("hex").slice(0, 40);
  if (req.method === "GET") { res.status(200).json({ ok: true, yuna: "alive", configured: !!(process.env.TELEGRAM_TOKEN && process.env.GH_TOKEN) }); return }
  if (req.headers["x-telegram-bot-api-secret-token"] !== secret) { res.status(401).end(); return }
  try { let u = req.body; if (typeof u === "string") u = JSON.parse(u); await handle(u) } catch (e) { console.error(e) }
  res.status(200).json({ ok: true });
};
module.exports.addressed = addressed;
