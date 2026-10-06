"""Render the original architecture diagram; requires Pillow, not a runtime dependency."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
W,H=1600,1200
im=Image.new('RGB',(W,H),'#08090b');d=ImageDraw.Draw(im)
fonts=Path('C:/Windows/Fonts')
def font(size,bold=False):
    candidates=[fonts/('segoeuib.ttf' if bold else 'segoeui.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
    for p in candidates:
        if p.exists():return ImageFont.truetype(str(p),size)
    return ImageFont.load_default()
def text(x,y,s,size=28,color='#eef1ed',bold=False):d.text((x,y),s,font=font(size,bold),fill=color)
def card(x,y,w,h,accent=False):d.rounded_rectangle((x,y,x+w,y+h),24,fill='#1b1922' if accent else '#111215',outline='#7d728d' if accent else '#33333e',width=2)
def arrow(points,color='#c6bed7'):
    d.line(points,fill=color,width=5)
    x,y=points[-1];d.polygon([(x,y),(x-16,y-10),(x-16,y+10)],fill=color)
text(80,54,'CODEX ACCOUNT GATEWAY',23,'#c6bed7',True)
text(80,111,'One Codex workspace.',76,bold=True)
text(80,200,'An expandable account pool.',65,bold=True)
text(80,311,'A local router chooses who handles each model request.',30,'#8e91a0')
card(80,420,370,320)
text(112,455,'01  CODEX',23,'#c6bed7',True)
text(112,510,'Your familiar app',35,bold=True)
text(112,568,'Local chats and files',27,'#8e91a0')
text(112,612,'stay in the same place.',27,'#8e91a0')
text(112,685,'Desktop login stays fixed',23,'#c6bed7')
arrow([(450,580),(535,580)])
card(535,420,440,320,True)
text(568,455,'02  LOCAL GATEWAY',23,'#c6bed7',True)
text(568,510,'Select → stream → track',31,bold=True)
text(568,568,'On a limit before output:',26,'#aaa3b7')
text(568,612,'try another account.',26,'#aaa3b7')
text(568,685,'No replay after output starts',22,'#c6bed7')
arrow([(975,580),(1014,580),(1014,495),(1090,495)])
arrow([(1014,580),(1014,670),(1090,670)])
card(1090,420,430,145,True)
text(1122,445,'03  ACCOUNT A',23,'#c6bed7',True)
text(1122,494,'Own login · own allowance',25)
card(1090,595,430,145)
text(1122,620,'03  ACCOUNT B',23,'#c6bed7',True)
text(1122,662,'Own login · own allowance',25)
text(1122,709,'Add more desks: C, D, …',17,'#8e91a0')
labels=[('REAL ALLOWANCE','5-hour + weekly % and reset times'),('LOCAL ACTIVITY','Input, output, cache, duration'),('REMOTE ACCESS','SSH to your Codex machine')]
for i,(title,detail) in enumerate(labels):
    x=80+i*490;card(x,825,460,145)
    text(x+25,847,title,20,'#c6bed7',True)
    text(x+25,895,detail,22)
text(80,1025,'Separate credentials. Separate quotas. One local workspace.',30,bold=True)
text(80,1080,'Experimental project · Opaque compacted context may require the original account.',22,'#8e91a0')
text(80,1135,'github.com/MMR1s/codex-account-gateway',24,'#c6bed7')
im.save(Path(__file__).with_name('how-it-works.png'))
