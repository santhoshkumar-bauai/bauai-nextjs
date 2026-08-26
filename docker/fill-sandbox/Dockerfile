FROM python:3.12-slim

# Layers of containment for LLM-written code, outermost set in compose
# (no-egress network, read-only rootfs, mem/cpu/pid limits). In here: a
# non-root user and a minimal env. runner.py adds per-exec rlimits.

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox

# OCR is deterministic and local. German is the default language for the
# procurement forms in scope; English remains as Tesseract's base language.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-deu \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# toolkit is importable by BOTH the service and free-form exec'd code;
# it is baked read-only into the image, so the model cannot alter the
# code that computes its score.
COPY toolkit /opt/toolkit/toolkit
COPY app /opt/app/app
COPY tests /opt/tests

ENV PYTHONPATH=/opt/toolkit \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FILL_SANDBOX_WORK_ROOT=/work

RUN mkdir -p /work && chown sandbox:sandbox /work

USER sandbox
WORKDIR /opt/app
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
