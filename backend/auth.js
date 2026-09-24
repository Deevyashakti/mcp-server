// Login with the same email + password people use for DivOS, checked against
// the DivOS users collection in MongoDB. Passwords are compared with bcrypt and
// never stored or logged here.
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const mongo = require("./mongo");
const { redact } = require("./db-tools");

const TOKEN_TTL = process.env.JWT_EXPIRES_IN || "8h";
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

function config() {
  return {
    collection: process.env.AUTH_USERS_COLLECTION || "users",
    emailField: process.env.AUTH_EMAIL_FIELD || "email",
    passwordField: process.env.AUTH_PASSWORD_FIELD || "password",
    roleField: process.env.AUTH_ROLE_FIELD || "role",
    nameField: process.env.AUTH_NAME_FIELD || "name",
  };
}

function jwtSecret() {
  const secret = String(process.env.JWT_SECRET || "");
  if (secret.length < 32) {
    throw new Error("JWT_SECRET in backend/.env must be at least 32 characters.");
  }
  return secret;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInactive(doc) {
  if (doc.isActive === false || doc.active === false || doc.isDeleted === true) return true;
  const status = String(doc.status || "").toLowerCase();
  return /inactive|disabled|blocked|deleted|terminated/.test(status);
}

// The user object the rest of the app sees: the DB document minus secrets,
// with role/name/email normalised from the configured field names.
function toUser(doc) {
  const cfg = config();
  const clean = redact(doc);
  return {
    ...clean,
    _id: doc._id,
    email: doc[cfg.emailField],
    name: doc[cfg.nameField] || doc.fullName || doc.username || doc[cfg.emailField],
    role: doc[cfg.roleField],
  };
}

function tooManyAttempts(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { first: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

async function login(email, password, ip) {
  const cfg = config();
  email = String(email || "").trim();
  password = String(password || "");
  if (!email || !password) {
    const err = new Error("Email and password are required.");
    err.status = 400;
    throw err;
  }
  if (tooManyAttempts(`${ip}|${email.toLowerCase()}`)) {
    const err = new Error("Too many login attempts. Try again in 15 minutes.");
    err.status = 429;
    throw err;
  }

  const db = await mongo.getDb();
  const doc = await db.collection(cfg.collection).findOne({
    [cfg.emailField]: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
  });
  const hash = doc?.[cfg.passwordField];
  // Only bcrypt hashes are accepted; a plain-text stored password is never compared.
  const ok =
    typeof hash === "string" && /^\$2[aby]\$/.test(hash) && (await bcrypt.compare(password, hash));
  if (!ok || isInactive(doc)) {
    const err = new Error("Invalid email or password.");
    err.status = 401;
    throw err;
  }

  const user = toUser(doc);
  const token = jwt.sign({ sub: String(doc._id), email: user.email }, jwtSecret(), {
    expiresIn: TOKEN_TTL,
  });
  return { token, user: { name: user.name, email: user.email, role: user.role } };
}

// Reload the user from MongoDB on every request so a deactivated or
// re-roled DivOS account takes effect immediately.
async function loadUser(id) {
  const cfg = config();
  let _id;
  try {
    _id = new ObjectId(id);
  } catch {
    _id = id;
  }
  const db = await mongo.getDb();
  const doc = await db.collection(cfg.collection).findOne({ _id });
  if (!doc || isInactive(doc)) return null;
  return toUser(doc);
}

async function findUserByEmail(email) {
  const cfg = config();
  const db = await mongo.getDb();
  const doc = await db.collection(cfg.collection).findOne({
    [cfg.emailField]: { $regex: `^${escapeRegex(String(email).trim())}$`, $options: "i" },
  });
  if (!doc || isInactive(doc)) return null;
  return toUser(doc);
}

function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Please log in." });

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
  loadUser(payload.sub)
    .then((user) => {
      if (!user) return res.status(401).json({ error: "Account not found or inactive." });
      req.user = user;
      next();
    })
    .catch(next);
}

module.exports = { login, requireAuth, findUserByEmail };
