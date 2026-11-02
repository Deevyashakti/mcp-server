// Office records that the chat assistant must not read back.
// assistantlogs: who asked what, which collections were used, and wrong-answer flags.
// assistantchats: one person's saved chats, so they follow the account.
const mongo = require("./mongo");

const LOGS = "assistantlogs";
const CHATS = "assistantchats";

function clip(value, max) {
  return String(value || "").slice(0, max);
}

function sourceLine(question, collections) {
  const names = [...new Set((collections || []).map((name) => String(name).trim()).filter(Boolean))];
  if (!names.length) return "";
  const q = String(question || "").toLowerCase();
  let meaning = "";
  if (/pending/.test(q) && /truck|trip|gaadi|vehicle/.test(q)) {
    meaning =
      "pending truck means a trip that is not done, complete, delivered, or dispatched, and whose placement is not done or complete";
  } else if (/pending/.test(q) && /plan/.test(q)) {
    meaning = "pending plan means status empty, draft, pending, or open";
  } else if (/leave/.test(q)) {
    meaning = "on leave means an approved leave request whose dates include today";
  } else if (/(aaj|today)/.test(q) && /order/.test(q)) {
    meaning = "today's orders means orders created today";
  }
  const when = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
  const where = names.join(", ");
  return meaning ? `Source: ${where} · ${meaning} · ${when} IST` : `Source: ${where} · ${when} IST`;
}

function withSource(question, reply, collections) {
  const line = sourceLine(question, collections);
  if (!line) return reply;
  return `${String(reply || "").trim()}\n\n${line}`;
}

async function recordQuestion({ user, sessionId, question, collections, reply, error, flagged }) {
  const db = await mongo.getDb();
  await db.collection(LOGS).insertOne({
    userId: user._id,
    email: user.email,
    name: user.name || "",
    role: user.role || "",
    sessionId: clip(sessionId, 100),
    question: clip(question, 4000),
    collections: [...new Set(collections || [])].slice(0, 20),
    reply: reply ? clip(reply, 8000) : undefined,
    error: error ? clip(error, 500) : undefined,
    flagged: Boolean(flagged),
    createdAt: new Date(),
  });
}

function cleanChats(chats) {
  if (!Array.isArray(chats)) return [];
  return chats
    .slice(0, 40)
    .map((chat) => ({
      id: clip(chat?.id, 80),
      title: clip(chat?.title || "Chat", 80),
      updatedAt: Number(chat?.updatedAt) || Date.now(),
      messages: (Array.isArray(chat?.messages) ? chat.messages : []).slice(-30).map((message) => ({
        role: message?.role === "user" ? "user" : "assistant",
        text: clip(message?.text, 4000),
        hadImage: Boolean(message?.hadImage),
        flagged: Boolean(message?.flagged),
      })),
    }))
    .filter((chat) => chat.id);
}

async function loadWorkspace(userId) {
  const db = await mongo.getDb();
  const doc = await db.collection(CHATS).findOne({ userId });
  return { chats: doc?.chats || [], openChatId: doc?.openChatId || "" };
}

async function saveWorkspace(userId, chats, openChatId) {
  const db = await mongo.getDb();
  await db.collection(CHATS).updateOne(
    { userId },
    {
      $set: {
        userId,
        chats: cleanChats(chats),
        openChatId: clip(openChatId, 80),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

module.exports = {
  LOGS,
  CHATS,
  sourceLine,
  withSource,
  recordQuestion,
  loadWorkspace,
  saveWorkspace,
};
