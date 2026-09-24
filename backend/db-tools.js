// Read-only MongoDB helpers used by the chat agent and the MCP server.
// Every query goes through the access filter for the current user, and
// write/code-execution operators are rejected before anything reaches MongoDB.
const { EJSON } = require("mongodb").BSON;
const mongo = require("./mongo");
const access = require("./access");

const MAX_FIND_LIMIT = 50;
const MAX_AGG_RESULTS = 200;
const MAX_OUTPUT_CHARS = 20000;
const QUERY_TIMEOUT_MS = 15000;

// Operators that write data or run arbitrary JavaScript on the server.
const FORBIDDEN_OPERATORS = new Set([
  "$out",
  "$merge",
  "$where",
  "$function",
  "$accumulator",
]);
// Stages that read another collection; that collection's access rules would be bypassed.
const CROSS_COLLECTION_STAGES = new Set(["$lookup", "$graphLookup", "$unionWith"]);

const SENSITIVE_FIELD = /password|passwd|^pwd$|^pass$|token|secret|^otp|hash|salt|api_?key/i;

function assertSafe(value, { allowCrossCollection }) {
  // "$password" style field references inside aggregation expressions
  if (typeof value === "string" && value.startsWith("$")) {
    if (value.slice(1).split(".").some((part) => SENSITIVE_FIELD.test(part))) {
      throw new Error(`Field "${value}" is sensitive and cannot be queried.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => assertSafe(v, { allowCrossCollection }));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN_OPERATORS.has(key)) {
      throw new Error(`Operator ${key} is not allowed (read-only access).`);
    }
    if (CROSS_COLLECTION_STAGES.has(key) && !allowCrossCollection) {
      throw new Error(
        `${key} is only available to admins. Query each collection separately instead.`
      );
    }
    if (!key.startsWith("$") && key.split(".").some((part) => SENSITIVE_FIELD.test(part))) {
      throw new Error(`Field "${key}" is sensitive and cannot be queried.`);
    }
    assertSafe(v, { allowCrossCollection });
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object" || value._bsontype || value instanceof Date) {
    return value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_FIELD.test(k) ? "[hidden]" : redact(v);
  }
  return out;
}

// Claude sends dates/ids as Extended JSON ({"$date": "..."}, {"$oid": "..."}).
function parseEjson(value) {
  if (value === undefined || value === null) return value;
  return EJSON.deserialize(value, { relaxed: true });
}

function toText(data) {
  const text = EJSON.stringify(redact(data), { relaxed: true });
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n…[truncated — result was ${text.length} chars; narrow the filter, add a projection, or use count/aggregate]`
  );
}

async function requireCollection(user, name) {
  const db = await mongo.getDb();
  const exists = await db.listCollections({ name }, { nameOnly: true }).toArray();
  if (!exists.length) throw new Error(`Collection "${name}" does not exist.`);
  const filter = access.filterFor(user, name);
  if (filter === null) {
    throw new Error(`You do not have access to collection "${name}".`);
  }
  return { col: db.collection(name), accessFilter: filter };
}

function withAccess(filter, accessFilter) {
  const parts = [filter, accessFilter].filter((f) => f && Object.keys(f).length);
  if (!parts.length) return {};
  return parts.length === 1 ? parts[0] : { $and: parts };
}

async function listCollections(user) {
  const db = await mongo.getDb();
  const cols = await db.listCollections({}, { nameOnly: true }).toArray();
  const visible = cols
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system.") && access.filterFor(user, n) !== null)
    .sort();
  const result = [];
  for (const name of visible) {
    result.push({ name, approxCount: await db.collection(name).estimatedDocumentCount() });
  }
  return result;
}

function fieldType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  if (v && v._bsontype) return v._bsontype;
  return typeof v;
}

function collectFields(doc, prefix, fields, depth) {
  for (const [k, v] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const entry = (fields[path] ||= { types: new Set(), example: undefined });
    entry.types.add(fieldType(v));
    if (entry.example === undefined && v !== null && typeof v !== "object") {
      entry.example = SENSITIVE_FIELD.test(k) ? "[hidden]" : String(v).slice(0, 60);
    }
    if (depth >= 3) continue;
    if (Array.isArray(v) && v[0] && typeof v[0] === "object" && !v[0]._bsontype) {
      collectFields(v[0], `${path}[]`, fields, depth + 1);
    } else if (v && typeof v === "object" && !Array.isArray(v) && !v._bsontype && !(v instanceof Date)) {
      collectFields(v, path, fields, depth + 1);
    }
  }
}

async function describeCollection(user, name) {
  const { col, accessFilter } = await requireCollection(user, name);
  const docs = await col
    .find(accessFilter, { maxTimeMS: QUERY_TIMEOUT_MS })
    .sort({ _id: -1 })
    .limit(20)
    .toArray();
  const fields = {};
  docs.forEach((d) => collectFields(d, "", fields, 0));
  return {
    collection: name,
    sampledDocuments: docs.length,
    fields: Object.fromEntries(
      Object.entries(fields).map(([path, f]) => [
        path,
        { types: [...f.types].join("|"), example: f.example },
      ])
    ),
  };
}

async function findDocuments(user, { collection, filter, projection, sort, limit }) {
  const allowCrossCollection = access.isAdmin(user);
  assertSafe(filter, { allowCrossCollection });
  assertSafe(projection, { allowCrossCollection });
  const { col, accessFilter } = await requireCollection(user, collection);
  const docs = await col
    .find(withAccess(parseEjson(filter), accessFilter), {
      projection: projection || undefined,
      maxTimeMS: QUERY_TIMEOUT_MS,
    })
    .sort(sort || { _id: -1 })
    .limit(Math.min(Math.max(Number(limit) || 10, 1), MAX_FIND_LIMIT))
    .toArray();
  return { collection, returned: docs.length, documents: docs };
}

async function countDocuments(user, { collection, filter }) {
  assertSafe(filter, { allowCrossCollection: access.isAdmin(user) });
  const { col, accessFilter } = await requireCollection(user, collection);
  const count = await col.countDocuments(withAccess(parseEjson(filter), accessFilter), {
    maxTimeMS: QUERY_TIMEOUT_MS,
  });
  return { collection, count };
}

async function aggregate(user, { collection, pipeline }) {
  if (!Array.isArray(pipeline)) throw new Error("pipeline must be an array of stages.");
  assertSafe(pipeline, { allowCrossCollection: access.isAdmin(user) });
  const { col, accessFilter } = await requireCollection(user, collection);
  const stages = parseEjson(pipeline);
  if (Object.keys(accessFilter).length) stages.unshift({ $match: accessFilter });
  stages.push({ $limit: MAX_AGG_RESULTS });
  const results = await col
    .aggregate(stages, { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false })
    .toArray();
  return { collection, returned: results.length, results };
}

module.exports = {
  listCollections,
  describeCollection,
  findDocuments,
  countDocuments,
  aggregate,
  toText,
  redact,
};
