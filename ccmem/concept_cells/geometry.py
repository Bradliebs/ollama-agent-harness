"""Geometric measurements on embedding sets.

This is the heart of Experiment 01. We're answering:

  1. How isotropic are these embeddings? (closer to uniform-on-sphere = better)
  2. What's the effective dimensionality? (high = good for separation)
  3. Does the one-shot separation construction actually work?

The Tyukin/Gorban theorems give us precise theoretical predictions for case (3)
under the uniform-ball distribution. We compare actual false-positive rates
against those predictions.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np


# ---------- Isotropy and effective dimension ----------

@dataclass
class IsotropyReport:
    """Summary statistics on how 'isotropic' a set of embeddings is.

    For uniform-on-sphere in high dim:
      - mean_pairwise_cosine ~ 0
      - std_pairwise_cosine ~ 1/sqrt(d)
      - participation_ratio ~ d (effective dim ~ ambient dim)
    """
    n: int
    dim: int
    mean_norm: float
    std_norm: float
    mean_pairwise_cosine: float
    std_pairwise_cosine: float
    abs_mean_pairwise_cosine: float
    participation_ratio: float
    effective_dim_fraction: float  # participation_ratio / dim, in (0, 1]


def participation_ratio(emb: np.ndarray) -> float:
    """Effective dimensionality via eigenvalue participation ratio.

    PR = (sum lambda_i)^2 / sum(lambda_i^2)

    For isotropic data, PR = d. For data living on a k-dim subspace, PR ~ k.
    This is a standard measure (Gao et al., del Giudice, etc.).
    """
    # Center the data
    centered = emb - emb.mean(axis=0, keepdims=True)
    # Covariance eigenvalues; use SVD for numerical stability
    # Singular values of centered/sqrt(n-1) squared = eigenvalues of cov
    n = emb.shape[0]
    s = np.linalg.svd(centered, compute_uv=False)
    eigvals = (s ** 2) / max(n - 1, 1)
    eigvals = eigvals[eigvals > 1e-12]
    if len(eigvals) == 0:
        return 0.0
    return float((eigvals.sum() ** 2) / (eigvals ** 2).sum())


def isotropy_report(emb: np.ndarray, sample_pairs: int = 50_000,
                    seed: int = 0) -> IsotropyReport:
    """Compute isotropy diagnostics on an embedding matrix.

    For pairwise cosine we sample to avoid O(N^2) memory on large N.
    """
    n, d = emb.shape
    norms = np.linalg.norm(emb, axis=1)

    # Unit vectors for cosine similarity
    unit = emb / np.maximum(norms[:, None], 1e-12)

    # Sample random pairs
    rng = np.random.default_rng(seed)
    n_pairs = min(sample_pairs, n * (n - 1) // 2)
    i = rng.integers(0, n, size=n_pairs)
    j = rng.integers(0, n, size=n_pairs)
    mask = i != j
    i, j = i[mask], j[mask]
    cos = np.einsum("ij,ij->i", unit[i], unit[j])

    pr = participation_ratio(emb)

    return IsotropyReport(
        n=n,
        dim=d,
        mean_norm=float(norms.mean()),
        std_norm=float(norms.std()),
        mean_pairwise_cosine=float(cos.mean()),
        std_pairwise_cosine=float(cos.std()),
        abs_mean_pairwise_cosine=float(np.abs(cos).mean()),
        participation_ratio=pr,
        effective_dim_fraction=pr / d,
    )


# ---------- Separation test ----------

@dataclass
class SeparationResult:
    """Result of the Tyukin/Gorban separation experiment.

    For each item x_i in the memory, we build a 'concept cell' with
    w_i = x_i / ||x_i|| and threshold theta = ||x_i|| - eps.
    Then we query with every item and measure:

      - true_positive_rate: cell i fires for query i (should be ~1)
      - false_positive_rate: cell i fires for query j != i (should be ~0)
      - perfect_selectivity_rate: cell i fires *only* for query i

    The paper's Theorem 1 gives a theoretical lower bound on the probability
    of perfect selectivity, which we compute for comparison.
    """
    n_items: int
    dim: int
    epsilon: float
    threshold_scheme: str
    true_positive_rate: float
    false_positive_rate: float
    perfect_selectivity_rate: float
    theoretical_lower_bound: Optional[float]
    fp_rate_per_cell_mean: float
    fp_rate_per_cell_std: float


def build_concept_cells(emb: np.ndarray, epsilon: float = 0.05,
                        threshold_scheme: str = "norm_minus_eps"
                        ) -> Tuple[np.ndarray, np.ndarray]:
    """Build the one-shot concept-cell memory.

    Following Theorem 1 / equation (13) of the paper:
      w_i = x_i / ||x_i||                     (unit weight aligned with item)
      theta_i = chosen so the cell fires for its own item but not for random others

    threshold_scheme:
      - "norm_minus_eps": theta_i = ||x_i|| - epsilon
            This is what fires for x_i specifically. Best for selectivity to
            individual items.
      - "fixed": theta_i = epsilon (small positive constant)
            Coarser; useful when norms vary wildly.
    """
    norms = np.linalg.norm(emb, axis=1)
    w = emb / np.maximum(norms[:, None], 1e-12)

    if threshold_scheme == "norm_minus_eps":
        theta = norms - epsilon
    elif threshold_scheme == "fixed":
        theta = np.full_like(norms, epsilon)
    else:
        raise ValueError(f"Unknown threshold_scheme: {threshold_scheme}")

    return w, theta


def theoretical_selectivity_lower_bound(dim: int, n_background: int,
                                         theta_over_norm: float = 0.95) -> float:
    """Theorem 1 lower bound on P(neuron silent for all M background stimuli).

    P >= [1 - 0.5 * (1 - (theta/||w||)^2)^(n/2)]^M

    Note this assumes uniform-on-ball, which is the paper's setting.
    Real embeddings can do better or worse.
    """
    inner = 1.0 - 0.5 * (1.0 - theta_over_norm ** 2) ** (dim / 2)
    if inner <= 0:
        return 0.0
    return float(inner ** n_background)


def separation_test(emb: np.ndarray, epsilon: float = 0.05,
                    threshold_scheme: str = "norm_minus_eps",
                    max_items: Optional[int] = None) -> SeparationResult:
    """Run the full separation test on an embedding set.

    For each query item, check which cells fire. Compute:
      - TP: does cell i fire for query i?
      - FP: does cell i fire for any query j != i?
      - Perfect selectivity: cell i fires *only* for query i.
    """
    if max_items is not None and emb.shape[0] > max_items:
        # Subsample to keep things tractable
        rng = np.random.default_rng(0)
        idx = rng.choice(emb.shape[0], size=max_items, replace=False)
        emb = emb[idx]

    n, d = emb.shape
    w, theta = build_concept_cells(emb, epsilon=epsilon,
                                    threshold_scheme=threshold_scheme)

    # Activations: A[i, j] = <w_i, x_j> - theta_i. Cell i fires for query j iff A[i, j] > 0.
    # Memory: n x n matrix of floats. For n=10k that's 400MB at float32 - manageable.
    # For larger n we'd chunk.
    activations = w @ emb.T  # (n, n)
    fires = activations > theta[:, None]  # (n, n) bool

    # Diagonal: cell i firing for query i (true positive)
    tp = fires.diagonal()
    tp_rate = float(tp.mean())

    # Off-diagonal: cell i firing for query j != i (false positive)
    eye = np.eye(n, dtype=bool)
    off_diag = fires & ~eye
    fp_rate = float(off_diag.sum()) / float(n * (n - 1))

    # FP rate per cell (how many spurious activations does each cell have)
    fp_per_cell = off_diag.sum(axis=1) / max(n - 1, 1)

    # Perfect selectivity: cell i fires for query i AND no others
    perfectly_selective = tp & (off_diag.sum(axis=1) == 0)
    selectivity_rate = float(perfectly_selective.mean())

    # Theoretical bound (using the average theta/||w|| ratio; w is unit norm
    # so this is just theta_i, and the bound from Thm 1 uses theta/||w||).
    # With norm_minus_eps scheme: theta_i = ||x_i|| - eps, w_i unit.
    # The bound in the paper is for w with ||w||=1, so theta_over_norm = theta_i / 1 = theta_i.
    # But theta_i can exceed 1 if ||x_i|| > 1+eps, in which case bound is vacuous.
    # Use mean theta clipped to (0,1).
    mean_theta = float(np.clip(theta, 0, 0.9999).mean())
    bound = theoretical_selectivity_lower_bound(
        dim=d, n_background=n - 1, theta_over_norm=mean_theta
    )

    return SeparationResult(
        n_items=n,
        dim=d,
        epsilon=epsilon,
        threshold_scheme=threshold_scheme,
        true_positive_rate=tp_rate,
        false_positive_rate=fp_rate,
        perfect_selectivity_rate=selectivity_rate,
        theoretical_lower_bound=bound,
        fp_rate_per_cell_mean=float(fp_per_cell.mean()),
        fp_rate_per_cell_std=float(fp_per_cell.std()),
    )


# ---------- Whitening ----------

def zca_whiten(emb: np.ndarray, eps: float = 1e-5) -> np.ndarray:
    """ZCA whitening: decorrelate dimensions while staying close to original.

    If real embeddings are anisotropic, whitening pushes them toward the
    isotropic ideal the theorems assume. We test whether this helps.
    """
    mu = emb.mean(axis=0, keepdims=True)
    centered = emb - mu
    cov = (centered.T @ centered) / max(centered.shape[0] - 1, 1)
    # Symmetric matrix sqrt via eigendecomposition
    eigvals, eigvecs = np.linalg.eigh(cov)
    eigvals = np.maximum(eigvals, eps)
    w_mat = eigvecs @ np.diag(1.0 / np.sqrt(eigvals)) @ eigvecs.T
    return (centered @ w_mat).astype(np.float32)


def scale_to_unit_ball(emb: np.ndarray) -> np.ndarray:
    """Rescale so all vectors fit inside the unit ball.

    The theorems assume support in B^n(1). Most encoders produce embeddings
    with norms in [0.5, 20] or so. This is a simple rescaling so that the
    theoretical bounds are meaningful.
    """
    max_norm = float(np.linalg.norm(emb, axis=1).max())
    return (emb / (max_norm + 1e-8)).astype(np.float32)
