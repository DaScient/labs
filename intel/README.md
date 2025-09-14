🌐 Worldwide Intel Coverage API (v3)

An API worker providing global, real-time news and intel coverage with NIPF-aligned tagging, clustering, corroboration, and Hugging Face AI enrichment (translation, summaries, sentiment, NER). Lives in /labs/intel.

⸻

🚀 Features
	•	Global Sources: AP, Reuters, BBC, DW, France24, NHK, Al Jazeera, CNN, Yonhap, ABC AU, News24 ZA, Anadolu, JPost, and more.
	•	Robust ingestion: retries, timeouts, XML parsing, per-source weights.
	•	Tagging:
	•	NIPF topic tagging (PRC/China, Russia/Ukraine, Cyber, etc.)
	•	Heuristic region tagging (Asia, Europe, MEA, Africa, Americas, Oceania)
	•	Scoring: Impact × Confidence × Urgency + corroboration boost.
	•	Clustering: de-duplication by normalized title keys + Jaccard merging.
	•	Enrichment (Hugging Face):
	•	Zero-shot classification to reinforce NIPF topics
	•	Multilingual language detection & translation → English normalization
	•	Abstractive summarization (2–3 sentences, dashboard-ready)
	•	Sentiment analysis & NER (entities: people, orgs, places)
	•	APIs:
	•	/api/feeds — items with scores/tags
	•	/api/clusters — corroborated story clusters
	•	/api/enrich — enriched items (summary, sentiment, NER)
	•	/api/clusters/enriched — enriched clusters
	•	/api/search — query by keyword/tags
	•	/api/topics — available tags/regions
	•	/api/feargreed — CNN Fear & Greed scrape
	•	/api/live — licensed YouTube live news
	•	/api/stream — SSE stream (near-real-time pushes)
	•	Reliability:
	•	KV persistence (first-seen, enrichment cache)
	•	Cron warm-cache for freshness
	•	Optional HMAC-SHA256 signatures (X-Signature header)
	•	Hardened CORS + CSP⸻

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

Mermaid Chart
flowchart LR
  subgraph Feeds["Global Sources"]
    A1[AP]:::src -->|RSS/Atom| ING
    A2[Reuters]:::src -->|RSS/Atom| ING
    A3[BBC]:::src -->|RSS/Atom| ING
    A4[Al Jazeera]:::src -->|RSS/Atom| ING
    A5[DW / France24 / NHK / Yonhap / ABC AU / News24 ZA / Anadolu / JPost / CNN]:::src -->|RSS/Atom| ING
  end

  subgraph Worker["Cloudflare Worker (edge)"]
    ING[Ingestion<br/>• retries/timeouts<br/>• XML parse<br/>• per-source weights] --> TAG[Heuristics<br/>• NIPF topic tagging<br/>• Geo tagging]
    TAG --> SCORE[Scoring<br/>Impact × Confidence × Urgency]
    SCORE --> DEDUP[De-dup + Clustering<br/>• normalized keys<br/>• Jaccard merge<br/>• corroboration boost]
    DEDUP --> ENRICH[HF Enrichment (optional)<br/>• lang detect/translate→EN<br/>• zero-shot topics<br/>• summarization<br/>• sentiment & NER]
    ENRICH --> CACHE[KV Cache<br/>• first-seen<br/>• enrichment cache]
    DEDUP --> CACHE
  end

  subgraph Outputs["API & Streaming"]
    API1[/GET /api/feeds/]:::api
    API2[/GET /api/clusters/]:::api
    API3[/GET /api/enrich/]:::api
    API4[/GET /api/clusters/enriched/]:::api
    API5[/GET /api/search/]:::api
    API6[/GET /api/topics/]:::api
    API7[/GET /api/feargreed/]:::api
    API8[/GET /api/live/]:::api
    API9[/GET /api/stream (SSE)/]:::api
  end

  CACHE --> API1
  CACHE --> API2
  CACHE --> API3
  CACHE --> API4
  CACHE --> API5
  CACHE --> API6
  CACHE --> API7
  CACHE --> API8
  CACHE --> API9

  subgraph HF["Hugging Face (Inference API or Endpoints)"]
    ZS[Zero-shot<br/>bart-large-mnli]:::hf
    LD[Language detect<br/>xlm-roberta]:::hf
    TR[Translate<br/>M2M100/NLLB]:::hf
    SM[Summarize<br/>bart-large-cnn]:::hf
    ST[Sentiment<br/>roberta-sentiment]:::hf
    NR[NER<br/>bert-base-NER]:::hf
  end

  ENRICH <--> LD
  ENRICH <--> TR
  ENRICH <--> ZS
  ENRICH <--> SM
  ENRICH <--> ST
  ENRICH <--> NR

  subgraph Ops["Ops & Freshness"]
    CRON[[Cron: */10]]:::ops --> ING
    SIGN[[X-Signature (HMAC)]]:::ops --> API1
    SIGN --> API2
    SIGN --> API3
    SIGN --> API4
    ETag[[ETag/Cache]]:::ops --> API1
    ETag --> API2
  end

  classDef src fill:#f5faff,stroke:#7aa6d9,stroke-width:1px,color:#0b3b66;
  classDef api fill:#eefcf3,stroke:#52a86d,stroke-width:1px,color:#0b3a1c;
  classDef hf fill:#fff7f0,stroke:#c58a54,stroke-width:1px,color:#61370c;
  classDef ops fill:#f3f0ff,stroke:#8b7fd1,stroke-width:1px,color:#2d246b;

⸻

ASCII Chart
[Global Feeds] --RSS/Atom--> [Ingestion @ Worker]
      | retries/timeouts, XML parse, weights
      v
[Heuristic Tags: NIPF + Geo]
      v
[Scoring: Impact x Confidence x Urgency]
      v
[De-dup + Clustering] --corroboration boost-->
      |                             \
      |                              \-> [KV Cache: first-seen, enrichment]
      v
[HF Enrichment (optional)]
  |-- lang detect/translate -> EN
  |-- zero-shot topics (NIPF reinforcement)
  |-- summarization (2–3 sentences)
  |-- sentiment / NER
      v
[KV Cache]
      v
[APIs]
  /api/feeds, /api/clusters, /api/enrich, /api/clusters/enriched,
  /api/search, /api/topics, /api/feargreed, /api/live, /api/stream (SSE)

[Ops]
  Cron */10 -> warm cache
  HMAC X-Signature + ETag
  CORS/CSP hardened

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

