from pathlib import Path
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfbase.acroform import AcroForm
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

OUT = Path(__file__).resolve().parents[1] / "output" / "pdf" / "SEVEN_ROOTS_Employee_Training_Acknowledgment.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

W, H = LETTER
FOREST = HexColor("#143D32")
INK = HexColor("#22251F")
CLAY = HexColor("#C56B3C")
CREAM = HexColor("#F7F1E6")
GOLD = HexColor("#D6B56B")
MUTED = HexColor("#68706A")
LINE = HexColor("#D8D2C6")
GREEN = HexColor("#2F755B")

c = canvas.Canvas(str(OUT), pagesize=LETTER)
c.setTitle("SEVEN ROOTS Employee Training and Acknowledgment")
c.setAuthor("SEVEN ROOTS Botanical Oral Care")
form: AcroForm = c.acroForm

def footer(page, doc="SR-HR-FRM-001 | Rev. 1.0 | Effective 2026-08-23"):
    c.setStrokeColor(LINE); c.line(42, 34, W-42, 34)
    c.setFillColor(MUTED); c.setFont("Helvetica", 7)
    c.drawString(42, 21, doc)
    c.drawRightString(W-42, 21, f"Page {page} of 5 | Private employee record")

def header(label, title, page):
    c.setFillColor(FOREST); c.rect(0, H-92, W, 92, fill=1, stroke=0)
    c.setFillColor(GOLD); c.setFont("Helvetica-Bold", 9); c.drawString(42, H-34, "SEVEN ROOTS")
    c.setFillColor(white); c.setFont("Helvetica", 7); c.drawString(42, H-48, "BOTANICAL ORAL CARE | STAFF OPERATIONS")
    c.setFillColor(CLAY); c.setFont("Helvetica-Bold", 8); c.drawString(42, H-70, label.upper())
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 23); c.drawString(42, H-126, title)
    footer(page)

def text(txt, x, y, width, size=9, leading=13, color=MUTED, font="Helvetica"):
    c.setFillColor(color); c.setFont(font, size)
    lines = simpleSplit(txt, font, size, width)
    for line in lines:
        c.drawString(x, y, line); y -= leading
    return y

def field(name, label, x, y, width, height=22, required=False, multiline=False):
    c.setFillColor(MUTED); c.setFont("Helvetica-Bold", 7); c.drawString(x, y+height+5, label.upper() + (" *" if required else ""))
    flags = 4096 if multiline else 0
    form.textfield(name=name, x=x, y=y, width=width, height=height, borderColor=LINE,
                   fillColor=white, textColor=INK, borderWidth=1, fontName="Helvetica",
                   fontSize=9, fieldFlags=flags)

def checkbox(name, label, x, y, width=500):
    form.checkbox(name=name, x=x, y=y-2, size=12, borderColor=LINE, fillColor=white,
                  buttonStyle="check", checked=False)
    text(label, x+19, y, width-19, size=8, leading=11, color=INK)

def module_page(page, code, title, docnum, objective, sections, check_q, choices):
    header(f"Controlled training document | {docnum}", title, page)
    y = H-154
    c.setFillColor(CREAM); c.roundRect(42, y-54, W-84, 54, 6, fill=1, stroke=0)
    c.setFillColor(CLASSIC if False else CLAY); c.setFont("Helvetica-Bold", 7); c.drawString(56, y-17, "TRAINING OBJECTIVE")
    text(objective, 56, y-34, W-112, size=8, leading=11, color=INK)
    y -= 76
    for heading, points in sections:
        c.setFillColor(FOREST); c.setFont("Helvetica-Bold", 11); c.drawString(42, y, heading)
        y -= 17
        for point in points:
            c.setFillColor(CLAYS if False else CLAY); c.circle(47, y+3, 2, fill=1, stroke=0)
            y = text(point, 57, y+7, W-99, size=8, leading=11, color=MUTED) - 5
        y -= 5
    c.setFillColor(FOREST); c.roundRect(42, 114, W-84, 116, 7, fill=1, stroke=0)
    c.setFillColor(GOLD); c.setFont("Helvetica-Bold", 7); c.drawString(56, 210, "KNOWLEDGE CHECK - SELECT ONE")
    text(check_q, 56, 191, W-112, size=9, leading=12, color=white, font="Helvetica-Bold")
    cy = 162
    for idx, choice in enumerate(choices):
        form.checkbox(name=f"{code}_answer_{idx+1}", x=58, y=cy-3, size=11, borderColor=GOLD, fillColor=white, buttonStyle="check")
        text(choice, 76, cy, W-134, size=8, leading=10, color=white)
        cy -= 20
    field(f"{code}_employee_initials", "Employee initials after completing this module", 42, 63, 174, 22, True)
    field(f"{code}_completion_date", "Completion date (YYYY-MM-DD)", 235, 63, 160, 22, True)
    field(f"{code}_trainer_initials", "Trainer/manager initials", 414, 63, 156, 22)
    c.showPage()

# Page 1
header("Employee onboarding packet", "Training & Acknowledgment", 1)
y = H-158
y = text("Complete this private form before operational dashboard access is approved. Read each controlled training document, complete its knowledge check, initial and date the module, then sign the final acknowledgment.", 42, y, W-84, size=10, leading=15, color=MUTED)
y -= 18
c.setFillColor(CREAM); c.roundRect(42, y-164, W-84, 164, 7, fill=1, stroke=0)
field("employee_full_name", "Employee full legal name", 56, y-48, 310, 24, True)
field("employee_number", "Employee number", 386, y-48, 170, 24, True)
field("job_title", "Job title", 56, y-96, 245, 24, True)
field("work_location", "Work location - Liberia or United States", 321, y-96, 235, 24, True)
field("manager_name", "Assigned manager", 56, y-144, 245, 24, True)
field("hire_date", "Hire/start date (YYYY-MM-DD)", 321, y-144, 235, 24, True)
y -= 198
c.setFillColor(FOREST); c.setFont("Helvetica-Bold", 13); c.drawString(42, y, "Required training record")
y -= 24
modules = [
    ("01", "Personal Hygiene", "SR-HR-TRN-001", "Clean personal habits, handwashing, wound control, and illness reporting."),
    ("02", "Workplace Hygiene", "SR-QA-TRN-002", "Cleaning, contamination control, segregation, and escalation."),
    ("03", "Personal Protective Equipment", "SR-HSE-TRN-003", "Task-specific PPE selection, inspection, use, removal, and replacement."),
    ("04", "Customer Service Training", "SR-CS-TRN-004", "Respectful service, privacy, documentation, and escalation."),
]
for num, title, doc, desc in modules:
    c.setStrokeColor(LINE); c.roundRect(42, y-49, W-84, 49, 5, fill=0, stroke=1)
    c.setFillColor(CLAYS if False else CLAY); c.setFont("Helvetica-Bold", 11); c.drawString(55, y-20, num)
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 9); c.drawString(86, y-17, title)
    c.setFillColor(MUTED); c.setFont("Helvetica", 7); c.drawRightString(W-55, y-17, doc)
    text(desc, 86, y-32, W-141, size=7, leading=9)
    y -= 58
c.setFillColor(CREAM); c.roundRect(42, 56, W-84, 74, 6, fill=1, stroke=0)
c.setFillColor(CLAYS if False else CLAY); c.setFont("Helvetica-Bold", 8); c.drawString(56, 111, "EMPLOYEE PHOTO")
text("Attach or upload a clear recent employee photograph with this signed packet. The photo must match the staff profile submitted in the backend.", 56, 94, 330, size=8, leading=11, color=INK)
checkbox("photo_attached", "Employee photo attached or uploaded", 410, 86, 150)
c.showPage()

module_page(2, "PH", "Personal Hygiene", "SR-HR-TRN-001",
    "Protect products, coworkers, and customers by maintaining clean personal habits before and during every shift.",
    [("Arrive ready", ["Bathe regularly and report in clean work clothing.", "Keep fingernails short, clean, and free of false nails or loose polish when handling product.", "Cover cuts with a waterproof dressing and a glove when hands may contact product or packaging."]),
     ("Wash hands correctly", ["Wash with soap and clean running water for at least 20 seconds.", "Wash before work and after breaks, restroom use, eating, coughing, sneezing, waste handling, or touching unclean surfaces.", "Dry with a clean single-use towel or approved hand dryer."]),
     ("Report illness", ["Tell a manager before work if you have vomiting, diarrhea, fever, infected skin, or another condition that may contaminate product.", "Follow management instructions before returning to product-handling duties."])],
    "How long should hands be washed with soap and clean running water?",
    ["About 5 seconds", "At least 20 seconds", "Only when dirt is visible"])

module_page(3, "WH", "Workplace Hygiene", "SR-QA-TRN-002",
    "Keep receiving, processing, packing, storage, and fulfillment areas clean enough to prevent contamination and product mix-ups.",
    [("Clean as you go", ["Follow the posted cleaning schedule and use only approved cleaning materials.", "Clean and sanitize tools and contact surfaces before work, between incompatible activities, and after contamination.", "Keep chemicals labeled and away from product and packaging."]),
     ("Control contamination", ["Separate raw, approved, rejected, returned, and waste materials.", "Keep food, drinks, tobacco, and personal items outside product-handling areas.", "Never place product or primary packaging directly on the floor."]),
     ("Stop and report", ["Stop work for pests, spills, damaged packaging, foreign material, unusual odor, mold, or unsafe equipment.", "Never release quarantined or rejected stock without written authorization."])],
    "What should happen when a product-contact surface becomes contaminated?",
    ["Finish the batch, then clean", "Wipe it with work clothing", "Stop, clean and sanitize before continuing"])

module_page(4, "PPE", "Personal Protective Equipment", "SR-HSE-TRN-003",
    "Select, inspect, wear, remove, and replace PPE correctly for the assigned task and posted warehouse rules.",
    [("Use task-specific PPE", ["Wear assigned hair restraint, clean protective clothing, gloves, eye protection, safety footwear, mask, or other PPE.", "PPE never replaces handwashing, training, guards, or safe work practices."]),
     ("Inspect before use", ["Check PPE for holes, tears, contamination, poor fit, missing parts, or expired service life.", "Replace disposable gloves when torn, contaminated, or changing activities; never wash them for reuse."]),
     ("Remove safely", ["Avoid touching contaminated outer surfaces when removing PPE.", "Discard single-use PPE correctly and clean reusable PPE according to procedure.", "Report missing or damaged PPE before starting work."])],
    "What should you do before using assigned PPE?",
    ["Inspect its condition and fit", "Share it without cleaning", "Use it instead of washing hands"])

# Page 5 combines CST and signatures
header("Controlled training document | SR-CS-TRN-004", "Customer Service & Final Attestation", 5)
y = H-154
for heading, points in [
    ("Listen and confirm", ["Greet customers respectfully, listen without interrupting, and restate the concern.", "Confirm the order number and only the minimum information needed."]),
    ("Resolve within authority", ["Explain the next step, owner, and expected follow-up time.", "Escalate refunds, safety concerns, adverse reactions, legal threats, and matters outside your role.", "Never promise medical outcomes or invent product, shipping, or refund information."]),
    ("Protect privacy", ["Use customer information only for assigned work.", "Never share passwords, payment details, addresses, or records through unauthorized channels.", "Never request or store full payment-card numbers."])
]:
    c.setFillColor(FOREST); c.setFont("Helvetica-Bold", 10); c.drawString(42, y, heading); y -= 15
    for point in points:
        c.setFillColor(CLAY); c.circle(47, y+3, 2, fill=1, stroke=0)
        y = text(point, 57, y+7, W-99, size=7.5, leading=10, color=MUTED)-3
    y -= 3
c.setFillColor(CREAM); c.roundRect(42, y-77, W-84, 77, 6, fill=1, stroke=0)
c.setFillColor(CLAYS if False else CLAY); c.setFont("Helvetica-Bold", 7); c.drawString(56, y-16, "KNOWLEDGE CHECK - SELECT ONE")
text("Which sequence best handles a customer concern?", 56, y-33, 470, size=8, color=INK, font="Helvetica-Bold")
for idx, choice in enumerate(["Argue, defend, and close", "Listen, confirm, resolve or escalate, and document", "Promise anything to end the call"]):
    form.checkbox(name=f"CST_answer_{idx+1}", x=58+(idx*168), y=y-60, size=11, borderColor=LINE, fillColor=white, buttonStyle="check")
    text(choice, 75+(idx*168), y-57, 145, size=6.7, leading=8, color=INK)
y -= 100
c.setFillColor(FOREST); c.setFont("Helvetica-Bold", 12); c.drawString(42, y, "Employee acknowledgment and signature")
y -= 18
for name, label in [
    ("ack_truthful", "I completed this training myself and the information submitted is accurate."),
    ("ack_safety", "I will stop work and notify management about unsafe or contaminating conditions."),
    ("ack_policy", "I understand this training does not replace the current Scope of Work, posted procedures, or manager instructions."),
    ("ack_confidentiality", "I will protect employee, customer, order, payment, and company information."),
]:
    checkbox(name, label, 44, y, 520); y -= 27
field("employee_signature", "Employee signature - type full name or sign after printing", 42, y-45, 330, 28, True)
field("employee_signed_date", "Date signed (YYYY-MM-DD)", 392, y-45, 178, 28, True)
y -= 84
c.setFillColor(FOREST); c.setFont("Helvetica-Bold", 12); c.drawString(42, y, "Management review and approval")
y -= 20
field("management_review_notes", "Review notes or required corrections", 42, y-70, W-84, 54, multiline=True)
y -= 106
checkbox("management_approved", "Approved - employee may enter the staff operations dashboard", 44, y, 500)
checkbox("management_changes", "Changes required - dashboard remains locked until resubmission", 44, y-25, 500)
field("manager_name_approval", "Reviewing manager full name", 42, 59, 244, 24, True)
field("manager_signature", "Manager signature", 306, 59, 150, 24, True)
field("manager_review_date", "Review date", 476, 59, 94, 24, True)
c.showPage()

c.save()
print(OUT)
