#!/usr/bin/env python3
import os, re, requests
import pandas as pd
import matplotlib.pyplot as plt

API_KEY = os.getenv("EIA_API_KEY")
URL = (
    "https://api.eia.gov/v2/electricity/state-electricity-profiles/source-disposition/data/"
    "?frequency=annual"
    "&data[0]=direct-use"
    "&data[1]=facility-direct"
    "&data[2]=independent-power-producers"
    "&data[3]=estimated-losses"
    "&data[4]=total-supply"
    "&data[5]=total-disposition"
    "&facets[state][]=VA"
    "&sort[0][column]=period&sort[0][direction]=asc"
    f"&api_key={API_KEY}"
)

resp = requests.get(URL); resp.raise_for_status()
data = resp.json()
df = pd.DataFrame(data["response"]["data"])
df.columns = [re.sub(r'[^a-z0-9_]', '_', c.lower()) for c in df.columns]

numeric_cols = ["direct_use","facility_direct","independent_power_producers","estimated_losses","total_supply","total_disposition"]
for c in numeric_cols:
    if c in df.columns: df[c] = pd.to_numeric(df[c], errors="coerce")

for c in ["direct_use","facility_direct","independent_power_producers","estimated_losses"]:
    df[f"{c}_share_supply_pct"] = 100 * df[c] / df["total_supply"]

print(df.tail(3)[["period","direct_use_share_supply_pct","facility_direct_share_supply_pct"]])
