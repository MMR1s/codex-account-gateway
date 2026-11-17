"""Subscription image MCP tools for gateway-authenticated Codex chats.

Only the existing loopback gateway is contacted. No Platform API key is used.
"""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import mimetypes
import os
from pathlib import Path
import uuid

import httpx
from mcp.server.fastmcp import FastMCP, Image
from mcp.types import ToolAnnotations

HERE = Path(__file__).resolve().parent
legacy = HERE.parent.parent / 'work' / 'gateway-state'
STATE = Path(os.environ.get('CODEX_GATEWAY_STATE_DIR', str(legacy if HERE.name == 'gateway' and legacy.exists() else HERE / '.runtime' / 'state')))
SAVE_ROOT = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'generated_images' / 'gateway'
MAX_BYTES = 32 * 1024 * 1024
mcp = FastMCP('Gateway subscription images')


def reference_images(paths: list[str] | None):
    if not paths:
        return []
    if len(paths) > 5:
        raise ValueError('Use at most five reference images.')
    images = []
    for value in paths:
        path = Path(value)
        if not path.is_absolute() or not path.is_file():
            raise ValueError('Each reference must be an existing absolute image path.')
        mime = mimetypes.guess_type(path.name)[0]
        if mime not in ('image/png', 'image/jpeg', 'image/webp'):
            raise ValueError('Reference images must be PNG, JPEG or WebP.')
        if path.stat().st_size > MAX_BYTES:
            raise ValueError('Reference image exceeds 32 MiB.')
        images.append({'image_url': 'data:' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode('ascii')})
    return images


async def generate(prompt: str, transparent_background: bool = False, referenced_image_paths: list[str] | None = None):
    if not prompt.strip():
        raise ValueError('Provide an image description.')
    images = reference_images(referenced_image_paths)
    key = (STATE / 'gateway-key.txt').read_text(encoding='utf-8').strip()
    if not key:
        raise ValueError('Start the gateway first.')
    body = {'model': 'gpt-image-2', 'prompt': prompt, 'n': 1,
            'background': 'transparent' if transparent_background else 'opaque'}
    operation = 'edits' if images else 'generations'
    if images:
        body['images'] = images
    async with httpx.AsyncClient(timeout=340, trust_env=False) as client:
        try:
            response = await client.post('http://127.0.0.1:4000/v1/images/' + operation,
                                         json=body, headers={'Authorization': 'Bearer ' + key})
        except httpx.HTTPError:
            raise RuntimeError('The gateway image request failed. It was not retried; check the dashboard before trying again.') from None
    if response.status_code != 200:
        raise RuntimeError(f'Gateway image request returned HTTP {response.status_code}. Check the connected account and image allowance. No API fallback was used.')
    payload = response.json()
    encoded = payload.get('data', [{}])[0].get('b64_json')
    if not isinstance(encoded, str) or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
        raise ValueError('The gateway returned no image or an oversized image.')
    try:
        content = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError('The gateway returned an invalid image.') from None
    if content.startswith(b'\x89PNG\r\n\x1a\n'):
        extension, mime = '.png', 'image/png'
    elif content.startswith(b'\xff\xd8\xff'):
        extension, mime = '.jpg', 'image/jpeg'
    elif content[:4] == b'RIFF' and content[8:12] == b'WEBP':
        extension, mime = '.webp', 'image/webp'
    else:
        raise ValueError('The gateway returned an unsupported image format.')
    destination = SAVE_ROOT / datetime.now(timezone.utc).strftime('%Y-%m-%d') / (str(uuid.uuid4()) + extension)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
    return destination, content, mime, response.headers.get('x-gateway-account', 'unreported')


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True))
async def generate_image(prompt: str, transparent_background: bool = False, referenced_image_paths: list[str] | None = None):
    """Generate or edit one image using the selected gateway account's INCLUDED subscription access.

    Use for picture creation and edits in gateway-backed Codex chats. No paid API
    key or browser is required. Supply absolute reference image paths for edits;
    leave them empty for a new picture. Returns the generated image and its saved
    absolute path. Use transparent_background for transparent cutouts. Image
    limits still apply; failed requests are never automatically repeated.
    """
    destination, content, mime, slot = await generate(prompt, transparent_background, referenced_image_paths)
    return [f'Saved image: {destination}\nGateway account: {slot}\nUsed subscription image access; no Platform API key.', Image(data=content, format=destination.suffix.lstrip('.'))]


if __name__ == '__main__':
    mcp.run(transport='stdio')
