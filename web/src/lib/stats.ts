// Small statistics toolkit for the analytics pages. Pure functions, no dependencies.

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Wilson score interval for a proportion k/n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface TwoPropResult {
  p1: number;
  p2: number;
  diff: number;
  ratio: number;
  z: number;
  pValue: number;
}

/** Two-sided two-proportion z-test (pooled variance) of k1/n1 vs k2/n2. */
export function twoProportion(k1: number, n1: number, k2: number, n2: number): TwoPropResult {
  const p1 = n1 ? k1 / n1 : 0;
  const p2 = n2 ? k2 / n2 : 0;
  const pooled = n1 + n2 ? (k1 + k2) / (n1 + n2) : 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(n1, 1) + 1 / Math.max(n2, 1)));
  const z = se > 0 ? (p1 - p2) / se : 0;
  return { p1, p2, diff: p1 - p2, ratio: p2 > 0 ? p1 / p2 : p1 > 0 ? Infinity : 1, z, pValue: 2 * (1 - normCdf(Math.abs(z))) };
}

/** Benjamini–Hochberg adjusted p-values (q-values), same order as input. */
export function benjaminiHochberg(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = order[rank - 1];
    running = Math.min(running, (p * m) / rank);
    q[i] = running;
  }
  return q;
}

/** Solve A x = b by Gauss–Jordan elimination with partial pivoting; returns x and A^-1. */
export function solveAndInvert(A: number[][], b: number[]): { x: number[]; inv: number[][] } {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)), b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col] || 1e-12;
    for (let c = 0; c < M[col].length; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f) for (let c = 0; c < M[r].length; c++) M[r][c] -= f * M[col][c];
    }
  }
  return { x: M.map((row) => row[2 * n]), inv: M.map((row) => row.slice(n, 2 * n)) };
}

export interface LogisticFit {
  intercept: number;
  coef: number[];
  se: number[];
  iterations: number;
}

/**
 * L2-regularised logistic regression by Newton–Raphson. X is rows × features (0/1 or numeric),
 * y is 0/1. The intercept is not penalised. Standard errors come from the inverse Hessian.
 */
export function logisticRegression(X: number[][], y: number[], lambda = 1, maxIter = 50): LogisticFit {
  const n = X.length;
  const k = (X[0]?.length || 0) + 1;
  const rows = X.map((r) => [1, ...r]);
  let w = new Array<number>(k).fill(0);
  let inv: number[][] = [];
  let it = 0;
  for (; it < maxIter; it++) {
    const grad = new Array<number>(k).fill(0);
    const H = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < n; i++) {
      const xi = rows[i];
      let eta = 0;
      for (let j = 0; j < k; j++) eta += w[j] * xi[j];
      const p = 1 / (1 + Math.exp(-eta));
      const wt = p * (1 - p);
      for (let j = 0; j < k; j++) {
        grad[j] += (y[i] - p) * xi[j];
        if (!xi[j]) continue;
        for (let l = j; l < k; l++) H[j][l] += wt * xi[j] * xi[l];
      }
    }
    for (let j = 0; j < k; j++) for (let l = 0; l < j; l++) H[j][l] = H[l][j];
    for (let j = 1; j < k; j++) {
      grad[j] -= lambda * w[j];
      H[j][j] += lambda;
    }
    const step = solveAndInvert(H, grad);
    inv = step.inv;
    w = w.map((v, j) => v + step.x[j]);
    if (Math.max(...step.x.map(Math.abs)) < 1e-6) break;
  }
  return { intercept: w[0], coef: w.slice(1), se: inv.slice(1).map((row, j) => Math.sqrt(Math.max(row[j + 1], 0))), iterations: it + 1 };
}

/**
 * Empirical-Bayes beta prior for a set of proportions (method of moments), so groups with few
 * observations are shrunk toward the overall rate. Falls back to a weak prior of `minStrength`.
 */
export function betaPrior(groups: { k: number; n: number }[], minStrength = 10): { alpha: number; beta: number } {
  const totalK = groups.reduce((s, g) => s + g.k, 0);
  const totalN = groups.reduce((s, g) => s + g.n, 0);
  const mean = totalN ? totalK / totalN : 0.1;
  const rates = groups.filter((g) => g.n >= 5).map((g) => g.k / g.n);
  let strength = minStrength;
  if (rates.length >= 5) {
    const m = rates.reduce((a, b) => a + b, 0) / rates.length;
    const v = rates.reduce((a, b) => a + (b - m) ** 2, 0) / (rates.length - 1);
    // Subtract average binomial noise to estimate true between-group variance.
    const avgN = groups.filter((g) => g.n >= 5).reduce((s, g) => s + g.n, 0) / rates.length;
    const between = v - (mean * (1 - mean)) / avgN;
    if (between > 1e-6) strength = Math.max(minStrength, (mean * (1 - mean)) / between - 1);
    else strength = 200; // groups look alike: shrink strongly
  }
  return { alpha: mean * strength, beta: (1 - mean) * strength };
}

/** Posterior summary for k/n under a Beta(alpha, beta) prior, with a normal-approx interval and P(rate > ref). */
export function betaPosterior(k: number, n: number, prior: { alpha: number; beta: number }, ref: number) {
  const a = prior.alpha + k;
  const b = prior.beta + n - k;
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return { mean, lo: Math.max(0, mean - 1.645 * sd), hi: Math.min(1, mean + 1.645 * sd), probAbove: 1 - normCdf((ref - mean) / (sd || 1e-9)) };
}

/**
 * Weighted log-odds ratio with an informative Dirichlet prior (Monroe, Colaresi & Quinn 2008).
 * Returns a z-score per token: positive = characteristic of A, negative = of B.
 */
export function logOddsZ(countsA: Map<string, number>, countsB: Map<string, number>, prior: Map<string, number>, priorScale = 1): Map<string, number> {
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
  const nA = sum(countsA);
  const nB = sum(countsB);
  const a0Raw = sum(prior) || 1;
  const a0 = a0Raw * priorScale;
  const out = new Map<string, number>();
  for (const [w, pc] of prior) {
    const aw = pc * priorScale;
    const yA = countsA.get(w) || 0;
    const yB = countsB.get(w) || 0;
    const lA = Math.log((yA + aw) / (nA + a0 - yA - aw));
    const lB = Math.log((yB + aw) / (nB + a0 - yB - aw));
    const variance = 1 / (yA + aw) + 1 / (yB + aw);
    out.set(w, (lA - lB) / Math.sqrt(variance));
  }
  return out;
}

export const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};
