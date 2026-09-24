// Reset one DivOS user's password directly in MongoDB.
// Usage (from the backend folder):  node scripts/reset-password.js you@deevyashakti.com
// The new password is typed hidden and never printed. The hash uses the same
// bcrypt format and cost as the user's existing hash so DivOS keeps accepting it.
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
  override: true,
  quiet: true,
});
const readline = require("readline");
const bcrypt = require("bcryptjs");
const mongo = require("../mongo");

const collection = process.env.AUTH_USERS_COLLECTION || "users";
const emailField = process.env.AUTH_EMAIL_FIELD || "email";
const passwordField = process.env.AUTH_PASSWORD_FIELD || "password";

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else if (!/[\r\n]/.test(s)) rl.output.write("*");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

(async () => {
  const email = String(process.argv[2] || "").trim();
  if (!email) {
    console.log("Usage: node scripts/reset-password.js you@deevyashakti.com");
    process.exit(1);
  }

  const db = await mongo.getDb();
  const users = db.collection(collection);
  const matches = await users
    .find({ [emailField]: { $regex: `^${escapeRegex(email)}$`, $options: "i" } })
    .limit(2)
    .toArray();
  if (matches.length !== 1) {
    console.log(matches.length ? `More than one user matches ${email}; not changing anything.` : `No user found with ${emailField} = ${email}.`);
    process.exit(1);
  }
  const user = matches[0];

  const current = user[passwordField];
  const m = typeof current === "string" && current.match(/^\$(2[aby])\$(\d{2})\$/);
  if (!m) {
    console.log(`The "${passwordField}" field of this user is not a bcrypt hash, so DivOS may hash passwords differently. Not changing anything.`);
    process.exit(1);
  }
  const [, prefix, cost] = m;
  console.log(`Found user: ${user.name || user.fullName || email} (${user._id})`);
  console.log(`Existing hash: bcrypt $${prefix}$, cost ${cost}`);

  const pw1 = await ask("New password: ", { hidden: true });
  const pw2 = await ask("Repeat new password: ", { hidden: true });
  if (pw1 !== pw2) {
    console.log("Passwords do not match. Nothing changed.");
    process.exit(1);
  }
  if (pw1.length < 8) {
    console.log("Use at least 8 characters. Nothing changed.");
    process.exit(1);
  }

  const confirm = await ask(`Type YES to change the DivOS password for ${email}: `);
  if (confirm.trim() !== "YES") {
    console.log("Cancelled. Nothing changed.");
    process.exit(0);
  }

  // bcryptjs produces $2b$; keep the prefix DivOS already uses.
  const hash = bcrypt.hashSync(pw1, Number(cost)).replace(/^\$2[aby]\$/, `$${prefix}$`);
  const result = await users.updateOne({ _id: user._id }, { $set: { [passwordField]: hash } });
  console.log(result.modifiedCount === 1 ? "Password updated. Log in with the new password." : "No change was made.");
  process.exit(0);
})().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
