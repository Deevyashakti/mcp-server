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
const mongo = require("./mongo");

const KNOWLEDGE_FILE = path.join(__dirname, "knowledge.md");

// Chat memory per (user, session). In-process: cleared when the server restarts.
const memory = new MemorySaver();
let durable;

async function getCheckpointer() {
  if (durable) return durable;
  try {
    const { MongoDBSaver } = await import("@langchain/langgraph-checkpoint-mongodb");
    const client = await mongo.getClient();
    const saver = new MongoDBSaver({
      client,
      dbName: mongo.mongoDbName(),
      checkpointCollectionName: "assistantcheckpoints",
      checkpointWritesCollectionName: "assistantcheckpointwrites",
    });
    const errors = await saver.setup();
    if (Array.isArray(errors) && errors.length) {
      console.error(
        "Chat memory setup:",
        errors.map((err) => err.message || String(err)).join("; ")
      );
    }
    durable = saver;
    return saver;
  } catch (err) {
    console.error("Chat memory stayed in this process:", err.message);
    return memory;
  }
}

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

Read-only, no exceptions:
- You cannot create, edit, update, delete, approve, reject, cancel, or dispatch any record.
- If the user asks for a change, say this assistant is read-only and the change has to be made in DivOS. Never say that a record was changed.

How to work:
- Understand what the user means, however they phrase it (English, Hindi, Hinglish, short forms, typos). Map their words to collections and fields using the business knowledge below and the actual schema.
- If you are not sure where the data lives, call list_collections and describe_collection before querying. Never guess field names.
- Prefer count_documents or aggregate for "how many / total / group by" questions instead of fetching documents.
- Base every answer only on tool results. If the data isn't there, or you don't have access, say so plainly. Never invent numbers or records.
- If a tool returns LOOKUP_FAILED, the lookup did not finish. Say you could not check. Never turn that into a count of zero.
- If the question is genuinely ambiguous (e.g. which date range), make a sensible assumption, state it in one line, and answer.
- Reply in the user's language. Keep answers short and clear: one short sentence first, then the data. Don't show raw MongoDB queries or internal ids unless asked.
- Do not add a "Source:" line. The server adds the collection, the meaning, and the time.
- These official questions always use the definitions in the business knowledge, with no other meaning of the words:
  - "how many trucks are pending?" counts pending trucktrips, not the trucks master.
  - "kitne orders aaj aaye?" / "how many orders today?" counts orders created today.
  - "who is on leave today?" lists approved leave whose dates include today.
- When the answer has counts, totals, amounts, comparisons, or more than one record, put the numbers in a markdown table, not a bullet list. Keep column names short. Example:
| Truck | Status | Count |
| --- | --- | --- |
| GJ01AB1234 | Pending | 4 |
- If the user attaches an image, read what is actually in it (a document, screenshot, or photo). When it refers to company data, look that up with the tools. Don't invent text that isn't visible.
- Dates in filters must be Extended JSON: {"$date": "2026-01-31T00:00:00Z"}. ObjectIds: {"$oid": "..."}.

Today's date: ${today}
Logged-in user: ${user.name || user.email} (role: ${String(user.role ?? "unknown")})

<business_knowledge>
${readKnowledge()}
</business_knowledge>`;
}

// Tools are built per request so they carry the logged-in user; the user's
// access filter is applied inside db-tools on every call.
function buildTools(user, used, failures) {
  const run = (fn) => async (input) => {
    try {
      const text = dbTools.toText(await fn(user, input));
      if (input && input.collection) used.add(String(input.collection));
      return text;
    } catch (err) {
      failures.push(err.message);
      return `LOOKUP_FAILED: ${err.message}. The lookup did not finish. Do not answer with zero. Tell the user you could not check this.`;
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

async function ask(user, sessionId, question, image) {
  const blocks = [];
  if (question) blocks.push({ type: "text", text: question });
  if (image) {
    blocks.push({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    });
  }
  const content = blocks.length === 1 && blocks[0].type === "text" ? question : blocks;
  const used = new Set();
  const failures = [];
  const agent = createAgent({
    model: getModel(),
    tools: buildTools(user, used, failures),
    systemPrompt: systemPrompt(user),
    checkpointer: await getCheckpointer(),
  });
  const result = await agent.invoke(
    { messages: [{ role: "user", content }] },
    {
      // Scoped to the user so nobody can read another person's chat history.
      configurable: { thread_id: `${user._id}:${sessionId}` },
      recursionLimit: 30,
    }
  );
  const last = result.messages[result.messages.length - 1];
  let text = textOf(last) || "Sorry, I couldn't produce an answer for that. Please try rephrasing.";
  const failedAll = failures.length > 0 && used.size === 0;
  if (failedAll) {
    text = "I could not check that. The lookup did not finish, so this is not a count of zero.";
  } else if (failures.length) {
    text = `${text}\n\nI could not finish every lookup. A missing result is not zero.`;
  }
  return { reply: text, collections: [...used], failed: failedAll };
}

module.exports = { ask, buildTools };
