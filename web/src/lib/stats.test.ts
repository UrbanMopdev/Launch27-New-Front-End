import { describe, expect, it } from 'vitest';
import { benjaminiHochberg, betaPosterior, betaPrior, logisticRegression, logOddsZ, normCdf, quantile, twoProportion, wilson } from './stats';

describe('stats', () => {
  it('normal CDF matches tables', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.645)).toBeCloseTo(0.05, 3);
  });

  it('Wilson interval matches the closed form', () => {
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeCloseTo(0.2366, 3);
    expect(hi).toBeCloseTo(0.7634, 3);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('two-proportion z-test', () => {
    const r = twoProportion(45, 100, 30, 100);
    expect(r.z).toBeCloseTo(2.191, 2);
    expect(r.pValue).toBeCloseTo(0.0285, 3);
    expect(r.ratio).toBeCloseTo(1.5, 6);
  });

  it('Benjamini–Hochberg q-values', () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.5]);
    expect(q[0]).toBeCloseTo(0.04, 6);
    expect(q[1]).toBeCloseTo(0.0533, 3);
    expect(q[2]).toBeCloseTo(0.0533, 3);
    expect(q[3]).toBeCloseTo(0.5, 6);
  });

  it('logistic regression recovers a known effect', () => {
    // Deterministic synthetic data: base rate 10%, feature A multiplies odds by ~4, B no effect.
    const X: number[][] = [];
    const y: number[] = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 4000; i++) {
      const a = rand() < 0.3 ? 1 : 0;
      const b = rand() < 0.5 ? 1 : 0;
      const p = 1 / (1 + Math.exp(-(-2.2 + 1.386 * a)));
      X.push([a, b]);
      y.push(rand() < p ? 1 : 0);
    }
    const fit = logisticRegression(X, y, 0.01);
    expect(Math.exp(fit.coef[0])).toBeGreaterThan(3);
    expect(Math.exp(fit.coef[0])).toBeLessThan(5.5);
    expect(Math.abs(fit.coef[1])).toBeLessThan(2.5 * fit.se[1]);
  });

  it('beta shrinkage pulls small groups toward the mean', () => {
    const groups = [...Array.from({ length: 20 }, () => ({ k: 2, n: 20 })), { k: 1, n: 1 }];
    const prior = betaPrior(groups);
    const small = betaPosterior(1, 1, prior, 0.1);
    expect(small.mean).toBeLessThan(0.3); // raw 100% shrinks a lot
    const big = betaPosterior(40, 100, prior, 0.1);
    expect(big.probAbove).toBeGreaterThan(0.95);
  });

  it('log-odds z separates characteristic words', () => {
    const A = new Map([['late', 20], ['great', 2], ['clean', 10]]);
    const B = new Map([['late', 2], ['great', 30], ['clean', 12]]);
    const prior = new Map([['late', 22], ['great', 32], ['clean', 22]]);
    const z = logOddsZ(A, B, prior, 0.1);
    expect(z.get('late')!).toBeGreaterThan(2);
    expect(z.get('great')!).toBeLessThan(-2);
  });

  it('quantile interpolates', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
  });
});
