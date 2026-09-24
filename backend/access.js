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

const RULES = {
  // Examples — replace with your real DivOS roles, collections and fields:
  //
  // dispatcher: {
  //   truckplannings: (user) => ({ branchId: user.branchId }),
  //   orders: (user) => ({ branchId: user.branchId }),
  // },
  // employee: {
  //   leaves: (user) => ({ userId: user._id }),
  // },
  //
  // "*" applies to every logged-in user:
  // "*": {
  //   holidays: true,
  // },
};

// Collections nobody reads through the chat, admins included.
const BLOCKED_COLLECTIONS = new Set(
  String(process.env.BLOCKED_COLLECTIONS || "sessions,tokens,otps,refreshtokens")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function adminRoles() {
  return String(process.env.ADMIN_ROLES || "admin,superadmin")
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
  if (BLOCKED_COLLECTIONS.has(collection.toLowerCase())) return null;
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
