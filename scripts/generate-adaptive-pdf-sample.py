"""Generate a synthetic, non-sensitive 20-page PDF for fill-agent E2E tests."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tmp_outputs" / "adaptive-fill-sample-20-pages.pdf"
WIDTH, HEIGHT = A4


def label_and_placeholder(pdf: canvas.Canvas, label: str, y: float, required: bool = False) -> None:
    suffix = " *" if required else ""
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(colors.HexColor("#293241"))
    pdf.drawString(48, y, f"{label}{suffix}")
    pdf.setFillColor(colors.black)
    # Deliberately use a standalone dash glyph. The adaptive extractor must
    # convert its tiny glyph box into the complete answer row to the margin.
    pdf.drawString(48, y - 17, "-")
    pdf.setStrokeColor(colors.HexColor("#CBD5E1"))
    pdf.line(48, y - 20, WIDTH - 48, y - 20)


def page_header(pdf: canvas.Canvas, page: int, title: str) -> None:
    pdf.setFillColor(colors.HexColor("#12355B"))
    pdf.rect(0, HEIGHT - 76, WIDTH, 76, fill=1, stroke=0)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(42, HEIGHT - 43, "Adaptive Supplier Form — Test Fixture")
    pdf.setFont("Helvetica", 8)
    pdf.drawRightString(WIDTH - 42, HEIGHT - 43, f"Page {page} of 20")
    pdf.setFillColor(colors.HexColor("#334155"))
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(48, HEIGHT - 104, title)


def footer(pdf: canvas.Canvas) -> None:
    pdf.setStrokeColor(colors.HexColor("#CBD5E1"))
    pdf.line(42, 38, WIDTH - 42, 38)
    pdf.setFillColor(colors.HexColor("#64748B"))
    pdf.setFont("Helvetica", 7)
    pdf.drawString(42, 25, "Synthetic test document — contains no personal or confidential data")


def master_page(pdf: canvas.Canvas) -> None:
    page_header(pdf, 1, "A. Company master data")
    fields = [
        ("Company name", True),
        ("Website", False),
        ("City", True),
        ("Country", True),
        ("Street and house number", False),
        ("Postal code", False),
        ("E-mail address", False),
        ("Telephone number", False),
    ]
    y = HEIGHT - 135
    for label, required in fields:
        label_and_placeholder(pdf, label, y, required)
        y -= 76
    footer(pdf)


def project_page(pdf: canvas.Canvas, page: int) -> None:
    page_header(pdf, page, f"B.{page - 1}. Optional reference project")
    pdf.setFont("Helvetica", 8)
    pdf.setFillColor(colors.HexColor("#64748B"))
    pdf.drawString(48, HEIGHT - 122, "Complete only when a matching company record is available; otherwise leave blank.")

    y = HEIGHT - 150
    for label in ("Project title", "Client organisation", "Project location", "Completion year"):
        label_and_placeholder(pdf, label, y)
        y -= 68

    pdf.setFillColor(colors.HexColor("#293241"))
    pdf.setFont("Helvetica", 9)
    pdf.drawString(48, y, "Service category (optional)")
    categories = ["Construction", "Planning", "Consulting"]
    x = 48
    pdf.setFont("Helvetica", 9)
    for category in categories:
        pdf.rect(x, y - 28, 10, 10, fill=0, stroke=1)
        pdf.drawString(x + 16, y - 27, category)
        x += stringWidth(category, "Helvetica", 9) + 58
    y -= 62

    pdf.drawString(48, y, "Contract values (optional)")
    table_top = y - 16
    row_h = 30
    cols = [48, 235, 375, WIDTH - 48]
    for x in cols:
        pdf.line(x, table_top, x, table_top - row_h * 3)
    for row in range(4):
        pdf.line(cols[0], table_top - row_h * row, cols[-1], table_top - row_h * row)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(56, table_top - 19, "Phase")
    pdf.drawString(243, table_top - 19, "Year")
    pdf.drawString(383, table_top - 19, "Value (EUR)")
    pdf.setFont("Helvetica", 8)
    pdf.drawString(56, table_top - 49, "Design")
    pdf.drawString(56, table_top - 79, "Delivery")

    y = table_top - row_h * 3 - 28
    pdf.setFont("Helvetica", 9)
    pdf.drawString(48, y, "Short description (optional)")
    pdf.setStrokeColor(colors.HexColor("#94A3B8"))
    for offset in (18, 38, 58):
        pdf.line(48, y - offset, WIDTH - 48, y - offset)
    footer(pdf)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(OUTPUT), pagesize=A4, pageCompression=1)
    pdf.setTitle("Adaptive PDF Filling — 20 Page Synthetic Test")
    pdf.setAuthor("BAU AI test fixture")
    master_page(pdf)
    pdf.showPage()
    for page in range(2, 21):
        project_page(pdf, page)
        if page < 20:
            pdf.showPage()
    pdf.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
