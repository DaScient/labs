🌐 Worldwide Intel Coverage API (v3)

A Cloudflare Worker providing global, real-time news and intel coverage with NIPF-aligned tagging, clustering, corroboration, and Hugging Face AI enrichment (translation, summaries, sentiment, NER). Lives in /labs/intel.

⸻

🚀 Features
	* Global Sources: AP, Reuters, BBC, DW, France24, NHK, Al Jazeera, CNN, Yonhap, ABC AU, News24 ZA, Anadolu, JPost, and more.
	* Robust ingestion: retries, timeouts, XML parsing, per-source weights.
	* Tagging:
	* NIPF topic tagging (PRC/China, Russia/Ukraine, Cyber, etc.)
	* Heuristic region tagging (Asia, Europe, MEA, Africa, Americas, Oceania)
	* Scoring: Impact × Confidence × Urgency + corroboration boost.
	* Clustering: de-duplication by normalized title keys + Jaccard merging.
	* Enrichment (Hugging Face):
	* Zero-shot classification to reinforce NIPF topics
	* Multilingual language detection & translation → English normalization
	* Abstractive summarization (2–3 sentences, dashboard-ready)
	* Sentiment analysis & NER (entities: people, orgs, places)
	* APIs:
	* /api/feeds — items with scores/tags
	* /api/clusters — corroborated story clusters
	* /api/enrich — enriched items (summary, sentiment, NER)
	* /api/clusters/enriched — enriched clusters
	* /api/search — query by keyword/tags
	* /api/topics — available tags/regions
	* /api/feargreed — CNN Fear & Greed scrape
	* /api/live — licensed YouTube live news
	* /api/stream — SSE stream (near-real-time pushes)
	* Reliability:
	* KV persistence (first-seen, enrichment cache)
	* Cron warm-cache for freshness
	* Optional HMAC-SHA256 signatures (X-Signature header)
	* Hardened CORS + CSP

⸻

📂 Routes

* GET  /api/health
* GET  /api/sources
* GET  /api/feeds?sinceHours=24&limit=80
* GET  /api/clusters?sinceHours=24&limit=80&minSources=1
* GET  /api/enrich?sinceHours=24&limit=40
* GET  /api/clusters/enriched?sinceHours=24&limit=40&minSources=2
* GET  /api/search?q=cyber&sinceHours=48
* GET  /api/topics
* GET  /api/feargreed
* GET  /api/live
* GET  /api/stream (SSE)
* OPTIONS * (CORS preflight)


⸻

⚙️ Setup

1. Clone & enter

git clone https://github.com/dascient/labs.git
cd labs/intel

2. Configure wrangler.toml

name = "worldwide-intel-api"
main = "worker.js"
compatibility_date = "2025-09-01"

[vars]
HF_TOKEN = "hf_xxx_your_token"
HF_USE_ENDPOINTS = "false"   # set "true" if using dedicated endpoints
API_SECRET = "optional-signing-key"

HF_EP_ZEROSHOT = ""   # if using dedicated Inference Endpoints
HF_EP_SUMMARIZE = ""
HF_EP_TRANSLATE = ""
HF_EP_LANG_DETECT = ""
HF_EP_SENTIMENT = ""
HF_EP_NER = ""

[[kv_namespaces]]
binding = "NEWS_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[triggers]
crons = ["*/10 * * * *"]

3. Publish

npm install -g wrangler
wrangler publish


⸻

🤖 Hugging Face Integration

Task	Default Model
Zero-shot topics	facebook/bart-large-mnli
Language detect	papluca/xlm-roberta-base-language-detection
Translation	facebook/m2m100_418M
Summarization	facebook/bart-large-cnn
Sentiment	cardiffnlp/twitter-roberta-base-sentiment-latest
NER	dslim/bert-base-NER

Swap any model via Wrangler vars or point to Inference Endpoints for scale/reliability.

⸻

🧪 Example Calls
	* Enriched items (last 18h):

curl "https://intel.aristocles24.workers.dev/api/enrich?sinceHours=18&limit=20"


	* Enriched corroborated clusters (min 2 sources):

curl "https://intel.aristocles24.workers.dev/api/clusters/enriched?sinceHours=24&limit=40&minSources=2"


	* SSE stream (new items, every ~4s):

curl -N "https://intel.aristocles24.workers.dev/api/stream"



⸻

🔐 Notes
	* KV caching reduces Hugging Face API calls (lower cost, lower latency).
	* Limit per-call enrichment with HF.MAX_HF_ENRICH (default: 25).
	* Responses can be signed with X-Signature if API_SECRET is set.
	* SSE streams auto-close after ~90s (Cloudflare edge guard).

⸻

📜 License

MIT © 2025 DaScient Labs

⸻

