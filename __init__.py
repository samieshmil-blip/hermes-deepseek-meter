"""DeepSeek meter — agent half.

The plugin is a read-only readout: the Python half serves two GET routes
(``/stats``, ``/balance``) under ``/api/plugins/deepseek-meter`` and the desktop
half draws the status-bar chip. It registers no tools, hooks or middleware.
"""

from __future__ import annotations

__version__ = "1.0.0"


def register(ctx) -> None:  # noqa: ARG001 — nothing to register by design
    """Called once at startup; this plugin contributes no tools or hooks."""
    return None
