import express from "express";
import axios from "axios";
import { Telegraf } from "telegraf";
import Redis from "ioredis";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const REDIS_URL = process.env.REDIS_URL;

if (!BOT_TOKEN || !BASE_URL || !REDIS_URL) {
  console.error("Missing environment variables");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const redis = new Redis(REDIS_URL);

const FREE_PERIOD = 30 * 60; // 30 دقيقة للإعلان
const REF_BONUS = 10 * 60;   // 10 دقائق لكل دعوة
const DAILY_LIMIT = 10;      // حد يومي للدعوات
const ADMIN_ID = 8287143547;

// =========================
// 📊 الإحصائيات
// =========================

bot.command("stats", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const total = await redis.scard("users");
  const active = await redis.keys("session:*");

  ctx.reply(
    `📊 احصائيات البوت\n\n` +
    `👥 المستخدمين الكلي: ${total}\n` +
    `🛡 النشطين حالياً: ${active.length}`
  );
});

bot.command("active", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const active = await redis.keys("session:*");
  ctx.reply(`🛡 النشطين حالياً: ${active.length}`);
});

// =========================
// عرض رصيد الدعوات
// =========================

bot.command("bonus", async (ctx) => {
  const userId = ctx.from.id;
  const bonus = await redis.get(`bonus:${userId}`);
  const seconds = Number(bonus || 0);

  if (seconds <= 0) {
    return ctx.reply("❌ لا تملك دقائق دعوات حالياً.");
  }

  ctx.reply(`🎁 لديك ${Math.floor(seconds/60)} دقيقة جاهزة للتفعيل.\nاستخدم /activate_bonus لتفعيلها.`);
});

// =========================
// تفعيل يدوي للمكافآت
// =========================

bot.command("activate_bonus", async (ctx) => {
  const userId = ctx.from.id;
  const bonus = Number(await redis.get(`bonus:${userId}`) || 0);

  if (bonus <= 0) {
    return ctx.reply("❌ لا يوجد رصيد دعوات لتفعيله.");
  }

  const currentTTL = await redis.ttl(`session:${userId}`);
  let newTime = bonus;

  if (currentTTL > 0) {
    newTime += currentTTL;
  }

  await redis.set(`session:${userId}`, "1", "EX", newTime);
  await redis.del(`bonus:${userId}`);

  ctx.reply(`✅ تم تفعيل ${Math.floor(newTime/60)} دقيقة حماية.`);
});

// =========================
// /start + نظام الدعوات الجديد
// =========================

bot.start(async (ctx) => {
  const userId = ctx.from.id;

  const isNewUser = !(await redis.sismember("users", userId));
  await redis.sadd("users", userId);

  const referral = ctx.startPayload;

  if (isNewUser && referral && referral !== String(userId)) {
    const refUserId = Number(referral);

    if (!isNaN(refUserId)) {
      const todayKey = `daily_ref:${refUserId}:${new Date().toISOString().slice(0,10)}`;
      const todayCount = Number(await redis.get(todayKey) || 0);

      if (todayCount < DAILY_LIMIT) {
        await redis.incrby(`bonus:${refUserId}`, REF_BONUS);
        await redis.incr(todayKey);
        await redis.expire(todayKey, 86400);

        await bot.telegram.sendMessage(
          refUserId,
          `🎉 دعوة جديدة!\nتم إضافة 10 دقائق إلى رصيدك.\nاستخدم /bonus لعرض الرصيد.`
        ).catch(()=>{});
      }
    }
  }

  ctx.reply("👇 اضغط على زر تحميل الفيديو لفتح الصفحة", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "تحميل الفيديو", web_app: { url: `${BASE_URL}/app` } }]
      ]
    }
  });
});

// =========================
// استقبال الروابط
// =========================

bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  const userId = ctx.from.id;
  const text = ctx.message.text;

  await redis.sadd("users", userId);

  if (!text.includes("tiktok.com")) {
    return ctx.reply("ارسل رابط تيك توك صحيح.");
  }

  const hasAccess = await redis.get(`session:${userId}`);

  if (hasAccess) {
    return downloadVideo(userId, text);
  }

  const msg = await ctx.reply(
    "🔔 لمتابعة التحميل يرجى مشاهدة إعلان قصير.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎥 مشاهدة الإعلان", web_app: { url: `${BASE_URL}/ad` } }]
        ]
      }
    }
  );

  await redis.set(
    `pending:${userId}`,
    JSON.stringify({
      url: text,
      messageId: msg.message_id
    }),
    "EX",
    600
  );
});

// =========================
// تحميل الفيديو
// =========================

async function downloadVideo(userId, url) {
  try {
    const response = await axios.get(
      `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const videoUrl = response.data?.data?.play;
    const musicUrl = response.data?.data?.music;

    if (!videoUrl) {
      return bot.telegram.sendMessage(
        userId,
        "❌ تعذر تحميل الرابط."
      );
    }

    await redis.set(
      `media:${userId}`,
      JSON.stringify({
        videoUrl,
        musicUrl
      }),
      "EX",
      600
    );

    await bot.telegram.sendMessage(
      userId,
      "اختر نوع التحميل:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎬 فيديو", callback_data: "video" },
              { text: "🎵 صوت", callback_data: "audio" }
            ]
          ]
        }
      }
    );

  } catch (e) {
    console.log(e.message);
  }
}

// =========================
// صفحة التحميل
// =========================

app.get("/app", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src='//libtl.com/sdk.js' data-zone='10620995' data-sdk='show_10620995'></script>
</head>
<body>
<script>
const tg = Telegram.WebApp;
tg.expand();
</script>
</body>
</html>`);
});

// =========================
// صفحة الإعلان
// =========================

app.get("/ad", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src='//libtl.com/sdk.js' data-zone='10620995' data-sdk='show_10620995'></script>
</head>
<body>
<script>
const tg = Telegram.WebApp;
tg.expand();

show_10620995().then(() => {
    const userId = tg.initDataUnsafe.user.id;
    fetch("/activate-from-message?user_id=" + userId)
    .then(()=> tg.close());
});
</script>
</body>
</html>`);
});

// =========================
// API
// =========================

app.get("/check-access", async (req, res) => {
  const userId = Number(req.query.user_id);
  const session = await redis.get(`session:${userId}`);
  res.json({ hasAccess: !!session });
});

app.get("/direct-download", async (req, res) => {
  const userId = Number(req.query.user_id);
  const url = req.query.url;
  await downloadVideo(userId, url);
  res.send("ok");
});

app.get("/activate-from-message", async (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId) return res.send("error");

  await redis.set(`session:${userId}`, "1", "EX", FREE_PERIOD);

  const referralLink = `https://t.me/ViroTik_bot?start=${userId}`;

  await bot.telegram.sendMessage(
    userId,
    `🎉 لديك حماية 30 دقيقة!\n\n` +
    `🚀 كل دعوة = 10 دقائق (حد يومي 10 دعوات)\n` +
    `استخدم /bonus لرصيدك\n` +
    `${referralLink}`
  ).catch(()=>{});

  res.send("ok");
});
bot.action("video", async (ctx) => {
  const userId = ctx.from.id;

  const media = await redis.get(`media:${userId}`);

  if (!media) {
    return ctx.answerCbQuery("انتهت صلاحية الرابط");
  }

  const { videoUrl } = JSON.parse(media);

  await ctx.answerCbQuery();
  await bot.telegram.sendVideo(userId, videoUrl);
});

bot.action("audio", async (ctx) => {
  const userId = ctx.from.id;

  const media = await redis.get(`media:${userId}`);

  if (!media) {
    return ctx.answerCbQuery("انتهت صلاحية الرابط");
  }

  const { musicUrl } = JSON.parse(media);

  await ctx.answerCbQuery();

  if (musicUrl) {
    await bot.telegram.sendAudio(userId, musicUrl);
  }
});
// =========================
// Webhook
// =========================

app.post("/webhook", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(`${BASE_URL}/webhook`);
});
