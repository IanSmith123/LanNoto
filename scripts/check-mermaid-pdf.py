"""Verify the native --mermaid print fixture. Dev-only pypdf dependency."""
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

path = Path(sys.argv[1])
reader = PdfReader(path)
pages = [page.extract_text() for page in reader.pages]
compact = re.sub(r"\s+", "", "\n".join(pages))
checks = {label: label in compact for label in [
    "MERMAID_START", "MERMAID_END", "MERMAID_OFFSCREEN",
    "MERMAID_DOCUMENT_END", "Alice", "Bob", "开始", "完成", "你好",
]}
checks["noSourceCode"] = "flowchartLR" not in compact and "sequenceDiagram" not in compact
checks["noEmptyPages"] = all(text.strip() for text in pages)
checks["noApplicationControls"] = not any(label in compact for label in ["关闭打印预览", "下载Word", "在线成员"])
report = {"pdf": str(path.resolve()), "pages": len(pages), "checks": checks}
(path.parent / "mermaid-content.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
if not all(checks.values()):
    raise SystemExit(1)
