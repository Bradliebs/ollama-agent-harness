# ccmem — Semantic Memory Service

Built-in semantic memory for the Ollama Agent Harness, powered by the
[Concept Cells](https://github.com/Bradliebs/ollama-agent-harness) architecture
(Tyukin, Gorban et al. 2018).

## What it does

Every `remember` or `reflect` call in the harness is dual-written here as a
**concept cell** — a single neuron whose weights align with the MiniLM embedding
of the text. On each chat turn, the harness queries the bank semantically and
injects the most relevant memories into the system context automatically.

Key properties:
- **One-shot writes**: no training, no gradient descent
- **2000+ memories at 100% recall** (validated on Wikipedia)
- **Graceful fallback**: harness works normally when this service is offline

## Requirements

Python 3.10+ with the packages in `ccmem/requirements.txt`.

First-time setup:
```
pip install -r ccmem/requirements.txt
```

## Starting manually

From the harness root:
```
python -m uvicorn ccmem.service:app --host 0.0.0.0 --port 8765
```

`start.bat` does this automatically when Python is available.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + cell count |
| GET | `/cells` | List all stored cells |
| POST | `/write` | Store one text |
| POST | `/write_many` | Store batch |
| POST | `/query` | Semantic search |
| POST | `/bind` | Bind related texts into one composite cell |
