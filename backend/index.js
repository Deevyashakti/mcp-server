require("dotenv").config({
  path: require("path").join(__dirname, ".env"),
  override: true,
});
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mongo = require("./mongo");
const auth = require("./auth");
const access = require("./access");
const dbTools = require("./db-tools");
const agent = require("./agent");
const office = require("./office");
const checks = require("./checks");

const app = express();
const PORT = process.env.PORT || 5050;

const corsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin / server-to-server / local tools (no Origin header)
      if (!origin) return callback(null, true);
      if (corsOrigins.length === 0) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      try {
        const host = new URL(origin).hostname;
        if (host === "localhost" || host.endsWith(".vercel.app")) {
          return callback(null, true);
        }
      } catch {
        /* ignore invalid Origin */
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "8mb" }));

function mongoHostLabel() {
  return mongo.mongoHost(mongo.mongoUri());
}

function truckLabel(truck, i) {
  const name =
    truck.truckLabel ||
    truck.vehicleNo ||
    truck.truckNumber ||
    truck.planId ||
    `Truck ${i + 1}`;
  const dest = truck.destination || truck.city || "";
  return dest ? `${name} → ${dest}` : name;
}

function answerFromPlans(message, { collectionName, plans }) {
  const q = message.toLowerCase();
  if (!plans.length) {
    return `No documents found in MongoDB collection "${collectionName || "unknown"}".`;
  }

  const pendingPlans = plans.filter(mongo.isPendingPlan);
  const trucks = plans.flatMap((p) =>
    Array.isArray(p.trucks) ? p.trucks : []
  );
  const pendingTrucks = trucks.filter(mongo.isPendingTruck);

  if (/how many/.test(q) && /pending/.test(q)) {
    if (/truck plans?/.test(q) && !/\btrucks\b/.test(q)) {
      return `There ${pendingPlans.length === 1 ? "is" : "are"} ${pendingPlans.length} pending truck plan${pendingPlans.length === 1 ? "" : "s"} in MongoDB (${collectionName}).`;
    }
    return `There ${pendingTrucks.length === 1 ? "is" : "are"} ${pendingTrucks.length} pending truck${pendingTrucks.length === 1 ? "" : "s"} in MongoDB.`;
  }

  const latest = plans[0];
  const latestTrucks = Array.isArray(latest.trucks) ? latest.trucks : [];
  const lines = [
    `Source: MongoDB ${mongoHostLabel()} collection "${collectionName}"`,
    `Latest plan: ${latest.planName || latest._id} (${latest.status || "unknown"})`,
    `Plans in sample: ${plans.length}`,
    `Pending plans: ${pendingPlans.length}`,
    `Pending trucks: ${pendingTrucks.length}`,
  ];
  latestTrucks.slice(0, 10).forEach((t, i) => lines.push(`- ${truckLabel(t, i)}`));
  return lines.join("\n");
}

const LOG_DIR = path.join(__dirname, "logs");

// Every question/answer is logged so wrong answers can be reviewed and fixed
// by adding a line to knowledge.md.
function logChat(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, "chat-log.jsonl"),
      JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n"
    );
  } catch (err) {
    console.error("Could not write chat log:", err.message);
  }
}

function mongoErrorHint(err) {
  if (!/timed out|ECONNREFUSED|ENOTFOUND/i.test(err.message)) return "";
  return ` Cannot reach MongoDB at ${mongoHostLabel()} from this machine. Open port 27017 on that server for this machine's IP, use a VPN/SSH tunnel, or run the backend on the database server.`;
}

function loginRoute(handler) {
  return async (req, res) => {
    try {
      return res.json(await handler(req));
    } catch (err) {
      const status = err.status || 500;
      return res
        .status(status)
        .json({ error: status === 500 ? `Login failed: ${err.message}.${mongoErrorHint(err)}` : err.message });
    }
  };
}

app.post("/api/login/otp/request", loginRoute((req) => auth.requestOtp(req.body?.email, req.ip)));
app.post(
  "/api/login/otp/verify",
  loginRoute((req) => auth.verifyOtp(req.body?.challenge, req.body?.code, req.ip))
);
app.post("/api/login/google", loginRoute((req) => auth.googleLogin(req.body?.credential, req.ip)));

app.get("/api/auth/config", (req, res) => {
  res.json({ googleClientId: auth.googleClientId() || null });
});

app.get("/api/me", auth.requireAuth, (req, res) => {
  res.json({ user: { name: req.user.name, email: req.user.email, role: req.user.role } });
});

app.get("/api/chats", auth.requireAuth, async (req, res) => {
  try {
    return res.json(await office.loadWorkspace(req.user._id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put("/api/chats", auth.requireAuth, async (req, res) => {
  try {
    await office.saveWorkspace(req.user._id, req.body?.chats, req.body?.openChatId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat/flag", auth.requireAuth, async (req, res) => {
  try {
    await office.recordQuestion({
      user: req.user,
      sessionId: req.body?.sessionId,
      question: req.body?.question,
      reply: req.body?.reply,
      collections: [],
      flagged: true,
    });
    logChat({ email: req.user.email, sessionId: req.body?.sessionId, question: req.body?.question, flagged: true });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/reviews", auth.requireAuth, async (req, res) => {
  if (!access.isAdmin(req.user)) {
    return res.status(403).json({ error: "Admins only." });
  }
  try {
    const db = await mongo.getDb();
    const flags = await db
      .collection(office.LOGS)
      .find({ flagged: true })
      .sort({ createdAt: -1 })
      .limit(100)
      .project({ name: 1, email: 1, role: 1, question: 1, reply: 1, collections: 1, createdAt: 1 })
      .toArray();
    const daily = await checks.recentChecks();
    return res.json({ flags, daily });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", async (req, res) => {
  const mongoStatus = await mongo.pingMongo();
  res.json({
    ok: true,
    mongo: mongoStatus,
  });
});

app.get("/api/hello", (req, res) => {
  const name = req.query.name || "world";
  res.json({ message: `Hello, ${name}` });
});

app.get("/api/truck-planning", auth.requireAuth, async (req, res) => {
  // Returns unfiltered plans, so admins only.
  if (!access.isAdmin(req.user)) {
    return res.status(403).json({ reply: "Admins only." });
  }
  try {
    if (!mongo.mongoConfigured()) {
      return res.status(500).json({
        reply: "Add MONGODB_URI and MONGODB_DB to backend/.env",
      });
    }
    const data = await mongo.getTruckPlanning();
    return res.json({
      source: "mongodb",
      reply: answerFromPlans("summary", data),
      collectionName: data.collectionName,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ reply: err.message });
  }
});

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function readImage(body) {
  if (!body?.image) return null;
  const mediaType = String(body.image.mediaType || "");
  const data = String(body.image.data || "").replace(/\s/g, "");
  if (!IMAGE_TYPES.has(mediaType) || !/^[A-Za-z0-9+/=]+$/.test(data)) {
    const err = new Error("Use a JPG, PNG, WEBP, or GIF image.");
    err.status = 400;
    throw err;
  }
  if (data.length > 5_000_000) {
    const err = new Error("That image is too large. Keep it under 3.5 MB.");
    err.status = 413;
    throw err;
  }
  return { mediaType, data };
}

app.post("/api/chat", auth.requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || "default").slice(0, 100);
  let message = String(req.body?.message || "").trim().slice(0, 4000);
  let image = null;
  try {
    image = readImage(req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (!message && !image) {
    return res.status(400).json({ error: "message is required" });
  }
  if (!message) message = "Read this image.";

  const refusal = dbTools.writeRefusal(message);
  if (refusal) {
    logChat({ email: req.user.email, sessionId, question: message, reply: refusal, readOnly: true });
    office
      .recordQuestion({
        user: req.user,
        sessionId,
        question: message,
        collections: [],
        reply: refusal,
      })
      .catch((err) => console.error("Could not write question record:", err.message));
    return res.json({ reply: refusal });
  }

  try {
    const result = await agent.ask(req.user, sessionId, message, image);
    const reply = result.failed
      ? result.reply
      : office.withSource(message, result.reply, result.collections);
    logChat({
      email: req.user.email,
      sessionId,
      question: message,
      collections: result.collections,
      image: Boolean(image),
      reply,
    });
    office.recordQuestion({
      user: req.user,
      sessionId,
      question: message,
      collections: result.collections,
      reply,
    }).catch((err) => console.error("Could not write question record:", err.message));
    return res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    logChat({ email: req.user.email, sessionId, question: message, error: err.message });
    office.recordQuestion({
      user: req.user,
      sessionId,
      question: message,
      collections: [],
      error: err.message,
    }).catch(() => {});
    return res.status(500).json({
      reply: `Sorry, something went wrong: ${err.message}.${mongoErrorHint(err)}`,
    });
  }
});

function startLocal() {
  // Express 5 passes listen errors (e.g. port in use) to this callback instead of throwing.
  app.listen(PORT, (err) => {
    if (err) {
      console.error(`Could not start API on port ${PORT}: ${err.message}`);
      process.exit(1);
    }
    console.log(`API running on http://localhost:${PORT}`);
    console.log(
      mongo.mongoConfigured()
        ? "MongoDB: configured"
        : "MongoDB: not configured — set MONGODB_URI and MONGODB_DB"
    );
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("ANTHROPIC_API_KEY: missing — chat will not work until it is set");
    }
    if (String(process.env.JWT_SECRET || "").length < 32) {
      console.warn("JWT_SECRET: missing or shorter than 32 characters — login will not work");
    }
    if (mongo.mongoConfigured()) checks.start();
  });
}

// Vercel imports this file as a serverless handler; only listen when run directly.
if (require.main === module) {
  startLocal();
}

module.exports = app;
