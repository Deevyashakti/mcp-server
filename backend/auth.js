// Login for existing DivOS users only (no signup), checked against the DivOS
// users collection in MongoDB: either a one-time code sent to their email, or
// Sign in with Google with a matching verified email.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { ObjectId } = require("mongodb");
const mongo = require("./mongo");
const mailer = require("./mailer");
const { redact } = require("./db-tools");

const TOKEN_TTL = process.env.JWT_EXPIRES_IN || "8h";
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();
const OTP_TTL_MINUTES = 10;
const MAX_CODE_TRIES = 5;
const usedChallenges = new Map();

function config() {
  return {
    collection: process.env.AUTH_USERS_COLLECTION || "users",
    emailField: process.env.AUTH_EMAIL_FIELD || "email",
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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function findActiveUserDoc(email) {
  const cfg = config();
  const db = await mongo.getDb();
  const doc = await db.collection(cfg.collection).findOne({
    [cfg.emailField]: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
  });
  return doc && !isInactive(doc) ? doc : null;
}

function hashCode(code, email, jti) {
  return crypto
    .createHmac("sha256", jwtSecret())
    .update(`${jti}|${email}|${code}`)
    .digest("hex");
}

// The code is never stored: the client gets a short-lived signed challenge
// holding an HMAC of it, and sends that back with the code the user typed.
// This keeps OTP login stateless (works on serverless) and writes nothing to
// the DivOS database.
async function requestOtp(email, ip) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, "Enter a valid email address.");
  }
  if (tooManyAttempts(`${ip}|otp-send`) || tooManyAttempts(`otp-send|${email}`)) {
    throw httpError(429, "Too many code requests. Try again in 15 minutes.");
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const jti = crypto.randomUUID();
  const doc = await findActiveUserDoc(email);
  if (doc) {
    await mailer.sendOtp(email, code, OTP_TTL_MINUTES);
  }

  // Same response whether or not the account exists, so emails can't be probed.
  const challenge = jwt.sign({ typ: "otp", email, h: hashCode(code, email, jti) }, jwtSecret(), {
    expiresIn: `${OTP_TTL_MINUTES}m`,
    jwtid: jti,
  });
  return {
    challenge,
    message: `If ${email} has a DivOS account, a ${code.length}-digit code has been sent to it.`,
  };
}

async function verifyOtp(challenge, code, ip) {
  code = String(code || "").replace(/\D/g, "");
  if (!challenge || code.length !== 6) {
    throw httpError(400, "Enter the 6-digit code from your email.");
  }
  if (tooManyAttempts(`${ip}|otp-verify`)) {
    throw httpError(429, "Too many attempts. Try again in 15 minutes.");
  }

  let payload;
  try {
    payload = jwt.verify(String(challenge), jwtSecret());
  } catch {
    throw httpError(401, "This code has expired. Request a new one.");
  }
  if (payload.typ !== "otp" || !payload.jti || !payload.email) {
    throw httpError(401, "Invalid code. Request a new one.");
  }

  const now = Date.now();
  for (const [id, entry] of usedChallenges) {
    if (entry.expires < now) usedChallenges.delete(id);
  }
  const entry = usedChallenges.get(payload.jti) || { tries: 0, used: false, expires: payload.exp * 1000 };
  usedChallenges.set(payload.jti, entry);
  if (entry.used || entry.tries >= MAX_CODE_TRIES) {
    throw httpError(401, "This code can no longer be used. Request a new one.");
  }
  entry.tries += 1;

  const expected = Buffer.from(String(payload.h));
  const actual = Buffer.from(hashCode(code, payload.email, payload.jti));
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw httpError(401, "Incorrect code. Please check your email and try again.");
  }

  const doc = await findActiveUserDoc(payload.email);
  if (!doc) {
    throw httpError(401, "Incorrect code. Please check your email and try again.");
  }
  entry.used = true;
  return issueSession(doc);
}

function issueSession(doc) {
  const user = toUser(doc);
  const token = jwt.sign({ sub: String(doc._id), email: user.email }, jwtSecret(), {
    expiresIn: TOKEN_TTL,
  });
  return { token, user: { name: user.name, email: user.email, role: user.role } };
}

function googleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || "").trim();
}

let googleClient;

// Sign in with Google for existing DivOS users only — there is no signup.
// The Google account's verified email must match an active user in MongoDB.
async function googleLogin(credential, ip) {
  const clientId = googleClientId();
  if (!clientId) {
    const err = new Error("Google login is not configured.");
    err.status = 503;
    throw err;
  }
  credential = String(credential || "");
  if (!credential) {
    const err = new Error("Google credential is required.");
    err.status = 400;
    throw err;
  }
  if (tooManyAttempts(`${ip}|google`)) {
    const err = new Error("Too many login attempts. Try again in 15 minutes.");
    err.status = 429;
    throw err;
  }

  googleClient ||= new OAuth2Client(clientId);
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    const err = new Error("Google sign-in failed. Please try again.");
    err.status = 401;
    throw err;
  }
  if (!payload?.email || payload.email_verified !== true) {
    const err = new Error("Your Google email is not verified.");
    err.status = 401;
    throw err;
  }

  const doc = await findActiveUserDoc(payload.email);
  if (!doc) {
    throw httpError(403, `${payload.email} does not have a DivOS account. Ask your admin for access.`);
  }
  return issueSession(doc);
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
  if (payload.typ === "otp" || !payload.sub) {
    return res.status(401).json({ error: "Please log in." });
  }
  loadUser(payload.sub)
    .then((user) => {
      if (!user) return res.status(401).json({ error: "Account not found or inactive." });
      req.user = user;
      next();
    })
    .catch(next);
}

module.exports = {
  requestOtp,
  verifyOtp,
  googleLogin,
  googleClientId,
  requireAuth,
  findUserByEmail,
};
