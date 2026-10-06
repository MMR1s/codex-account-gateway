from pathlib import Path
import tomlkit

from gateway import STATE
backup = STATE / 'config-before-gateway.toml'
path = Path.home() / '.codex' / 'config.toml'
if not backup.exists():
    raise SystemExit('Gateway has not changed the provider; no restoration needed.')
before = tomlkit.parse(backup.read_text(encoding='utf-8'))
current = tomlkit.parse(path.read_text(encoding='utf-8-sig'))
if current.get('model_provider') != 'dual-account-local':
    raise SystemExit('Another provider is already selected; leaving it unchanged.')
for key in ('model', 'model_provider', 'model_catalog_json'):
    if key in before:
        current[key] = before[key]
    else:
        current.pop(key, None)
current.get('model_providers', {}).pop('dual-account-local', None)
path.write_text(tomlkit.dumps(current), encoding='utf-8')
print('Original model provider restored. Restart Codex to apply it.')
