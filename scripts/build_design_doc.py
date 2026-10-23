"""Regenerate output/design/design_document.md from HLD.md (case study deliverable 6.6)."""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
hld = open(os.path.join(ROOT, "HLD.md")).read()


def section(title):
    m = re.search(r"^## " + re.escape(title) + r"\n(.*?)(?=^## |\Z)", hld, re.S | re.M)
    return m.group(1).strip()


parts = [
    "# FraudShield design document", "",
    "Deliverable for case study section 6.6 (`/output/design`). Generated from [HLD.md](../../HLD.md); edit HLD.md and "
    "regenerate with `python3 scripts/build_design_doc.py`.", "",
    "## Decision flowchart (R1 to R13 evaluation order)", "", section("5. Rules engine and decision policy"), "",
    "## Transaction and alert status lifecycles", "", section("6. Status lifecycles"), "",
    "## ER diagram", "", section("7. Data model"), "",
    "## Architecture", "", section("2. System context"), "",
    "## Technology decisions", "", section("12. Architecture decisions"), "",
    "## API documentation", "",
    "OpenAPI 3: `GET /api/openapi.json`, Swagger UI at `/api/docs` (source `backend/src/openapi.js`). Summary: "
    "[docs/API.md](../../docs/API.md).", "",
    "## Assumptions", "", "See [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md#assumptions-and-interpretations).", "",
]
os.makedirs(os.path.join(ROOT, "output", "design"), exist_ok=True)
with open(os.path.join(ROOT, "output", "design", "design_document.md"), "w") as f:
    f.write("\n".join(parts))
print("output/design/design_document.md written")
