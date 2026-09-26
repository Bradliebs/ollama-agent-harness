---
title: Getting Started
description: Entry point for local or cloud setup and a confirmed first task
ms.date: 2026-09-15
---

> **The beginner's setup guide lives at [`../START-HERE.md`](../START-HERE.md).**

To set up and run the Ollama Agent Harness for the first time, open
[`START-HERE.md`](../START-HERE.md) in the project root. It walks you through:

1. Installing **Node.js 24 LTS** (minimum **22.13.0**)
2. Choosing a local Ollama model or explicitly configuring a cloud provider
3. Starting the harness: double-click `start.bat` on Windows, or run `./start.sh` on macOS/Linux
4. Opening the printed URL, confirming your workspace and model, and running Quick Test

Cloud model execution and network tools can transmit data externally. Configuration checks do not prove successful inference; inspect the first task's response and tool evidence.

For the full feature reference, see the [README](../README.md).

For cloud inference while local hardware is busy, see
[Model Presets](MODEL-PRESETS.md#adding-an-ollama-cloud-model). Normal harness
use does not require elevation. For background start/stop and abandoned ownership
markers, use the [Background Lifecycle](MODERNIZATION-STATUS.md#background-lifecycle)
guide rather than killing processes from saved PIDs.

The [Modernization Status](MODERNIZATION-STATUS.md) record distinguishes verified
checks from remaining release gates. A successful setup or scripted browser test
does not establish live-model task correctness.

