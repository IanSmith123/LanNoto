"""Inspect verify-print.mjs's native PDF fixture; requires dev-only pypdf.

This checks text/image presence, not formula rendering or visual correctness.
The native browser verifier separately rejects unrendered block formulas.
"""
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader


path = Path(sys.argv[1])
reader = PdfReader(path)
text = "\n".join(page.extract_text() for page in reader.pages)
sections = [int(value) for value in re.findall(r"正文第\s*(\d+)\s*节", text)]
starts = re.findall(r"CODE_(\d{3})_START", text)
ends = re.findall(r"CODE_(\d{3})_END", text)
expected_codes = [f"{index:03d}" for index in range(90)]
checks = {
    "allSectionsInOrder": sections == list(range(1, 31)),
    "allCodeStartsInOrder": starts == expected_codes,
    "allCodeEndsInOrder": ends == expected_codes,
    "documentEnd": "DOCUMENT_END_验收完成" in text,
    "chineseTitle": "中文打印验收" in text,
    "wideTableEdges": "TABLE_START" in text and "TABLE_END" in text,
    "oneBitmap": sum(len(page.images) for page in reader.pages) == 1,
    "noApplicationControls": not any(
        label in text for label in ["关闭打印预览", "在线成员", "下载 Word"]
    ),
    "noEmptyPages": all(page.extract_text().strip() or len(page.images) for page in reader.pages),
}
report = {
    "pdf": str(path.resolve()),
    "pages": len(reader.pages),
    "sections": sections,
    "checks": checks,
    "passed": all(checks.values()),
    "scope": "Fixture content only; does not establish rendered formulas or visual quality.",
}
path.with_name("pdf-content.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print(json.dumps(report, ensure_ascii=True))
sys.exit(0 if report["passed"] else 1)
