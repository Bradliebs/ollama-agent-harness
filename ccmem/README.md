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
python -m uvicorn ccmem.service:app --host 127.0.0.1 --port 8765
```

`start.bat` does this automatically when Python is available. The service binds
to loopback (`127.0.0.1`) so the memory bank is not reachable from other
machines on the network. The harness talks to it over `localhost`, so local
memory keeps working identically.

### Optional auth (same-host protection)

By default the service is unauthenticated. To stop other local processes from
reading or poisoning the memory bank, set `HARNESS_CCMEM_TOKEN` for both the
service and the harness — every endpoint then requires
`Authorization: Bearer <token>`:

```
set HARNESS_CCMEM_TOKEN=your-shared-secret
python -m uvicorn ccmem.service:app --host 127.0.0.1 --port 8765
```

`start.bat` / `start.sh` generate and persist a token under
`.harness/ccmem/token` and export it to both processes automatically, so the
supported launch path is authenticated out of the box. Leaving the variable
unset keeps the old zero-config behaviour.


## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + cell count |
| GET | `/cells` | List all stored cells |
| POST | `/write` | Store one text |
| POST | `/write_many` | Store batch |
| POST | `/query` | Semantic search |
| POST | `/bind` | Bind related texts into one composite cell |
