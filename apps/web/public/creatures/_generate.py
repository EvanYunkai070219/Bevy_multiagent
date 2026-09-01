"""Second pass. The first cast read as sixteen variations on a bear because the
face carried nothing: two small dots on a big blank circle. Charm lives in the
face, so this one spends its budget there -- big glossy eyes with highlights,
cheek blush, a soft muzzle -- and gives every creature paws so the body stops
looking like a pebble the head is resting on."""
import os

INK = "#3b3540"
SW = 1.9

def eyes(cx, cy, dx=6.0, r=4.3, tone=INK):
    """Big, glossy, and identical on every creature: this is the family
    resemblance that makes sixteen drawings one set."""
    out = []
    for side in (-1, 1):
        x = cx + side * dx
        out.append(f'<ellipse cx="{x:.1f}" cy="{cy:.1f}" rx="{r:.1f}" ry="{r*1.12:.1f}" fill="{tone}"/>')
        out.append(f'<circle cx="{x + side*1.15:.1f}" cy="{cy - r*0.42:.1f}" r="{r*0.36:.1f}" fill="#ffffff"/>')
        out.append(f'<circle cx="{x - side*1.0:.1f}" cy="{cy + r*0.46:.1f}" r="{r*0.18:.1f}" fill="#ffffff" opacity="0.75"/>')
    return "".join(out)

def blush(cx, cy, dx=10.6, colour="#f0a6a6"):
    return "".join(
        f'<ellipse cx="{cx + s*dx:.1f}" cy="{cy:.1f}" rx="3.1" ry="2.1" fill="{colour}" opacity="0.6"/>'
        for s in (-1, 1))

def paws(cx, y, body, dx=8.6):
    return "".join(
        f'<ellipse cx="{cx + s*dx:.1f}" cy="{y:.1f}" rx="4.0" ry="3.2" fill="{body}" stroke="{INK}" stroke-width="{SW}"/>'
        for s in (-1, 1))

def ear(kind, cx, cy, r, body, inner):
    dx, out = r * 0.68, []
    for s in (-1, 1):
        x, y = cx + s * dx, cy - r * 0.78
        if kind == "point":
            out.append(f'<path d="M{x-5.6:.1f} {y+4.0:.1f} Q{x+s*0.6:.1f} {y-7.4:.1f} {x+5.4:.1f} {y+3.0:.1f} Z" fill="{body}" stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round"/>')
            out.append(f'<path d="M{x-2.4:.1f} {y+2.6:.1f} Q{x+s*0.4:.1f} {y-3.0:.1f} {x+2.6:.1f} {y+2.2:.1f} Z" fill="{inner}"/>')
        elif kind == "round":
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5.4" fill="{body}" stroke="{INK}" stroke-width="{SW}"/>')
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.7" fill="{inner}"/>')
        elif kind == "long":
            out.append(f'<ellipse cx="{x-s*0.4:.1f}" cy="{y-7.4:.1f}" rx="3.5" ry="10.0" fill="{body}" stroke="{INK}" stroke-width="{SW}"/>')
            out.append(f'<ellipse cx="{x-s*0.4:.1f}" cy="{y-7.4:.1f}" rx="1.6" ry="7.2" fill="{inner}"/>')
        elif kind == "tuft":
            out.append(f'<circle cx="{x+s*1.8:.1f}" cy="{y+1.6:.1f}" r="7.0" fill="{inner}" stroke="{INK}" stroke-width="{SW}"/>')
        elif kind == "tiny":
            out.append(f'<circle cx="{x:.1f}" cy="{y+2.0:.1f}" r="3.8" fill="{body}" stroke="{INK}" stroke-width="{SW}"/>')
            out.append(f'<circle cx="{x:.1f}" cy="{y+2.0:.1f}" r="1.8" fill="{inner}"/>')
    return "".join(out)

def creature(body, inner, ear_kind, face=None, belly=None, nose=INK, patch=None,
             behind="", tail="", extra="", cheeks="#f0a6a6"):
    cx, hy, hr = 32.0, 25.5, 16.0
    p = [behind, tail]
    p.append(f'<ellipse cx="{cx}" cy="48.5" rx="13.0" ry="11.2" fill="{body}" stroke="{INK}" stroke-width="{SW}"/>')
    if belly:
        p.append(f'<ellipse cx="{cx}" cy="50.4" rx="7.8" ry="7.6" fill="{belly}"/>')
    p.append(paws(cx, 55.0, body))
    p.append(ear(ear_kind, cx, hy, hr, body, inner))
    p.append(f'<circle cx="{cx}" cy="{hy}" r="{hr}" fill="{body}" stroke="{INK}" stroke-width="{SW}"/>')
    if face:
        p.append(f'<ellipse cx="{cx}" cy="{hy+3.4:.1f}" rx="11.6" ry="9.6" fill="{face}"/>')
    if patch:
        p.append(patch)
    p.append(blush(cx, hy + 3.4, colour=cheeks))
    p.append(eyes(cx, hy - 0.8))
    p.append(f'<ellipse cx="{cx}" cy="{hy+5.6:.1f}" rx="2.0" ry="1.6" fill="{nose}"/>')
    p.append(f'<path d="M{cx-3.2:.1f} {hy+8.4:.1f} Q{cx:.1f} {hy+10.8:.1f} {cx+3.2:.1f} {hy+8.4:.1f}" fill="none" stroke="{INK}" stroke-width="1.6" stroke-linecap="round"/>')
    p.append(extra)
    return "".join(p)

def svg(inner):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
            + inner + "</svg>")

CX, HY = 32.0, 25.5
def patch_eyes(colour, dx=6.0, rx=6.2, ry=6.6):
    return "".join(f'<ellipse cx="{CX+s*dx:.1f}" cy="{HY-0.8:.1f}" rx="{rx}" ry="{ry}" fill="{colour}"/>' for s in (-1,1))
BEAK = f'<path d="M{CX-3.6} {HY+3.8} Q{CX} {HY+10.4} {CX+3.6} {HY+3.8} Z" fill="#f0ad4a" stroke="{INK}" stroke-width="1.5" stroke-linejoin="round"/>'

C = {
 "otter":    dict(body="#a4794f", inner="#d8b489", ear_kind="round", face="#e2c39c", belly="#e2c39c"),
 "panda":    dict(body="#fbf9f4", inner="#3b3540", ear_kind="round", patch=patch_eyes("#3b3540"), cheeks="#f2b4b4"),
 "beaver":   dict(body="#c08a55", inner="#e6bd8e", ear_kind="tiny", face="#e8c8a1",
                  tail=f'<ellipse cx="51" cy="54" rx="9.0" ry="5.0" fill="#8f6238" stroke="{INK}" stroke-width="{SW}"/>',
                  extra=f'<rect x="{CX-3.2}" y="{HY+7.6}" width="6.4" height="4.6" rx="1.3" fill="#fffdf6" stroke="{INK}" stroke-width="1.4"/>'),
 "hedgehog": dict(body="#b7a279", inner="#d8c9a6", ear_kind="tiny", face="#eae0c6",
                  behind=f'<path d="M32 3 L26 13 L17 8 L16 20 L5 20 L11 30 L2 35 L13 40 M32 3 L38 13 L47 8 L48 20 L59 20 L53 30 L62 35 L51 40" fill="#8b7a55" stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round"/>'),
 "fox":      dict(body="#ec8f45", inner="#fbe3d2", ear_kind="point", face="#fffaf2", belly="#fffaf2",
                  tail=f'<path d="M43 56 Q60 51 57 38 Q55 30 46 33" fill="#ec8f45" stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round"/>'),
 "owl":      dict(body="#8878b8", inner="#c9bfe4", ear_kind="tuft", face="#ded6f2",
                  patch=patch_eyes("#fffdf8", rx=7.0, ry=7.4), extra=BEAK),
 "rabbit":   dict(body="#f6ecec", inner="#f2b8c4", ear_kind="long", face="#fffdfd", nose="#e08a9b"),
 "squirrel": dict(body="#c96a3c", inner="#eaae86", ear_kind="tiny", face="#f0c9a8",
                  tail=f'<path d="M43 57 Q63 49 56 31 Q51 20 41 25" fill="#c96a3c" stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round"/>'),
 "penguin":  dict(body="#41577a", inner="#8fa4c4", ear_kind="tiny", face="#fffdf8", belly="#fffdf8", extra=BEAK),
 "cat":      dict(body="#7fb0bd", inner="#f2c6cd", ear_kind="point", face="#e4f2f5",
                  extra=f'<path d="M14 27 L5 25 M14 30 L5 31 M50 27 L59 25 M50 30 L59 31" stroke="{INK}" stroke-width="1.4" stroke-linecap="round" fill="none"/>'),
 "raccoon":  dict(body="#9aa0ac", inner="#c8cdd6", ear_kind="round", face="#eef1f5",
                  patch=patch_eyes("#565c68", dx=6.2, rx=6.6, ry=5.8),
                  tail=f'<ellipse cx="51" cy="54" rx="9.0" ry="4.8" fill="#565c68" stroke="{INK}" stroke-width="{SW}"/>'),
 "koala":    dict(body="#b0aacb", inner="#d7d3e8", ear_kind="tuft", face="#d3cfe6",
                  nose="#3b3540", extra=f'<ellipse cx="{CX}" cy="{HY+5.8}" rx="3.6" ry="2.9" fill="{INK}"/>'),
 "bear":     dict(body="#8d6543", inner="#c49a72", ear_kind="round", face="#cfa87f"),
 "hamster":  dict(body="#f0c766", inner="#fae3ad", ear_kind="tiny", face="#fdf2d8", belly="#fdf2d8"),
 "shiba":    dict(body="#e39c4e", inner="#f7d6ad", ear_kind="point", face="#fffaf2", belly="#fffaf2"),
 "sloth":    dict(body="#9aa886", inner="#c6d1b3", ear_kind="tiny", face="#dde5cd",
                  extra=f'<path d="M24 23 Q28 20 32 23 M32 23 Q36 20 40 23" stroke="{INK}" stroke-width="1.7" stroke-linecap="round" fill="none"/>'),
}

out = os.path.join(os.path.dirname(__file__), "svg2")
os.makedirs(out, exist_ok=True)
for n, spec in C.items():
    open(os.path.join(out, n + ".svg"), "w").write(svg(creature(**spec)))
print("v3:", len(C))
