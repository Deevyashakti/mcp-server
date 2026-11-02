// Who can see which collections. Enforced in code on every query — Claude
// never decides access.
//
// - Roles listed in ADMIN_ROLES (backend/.env) can read every collection.
// - Every other role can read only what RULES grants it below. A collection
//   not listed for a role is invisible to that role.
//
// Rule values:
//   true                 -> whole collection
//   (user) => ({ ... })  -> only documents matching the returned MongoDB filter
//
// `user` is the logged-in user's document from the users collection
// (sensitive fields removed), so you can use any field on it, e.g. user.branchId.

const office = require("./office");

// Collections every logged-in office user can read. Applicant pay and login
// records are not in this list.
const OFFICE_COLLECTIONS = [
  "truckplans",
  "trucktrips",
  "trucks",
  "truckmasterconfigs",
  "orders",
  "orderclaims",
  "clients",
  "consignees",
  "stockplannings",
  "stockallocations",
  "stockrecoveries",
  "stockrecoverysfgs",
  "pendingstocks",
  "bulkpackings",
  "bundlepackings",
  "holidays",
  "leavetypes",
];

function allow(names) {
  return Object.fromEntries(names.map((name) => [name, true]));
}

// Role names are matched after lowercasing. "*" applies to every logged-in user.
// Admin, Owner, and Function Head are full readers via ADMIN_ROLES, except blocked collections.
const RULES = {
  "*": allow(OFFICE_COLLECTIONS),
  "team member": {
    leaverequests: (user) => ({ userId: user._id }),
  },
  "team leader": {
    leaverequests: true,
  },
  hr: {
    leaverequests: true,
    people: true,
  },
};

// Collections nobody reads through the chat, admins included.
const BLOCKED_COLLECTIONS = new Set(
  String(process.env.BLOCKED_COLLECTIONS || "sessions,tokens,otps,refreshtokens,loginsessions,assistantlogs,assistantchats")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function adminRoles() {
  return String(process.env.ADMIN_ROLES || "admin,owner,function head")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function userRoles(user) {
  const raw = user?.role ?? user?.roles;
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((r) => (r && typeof r === "object" ? r.name || r.role || r.code : r))
    .filter(Boolean)
    .map((r) => String(r).toLowerCase());
}

function isAdmin(user) {
  const admins = adminRoles();
  return userRoles(user).some((r) => admins.includes(r));
}

// Returns a MongoDB filter to AND into every query, {} for full access,
// or null when the user may not read the collection at all.
function filterFor(user, collection) {
  if (!user) return null;
  const name = collection.toLowerCase();
  if (
    name === office.LOGS ||
    name === office.CHATS ||
    name === "assistantchecks" ||
    name === "assistantcheckpoints" ||
    name === "assistantcheckpointwrites"
  ) {
    return null;
  }
  if (BLOCKED_COLLECTIONS.has(name)) return null;
  if (isAdmin(user)) return {};

  const filters = [];
  for (const role of [...userRoles(user), "*"]) {
    const rule = RULES[role]?.[collection];
    if (rule === true) return {};
    if (typeof rule === "function") filters.push(rule(user));
  }
  if (!filters.length) return null;
  return filters.length === 1 ? filters[0] : { $or: filters };
}

module.exports = { filterFor, isAdmin, userRoles };
