// MCP server (stdio) exposing the same read-only MongoDB tools as the chat,
// for Cursor / Claude Desktop. It acts as the DivOS user in MCP_USER_EMAIL and
// applies that user's access rules. Nothing may be written to stdout except
// MCP messages, so dotenv runs in quiet mode.
require("dotenv").config({
  path: require("path").join(__dirname, ".env"),
  override: true,
  quiet: true,
});
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const dbTools = require("./db-tools");
const auth = require("./auth");

const server = new McpServer({
  name: "divos-data",
  version: "2.0.0",
});

async function currentUser() {
  const email = process.env.MCP_USER_EMAIL;
  if (!email) throw new Error("Set MCP_USER_EMAIL to your DivOS email in the MCP config.");
  const user = await auth.findUserByEmail(email);
  if (!user) throw new Error(`DivOS user ${email} not found or inactive.`);
  return user;
}

function register(name, description, shape, fn) {
  server.tool(name, description, shape, async (input) => {
    try {
      const text = dbTools.toText(await fn(await currentUser(), input));
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
}

const filter = z
  .record(z.string(), z.any())
  .optional()
  .describe('MongoDB filter as JSON, e.g. {"status": "pending"}. Dates: {"$date": "..."}.');

register(
  "list_collections",
  "List the DivOS MongoDB collections you can read, with approximate document counts.",
  {},
  (user) => dbTools.listCollections(user)
);

register(
  "describe_collection",
  "Show the fields of a collection (paths, types, example values).",
  { collection: z.string() },
  (user, { collection }) => dbTools.describeCollection(user, collection)
);

register(
  "count_documents",
  "Count documents in a collection matching a filter.",
  { collection: z.string(), filter },
  dbTools.countDocuments
);

register(
  "find_documents",
  "Fetch up to 50 documents from a collection.",
  {
    collection: z.string(),
    filter,
    projection: z.record(z.string(), z.any()).optional(),
    sort: z.record(z.string(), z.any()).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  dbTools.findDocuments
);

register(
  "aggregate",
  "Run a read-only aggregation pipeline (max 200 rows; $out/$merge not allowed).",
  { collection: z.string(), pipeline: z.array(z.record(z.string(), z.any())) },
  dbTools.aggregate
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
