"""Hebbian binding via Oja's rule.

This implements equation (10) of Tyukin/Gorban for the dynamic-memory case:

    dw/dt = α · v(s, w, θ) · y(s, w) · (s − w · y(s, w))

where the cell sees a SUM of co-presented stimuli s̄ = Σ x_i (equation 24).
The cell rotates toward the mean direction of the items it co-fires for,
provided one of them was already "known" (so the gate v fires).

We use Euler integration: w ← w + dt · dw/dt, with dt small enough that
the update stays stable. For the alpha and dt values below this is fine.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np


@dataclass
class BindingResult:
    """Outcome of trying to bind a set of items into a single cell."""
    n_items: int                 # how many items we tried to bind
    n_steps: int                 # how many Oja update steps were taken
    success: bool                # cell fires for each bound item alone?
    fires_per_item: List[bool]   # per-item firing in retrieval phase
    margins_per_item: List[float]
    final_alignment_to_mean: float  # cos(w_final, x̄) — should approach 1
    n_distractor_false_fires: int
    distractor_margin_max: float    # most-positive margin among distractors
    w_norm_final: float


def oja_step(w: np.ndarray, s: np.ndarray, theta: float,
              alpha: float, dt: float) -> np.ndarray:
    """Single Euler step of the gated Oja rule.

    w   : (D,) current synaptic weights
    s   : (D,) input stimulus (sum of co-presented items for binding)
    theta: scalar firing threshold
    alpha: learning-rate constant from eq. (10)
    dt  : integration step size

    Returns updated w.
    """
    y = float(w @ s)               # membrane potential
    v = max(y - theta, 0.0)        # threshold gate (only fires if above θ)
    if v <= 0.0:
        return w                   # cell silent — no plasticity
    # Oja's rule with the gating multiplier
    dw = alpha * v * y * (s - w * y)
    return w + dt * dw


def bind_items(w0: np.ndarray, items: List[np.ndarray], theta: float,
                alpha: float = 1.0, dt: float = 0.05,
                n_steps: int = 200) -> Tuple[np.ndarray, List[float]]:
    """Run Oja-rule co-presentation for binding a set of items into one cell.

    During each step the cell sees s̄ = Σ items (linear sum, per eq. 24).
    Returns the final weight vector and the trajectory of ||w|| values
    (useful for diagnosing instability).
    """
    w = w0.copy().astype(np.float64)
    s_bar = np.sum(items, axis=0).astype(np.float64)
    norm_trajectory: List[float] = [float(np.linalg.norm(w))]
    for _ in range(n_steps):
        w = oja_step(w, s_bar, theta, alpha, dt)
        norm_trajectory.append(float(np.linalg.norm(w)))
    return w.astype(np.float32), norm_trajectory


def test_binding(items: List[np.ndarray], distractors: List[np.ndarray],
                  w_initial: np.ndarray, w_final: np.ndarray,
                  theta_initial: float, theta_final: Optional[float] = None
                  ) -> BindingResult:
    """Check whether `w_final` correctly fires for each bound item and
    correctly stays silent for the distractors.

    Before binding, the cell with `w_initial` should fire for items[0] (the
    "known" anchor) and stay silent for everything else. After binding, the
    cell with `w_final` should fire for ALL bound items and stay silent for
    distractors.

    For multi-item binding, Theorem 3 allows lowering theta after binding
    (because once w aligns with the mean, the projections of individual
    items onto w get smaller). If theta_final is None, we keep theta unchanged
    and see whether the original threshold still works.
    """
    if theta_final is None:
        theta_final = theta_initial

    margins_items = [float(w_final @ x) - theta_final for x in items]
    margins_dist = [float(w_final @ x) - theta_final for x in distractors]

    fires_items = [m > 0 for m in margins_items]
    fires_dist = [m > 0 for m in margins_dist]

    # Alignment of final weights to the mean direction of the bound items
    x_bar = np.mean(items, axis=0)
    x_bar_unit = x_bar / max(np.linalg.norm(x_bar), 1e-12)
    w_unit = w_final / max(np.linalg.norm(w_final), 1e-12)
    alignment = float(w_unit @ x_bar_unit)

    success = all(fires_items) and not any(fires_dist)

    return BindingResult(
        n_items=len(items),
        n_steps=0,  # filled in by caller
        success=success,
        fires_per_item=fires_items,
        margins_per_item=margins_items,
        final_alignment_to_mean=alignment,
        n_distractor_false_fires=sum(fires_dist),
        distractor_margin_max=float(max(margins_dist)) if margins_dist else float("-inf"),
        w_norm_final=float(np.linalg.norm(w_final)),
    )


def initialize_cell_for_anchor(anchor: np.ndarray, theta: float,
                                eps: float = 0.05) -> np.ndarray:
    """Build the initial 'known stimulus' cell.

    The cell weights are placed on the UNIT SPHERE aligned with the anchor:
        w0 = anchor / ||anchor||

    This is a small but critical departure from the literal reading of
    Theorem 1 / eq. (13), which writes w0 = (theta + eps) * unit(anchor).
    That construction is fine when ||anchor|| ≈ 1 (the paper's uniform-ball
    setting) because then <w0, anchor> = theta + eps clears the threshold.

    On real embeddings, ||anchor|| varies: after whitening + ball-scaling,
    most items have norm < 1 (only the max-norm item has ||x|| = 1). Under
    the literal construction, <w0, anchor> becomes
       (theta + eps) * ||anchor|| < theta + eps,
    which can fall BELOW theta — the cell silently fails its pre-binding
    firing condition, the Oja gate stays shut forever, and binding never
    happens. This is exactly what broke our first exp04 run.

    With w on the unit sphere, <w0, anchor> = ||anchor||, which clears the
    threshold as long as theta < min(||x||) over the corpus. For our setup
    that means theta < ~0.78, which is the regime we care about anyway.

    `theta` and `eps` are kept as parameters for backward compatibility,
    but only `anchor` actually determines w0 now.
    """
    _ = (theta, eps)  # accepted but unused; preserved for API compatibility
    a = anchor / max(np.linalg.norm(anchor), 1e-12)
    return a.astype(np.float32)


def theoretical_theta_star(m: int, eps: float = 0.05, delta: float = 0.05
                            ) -> float:
    """Theorem 3 upper bound on the firing threshold for binding m items.

    For uniform-on-ball samples with quasi-orthogonality parameter delta and
    norm-tightness parameter eps, the firing threshold theta must satisfy
    0 < theta < theta_star to guarantee post-binding selectivity. Lower
    theta_star means binding is harder.
    """
    if m < 1:
        return 0.0
    num = (1 - eps) ** 3 - delta * (m - 1)
    if num <= 0:
        return 0.0
    den = np.sqrt(m) * (1 - eps) * ((1 - eps) + delta * (m - 1))
    return float(num / den)
