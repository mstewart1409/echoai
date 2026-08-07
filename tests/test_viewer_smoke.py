"""Runs the JavaScript viewer smoke test through pytest.

The real assertions live in tests/viewer/app.smoke.test.mjs (they need a JS
runtime). This wrapper keeps `uv run pytest` as the single command for the whole
suite, including the pre-commit hook and CI, and skips cleanly where node is
absent rather than failing the build.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

SMOKE_TEST = Path(__file__).parent / 'viewer' / 'app.smoke.test.mjs'


@pytest.mark.skipif(shutil.which('node') is None, reason='node is not installed')
def test_viewer_app_js_smoke() -> None:
    """app.js must load, bootstrap, and wire its event listeners."""
    result = subprocess.run(
        ['node', '--test', str(SMOKE_TEST)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=Path(__file__).parent.parent,
    )
    assert result.returncode == 0, f'viewer smoke test failed:\n{result.stdout}\n{result.stderr}'
