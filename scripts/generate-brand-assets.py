"""Export the shared EnvDock brand master to application and installer assets.

Authoring dependency: Pillow 13.0.0 (never required by the shipped app).
Run: python scripts/generate-brand-assets.py
Check committed exports: python scripts/generate-brand-assets.py --check

The small SVG subset used by assets/brand/mark.svg is rendered here so asset
creation needs no browser, platform fonts, macOS iconutil, or Node packages.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "assets/brand/mark.svg"
SUPERSAMPLE = 4
SVG_NS = "{http://www.w3.org/2000/svg}"


def color(value: str) -> tuple[int, int, int]:
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def path_points(data: str) -> list[tuple[float, float]]:
    """Read absolute M/L/H/V/Q/Z paths; reject unsupported source edits."""
    tokens = re.findall(r"[A-Za-z]|-?(?:\d*\.\d+|\d+)", data)
    points: list[tuple[float, float]] = []
    position = (0.0, 0.0)
    index = 0
    while index < len(tokens):
        command = tokens[index]
        index += 1
        count = {"M": 2, "L": 2, "H": 1, "V": 1, "Q": 4, "Z": 0}.get(command)
        if count is None:
            raise ValueError(f"Unsupported SVG path command: {command}")
        numbers = [float(x) for x in tokens[index:index + count]]
        index += count
        if command in ("M", "L"):
            position = (numbers[0], numbers[1])
            points.append(position)
        elif command == "H":
            position = (numbers[0], position[1])
            points.append(position)
        elif command == "V":
            position = (position[0], numbers[0])
            points.append(position)
        elif command == "Q":
            start, control, end = position, numbers[:2], numbers[2:]
            for step in range(1, 17):
                t = step / 16
                points.append(tuple((1-t)**2 * start[n] + 2*(1-t)*t * control[n] + t*t * end[n] for n in (0, 1)))
            position = (end[0], end[1])
    return points


def gradient(size: int, start: str, end: str) -> Image.Image:
    """Match the SVG's diagonal sRGB interpolation at a fixed source scale."""
    a, b = color(start), color(end)
    ramp = [tuple(round(a[n] + (b[n]-a[n]) * i/510) for n in range(3)) for i in range(511)]
    image = Image.new("RGB", (256, 256))
    image.putdata([ramp[x+y] for y in range(256) for x in range(256)])
    return image.resize((size, size), Image.Resampling.BILINEAR)


def logo(size: int, *, desktop: bool = False) -> Image.Image:
    root = ET.fromstring(MASTER.read_text(encoding="utf-8"))
    if root.attrib.get("viewBox") != "0 0 256 256":
        raise ValueError("The brand master must use the shared 256x256 viewBox")
    scale = SUPERSAMPLE * size / 256
    edge = size * SUPERSAMPLE
    definitions = root.find(f"{SVG_NS}defs")
    gradients = {element.attrib["id"]: element for element in definitions}
    image = Image.new("RGBA", (edge, edge))
    for element in root:
        tag = element.tag.removeprefix(SVG_NS)
        if tag == "defs":
            continue
        if tag == "rect":
            x, y = (float(element.attrib.get(k, 0)) * scale for k in ("x", "y"))
            width, height = (float(element.attrib[k]) * scale for k in ("width", "height"))
            radius = float(element.attrib["rx"]) * scale
            bounds = (x, y, x+width-1, y+height-1)
            if element.attrib.get("fill") != "none":
                stops = list(gradients["tile"])
                fill = gradient(edge, stops[0].attrib["stop-color"], stops[1].attrib["stop-color"]).convert("RGBA")
                mask = Image.new("L", image.size)
                ImageDraw.Draw(mask).rounded_rectangle(bounds, radius, fill=255)
                fill.putalpha(mask)
                image.alpha_composite(fill)
            else:
                stops = list(gradients["edge"])
                opacity = Image.new("L", (1, 256))
                start, end = [float(stop.attrib["stop-opacity"]) for stop in stops]
                opacity.putdata([round(255 * (start + (end-start) * y/255)) for y in range(256)])
                opacity = opacity.resize(image.size, Image.Resampling.BILINEAR)
                mask = Image.new("L", image.size)
                ImageDraw.Draw(mask).rounded_rectangle(bounds, radius, outline=255, width=max(1, round(float(element.attrib["stroke-width"])*scale)))
                border = Image.new("RGBA", image.size, "white")
                border.putalpha(ImageChops.multiply(mask, opacity))
                image.alpha_composite(border)
        elif tag == "path":
            # At 16/24px the central pillars would be subpixel details. The
            # two large paired chambers remain the same shared brand mark.
            if size <= 24 and element.attrib.get("data-small-hidden") == "true":
                continue
            points = [(x*scale, y*scale) for x, y in path_points(element.attrib["d"])]
            ImageDraw.Draw(image).polygon(points, fill=element.attrib["fill"])
        else:
            raise ValueError(f"Unsupported SVG element: {tag}")
    image = image.resize((size, size), Image.Resampling.LANCZOS)
    if not desktop:
        return image
    # Only the macOS transparent canvas margin differs. The app's SVG has no
    # margin, and every format uses the identical palette and large chambers.
    content_size = round(size * 824/1024)
    canvas = Image.new("RGBA", (size, size))
    tile = image.resize((content_size, content_size), Image.Resampling.LANCZOS)
    inset = (size-content_size)//2
    canvas.alpha_composite(tile, (inset, inset))
    return canvas


def encode(image: Image.Image, fmt: str, **options: object) -> bytes:
    stream = io.BytesIO()
    image.save(stream, fmt, **options)
    return stream.getvalue()


def icns() -> bytes:
    # PNG-only ICNS is supported by current macOS and can be built on Windows.
    formats = [(b"icp4",16),(b"icp5",32),(b"icp6",64),(b"ic07",128),
               (b"ic08",256),(b"ic09",512),(b"ic10",1024)]
    chunks = []
    for kind, size in formats:
        data = encode(logo(size, desktop=True), "PNG")
        chunks.append(kind + struct.pack(">I", len(data)+8) + data)
    body = b"".join(chunks)
    return b"icns" + struct.pack(">I", len(body)+8) + body


def installer_art() -> dict[str, bytes]:
    root = ET.fromstring(MASTER.read_text(encoding="utf-8"))
    paths = root.findall(f"{SVG_NS}path")
    cream, copper = paths[0].attrib["fill"], paths[1].attrib["fill"]
    tile = root.find(f"{SVG_NS}defs/{SVG_NS}linearGradient")
    bg = list(tile)[-1].attrib["stop-color"]
    canvas = Image.new("RGB", (492, 942), bg)
    draw = ImageDraw.Draw(canvas)
    draw.line((62, 74, 136, 74), fill=copper, width=5)
    mark = logo(210)
    canvas.paste(mark, (48, 202), mark)
    # Pillow's bundled Aileron font is deterministic and needs no OS fonts.
    draw.text((62, 454), "EnvDock", font=ImageFont.load_default(size=48), fill=cream)
    draw.text((65, 526), "LOCAL API WORKBENCH", font=ImageFont.load_default(size=18), fill=copper)
    draw.text((65, 762), "Build. Send. Inspect.", font=ImageFont.load_default(size=21), fill=cream)
    draw.text((65, 807), "YOUR APIS. YOUR MACHINE.", font=ImageFont.load_default(size=16), fill="#B9A99C")
    header = Image.new("RGB", (450, 171), bg)
    mark = logo(126)
    header.paste(mark, (300, 22), mark)
    return {"src-tauri/installer/sidebar.bmp": encode(canvas, "BMP"),
            "src-tauri/installer/header.bmp": encode(header, "BMP")}


def exports() -> dict[str, bytes]:
    ico_sizes = [16,24,32,48,64,128,256]
    frames = [logo(size) for size in ico_sizes]
    result = {
        "public/envdock.svg": MASTER.read_bytes(),
        "src-tauri/icons/icon.png": encode(logo(256), "PNG"),
        "src-tauri/icons/icon.ico": encode(frames[-1], "ICO", sizes=[(n,n) for n in ico_sizes], append_images=frames[:-1]),
        "src-tauri/icons/icon.icns": icns(),
    }
    result.update(installer_art())
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate existing exports without changing files")
    args = parser.parse_args()
    result = exports()
    source = ET.fromstring(MASTER.read_text(encoding="utf-8"))
    source_paths = source.findall(f"{SVG_NS}path")
    tile = source.find(f"{SVG_NS}defs/{SVG_NS}linearGradient")
    metadata = {
        "master": "assets/brand/mark.svg",
        "identity": "paired-chambers-b",
        "masterSha256": hashlib.sha256(MASTER.read_bytes()).hexdigest(),
        "palette": {"background": list(tile)[-1].attrib["stop-color"], "main": source_paths[0].attrib["fill"], "accent": source_paths[1].attrib["fill"]},
        "opticalSizes": {"16-24": "paired chambers without central detail pillars", "32-1024": "full shared mark"},
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in result.items()},
    }
    result["assets/brand/exports.json"] = (json.dumps(metadata, indent=2, ensure_ascii=False)+"\n").encode()
    mismatched = []
    for name, data in result.items():
        path = ROOT / name
        if args.check:
            if not path.exists() or path.read_bytes() != data:
                mismatched.append(name)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    if mismatched:
        raise SystemExit("Brand exports are stale: " + ", ".join(mismatched))
    print(("Verified" if args.check else "Generated") + f" {len(result)} shared EnvDock brand exports.")


if __name__ == "__main__":
    main()
