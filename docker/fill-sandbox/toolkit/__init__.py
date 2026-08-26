"""Trusted PDF fill toolkit, ported from the pdf-form-agent POC.

Baked into the sandbox image read-only. The agent's free-form /exec code can
IMPORT these helpers, but the /run/* endpoints that produce the score always
execute this exact code — the model cannot modify what grades its work.
"""

TOOLKIT_VERSION = "1.3.0"
