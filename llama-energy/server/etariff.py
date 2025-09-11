import base64, re, requests
from bs4 import BeautifulSoup
from fastapi import APIRouter, Query

router = APIRouter()

@router.get("/etariff/list")
def etariff_list(company: str = Query(...)):
    # Worker proxy returns raw HTML (keeps CORS simple)
    worker = "https://llama-energy.aristocles24.workers.dev/api/etariff/list"
    r = requests.get(worker, params={"company": company}, timeout=30); r.raise_for_status()
    html = r.json()["html"]
    soup = BeautifulSoup(html, "html.parser")
    rows = []
    # Heuristic selectors – TariffList shows a grid; adjust after inspecting markup
    for tr in soup.select("table tr"):
      tds = [td.get_text(" ", strip=True) for td in tr.select("td")]
      link = tr.select_one("a[href]"); href = (link["href"] if link else None)
      if len(tds) >= 3:
        rows.append({
          "company": company,
          "tariff_title": tds[0],
          "record": tds[1],
          "status": tds[2],
          "href": (("https://etariff.ferc.gov/"+href) if href and href.startswith("Tariff") else href)
        })
    return {"company": company, "rows": rows}

@router.get("/etariff/record")
def etariff_record(link: str = Query(...)):
    # Fetch via Worker passthrough for caching/CORS
    worker = "https://llama-energy.aristocles24.workers.dev/api/etariff/record"
    r = requests.get(worker, params={"link": link}, timeout=30); r.raise_for_status()
    content = r.text
    # If page presents XML payload or a download button, you can follow the href and decode base64
    # Example: look for <textarea> or <pre> with XML or “data:” links.
    m = re.search(r"<\?xml[^>]*>.*</Filing>", content, re.S|re.I)
    xml = m.group(0) if m else None
    return {"link": link, "has_xml": bool(xml), "xml_snippet": (xml[:1000] if xml else None)}
