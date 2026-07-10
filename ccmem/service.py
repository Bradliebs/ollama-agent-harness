"""
ccmem — Concept Cells Memory Service
=====================================
A semantic memory sidecar for the Ollama Agent Harness.

Based on the high-dimensional separation theorems from:
  Tyukin, Gorban et al. (2018) "High-Dimensional Brain: A Tool for Encoding
  and Rapid Learning of Memories by Single Neurons"

Each remembered item is stored as a single neuron-like "concept cell":
  w_i = unit(embed(text))   — weight vector aligned with the item
  θ_i = ||embed(text)|| - ε — firing threshold

Query: dot-product of query embedding against all cells → only firing cells returned.
Near-paraphrases automatically land near the same cell (semantic clustering).

Endpoints:
  POST /write       — store a single text
  POST /write_many  — batch store
  POST /query       — semantic search
  POST /bind        — bind related cells into one composite cell
  GET  /health      — liveness
  GET  /cells       — list all stored cells

Usage:
  pip install -r ccmem/requirements.txt
  python -m uvicorn ccmem.service:app --host 127.0.0.1 --port 8765

Binds to loopback (127.0.0.1) by default so the local memory bank is never
reachable from other machines on the network. The harness talks to it over
localhost, so local agent memory keeps working identically. Only override the
host if you understand the exposure (the service is unauthenticated unless you
set HARNESS_CCMEM_TOKEN).

Optional auth: when the HARNESS_CCMEM_TOKEN env var is set, every endpoint
except GET /health requires `Authorization: Bearer <token>`. This closes
same-host access by other local processes/users while leaving an unauthenticated
liveness probe for start scripts and monitors. When unset (the default) auth is
disabled and the service behaves exactly as before, so the harness's best-effort
memory needs zero configuration. start.bat / start.sh generate and export a
token automatically so the supported launch path is authenticated out of the box.
"""
from __future__ import annotations

import hmac
import os
import sqlite3
import threading
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Paths — bank lives in .harness/ccmem/ inside the workspace (not the repo)
# ---------------------------------------------------------------------------

def _bank_path() -> Path:
    workspace = os.environ.get("HARNESS_PROJECT_DIR", "")
    if workspace:
        p = Path(workspace) / ".harness" / "ccmem"
    else:
        p = Path(__file__).parent.parent / ".harness" / "ccmem"
    p.mkdir(parents=True, exist_ok=True)
    return p / "bank.db"


# ---------------------------------------------------------------------------
# Encoder — loaded once, lazily
# ---------------------------------------------------------------------------

_encoder = None
_encoder_lock = threading.Lock()


def _get_encoder():
    global _encoder
    if _encoder is None:
        with _encoder_lock:
            if _encoder is None:
                from ccmem.concept_cells.encoders import TextEncoder
                _encoder = TextEncoder("all-MiniLM-L6-v2")
    return _encoder


# ---------------------------------------------------------------------------
# Whitening state — fitted once we have ≥ MIN_REF_TEXTS cells
# ---------------------------------------------------------------------------

MIN_REF_TEXTS = 50   # fit whitening after this many writes (lowered from 200 for faster startup)
_W_mat: Optional[np.ndarray] = None  # ZCA matrix (D, D)
_W_mu: Optional[np.ndarray] = None   # mean vector
_W_scale: float = 1.0                # ball scale divisor
_whiten_lock = threading.Lock()


def _raw_embed(texts: List[str]) -> np.ndarray:
    enc = _get_encoder()
    batch = enc.encode(texts)
    return batch.embeddings  # (N, D) float32


def _whiten(emb: np.ndarray) -> np.ndarray:
    """Apply stored ZCA whitening + ball scaling. If not yet fitted, return raw."""
    if _W_mat is None:
        return emb
    centered = emb - _W_mu
    whitened = (centered @ _W_mat).astype(np.float32)
    return (whitened / (_W_scale + 1e-8)).astype(np.float32)


def _try_fit_whitening(conn: sqlite3.Connection) -> None:
    """Fit ZCA on all stored source embeddings if we have enough and haven't fitted yet."""
    global _W_mat, _W_mu, _W_scale
    if _W_mat is not None:
        return
    rows = conn.execute("SELECT source_emb FROM cells").fetchall()
    if len(rows) < MIN_REF_TEXTS:
        return
    with _whiten_lock:
        if _W_mat is not None:
            return
        embs = np.stack([np.frombuffer(r[0], dtype=np.float32) for r in rows])
        from ccmem.concept_cells.geometry import zca_whiten, scale_to_unit_ball
        whitened = zca_whiten(embs)
        scaled = scale_to_unit_ball(whitened)
        # Recover the transform parameters
        mu = embs.mean(axis=0)
        centered = embs - mu
        eps = 1e-5
        cov = (centered.T @ centered) / max(centered.shape[0] - 1, 1)
        eigvals, eigvecs = np.linalg.eigh(cov)
        eigvals = np.maximum(eigvals, eps)
        W = eigvecs @ np.diag(1.0 / np.sqrt(eigvals)) @ eigvecs.T
        pre_scale = (centered @ W).astype(np.float32)
        scale = float(np.linalg.norm(pre_scale, axis=1).max())
        _W_mu = mu
        _W_mat = W.astype(np.float32)
        _W_scale = scale


# ---------------------------------------------------------------------------
# SQLite bank
# ---------------------------------------------------------------------------

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_bank_path()), check_same_thread=False)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cells (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            label    TEXT NOT NULL,
            source   TEXT NOT NULL,
            source_emb BLOB NOT NULL,
            w        BLOB NOT NULL,
            theta    REAL NOT NULL
        )
    """)
    conn.commit()
    return conn


_conn: Optional[sqlite3.Connection] = None
_db_lock = threading.Lock()


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        with _db_lock:
            if _conn is None:
                _conn = _get_conn()
    return _conn


def _store_cell(source: str, label: str, emb_raw: np.ndarray) -> int:
    """Embed, whiten, build concept cell, persist. Returns new cell id."""
    _try_fit_whitening(_db())
    emb_w = _whiten(emb_raw.reshape(1, -1))[0]
    norm = float(np.linalg.norm(emb_w))
    w = (emb_w / max(norm, 1e-12)).astype(np.float32)
    theta = norm - 0.05
    with _db_lock:
        cur = _db().execute(
            "INSERT INTO cells (label, source, source_emb, w, theta) VALUES (?,?,?,?,?)",
            (label, source, emb_raw.tobytes(), w.tobytes(), theta)
        )
        _db().commit()
        return cur.lastrowid


def _all_cells():
    rows = _db().execute("SELECT id, label, source, w, theta FROM cells").fetchall()
    ws, thetas, ids, labels, sources = [], [], [], [], []
    for (cid, lbl, src, w_blob, th) in rows:
        ws.append(np.frombuffer(w_blob, dtype=np.float32))
        thetas.append(th)
        ids.append(cid)
        labels.append(lbl)
        sources.append(src)
    if not ws:
        return np.empty((0,), dtype=object), [], [], [], []
    return np.stack(ws), np.array(thetas, dtype=np.float32), ids, labels, sources


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

# Optional shared-secret auth. Read once at import. When empty, auth is OFF and
# every request is allowed (best-effort default — harness memory works with no
# configuration). When set, every endpoint requires a matching bearer token.
_CCMEM_TOKEN = os.environ.get("HARNESS_CCMEM_TOKEN", "").strip()


def _require_token(authorization: Optional[str] = Header(default=None)) -> None:
    """Gate every endpoint behind a shared bearer token when one is configured.

    Constant-time compared to avoid leaking the token via timing. Disabled
    entirely when HARNESS_CCMEM_TOKEN is unset so the default experience and
    the harness's best-effort memory are unchanged.
    """
    if not _CCMEM_TOKEN:
        return
    expected = f"Bearer {_CCMEM_TOKEN}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized: missing or invalid ccmem token")


app = FastAPI(title="ccmem — Concept Cells Memory Service")

# Protect content endpoints individually so GET /health stays an open liveness
# probe (used by start.bat readiness polling and external monitors). _AUTH is
# spread into each decorator's `dependencies`.
_AUTH = [Depends(_require_token)]


class WriteRequest(BaseModel):
    text: str
    label: str = ""


class WriteManyRequest(BaseModel):
    items: List[WriteRequest]


class QueryRequest(BaseModel):
    text: str
    top_k: int = 5


class BindRequest(BaseModel):
    texts: List[str]
    label: str = ""


class CellHit(BaseModel):
    id: int
    label: str
    source: str
    margin: float


@app.get("/health")
def health():
    return {"status": "ok", "cells": _db().execute("SELECT COUNT(*) FROM cells").fetchone()[0]}


@app.get("/cells", dependencies=_AUTH)
def list_cells():
    rows = _db().execute("SELECT id, label, source, theta FROM cells ORDER BY id").fetchall()
    return [{"id": r[0], "label": r[1], "source": r[2], "theta": r[3]} for r in rows]


@app.post("/write", dependencies=_AUTH)
def write(req: WriteRequest):
    label = req.label or req.text[:80]
    emb = _raw_embed([req.text])[0]
    cell_id = _store_cell(req.text, label, emb)
    return {"id": cell_id, "label": label}


@app.post("/write_many", dependencies=_AUTH)
def write_many(req: WriteManyRequest):
    if not req.items:
        return {"ids": []}
    texts = [it.text for it in req.items]
    embs = _raw_embed(texts)
    ids = []
    for i, item in enumerate(req.items):
        label = item.label or item.text[:80]
        ids.append(_store_cell(item.text, label, embs[i]))
    return {"ids": ids}


@app.post("/query", dependencies=_AUTH)
def query(req: QueryRequest):
    ws, thetas, ids, labels, sources = _all_cells()
    if len(ids) == 0:
        return {"hits": []}
    emb_raw = _raw_embed([req.text])[0]
    emb_w = _whiten(emb_raw.reshape(1, -1))[0]
    # Normalise query the same way
    norm = float(np.linalg.norm(emb_w))
    q = (emb_w / max(norm, 1e-12)).astype(np.float32)
    activations = ws @ q            # (N,)
    margins = activations - thetas  # fire where > 0
    # Return top_k by margin (descending), only firing cells
    order = np.argsort(-margins)
    hits = []
    for idx in order:
        if len(hits) >= req.top_k:
            break
        hits.append(CellHit(
            id=int(ids[idx]),
            label=labels[idx],
            source=sources[idx],
            margin=float(margins[idx])
        ))
    return {"hits": [h.dict() for h in hits]}


@app.post("/bind", dependencies=_AUTH)
def bind(req: BindRequest):
    if len(req.texts) < 2:
        raise HTTPException(400, "Need at least 2 texts to bind")
    label = req.label or " + ".join(t[:30] for t in req.texts[:3])
    embs_raw = _raw_embed(req.texts)
    _try_fit_whitening(_db())
    embs_w = _whiten(embs_raw)
    from ccmem.concept_cells.binding import bind_items, initialize_cell_for_anchor
    items_w = [embs_w[i] for i in range(len(req.texts))]
    anchor = items_w[0]
    # Use mean norm as threshold
    norms = np.array([float(np.linalg.norm(x)) for x in items_w])
    theta = float(norms.mean()) - 0.05
    w0 = initialize_cell_for_anchor(anchor, theta)
    w_final, _ = bind_items(w0, items_w, theta)
    w_unit = (w_final / max(float(np.linalg.norm(w_final)), 1e-12)).astype(np.float32)
    # Recalibrate theta: fire for all bound items
    margins = np.array([float(w_unit @ x) for x in items_w])
    theta_new = float(margins.min()) - 0.01
    with _db_lock:
        cur = _db().execute(
            "INSERT INTO cells (label, source, source_emb, w, theta) VALUES (?,?,?,?,?)",
            (label, " | ".join(req.texts), embs_raw[0].tobytes(), w_unit.tobytes(), theta_new)
        )
        _db().commit()
    return {"id": cur.lastrowid, "label": label, "theta": theta_new}
