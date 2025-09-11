# server/ferc.py
import re, time, requests
from bs4 import BeautifulSoup

DOCINFO = "https://elibrary.ferc.gov/eLibrary/docinfo?accession_Number={acc}"
FILELIST = "https://elibrary.ferc.gov/eLibrary/filelist?document_id={doc_id}&optimized=false"

def fetch_docinfo(accession:str):
    r = requests.get(DOCINFO.format(acc=accession), timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    # Minimal parse: pull docket(s), subdocket(s), type, and a link to files if present.
    text = soup.get_text(" ", strip=True)
    # naive examples; tune selectors against the actual markup you see:
    docket = re.search(r"Docket.*?([A-Z]+\d{2,}-\d+)", text)
    doc_type = re.search(r"Type\.\s*([A-Za-z ]+)", text)
    return {
        "accession": accession,
        "docket": docket.group(1) if docket else None,
        "doc_type": doc_type.group(1).strip() if doc_type else None,
        "raw_text": text
    }

def score(record, now=None):
    # Very simple: plug your weights here; you’ll augment with recency and topic tags.
    base = 0
    if record.get("doc_type", "").lower().startswith(("order","rule")):
        base += 3
    if "transmission" in record.get("raw_text","").lower():
        base += 2
    return base
