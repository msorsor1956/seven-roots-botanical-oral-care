from pathlib import Path
from shutil import copyfile, which
from subprocess import run
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "SEVEN_ROOTS_Packaging_Production_Brief.pdf"
PUBLIC_OUTPUT = ROOT / "assets" / "SEVEN_ROOTS_Packaging_Production_Brief.pdf"
EXPLODED = ROOT / "assets" / "seven-roots-packaging-exploded-family.webp"

FOREST = HexColor("#173D32")
FOREST_DARK = HexColor("#102B24")
GOLD = HexColor("#D6AE62")
CLAY = HexColor("#C86C3A")
IVORY = HexColor("#F2E8D8")
PAPER = HexColor("#FBF7EF")
INK = HexColor("#24251F")
MUTED = HexColor("#5A5D51")
LINE = HexColor("#D8CFBF")
WHITE = HexColor("#FFFFFF")
PAGE_W, PAGE_H = letter
M = 42

SANS = "DejaVuSans"
SANS_BOLD = "DejaVuSans-Bold"
SERIF = "DejaVuSerif"
pdfmetrics.registerFont(TTFont(SANS, "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont(SANS_BOLD, "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont(SERIF, "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"))

body = ParagraphStyle("body", fontName=SANS, fontSize=8.1, leading=12.5, textColor=MUTED, alignment=TA_LEFT)
body_dark = ParagraphStyle("body_dark", parent=body, textColor=HexColor("#C9D3CE"))
small = ParagraphStyle("small", parent=body, fontSize=7.4, leading=10.5)
small_dark = ParagraphStyle("small_dark", parent=small, textColor=HexColor("#C9D3CE"))

def draw_paragraph(c, text, x, y_top, width, height, style=body):
    p = Paragraph(text, style)
    _, h = p.wrap(width, height)
    p.drawOn(c, x, y_top - h)
    return h

def page_base(c, page_number, dark=False):
    c.setFillColor(FOREST_DARK if dark else PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setStrokeColor(Color(1, 1, 1, .16) if dark else LINE)
    c.line(M, 32, PAGE_W - M, 32)
    c.setFont(SANS_BOLD, 6.5)
    c.setFillColor(GOLD if dark else FOREST)
    c.drawString(M, 19, "SEVEN ROOTS · PACKAGING PRODUCTION BRIEF")
    c.setFillColor(HexColor("#9CAF9F") if dark else MUTED)
    c.drawRightString(PAGE_W - M, 19, f"PROPOSED · PAGE {page_number} OF 4")

def eyebrow(c, text, x, y, dark=False):
    c.setFillColor(GOLD if dark else CLAY)
    c.setFont(SANS_BOLD, 7)
    c.drawString(x, y, text.upper())

def title(c, text, x, y, size=27, dark=False):
    max_width = PAGE_W - M - x
    fitted_size = min(size, max_width / stringWidth(text, SERIF, 1))
    c.setFillColor(IVORY if dark else FOREST_DARK)
    c.setFont(SERIF, fitted_size)
    c.drawString(x, y, text)

def pill(c, text, x, y, fill, foreground):
    width = stringWidth(text, SANS_BOLD, 6.5) + 18
    c.setFillColor(fill)
    c.roundRect(x, y, width, 20, 10, fill=1, stroke=0)
    c.setFillColor(foreground)
    c.setFont(SANS_BOLD, 6.5)
    c.drawString(x + 9, y + 7, text)
    return width

def card(c, x, y, w, h, fill=WHITE, stroke=LINE):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.roundRect(x, y, w, h, 12, fill=1, stroke=1)

def label_value(c, label, value, x, y, label_color=MUTED, value_color=INK):
    c.setFillColor(label_color)
    c.setFont(SANS_BOLD, 6.2)
    c.drawString(x, y, label.upper())
    c.setFillColor(value_color)
    c.setFont(SANS_BOLD, 8.1)
    c.drawString(x, y - 13, value)

def bullet(c, text, x, y, width, dark=False):
    c.setFillColor(CLAY)
    c.circle(x + 3, y - 3, 2.2, fill=1, stroke=0)
    return draw_paragraph(c, text, x + 13, y + 2, width - 13, 30, small_dark if dark else small)

def measure_arrow(c, x1, y1, x2, y2, text, vertical=False):
    c.setStrokeColor(CLAY); c.setFillColor(CLAY); c.setLineWidth(1)
    c.line(x1, y1, x2, y2)
    if vertical:
        c.line(x1 - 3, y1 + 5, x1, y1); c.line(x1 + 3, y1 + 5, x1, y1)
        c.line(x2 - 3, y2 - 5, x2, y2); c.line(x2 + 3, y2 - 5, x2, y2)
        c.saveState(); c.translate(x1 - 8, (y1 + y2) / 2); c.rotate(90); c.setFont(SANS_BOLD, 6.5); c.drawCentredString(0, 0, text); c.restoreState()
    else:
        c.line(x1 + 5, y1 - 3, x1, y1); c.line(x1 + 5, y1 + 3, x1, y1)
        c.line(x2 - 5, y2 - 3, x2, y2); c.line(x2 - 5, y2 + 3, x2, y2)
        c.setFont(SANS_BOLD, 6.5); c.drawCentredString((x1 + x2) / 2, y1 - 12, text)

def package_drawing(c, x, y, w, h, sku, name, metric, count):
    c.setFillColor(WHITE); c.setStrokeColor(LINE); c.roundRect(x, y, w, h, 10, fill=1, stroke=1)
    c.setFillColor(CLAY); c.setFont(SANS_BOLD, 6); c.drawString(x + 12, y + h - 20, sku)
    c.setFillColor(FOREST_DARK); c.setFont(SERIF, 11.5); c.drawString(x + 12, y + h - 39, name)
    if count == 1:
        pw, ph = 28, 118
    elif count == 5:
        pw, ph = 96, 54
    else:
        pw, ph = 108, 78
    px = x + (w - pw) / 2; py = y + 47
    c.setFillColor(FOREST); c.setStrokeColor(FOREST_DARK); c.roundRect(px, py, pw, ph, 3, fill=1, stroke=1)
    c.setFillColor(CLAY); c.rect(px, py + ph * .17, pw, max(9, ph * .18), fill=1, stroke=0)
    c.setStrokeColor(GOLD); c.setLineWidth(1); c.line(px + pw*.34, py + ph*.62, px + pw*.66, py + ph*.82); c.line(px + pw*.66, py + ph*.62, px + pw*.34, py + ph*.82)
    measure_arrow(c, px, py - 15, px + pw, py - 15, metric.split(" x ")[0])
    measure_arrow(c, px - 14, py, px - 14, py + ph, metric.split(" x ")[1], vertical=True)
    c.setFillColor(MUTED); c.setFont(SANS, 6.2); c.drawCentredString(x + w/2, y + 15, f"depth {metric.split(' x ')[2]} · {count} stick{'s' if count > 1 else ''}")

def measurement_board(c, x, y, w, h):
    c.setFillColor(IVORY); c.setStrokeColor(LINE); c.roundRect(x, y, w, h, 12, fill=1, stroke=1)
    c.setFillColor(FOREST); c.setFont(SANS_BOLD, 6.5); c.drawString(x + 14, y + h - 18, "PROPOSED TECHNICAL ENVELOPE · MM")
    gap = 10; panel_w = (w - 28 - gap*2) / 3
    package_drawing(c, x + 14, y + 20, panel_w, h - 50, "SR-T01 · 01", "Travel Sleeve", "190 x 38 x 22 mm", 1)
    package_drawing(c, x + 14 + panel_w + gap, y + 20, panel_w, h - 50, "SR-R05 · 05", "Daily Ritual", "200 x 110 x 38 mm", 5)
    package_drawing(c, x + 14 + (panel_w + gap)*2, y + 20, panel_w, h - 50, "SR-F12 · 12", "Family Reserve", "210 x 155 x 50 mm", 12)

def page_one(c):
    page_base(c, 1)
    eyebrow(c, "African botanical oral care", M, PAGE_H - 72)
    title(c, "Packaging architecture for three rituals", M, PAGE_H - 118, 32)
    draw_paragraph(c, "A proposed production system for the one-stick Travel Sleeve, five-stick Daily Ritual, and twelve-stick Family Reserve. The brand family combines forest-green paperboard, terracotta coding, antique-gold detail, kraft structure, and hygienic primary wraps.", M, PAGE_H - 142, 500, 64)
    pill(c, "DESIGN + QUOTING BASIS", M, PAGE_H - 205, CLAY, WHITE)
    pill(c, "PHYSICAL SAMPLE REQUIRED", M + 128, PAGE_H - 205, FOREST, IVORY)
    img = ImageReader(str(EXPLODED))
    c.drawImage(img, M, 112, PAGE_W - 2*M, 360, preserveAspectRatio=True, anchor="c", mask="auto")
    c.setFillColor(FOREST)
    c.setFont(SERIF, 14)
    c.drawString(M, 82, "Ancient roots. Modern ritual.")
    c.setFillColor(MUTED)
    c.setFont(SANS, 7.2)
    c.drawRightString(PAGE_W - M, 83, "Exploded render shows component relationships; exact measurements follow.")
    c.showPage()

def page_two(c):
    page_base(c, 2)
    eyebrow(c, "Measurements", M, PAGE_H - 64)
    title(c, "Proposed finished-pack dimensions", M, PAGE_H - 104, 28)
    draw_paragraph(c, "Dimensions are length x width x depth. Confirm the product envelope at the 95th percentile, then let the packaging converter add board caliper, machine tolerances, glue flaps, bleed, grain direction, and cut/crease geometry.", M, PAGE_H - 126, 515, 48)
    measurement_board(c, M, 330, PAGE_W - 2*M, 300)

    widths = [163, 163, 163]
    x_positions = [M, M + 174, M + 348]
    products = [
        ("SR-T01", "Travel Sleeve", "190 x 38 x 22 mm", "7.48 x 1.50 x 0.87 in", "1 wrapped stick"),
        ("SR-R05", "Daily Ritual", "200 x 110 x 38 mm", "7.87 x 4.33 x 1.50 in", "5 wrapped sticks"),
        ("SR-F12", "Family Reserve", "210 x 155 x 50 mm", "8.27 x 6.10 x 1.97 in", "12 wrapped sticks"),
    ]
    for x, w, product in zip(x_positions, widths, products):
        card(c, x, 86, w, 225)
        sku, name, metric, imperial, count = product
        eyebrow(c, sku, x + 16, 286)
        c.setFillColor(FOREST_DARK); c.setFont(SERIF, 15); c.drawString(x + 16, 262, name)
        label_value(c, "Finished size", metric, x + 16, 231)
        label_value(c, "Imperial", imperial, x + 16, 190)
        label_value(c, "Pack count", count, x + 16, 149)
        label_value(c, "Status", "Proposed - validate", x + 16, 108, value_color=CLAY)
    c.showPage()

def product_band(c, y, sku, name, subtitle, size, description, construction, dark=False):
    fill = FOREST if dark else WHITE
    stroke = FOREST if dark else LINE
    card(c, M, y, PAGE_W - 2*M, 200, fill=fill, stroke=stroke)
    x = M + 20
    eyebrow(c, sku, x, y + 172, dark)
    title(c, name, x, y + 140, 22, dark)
    c.setFillColor(GOLD if dark else CLAY); c.setFont(SANS_BOLD, 7); c.drawString(x, y + 118, size)
    draw_paragraph(c, description, x, y + 100, 240, 78, body_dark if dark else body)
    c.setStrokeColor(Color(1,1,1,.16) if dark else LINE); c.line(M + 290, y + 20, M + 290, y + 180)
    eyebrow(c, subtitle, M + 312, y + 172, dark)
    by = y + 145
    for item in construction:
        bullet(c, item, M + 312, by, 210, dark)
        by -= 30

def page_three(c):
    page_base(c, 3)
    eyebrow(c, "Format descriptions + construction", M, PAGE_H - 64)
    title(c, "One system, three packaging jobs", M, PAGE_H - 104, 28)
    product_band(c, 468, "SR-T01 · 01", "Travel Sleeve", "PROPOSED CONSTRUCTION", "190 x 38 x 22 mm",
                 "A single 165 mm stick rests in a narrow kraft cradle inside a tamper-evident folding sleeve. Preparation and storage guidance print inside the flap or on a compact folded strip.",
                 ["350-400 gsm uncoated folding paperboard", "Kraft-fibre retaining cradle", "One food-contact-approved cellulose wrap", "Water-based matte protection if rub testing requires it"])
    product_band(c, 258, "SR-R05 · 05", "Daily Ritual", "PROPOSED CONSTRUCTION", "200 x 110 x 38 mm",
                 "The signature pull-drawer organizes five wrapped sticks in one presentation row. A reusable ventilated tube and folded care guide use a dedicated side or lower channel.",
                 ["400 gsm outer sleeve; 500-600 gsm kraft drawer", "Five sealed cellulose primary wraps", "Vented tube: 180 mm long x 24 mm outside diameter", "Folded ritual guide: 85 x 75 mm finished"], True)
    product_band(c, 48, "SR-F12 · 12", "Family Reserve", "PROPOSED CONSTRUCTION", "210 x 155 x 50 mm",
                 "Twelve wrapped sticks sit in two indexed rows of six. A larger folding carton, removable fibre tray, and recloseable band support household storage and stock rotation.",
                 ["400-450 gsm uncoated paperboard carton", "Moulded-fibre or folded-kraft two-row tray", "Twelve sealed cellulose primary wraps", "Care guide: 180 x 120 mm before folding"])
    c.showPage()

def page_four(c):
    page_base(c, 4, dark=True)
    eyebrow(c, "Production controls", M, PAGE_H - 64, True)
    title(c, "What must be approved before mass production", M, PAGE_H - 104, 27, True)
    draw_paragraph(c, "The measurements in this brief support early supplier quoting and prototype development. They are not final dielines and do not replace packaging engineering, food-contact review, product testing, or market-specific label review.", M, PAGE_H - 126, 520, 55, body_dark)

    sections = [
        ("01 · PRODUCT ENVELOPE", ["Condition representative sticks and record length and diameter distribution.", "Use the 95th-percentile pack-out sample to confirm internal clearances.", "Target stick: 165 mm long x 10-14 mm diameter; natural tolerance remains expected."]),
        ("02 · MATERIAL + BARRIER", ["Validate every primary wrap for food-contact suitability and seal integrity.", "Set moisture and oxygen barrier only after microbial and shelf-life testing.", "Verify board caliper, rub resistance, odor transfer, migration, and transit performance."]),
        ("03 · LABEL CONTENT", ["Botanical name, plant part, country of origin, lot, pack date, best-before date, and storage.", "Preparation, use, air-drying, replacement, supervision, irritation warning, and professional-care statement.", "Responsible business details, net count, barcode, and validated disposal instructions."]),
        ("04 · GOLDEN SAMPLE", ["Approve a converter white sample before artwork lock.", "Run fit, drop, vibration, compression, seal, microbial, moisture, and accelerated shelf-life tests.", "Sign a fully packed printed golden sample before mass production."]),
    ]
    coords = [(M, 410), (314, 410), (M, 148), (314, 148)]
    for (heading, items), (x, y) in zip(sections, coords):
        c.setFillColor(HexColor("#173D32")); c.setStrokeColor(Color(1,1,1,.16)); c.roundRect(x, y, 256, 224, 13, fill=1, stroke=1)
        eyebrow(c, heading, x + 18, y + 194, True)
        by = y + 163
        for item in items:
            h = bullet(c, item, x + 18, by, 220, True)
            by -= max(43, h + 18)

    c.setFillColor(CLAY); c.rect(M, 66, 4, 70, fill=1, stroke=0)
    c.setFillColor(IVORY); c.setFont(SERIF, 16); c.drawString(M + 18, 113, "Approval note")
    draw_paragraph(c, "Confirm certification, sustainability, recycling, origin, and oral-care claims before printing. Decorative linework must be original and must not copy sacred, restricted, or community-owned symbols.", M + 18, 98, 492, 38, small_dark)
    c.showPage()

def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    if not EXPLODED.exists():
        raise FileNotFoundError("Required packaging artwork is missing")
    c = canvas.Canvas(str(OUTPUT), pagesize=letter, pageCompression=1)
    c.setTitle("SEVEN ROOTS Packaging Production Brief")
    c.setAuthor("SEVEN ROOTS")
    c.setSubject("Proposed packaging descriptions, dimensions, exploded view, materials, and production validation")
    page_one(c); page_two(c); page_three(c); page_four(c)
    c.save()
    if which("gs"):
        optimized = OUTPUT.with_name(f"{OUTPUT.stem}.optimized.pdf")
        run([
            "gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.5", "-dPDFSETTINGS=/ebook", "-dDetectDuplicateImages=true",
            "-dCompressFonts=true", "-dSubsetFonts=true", f"-sOutputFile={optimized}", str(OUTPUT)
        ], check=True)
        optimized.replace(OUTPUT)
    copyfile(OUTPUT, PUBLIC_OUTPUT)
    print(OUTPUT)

if __name__ == "__main__":
    build()
