import os
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import requests

from .etariff import router as etariff_router
app.include_router(etariff_router, prefix="")

app = FastAPI(title="LLaMA-Energy API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
def health(): return {"ok": True}

@app.get("/eia")
def eia(state: str = Query("VA")):
    api_key = os.getenv("EIA_API_KEY", "")
    base = "https://api.eia.gov/v2/electricity/state-electricity-profiles/source-disposition/data/"
    params = {
        "frequency":"annual",
        "data[0]":"direct-use",
        "data[1]":"facility-direct",
        "data[2]":"independent-power-producers",
        "data[3]":"estimated-losses",
        "data[4]":"total-supply",
        "data[5]":"total-disposition",
        "facets[state][]": state,
        "sort[0][column]":"period",
        "sort[0][direction]":"asc",
        "api_key": api_key
    }
    r = requests.get(base, params=params, timeout=30)
    r.raise_for_status()
    return r.json()
