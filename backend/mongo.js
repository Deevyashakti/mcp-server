const path = require("path");
const { MongoClient } = require("mongodb");

let client;
let db;
let connectedUri = "";
let connectError = null;

function loadEnv() {
  require("dotenv").config({
    path: path.join(__dirname, ".env"),
    override: true,
    quiet: true,
  });
}

function mongoUri() {
  loadEnv();
  return String(process.env.MONGODB_URI || "").trim();
}

function mongoDbName() {
  const explicit = String(
    process.env.MONGODB_DB || process.env.DB_NAME || ""
  ).trim();
  if (explicit) return explicit;
  const uri = mongoUri();
  try {
    const path = new URL(uri).pathname.replace(/^\//, "");
    return path.split("?")[0] || "";
  } catch {
    return "";
  }
}

function mongoConfigured() {
  return Boolean(mongoUri() && mongoDbName());
}

function mongoHost(uri) {
  try {
    const normalized = uri
      .replace(/^mongodb\+srv:\/\//i, "https://")
      .replace(/^mongodb:\/\//i, "http://");
    return new URL(normalized).host;
  } catch {
    return "unknown";
  }
}

async function closeClient() {
  if (client) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
  client = null;
  db = null;
  connectedUri = "";
}

async function getDb() {
  const uri = mongoUri();
  const name = mongoDbName();
  if (!uri || !name) {
    const err = new Error("MONGODB_URI and MONGODB_DB are missing in backend/.env");
    err.status = 500;
    throw err;
  }

  if (db && connectedUri === uri) return db;
  await closeClient();

  client = new MongoClient(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await client.connect();
  db = client.db(name);
  connectedUri = uri;
  connectError = null;
  return db;
}

async function listCollections() {
  const database = await getDb();
  return database.listCollections().toArray();
}

function scoreCollectionName(name) {
  const n = name.toLowerCase();
  if (/truck/.test(n) && /plan/.test(n)) return 3;
  if (/dispatch/.test(n) && /plan/.test(n)) return 2;
  if (/plan/.test(n)) return 1;
  return 0;
}

async function findPlanCollection() {
  const cols = await listCollections();
  const ranked = cols
    .map((c) => ({ name: c.name, score: scoreCollectionName(c.name) }))
    .sort((a, b) => b.score - a.score);
  const hit = ranked.find((c) => c.score > 0);
  return hit ? hit.name : ranked[0]?.name || null;
}

function isPendingPlan(doc) {
  const s = String(doc.status || doc.planStatus || "").toLowerCase();
  return !s || /draft|pending|open/.test(s);
}

function isPendingTruck(truck) {
  const p = String(truck.placementStatus || "").toLowerCase();
  const s = String(truck.status || "").toLowerCase();
  if (/done|complete|delivered|dispatched/.test(s) || /done|complete/.test(p)) {
    return false;
  }
  return true;
}

async function getTruckPlanning() {
  const database = await getDb();
  const collectionName = await findPlanCollection();
  if (!collectionName) {
    return { collectionName: null, plans: [], collections: [] };
  }

  const col = database.collection(collectionName);
  const plans = await col
    .find({})
    .sort({ date: -1, updatedAt: -1, createdAt: -1 })
    .limit(50)
    .toArray();

  return { collectionName, plans };
}

async function getOverview() {
  const database = await getDb();
  const cols = await database.listCollections().toArray();
  const names = cols.map((c) => c.name).sort();
  const counts = [];
  for (const name of names) {
    const count = await database.collection(name).estimatedDocumentCount();
    counts.push({ name, count });
  }
  counts.sort((a, b) => b.count - a.count);
  return { db: database.databaseName, host: mongoHost(mongoUri()), collections: counts };
}

function matchCollections(question, collectionNames) {
  const q = question.toLowerCase();
  const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const scored = collectionNames
    .map((name) => {
      const n = name.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (n.includes(t) || t.includes(n.replace(/s$/, ""))) score += 2;
      }
      if (/truck|dispatch|plan/.test(q) && /truck|plan/.test(n)) score += 3;
      if (/order/.test(q) && n.includes("order")) score += 3;
      if (/\buser|people|employee/.test(q) && /user|people/.test(n)) score += 3;
      if (/stock/.test(q) && n.includes("stock")) score += 3;
      if (/leave/.test(q) && n.includes("leave")) score += 3;
      if (/pack/.test(q) && n.includes("pack")) score += 3;
      return { name, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((c) => c.name);
}

async function summarizeCollection(name, limit = 5) {
  const database = await getDb();
  const col = database.collection(name);
  const count = await col.estimatedDocumentCount();
  const docs = await col.find({}).sort({ updatedAt: -1, createdAt: -1 }).limit(limit).toArray();
  return { name, count, docs };
}

async function pingMongo() {
  if (!mongoConfigured()) {
    return { configured: false, connected: false };
  }
  try {
    const database = await getDb();
    await database.command({ ping: 1 });
    const hello = await database.command({ hello: 1 });
    const cols = await database.listCollections().toArray();
    return {
      configured: true,
      connected: true,
      db: database.databaseName,
      host: mongoHost(mongoUri()) || hello.me || null,
      collections: cols.map((c) => c.name),
    };
  } catch (err) {
    connectError = err.message;
    db = null;
    client = null;
    return {
      configured: true,
      connected: false,
      error: err.message,
    };
  }
}

module.exports = {
  mongoConfigured,
  mongoHost,
  mongoUri,
  getDb,
  pingMongo,
  getTruckPlanning,
  getOverview,
  matchCollections,
  summarizeCollection,
  isPendingPlan,
  isPendingTruck,
  connectError: () => connectError,
};
