"""Encoder wrappers.

We test multiple encoders because the geometry of the embedding space is
encoder-dependent. The hypothesis from the paper requires near-isotropic
embeddings; different encoders will satisfy this to wildly different degrees.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional

import numpy as np


@dataclass
class EncodedBatch:
    """Container for embeddings + their source items."""
    embeddings: np.ndarray  # shape (N, D)
    items: List[str]
    encoder_name: str

    @property
    def dim(self) -> int:
        return self.embeddings.shape[1]

    @property
    def n(self) -> int:
        return self.embeddings.shape[0]


class TextEncoder:
    """Wraps a sentence-transformers model."""

    def __init__(self, model_name: str = "all-MiniLM-L6-v2", device: Optional[str] = None):
        import torch
        from sentence_transformers import SentenceTransformer
        self.model_name = model_name
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model = SentenceTransformer(model_name, device=self.device)

    def encode(self, texts: Iterable[str], batch_size: int = 64,
               normalize: bool = False) -> EncodedBatch:
        """Encode a list of texts.

        Note: we default normalize=False here because the separation theorems
        analyse raw embeddings. We can normalize downstream if needed.
        """
        texts = list(texts)
        emb = self.model.encode(
            texts,
            batch_size=batch_size,
            convert_to_numpy=True,
            normalize_embeddings=normalize,
            show_progress_bar=True,
        )
        return EncodedBatch(
            embeddings=emb.astype(np.float32),
            items=texts,
            encoder_name=self.model_name,
        )


class RandomGaussianEncoder:
    """A control encoder: maps items to i.i.d. Gaussian vectors.

    This is the *ideal* case the paper's theorems were proved for (well, ball
    rather than Gaussian, but they're close in high dim by concentration).
    Used as a positive control to validate our measurement code.
    """

    def __init__(self, dim: int = 384, seed: int = 42):
        self.dim = dim
        self.seed = seed
        self.model_name = f"random-gaussian-{dim}d"

    def encode(self, items: Iterable[str], **kwargs) -> EncodedBatch:
        items = list(items)
        rng = np.random.default_rng(self.seed)
        emb = rng.standard_normal((len(items), self.dim)).astype(np.float32)
        return EncodedBatch(embeddings=emb, items=items, encoder_name=self.model_name)


class UniformBallEncoder:
    """Control encoder: maps items to uniform samples in the unit ball.

    This is *exactly* the distribution Tyukin/Gorban prove their theorems on.
    If our measurement code is correct, this encoder should saturate the
    theoretical bounds.
    """

    def __init__(self, dim: int = 384, seed: int = 42):
        self.dim = dim
        self.seed = seed
        self.model_name = f"uniform-ball-{dim}d"

    def encode(self, items: Iterable[str], **kwargs) -> EncodedBatch:
        items = list(items)
        rng = np.random.default_rng(self.seed)
        n = len(items)
        # Sample uniformly from unit ball: gaussian + normalize + scale by U^(1/d)
        g = rng.standard_normal((n, self.dim))
        g = g / np.linalg.norm(g, axis=1, keepdims=True)
        r = rng.uniform(0, 1, size=(n, 1)) ** (1.0 / self.dim)
        emb = (g * r).astype(np.float32)
        return EncodedBatch(embeddings=emb, items=items, encoder_name=self.model_name)
