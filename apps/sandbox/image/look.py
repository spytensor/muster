#!/usr/bin/env python3
"""look FILE...: what a Word, Excel, PowerPoint or PDF file looks like once it is laid out.

Turns the file into pages the way an office program would, then says, page by page, what
a reader would notice at a glance: how many pages, text that stands on other text, text
that runs off the page, and pages that are nearly empty. Each page is also kept as a
picture under look/, for a person to see.
"""

import os
import subprocess
import sys
import tempfile

import pymupdf as fitz


def to_pdf(path):
    if path.lower().endswith(".pdf"):
        return path
    out = tempfile.mkdtemp(prefix="look-")
    done = subprocess.run(
        ["soffice", "--headless", "--convert-to", "pdf", "--outdir", out, path],
        capture_output=True,
        text=True,
        timeout=180,
    )
    made = os.path.join(out, os.path.splitext(os.path.basename(path))[0] + ".pdf")
    if not os.path.exists(made):
        raise SystemExit(f"{path}: could not be laid out. {done.stderr.strip()[:300]}")
    return made


def overlap(a, b):
    wide = min(a.x1, b.x1) - max(a.x0, b.x0)
    tall = min(a.y1, b.y1) - max(a.y0, b.y0)
    return wide * tall if wide > 0 and tall > 0 else 0


def look(path):
    pdf = to_pdf(path)
    doc = fitz.open(pdf)
    stem = os.path.splitext(os.path.basename(path))[0]
    os.makedirs("look", exist_ok=True)
    print(f"{path}: {doc.page_count} page{'s' if doc.page_count != 1 else ''}")
    problems = 0
    for number, page in enumerate(doc, start=1):
        lines = []
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                words = "".join(span["text"] for span in line["spans"]).strip()
                if words:
                    lines.append((fitz.Rect(line["bbox"]), words))
        notes = []
        for i, (box, words) in enumerate(lines):
            if box.x1 > page.rect.x1 + 1 or box.y1 > page.rect.y1 + 1 or box.x0 < -1 or box.y0 < -1:
                notes.append(f'runs off the page: "{words[:50]}"')
            for other, theirs in lines[i + 1 :]:
                shared = overlap(box, other)
                # Lines of one paragraph touch; text on text shares a good part of the smaller.
                if shared > 0.25 * min(box.get_area(), other.get_area()) and shared > 4:
                    notes.append(f'text on text: "{words[:40]}" and "{theirs[:40]}"')
        if not lines and not page.get_images():
            notes.append("empty")
        if number <= 40:
            page.get_pixmap(dpi=72).save(os.path.join("look", f"{stem}-{number}.png"))
        problems += len(notes)
        first = lines[0][1][:60] if lines else ""
        print(f"  page {number}: {len(lines)} lines" + (f' · begins "{first}"' if first else ""))
        for note in notes[:8]:
            print(f"    ! {note}")
        if len(notes) > 8:
            print(f"    ! and {len(notes) - 8} more")
    print("  nothing stands on anything else." if not problems else f"  {problems} thing(s) to fix.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for name in sys.argv[1:]:
        look(name)
