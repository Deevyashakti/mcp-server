// LangChain agent (LangGraph under the hood) running Claude through the
// Anthropic SDK. Claude understands the question, decides which read-only
// MongoDB tools to call, and writes the answer from the real data.
const fs = require("fs");
const path = require("path");
const { createAgent, tool } = require("langchain");
const { MemorySaver } = require("@langchain/langgraph");
const { ChatAnthropic } = require("@langchain/anthropic");
const { z } = require("zod");
const dbTools = require("./db-tools");

const KNOWLEDGE_FILE = path.join(__dirname, "knowledge.md");

// Chat memory per (user, session). In-process: cleared when the server restarts.
const memory = new MemorySaver();

let model;
function getModel() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is missing in backend/.env");
  }
  model ||= new ChatAnthropic({
    model: process.env.CLAUDE_MODEL || "claude-opus-5",
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxTokens: 16000,
    // If a request is declined by a safety classifier, the API retries it on a
    // fallback model automatically instead of returning an empty answer.
    betas: ["server-side-fallback-2026-07-01"],
    invocationKwargs: { fallbacks: "default" },
  });
  return model;
}

function readKnowledge() {
  try {
    return fs.readFileSync(KNOWLEDGE_FILE, "utf8");
  } catch {
    return "(no knowledge.md yet)";
  }
}

function systemPrompt(user) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the DivOS data assistant for Deevyashakti. You answer questions about the company's data by querying its MongoDB database with the tools provided. All access is read-only.

How to work:
- Understand what the user means, however they phrase it (English, Hindi, Hinglish, short forms, typos). Map their words to collections and fields using the business knowledge below and the actual schema.
- If you are not sure where the data lives, call list_collections and describe_collection before querying. Never guess field names.
- Prefer count_documents or aggregate for "how many / total / group by" questions instead of fetching documents.
- Base every answer only on tool results. If the data isn't there, or you don't have access, say so plainly. Never invent numbers or records.
- If the question is genuinely ambiguous (e.g. which date range), make a sensible assumption, state it in one line, and answer.
- Reply in the user's language. Keep answers short and clear: the answer first, then key details. Use simple lists or tables for multiple records. Don't show raw MongoDB queries or internal ids unless asked.
- Dates in filters must be Extended JSON: {"$date": "2026-01-31T00:00:00Z"}. ObjectIds: {"$oid": "..."}.

Today's date: ${today}
Logged-in user: ${user.name || user.email} (role: ${String(user.role ?? "unknown")})

<business_knowledge>
${readKnowledge()}
</business_knowledge>`;
}

// Tools are built per request so they carry the logged-in user; the user's
// access filter is applied inside db-tools on every call.
function buildTools(user) {
  const run = (fn) => async (input) => {
    try {
      return dbTools.toText(await fn(user, input));
    } catch (err) {
      return `Error: ${err.message}`;
    }
  };
  const filterSchema = z
    .record(z.string(), z.any())
    .optional()
    .describe('MongoDB filter as JSON, e.g. {"status": "pending"}. Omit for all documents.');

  return [
    tool(run((u) => dbTools.listCollections(u)), {
      name: "list_collections",
      description:
        "List the MongoDB collections this user can read, with approximate document counts.",
      schema: z.object({}),
    }),
    tool(run((u, { collection }) => dbTools.describeCollection(u, collection)), {
      name: "describe_collection",
      description:
        "Show the fields of a collection (paths, types, example values) from recent documents. Use before querying an unfamiliar collection.",
      schema: z.object({ collection: z.string() }),
    }),
    tool(run(dbTools.countDocuments), {
      name: "count_documents",
      description: "Count documents in a collection matching a filter.",
      schema: z.object({ collection: z.string(), filter: filterSchema }),
    }),
    tool(run(dbTools.findDocuments), {
      name: "find_documents",
      description:
        "Fetch documents from a collection (max 50). Use a projection to return only the fields you need.",
      schema: z.object({
        collection: z.string(),
        filter: filterSchema,
        projection: z
          .record(z.string(), z.any())
          .optional()
          .describe('Fields to return, e.g. {"name": 1, "status": 1}'),
        sort: z
          .record(z.string(), z.any())
          .optional()
          .describe('Sort order, e.g. {"createdAt": -1}. Default: newest first.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    }),
    tool(run(dbTools.aggregate), {
      name: "aggregate",
      description:
        "Run a read-only aggregation pipeline ($match, $group, $project, $unwind, $sort, $count, ...). Max 200 result rows. $out/$merge are not allowed.",
      schema: z.object({
        collection: z.string(),
        pipeline: z.array(z.record(z.string(), z.any())),
      }),
    }),
  ];
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

async function ask(user, sessionId, question) {
  const agent = createAgent({
    model: getModel(),
    tools: buildTools(user),
    systemPrompt: systemPrompt(user),
    checkpointer: memory,
  });
  const result = await agent.invoke(
    { messages: [{ role: "user", content: question }] },
    {
      // Scoped to the user so nobody can read another person's chat history.
      configurable: { thread_id: `${user._id}:${sessionId}` },
      recursionLimit: 30,
    }
  );
  const last = result.messages[result.messages.length - 1];
  return textOf(last) || "Sorry, I couldn't produce an answer for that. Please try rephrasing.";
}

module.exports = { ask, buildTools };
