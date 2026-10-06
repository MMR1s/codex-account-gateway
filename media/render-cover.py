"""Compose the project's existing brand and illustrative dashboard network.

Requires Pillow and NumPy for asset production, not for running the gateway.
Usage: python media/render-cover.py /path/to/cover-constellation.png
"""
from pathlib import Path
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageOps

W,H=2400,1260
OUT=Path(__file__).resolve().parent
source=Path(sys.argv[1]) if len(sys.argv)>1 else OUT/'cover-constellation.png'
fonts=Path('C:/Windows/Fonts')
def font(size,bold=False,mono=False):
    candidates=[fonts/('consola.ttf' if mono else 'segoeuib.ttf' if bold else 'segoeui.ttf'),Path('/usr/share/fonts/truetype/dejavu')/('DejaVuSansMono.ttf' if mono else 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')]
    for path in candidates:
        if path.exists():return ImageFont.truetype(str(path),size)
    return ImageFont.load_default()
yy,xx=np.mgrid[0:H,0:W]
base=np.zeros((H,W,3),dtype=float)+[5,6,9]
for cx,cy,rgb,r in [(1770,510,[14,8,30],900),(1410,820,[3,18,22],600)]:
    strength=np.exp(-((xx-cx)**2+(yy-cy)**2)/(r*r))
    base+=strength[:,:,None]*np.array(rgb)
im=Image.fromarray(np.uint8(np.clip(base,0,255))).convert('RGBA')
detail=Image.new('RGBA',(W,H),(0,0,0,0));g=ImageDraw.Draw(detail)
for radius in [450,630,850]:g.ellipse((1720-radius,610-radius*.58,1720+radius,610+radius*.58),outline=(177,162,233,14),width=1)
g.line((120,1088,2280,1088),fill=(177,162,233,42),width=1)
im=Image.alpha_composite(im,detail)
scene=Image.open(source).convert('RGB')
scene=scene.crop((12,30,scene.width-6,min(scene.height,810)))
scene=ImageEnhance.Brightness(scene).enhance(1.28)
scene=ImageEnhance.Color(scene).enhance(1.12)
scene=scene.resize((1420,round(1420*scene.height/scene.width)),Image.Resampling.LANCZOS).convert('RGBA')
mask=Image.new('L',scene.size,0);md=ImageDraw.Draw(mask)
md.rounded_rectangle((60,12,scene.width-60,scene.height-12),radius=160,fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(55));scene.putalpha(mask)
im.alpha_composite(scene,(980,130))
d=ImageDraw.Draw(im)
def text(x,y,s,size,fill='#f1f0f5',bold=False,mono=False):d.text((x,y),s,font=font(size,bold,mono),fill=fill)
d.rounded_rectangle((120,85,190,155),radius=15,fill='#f1f0f5')
d.line((140,133,168,106),fill='#07090e',width=5)
d.line((151,106,168,106,168,122),fill='#07090e',width=5)
text(213,82,'codex',52,bold=True);text(365,82,'/ relay',52,'#b5a1ff')
text(123,186,'OPEN SOURCE ACCOUNT GATEWAY',23,'#a69cb9',mono=True)
text(115,322,'One workspace.',116,bold=True)
text(115,455,'Every account.',116,bold=True)
text(124,650,'Account routing. Usage visibility.',34,'#b5afc2')
text(124,705,'Agents and subagents, in one control room.',30,'#b5afc2')
for x,label,col in [(124,'ACCOUNTS','#b5a1ff'),(384,'AGENTS','#62d5e9'),(616,'TELEMETRY','#f58cb9')]:
    d.rounded_rectangle((x,842,x+220,896),radius=7,fill='#0e0e16',outline='#373242',width=1)
    d.ellipse((x+19,864,x+29,874),fill=col)
    text(x+43,854,label,21,'#e4dfef',mono=True)
text(122,971,'LOCAL FIRST',22,'#b5a1ff',mono=True)
text(1250,1031,'ILLUSTRATIVE NETWORK / DEMO VALUES',18,'#81798f',mono=True)
text(124,1144,'github.com/MMR1s/codex-account-gateway',26,'#dfdae8',mono=True)
text(1958,1144,'MIT LICENSE',26,'#b5a1ff',mono=True)
im.convert('RGB').save(OUT/'project-cover.png',optimize=True)
im.convert('RGB').save(OUT/'project-cover.jpg',quality=94,subsampling=0,optimize=True)
ImageOps.fit(im.convert('RGB'),(1280,640),Image.Resampling.LANCZOS,centering=(.5,.5)).save(OUT/'github-cover.png',optimize=True)
print('Rendered project-cover.png, project-cover.jpg, github-cover.png')
