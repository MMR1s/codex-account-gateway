"""Read-only agent documentation shared by the dashboard and plain-text clients."""
import html
from pathlib import Path
import re


def guide_text(here: Path) -> str:
    return (here / 'docs' / 'agent-guide.md').read_text(encoding='utf-8-sig')


def inline(value: str) -> str:
    return re.sub(r'`([^`]+)`', r'<code>\1</code>', html.escape(value))


def guide_html(text: str) -> str:
    """Render this trusted, deliberately small Markdown subset, escaping all text."""
    output = []
    code = None
    table = False
    listing = False
    for line in text.splitlines():
        if line.startswith('```'):
            if code is None:
                code = []
            else:
                output.append('<pre tabindex="0"><code>' + html.escape('\n'.join(code)) + '</code></pre>')
                code = None
            continue
        if code is not None:
            code.append(line)
            continue
        is_row = line.startswith('|')
        if table and not is_row:
            output.append('</tbody></table></div>')
            table = False
        if listing and not line.startswith('- '):
            output.append('</ul>')
            listing = False
        if is_row:
            cells = [v.strip() for v in line.strip('|').split('|')]
            if all(re.fullmatch(r':?-+:?', v) for v in cells):
                continue
            if not table:
                output.append('<div class="guide-table"><table><thead><tr>' + ''.join('<th>' + inline(v) + '</th>' for v in cells) + '</tr></thead><tbody>')
                table = True
            else:
                output.append('<tr>' + ''.join('<td>' + inline(v) + '</td>' for v in cells) + '</tr>')
        elif line.startswith('## '):
            title = line[3:]
            slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
            output.append('<h2 id="guide-' + slug + '">' + inline(title) + '</h2>')
        elif line.startswith('# '):
            continue
        elif line.startswith('- '):
            if not listing:
                output.append('<ul>')
                listing = True
            output.append('<li>' + inline(line[2:]) + '</li>')
        elif line.strip():
            output.append('<p>' + inline(line) + '</p>')
    if listing:
        output.append('</ul>')
    if table:
        output.append('</tbody></table></div>')
    return '\n'.join(output)
