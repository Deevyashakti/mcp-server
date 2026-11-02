// Company control counts for the three official questions. Stored once a day
// so a later answer can be compared with the same definition.
const mongo = require("./mongo");

const CHECKS = "assistantchecks";
const NOT_DONE_STATUS = /done|complete|delivered|dispatched/i;
const NOT_DONE_PLACEMENT = /done|complete/i;

function istDay(date = new Date()) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const start = new Date(`${day}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { day, start, end };
}

async function runDailyCheck() {
  const db = await mongo.getDb();
  const { day, start, end } = istDay();
  const [pendingTrucks, ordersToday, onLeave] = await Promise.all([
    db.collection("trucktrips").countDocuments({
      $nor: [
        { status: NOT_DONE_STATUS },
        { placementStatus: NOT_DONE_PLACEMENT },
      ],
    }),
    db.collection("orders").countDocuments({ createdAt: { $gte: start, $lt: end } }),
    db.collection("leaverequests").countDocuments({
      status: "Approved",
      fromDate: { $lte: end },
      toDate: { $gte: start },
    }),
  ]);
  const record = { day, pendingTrucks, ordersToday, onLeave, checkedAt: new Date() };
  await db.collection(CHECKS).updateOne({ day }, { $set: record }, { upsert: true });
  return record;
}

function start() {
  const run = () =>
    runDailyCheck().catch((err) => console.error("Daily check failed:", err.message));
  run();
  setInterval(run, 24 * 60 * 60 * 1000);
}

async function recentChecks(limit = 14) {
  const db = await mongo.getDb();
  return db.collection(CHECKS).find({}).sort({ day: -1 }).limit(limit).toArray();
}

module.exports = { CHECKS, runDailyCheck, start, recentChecks };
