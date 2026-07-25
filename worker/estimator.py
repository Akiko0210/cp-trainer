"""Rating estimator: MAP inference under a Rasch / 1-PL IRT (Elo) model.

WHY NOT "average the ratings of what you solved"
------------------------------------------------
That was v1's heuristic and it is biased in a way that shows up immediately in
real data. Averaging only *solved* problems is survivorship bias: the problems
you attempted and never solved — the most direct evidence of your ceiling —
are thrown away. Worse, it answers the wrong question. A Codeforces problem
rated `d` is *defined* as the difficulty at which a contestant rated `d` has a
50% chance of solving it on first encounter, so the average difficulty of the
problems you happen to clear is not your skill level: grind a few hard ones
with unlimited time and the average runs away from you. On this user's real
history, Data Structures read 2062 for a 1595-rated account whose solved
problems there average 1677 and whose 20 *failures* average 2045 — an estimate
above the difficulty they demonstrably could not clear.

TWO THINGS THAT MUST BE CORRECTED FOR (both measured, not guessed)
------------------------------------------------------------------
1. *Selection on the outcome.* You choose which problems to open, and you keep
   grinding a practice problem until it falls. So ~90% of the problems in your
   history are solved, and a naive fit reads that as "your ability is 400
   points above what you attempt". Codeforces does not have this problem: it
   defines a problem's rating against EVERY participant in the round, including
   those who never opened it. Reproducing that — counting all problems of every
   contest entered, not just the ones submitted to — took this account's fitted
   ability from 1921 to 1703 against a true rating of 1595.

2. *Regime.* A rating is calibrated for a first encounter under contest clock.
   A practice solve with unlimited time and the editorial one tab away is much
   weaker evidence, so practice solves are discounted in difficulty and
   down-weighted. A practice FAILURE is the opposite: you had unlimited time
   and still could not do it, which is a strong ceiling signal, so it counts
   fully at nominal difficulty.

THE MODEL
---------
CF ratings are on the standard Elo 400-point scale, and problem ratings are
calibrated to be compatible with contestant ratings. So the probability that a
contestant of ability `theta` solves a problem of difficulty `d` is

    P(solve) = 1 / (1 + 10 ** ((d - theta) / 400))

giving 0.50 at parity, ~0.76 at +200, ~0.91 at +400. This is the Rasch model
(1-parameter item response theory), which is the standard way to recover a
latent ability from binary pass/fail observations against known item
difficulties; it is equivalent to Bradley-Terry over (solver, problem) pairs.

We therefore *fit* theta instead of averaging: find the ability that best
explains the whole observed pattern of solves AND failures. Each observation
contributes a `push` of w * (y - P): clearing something you were expected to
fail pushes the estimate up, failing something you were expected to clear
pushes it down, and an outcome the model already predicted pushes ~nothing.
The estimate settles where the pushes cancel against the prior — which makes
the arithmetic auditable, one row per problem, in the UI.

A Gaussian prior centred on the account's overall CF rating regularises the
fit. This matters for two reasons: a category with only successes has no
finite maximum-likelihood solution (theta would run to infinity), and a
category with three observations should read "about your usual level", not
swing wildly. PRIOR_SIGMA is expressed below in equivalent-observations.

Everything here is pure functions over `Obs` records, so it can be checked
against real data without touching the database (see `__main__`).
"""

import math
from dataclasses import dataclass

# --- the model ------------------------------------------------------------

ELO_SCALE = 400.0
# d/d(theta) of the logit; converts Elo points to natural-log-odds units.
K = math.log(10.0) / ELO_SCALE

# --- tunables -------------------------------------------------------------

# Ability decays much more slowly than "heat" does. The heat score in
# mastery.py uses a 90-day half-life on purpose; the *estimate* answers "what
# can you handle", which a six-month-old solve is still real evidence about.
ESTIMATE_HALF_LIFE_DAYS = 240.0

# Prior strength, in equivalent coin-flip observations (an observation at
# P=0.5 carries Fisher information K**2 * 0.25). Two means: with ~2 recent
# observations the estimate sits midway between your CF rating and the data,
# and with a dozen the data dominates.
PRIOR_EQUIV_OBSERVATIONS = 2.0

# Cleanliness shifts *effective difficulty*: a first-try solve of a 2000 is
# stronger evidence than scraping one after six wrong submissions, so we score
# it as though the problem had been harder.
CLEAN_BONUS = {0: 60.0, 1: 30.0, 2: 0.0}
GRINDY_PENALTY = -60.0  # 3+ wrong submissions before the AC
FAST_DEBUG_BONUS = 30.0  # timed attempt whose debug time beat the user median

# A single failed submission is weak evidence of a real attempt (mis-clicks,
# abandoned reads); a repeated failure is strong evidence of a real wall.
LONE_FAILURE_WEIGHT = 0.4
UNRATED_BASELINE = 1200.0  # prior centre when the account has no CF rating

# CF author.participantType values that mean "first encounter, on the clock".
CONTEST_REGIMES = ("CONTESTANT", "VIRTUAL", "OUT_OF_COMPETITION")

# A practice solve is treated as clearing a problem this much easier than its
# nominal rating. The global fit is insensitive to this (0 -> 500 moves the
# anchor by only ~35 Elo, because the contest backbone dominates); it matters
# for topics practised but rarely met in contest.
PRACTICE_DISCOUNT = 300.0
PRACTICE_SOLVE_WEIGHT = 0.5

# A contest problem the user never submitted to still counts as a non-solve
# (that is the whole selection-bias correction), but slightly below full
# weight: "never reached it" is noisier evidence than "tried and failed".
UNATTEMPTED_WEIGHT = 1.0

_MIN_THETA, _MAX_THETA = 0.0, 4500.0


@dataclass
class Obs:
    """One problem the user has genuinely engaged with."""

    problem_id: int
    difficulty: float  # effective difficulty: rating + cleanliness adjustment
    solved: bool
    weight: float  # recency * evidence quality


@dataclass
class Fit:
    theta: float  # MAP ability estimate, in Elo points
    se: float  # standard error (1 / sqrt(total Fisher information))
    n_eff: float  # sum of observation weights
    prior_mu: float
    pushes: dict[int, float]  # problem_id -> w * (y - P) at the solution


def p_solve(theta: float, difficulty: float) -> float:
    """Rasch/Elo probability that `theta` clears `difficulty`."""
    return 1.0 / (1.0 + 10.0 ** ((difficulty - theta) / ELO_SCALE))


def prior_sigma(equiv_observations: float = PRIOR_EQUIV_OBSERVATIONS) -> float:
    """Prior SD giving the prior the weight of N coin-flip observations."""
    return 1.0 / math.sqrt(equiv_observations * K * K * 0.25)


def recency_weight(age_days: float, half_life: float = ESTIMATE_HALF_LIFE_DAYS) -> float:
    return 0.5 ** (max(0.0, age_days) / half_life)


def fit(observations: list[Obs], prior_mu: float, sigma: float | None = None) -> Fit:
    """MAP estimate of ability.

    The log-posterior is strictly concave in theta (a sum of logistic
    log-likelihoods plus a Gaussian), so its derivative is strictly decreasing
    and has exactly one root — bisection finds it without any step-size or
    convergence tuning to get wrong.
    """
    sigma = sigma if sigma is not None else prior_sigma()

    if not observations:
        return Fit(prior_mu, sigma, 0.0, prior_mu, {})

    def gradient(theta: float) -> float:
        g = -(theta - prior_mu) / (sigma * sigma)
        for o in observations:
            y = 1.0 if o.solved else 0.0
            g += o.weight * (y - p_solve(theta, o.difficulty)) * K
        return g

    lo, hi = _MIN_THETA, _MAX_THETA
    for _ in range(60):  # ~1e-16 relative precision; overkill is free here
        mid = 0.5 * (lo + hi)
        if gradient(mid) > 0.0:
            lo = mid
        else:
            hi = mid
    theta = 0.5 * (lo + hi)

    # Observed information -> standard error. Each observation is most
    # informative when P is near 0.5, i.e. when the problem sat right at the
    # edge of your ability; lopsided outcomes tell us little.
    info = 1.0 / (sigma * sigma)
    pushes: dict[int, float] = {}
    for o in observations:
        p = p_solve(theta, o.difficulty)
        info += o.weight * p * (1.0 - p) * K * K
        pushes[o.problem_id] = o.weight * ((1.0 if o.solved else 0.0) - p)

    return Fit(
        theta=theta,
        se=1.0 / math.sqrt(info),
        n_eff=sum(o.weight for o in observations),
        prior_mu=prior_mu,
        pushes=pushes,
    )


def confidence_from_se(se: float) -> float:
    """0..1 readout for the UI. 1.0 means the estimate is pinned to ~±40
    Elo, 0.0 means we know essentially nothing beyond the prior."""
    return max(0.0, min(1.0, 1.0 - (se - 40.0) / (prior_sigma() - 40.0)))


if __name__ == "__main__":
    # Sanity checks on the model, plus the pathological cases that motivated
    # the prior. Run: uv run python estimator.py
    assert abs(p_solve(1500, 1500) - 0.5) < 1e-9
    assert abs(p_solve(1700, 1500) - 0.7597) < 1e-3, p_solve(1700, 1500)
    assert abs(p_solve(1900, 1500) - 0.9091) < 1e-3, p_solve(1900, 1500)

    print(f"prior sigma = {prior_sigma():.0f} Elo "
          f"({PRIOR_EQUIV_OBSERVATIONS} equivalent observations)")

    # All-successes must stay finite and land above the prior, not at infinity.
    only_wins = [Obs(i, 1667, True, 1.0) for i in range(9)]
    f = fit(only_wins, 1595)
    print(f"9 solves @1667, none failed      -> {f.theta:.0f} +/- {f.se:.0f}")
    assert f.theta < 2100

    # The Data Structures shape: many mid solves, a wall of harder failures.
    mixed = [Obs(i, 1677, True, 1.0) for i in range(20)] + [
        Obs(100 + i, 2045, False, 1.0) for i in range(10)
    ]
    f = fit(mixed, 1595)
    print(f"20 solves @1677, 10 fails @2045  -> {f.theta:.0f} +/- {f.se:.0f}")
    assert 1677 < f.theta < 2045, "estimate must sit between clears and walls"

    # No evidence at all -> exactly the prior, with the prior's spread.
    f = fit([], 1595)
    print(f"no observations                  -> {f.theta:.0f} +/- {f.se:.0f}")
    assert f.theta == 1595
    print("estimator self-checks passed")
