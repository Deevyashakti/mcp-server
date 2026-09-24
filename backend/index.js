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
const agent = require("./agent");

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

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

app.post("/api/login", async (req, res) => {
  try {
    const result = await auth.login(req.body?.email, req.body?.password, req.ip);
    return res.json(result);
  } catch (err) {
    const status = err.status || 500;
    return res
      .status(status)
      .json({ error: status === 500 ? `Login failed: ${err.message}.${mongoErrorHint(err)}` : err.message });
  }
});

app.get("/api/me", auth.requireAuth, (req, res) => {
  res.json({ user: { name: req.user.name, email: req.user.email, role: req.user.role } });
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

app.post("/api/chat", auth.requireAuth, async (req, res) => {
  const message = String(req.body?.message || "").trim().slice(0, 4000);
  const sessionId = String(req.body?.sessionId || "default").slice(0, 100);
  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const reply = await agent.ask(req.user, sessionId, message);
    logChat({ email: req.user.email, sessionId, question: message, reply });
    return res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    logChat({ email: req.user.email, sessionId, question: message, error: err.message });
    return res.status(500).json({
      reply: `Sorry, something went wrong: ${err.message}.${mongoErrorHint(err)}`,
    });
  }
});

app.listen(PORT, () => {
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
});
