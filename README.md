# six-degrees-raindrop-agent

A small [pi](https://github.com/earendil-works/pi) agent that plays **Six Degrees of Wikipedia**: give it two topics and it navigates Wikipedia's link graph (read-only API calls) to find a short chain of articles connecting them. Models run through [OpenRouter](https://openrouter.ai), and every run is traced to [Raindrop](https://raindrop.ai) via [`@raindrop-ai/pi-agent`](https://www.npmjs.com/package/@raindrop-ai/pi-agent).

```
🧭 Octopus → The Beatles  (model: anthropic/claude-haiku-5.5)
  🔧 wiki_search({"query":"Octopus"})
  🔧 wiki_links({"title":"Octopus","filter":"Beatles"})
  ...
  🔧 submit_chain(...)
     ↳ error: "Rejected: "Octopus" does not link to "Octopolis and Octlantis". Fix that hop and resubmit."
  ...
✅ Octopus  →  Common octopus  →  Octopus's Garden  →  The Beatles  (3 hops)
```

## Tools

| Tool | What it does |
| --- | --- |
| `wiki_search` | Resolve a topic to exact article titles |
| `wiki_summary` | Intro paragraph of an article |
| `wiki_links` | Outgoing links from an article, with optional substring filter |
| `wiki_backlinks` | Incoming links to an article, with optional substring filter |
| `submit_chain` | Checks every hop against the live link graph, then ends the run. A bad hop is rejected and the model has to fix it, which shows up nicely in traces. |

## Setup

Requires Node 22.19+.

```bash
npm install
cp .env.example .env            # add your OPENROUTER_API_KEY
raindrop workshop setup         # local trace UI at http://localhost:5899
npm start -- "Octopus" "The Beatles"
```

To send traces to Raindrop cloud instead of (or in addition to) the local Workshop, set `RAINDROP_WRITE_KEY` (or run `raindrop cloud setup`).

## How the Raindrop wiring works

```ts
const raindrop = createRaindropPiAgent({ writeKey, userId, eventName: "six_degrees", properties: { from, to, model } });
raindrop.subscribe(agent, {
  runName: `Six degrees: ${from} → ${to}`,
  getOutput: () => JSON.stringify(committed),   // the verified chain becomes the run's output
});
await agent.prompt(...);
await raindrop.shutdown();                       // flush
```

Each run records the system prompt, the tool catalog, each LLM generation (with token usage), and each tool call with its full result.
