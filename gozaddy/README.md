# [GoZaddy.ai](https://gozaddy.ai)

## Live News RSS Auto-Article & Content Generator
### Real-time Global Trends Analytic Dashboard

GoZaddy.ai is an open-source, modular platform that ingests global RSS news feeds, applies AI-driven summarization and auto-article generation, and presents real-time trend analytics and sentiment data through a unified dashboard.

This repository contains the core backend, data pipelines, analytics engine, and example integrations to support GoZaddy.ai’s live trends and AI-generated content capabilities.



### Table of Contents
	1.	Project Overview
	2.	Key Features
	3.	Architecture & Design
	4.	Getting Started
	•	Requirements
	•	Installation
	•	Configuration
	•	Running Locally
	5.	Usage
	•	RSS Feed Sources
	•	Content Generation
	•	Analytics Dashboard
	•	API Endpoints
	6.	Examples
	7.	Deployment
	8.	Contributing
	9.	Code of Conduct
	10.	License
	11.	Security & Privacy
	12.	Contact & Credits



### 1. Project Overview

GoZaddy.ai is designed to:
	•	Continuously ingest global RSS news feeds
	•	Auto-summarize and generate structured articles using AI
	•	Provide live trend detection and sentiment analytics
	•	Expose a clean API for frontend dashboards or external applications
	•	Support extensible plug-ins for new data sources or models

Mission:
Provide an interoperable, trustworthy, and live interface for global trends backed by transparent, scalable AI systems.



### 2. Key Features
	•	Live RSS Feed Ingestion: Subscribe to hundreds of international news feeds.
	•	AI Auto-Article Generation: Transform raw news into coherent, structured articles.
	•	Trend Analytics: Detect rising topics, category breakdowns, and temporal signals.
	•	Sentiment & Metadata: Classify sentiment and metadata (entities, geolocation, topic scores).
	•	Real-time Dashboard: Visualize trends with time series graphs and heatmaps.
	•	API-First: REST endpoints for ingestion, analytics, and generated content.
	•	Modular Plugins: Easy integration with new AI models or feed sources.
	•	Extensible Architecture: Designed for scalability in cloud, edge, or container environments.



### 3. Architecture & Design

RSS Feeds ─► Ingestion Layer ─► Queue/Stream ─► AI Processing ─► Database
                                      │
                                      ▼
                                  Metrics Engine
                                      │
                                      ▼
                             Dashboard & API Layer

	•	Ingestion Layer: Connects and normalizes RSS/XML/JSON feeds.
	•	Processing Pipeline: Uses AI APIs (OpenAI, Anthropic, etc.) for summarization.
	•	Storage: Time series and document DB for content and analytics.
	•	Dashboard: React/Vue-based frontend for visualization.
	•	API: Exposes secure REST endpoints.



### 4. Getting Started

Requirements
	•	Node.js >= v18
	•	Python >= 3.10
	•	Database (PostgreSQL, TimescaleDB recommended)
	•	Redis (for caching/queue)
	•	API Keys for AI provider (e.g., OpenAI)

#### Installation

git clone https://github.com/your-org/gozaddy.ai.git
cd gozaddy.ai

#### Backend Setup

cd server
pip install -r requirements.txt
cp .env.example .env

#### Frontend Setup

cd frontend
npm install

#### Configuration

Populate .env:

AI_PROVIDER=OpenAI
OPENAI_KEY=yourkey
DATABASE_URL=postgres://...
REDIS_URL=redis://...
RSS_SOURCES_FILE=feeds.json

#### Running Locally

Backend:

cd server
uvicorn app.main:app --reload

Frontend:

cd frontend
npm run dev




### 5. Usage

Add RSS Feeds

Edit feeds.json:

[
  "https://rss.cnn.com/rss/edition.rss",
  "https://feeds.bbci.co.uk/news/rss.xml"
]

#### Generate AI Articles

Call the API:

POST /api/v1/generate
{
  "feedItemId": "12345"
}

Fetch Trends

GET /api/v1/trends

Dashboard Access

Open in browser: http://localhost:3000



### 6. Examples

Example generated article:

Title: Global Tech Stocks Rally as Markets Rebound
Summary: After a week of volatility, global indices showed strength with…
Sentiment: Positive
Topics: [Finance, Tech, Markets]




### 7. Deployment

GoZaddy.ai can be deployed via:
	•	Docker
	•	Kubernetes
	•	Cloud providers (AWS, GCP, Azure)

Example docker-compose.yml included.



### 8. Contributing

We welcome contributors!
	1.	Fork the repo
	2.	Create a new branch
	3.	Write tests for new features
	4.	Submit a PR

See CONTRIBUTING.md for full guidelines.



### 9. Code of Conduct

This project follows a Code of Conduct to create a welcoming community. See CODE_OF_CONDUCT.md.



### 10. License

Distributed under the MIT License. See LICENSE for details.

Copyright © 2025 DaScient Apps by DaScient, LLC.



### 11. Security & Privacy
	•	Do not expose API keys
	•	Use HTTPS in production
	•	Follow OWASP best practices
	•	Regularly update dependencies

Report vulnerabilities to security@dasci ent.com.



### 12. Contact & Credits

Maintained by:
Don D.M. Tadaya — Data Scientist, Engineer, and Architect
DaScient Apps | DaScient, LLC

Website: https://gozaddy.ai
Repo: https://github.com/your-org/gozaddy.ai



If you want, I can also generate the CONTRIBUTING.md, API spec, or diagram assets ready for GitHub.


## GoZaddy — AI News Summaries

### 1) Deploy the Cloudflare Worker
- Files: `/gozaddy/worker.js`
- In Cloudflare Dashboard (or `wrangler`), create a Worker and paste `worker.js`.
- (Optional) Add secret: **OPENAI_API_KEY** (Settings → Variables → Add Secret).
- Set a public URL, e.g. `https://gozaddy.<your-subdomain>.workers.dev`.

#### Endpoints
- `GET /summaries?feeds=<csv>&limit=25&interval=3600` → JSON
- `GET /ascii?feeds=<csv>&limit=25&interval=3600` → Plain text
- `GET /health` → `{ ok: true }`

> The Worker caches responses for `interval` seconds via Cloudflare Cache.  
> It always returns CORS headers (`Access-Control-Allow-Origin: *`).

### 2) Host the Frontends (GitHub Pages or Cloudflare Pages)
- Put `/labs/index.html` and `/labs/analytics.html` in your repo (e.g., `dascient/labs`).
- If using GitHub Pages: `https://dascient.github.io/labs/`
- If using Cloudflare Pages: your Pages URL.

#### Configure feeds
- Edit `/labs/configs/feeds.txt` (optional — frontends can also pass feeds via `?feeds=url1,url2`).

## 3) Use the UIs

#### Summaries UI
- `https://<your-pages>/labs/index.html`
- Options:
  - `?feeds=url1,url2` (CSV), defaults to curated set
  - `?refresh=60000` (ms)

#### Analytics UI
- `https://<your-pages>/labs/analytics.html`
- Options:
  - `?feeds=url1,url2`
  - `?refresh=90000` (ms)
  - `?window=6` (hours)

### 4) GoDaddy embed (Website Builder)
**HTML block → paste:**
```html
<!-- Summaries -->
<iframe src="https://dascient.github.io/labs/index.html?refresh=60000"
        style="width:100%;min-height:1200px;border:0;background:transparent" loading="lazy"></iframe>

<!-- Analytics -->
<iframe src="https://dascient.github.io/labs/analytics.html?window=6&refresh=90000"
        style="width:100%;min-height:1200px;border:0;background:transparent" loading="lazy"></iframe>
