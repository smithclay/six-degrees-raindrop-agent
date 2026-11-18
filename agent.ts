/**
 * Six Degrees of Wikipedia — a small pi agent, traced with Raindrop.
 *
 * Given two topics, the agent navigates Wikipedia's link graph (read-only API
 * calls, no writes anywhere) to find a short chain of articles connecting them,
 * then commits the chain with `submit_chain`.
 *
 *   npm start -- "Octopus" "The Beatles"
 */
import "dotenv/config";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRaindropPiAgent } from "@raindrop-ai/pi-agent";
import { Type } from "typebox";

const MODEL_ID = process.env.MODEL ?? "anthropic/claude-haiku-5.5";
const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS ?? 25);
const [from = "Octopus", to = "The Beatles"] = process.argv.slice(2);

// ---------- Wikipedia (read-only) ----------

const WIKI = "https://en.wikipedia.org/w/api.php";

const cache = new Map<string, any>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET the MediaWiki API with caching and polite retry/backoff on 429/5xx. */
async function wiki(params: Record<string, string>): Promise<any> {
  const url = `${WIKI}?${new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params })}`;
  if (cache.has(url)) return cache.get(url);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "six-degrees-demo-agent/0.1 (local demo; read-only)", "Accept-Encoding": "gzip" },
    });
    if (res.ok) {
      const json = await res.json();
      cache.set(url, json);
      return json;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`Wikipedia API ${res.status}`);
  }
}

const text = (s: string) => [{ type: "text" as const, text: s }];

/** Collect article links (namespace 0), following API continuation up to `cap`. */
async function collectLinks(title: string, mode: "links" | "backlinks", cap: number) {
  const out: string[] = [];
  let cont: Record<string, string> = {};
  let resolved = title;
  while (out.length < cap) {
    const params: Record<string, string> =
      mode === "links"
        ? { action: "query", titles: title, prop: "links", plnamespace: "0", pllimit: "max", redirects: "1", ...cont }
        : { action: "query", list: "backlinks", bltitle: title, blnamespace: "0", bllimit: "max", blfilterredir: "nonredirects", ...cont };
    const data = await wiki(params);
    if (mode === "links") {
      const page = data.query?.pages?.[0];
      if (!page || page.missing) throw new Error(`No article titled "${title}"`);
      resolved = page.title;
      out.push(...(page.links ?? []).map((l: any) => l.title));
    } else {
      out.push(...(data.query?.backlinks ?? []).map((l: any) => l.title));
    }
    if (!data.continue) break;
    cont = data.continue;
  }
  return { resolved, titles: out.slice(0, cap) };
}

function filterAndFormat(titles: string[], filter?: string, limit = 150) {
  const f = filter?.toLowerCase();
  const hits = f ? titles.filter((t) => t.toLowerCase().includes(f)) : titles;
  return { hits, shown: hits.slice(0, limit) };
}

const searchTool: AgentTool<any> = {
  name: "wiki_search",
  label: "Search Wikipedia",
  description: "Search Wikipedia for article titles matching a query. Use to resolve a topic to its exact article title.",
  parameters: Type.Object({ query: Type.String() }),
  async execute(_id, { query }) {
    const data = await wiki({ action: "query", list: "search", srsearch: query, srlimit: "8" });
    const results = (data.query?.search ?? []).map((r: any) => ({
      title: r.title,
      snippet: r.snippet.replace(/<[^>]+>/g, ""),
    }));
    return { content: text(results.map((r: any) => `- ${r.title}: ${r.snippet}`).join("\n") || "No results."), details: results };
  },
};

const summaryTool: AgentTool<any> = {
  name: "wiki_summary",
  label: "Article summary",
  description: "Get the intro paragraph of a Wikipedia article. Use to understand what a page is about before committing to it as a hop.",
  parameters: Type.Object({ title: Type.String() }),
  async execute(_id, { title }) {
    const data = await wiki({ action: "query", prop: "extracts", exintro: "1", explaintext: "1", exchars: "800", titles: title, redirects: "1" });
    const page = data.query?.pages?.[0];
    if (!page || page.missing) throw new Error(`No article titled "${title}"`);
    return { content: text(`${page.title}\n\n${page.extract}`), details: { title: page.title } };
  },
};

const linksTool: AgentTool<any> = {
  name: "wiki_links",
  label: "Outgoing links",
  description:
    "List articles that a Wikipedia article links TO (outgoing). Optionally filter by a case-insensitive substring " +
    "to find promising hops (e.g. filter='music'). Returns the total count and up to 150 matching titles.",
  parameters: Type.Object({ title: Type.String(), filter: Type.Optional(Type.String()) }),
  async execute(_id, { title, filter }) {
    const { resolved, titles } = await collectLinks(title, "links", 5000);
    const { hits, shown } = filterAndFormat(titles, filter);
    return {
      content: text(`"${resolved}" links to ${titles.length} articles; ${hits.length} match${filter ? ` "${filter}"` : ""}:\n${shown.join(" | ")}`),
      details: { resolved, total: titles.length, matched: hits.length },
    };
  },
};

const backlinksTool: AgentTool<any> = {
  name: "wiki_backlinks",
  label: "Incoming links",
  description:
    "List articles that link TO a given article (incoming). Useful for working backwards from the target. " +
    "Optionally filter by substring. Samples up to 2000 backlinks.",
  parameters: Type.Object({ title: Type.String(), filter: Type.Optional(Type.String()) }),
  async execute(_id, { title, filter }) {
    const { titles } = await collectLinks(title, "backlinks", 2000);
    const { hits, shown } = filterAndFormat(titles, filter);
    return {
      content: text(`${titles.length} sampled articles link to "${title}"; ${hits.length} match${filter ? ` "${filter}"` : ""}:\n${shown.join(" | ")}`),
      details: { total: titles.length, matched: hits.length },
    };
  },
};

// Verifies every hop really is a link, then ends the run.
let committed: { chain: string[]; story: string; verified: boolean; brokenHop?: string } | undefined;

const submitTool: AgentTool<any> = {
  name: "submit_chain",
  label: "Submit chain",
  description:
    "Submit the final chain of exact article titles from the start topic to the target topic. " +
    "Each consecutive pair must be a real outgoing link. The chain is verified before acceptance.",
  parameters: Type.Object({
    chain: Type.Array(Type.String(), { minItems: 2 }),
    story: Type.String({ description: "One or two fun sentences narrating how the hops connect." }),
  }),
  async execute(_id, { chain, story }) {
    for (let i = 0; i < chain.length - 1; i++) {
      const { titles } = await collectLinks(chain[i], "links", 10000);
      if (!titles.some((t) => t.toLowerCase() === chain[i + 1].toLowerCase())) {
        const brokenHop = `${chain[i]} → ${chain[i + 1]}`;
        return {
          content: text(`Rejected: "${chain[i]}" does not link to "${chain[i + 1]}". Fix that hop and resubmit.`),
          details: { brokenHop },
          isError: true,
        };
      }
    }
    committed = { chain, story, verified: true };
    return { content: text("Chain verified ✓"), details: committed, terminate: true };
  },
};

// ---------- Agent + Raindrop ----------

const models = createModels();
models.setProvider(openrouterProvider()); // reads OPENROUTER_API_KEY
const model = models.getModel("openrouter", MODEL_ID);
if (!model) throw new Error(`Model ${MODEL_ID} not found in OpenRouter catalog`);

const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  toolExecution: "sequential", // be gentle with Wikipedia
  initialState: {
    model,
    tools: [searchTool, summaryTool, linksTool, backlinksTool, submitTool],
    systemPrompt: [
      "You play Six Degrees of Wikipedia. Find a SHORT chain of English Wikipedia articles from the start topic to the target,",
      "where each article links directly to the next. Strategy: resolve both titles with wiki_search, then look for 'hub' pages",
      "(countries, cities, broad fields, famous people) via wiki_links with a filter, and use wiki_backlinks on the target to",
      "see what points into it. Aim for 2–4 hops. When confident, call submit_chain with exact titles. Be efficient.",
    ].join(" "),
  },
});

const raindrop = createRaindropPiAgent({
  writeKey: process.env.RAINDROP_WRITE_KEY, // optional: Raindrop cloud
  userId: process.env.USER ?? "demo-user",
  eventName: "six_degrees",
  properties: { from, to, model: MODEL_ID },
  // Local Workshop is picked up from RAINDROP_LOCAL_DEBUGGER in .env
});
raindrop.subscribe(agent, {
  runName: `Six degrees: ${from} → ${to}`,
  getOutput: () => (committed ? JSON.stringify(committed) : undefined),
});

// Console progress + a tool-call budget so it can't wander forever.
let toolCalls = 0;
agent.subscribe((e) => {
  if (e.type === "tool_execution_start") {
    toolCalls++;
    console.log(`  🔧 ${e.toolName}(${JSON.stringify(e.args)})`);
    if (toolCalls >= MAX_TOOL_CALLS) {
      console.log(`  ⛔ hit ${MAX_TOOL_CALLS} tool calls, stopping`);
      agent.abort();
    }
  }
  if (e.type === "tool_execution_end" && e.isError) console.log(`     ↳ error: ${JSON.stringify(e.result?.content?.[0]?.text ?? e.result).slice(0, 200)}`);
});

console.log(`🧭 ${from} → ${to}  (model: ${MODEL_ID})\n`);
try {
  await agent.prompt(`Start: "${from}". Target: "${to}".`);
  if (committed) {
    console.log(`\n✅ ${committed.chain.join("  →  ")}  (${committed.chain.length - 1} hops)\n   ${committed.story}`);
  } else {
    console.log(`\n❌ No verified chain found. ${agent.state.errorMessage ?? ""}`);
  }
} finally {
  await raindrop.shutdown(); // flush traces/events
}
