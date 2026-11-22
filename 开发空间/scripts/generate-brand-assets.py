"""Reproducible code-native EnvDock identity. Requires Pillow (asset authoring only)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri/icons"
ART = ROOT / "src-tauri/installer"
PUBLIC = ROOT / "public"
for folder in (ICONS, ART, PUBLIC):
    folder.mkdir(parents=True, exist_ok=True)

BG = "#0B111B"
CYAN = "#39E0D0"
BLUE = "#438FFF"
# Two interlocking, forward-facing pieces. The left silhouette reads as E.
LEFT = [(58, 58), (174, 58), (148, 84), (86, 84), (86, 114),
        (138, 114), (162, 140), (86, 140), (86, 172), (174, 172),
        (148, 198), (58, 198)]
RIGHT = [(183, 92), (218, 128), (183, 164), (156, 164),
         (191, 128), (156, 92)]
def points(items):
    return " ".join(f"{x},{y}" for x, y in items)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="56" fill="{BG}"/>
  <polygon points="{points(LEFT)}" fill="{CYAN}"/>
  <polygon points="{points(RIGHT)}" fill="{BLUE}"/>
</svg>
'''
(PUBLIC / "envdock.svg").write_text(svg, encoding="utf-8")

def logo(size):
    scale = 4
    im = Image.new("RGBA", (256 * scale, 256 * scale))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, 256*scale-1, 256*scale-1), 56*scale, fill=BG)
    for shape, color in ((LEFT, CYAN), (RIGHT, BLUE)):
        d.polygon([(x*scale, y*scale) for x,y in shape], fill=color)
    return im.resize((size, size), Image.Resampling.LANCZOS)

logo(256).save(ICONS / "icon.png")
logo(256).save(ICONS / "icon.ico", sizes=[(n,n) for n in (16,24,32,48,64,128,256)])

# High-resolution MUI bitmaps, matching the 164:314 sidebar aspect ratio.
canvas = Image.new("RGB", (492, 942), BG)
d = ImageDraw.Draw(canvas)
for y in range(942):
    t = y / 941
    d.line((0,y,491,y), fill=(11+int(3*t),17+int(10*t),27+int(16*t)))
for x in range(-440, 650, 54):
    d.line((x,942,x+450,400), fill="#152C3B", width=1)
d.line((58,70,126,70), fill=CYAN, width=4)
canvas.paste(logo(190), (48,200), logo(190))
fontdir = Path("C:/Windows/Fonts")
bold = ImageFont.truetype(str(fontdir / "segoeuib.ttf"), 48)
regular = ImageFont.truetype(str(fontdir / "segoeui.ttf"), 20)
small = ImageFont.truetype(str(fontdir / "segoeui.ttf"), 17)
d.text((62,430), "EnvDock", font=bold, fill="#EDF5FA")
d.text((65,500), "LOCAL API WORKBENCH", font=small, fill=CYAN)
d.text((65,754), "Build. Send. Inspect.", font=regular, fill="#B4C5D6")
d.text((65,798), "YOUR APIS. YOUR MACHINE.", font=small, fill="#70889C")
canvas.save(ART / "sidebar.bmp")
header = Image.new("RGB", (450,171), BG)
header.paste(logo(126), (300,22), logo(126))
header.save(ART / "header.bmp")
print("Generated SVG, seven-size ICO, PNG and installer bitmaps.")
