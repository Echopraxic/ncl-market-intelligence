// src/agents/signals/trend-detection/statistical-trend-engine.ts
import { createRequire } from 'module';
import { linearRegression, linearRegressionLine, sampleVariance, mean } from 'simple-statistics';
import { db } from '../../../db/index.js';
import { euMarketSignals, trends } from '../../../db/schema.js';
import { and, gte, lte, eq } from 'drizzle-orm';

// jStat is CJS with no ESM exports field — use createRequire for reliable interop
const require = createRequire(import.meta.url);
const jStat: any = require('jstat');

interface TimeSeriesPoint {
  id: string;
  date: Date;
  value: number;
  source: string;
  countryCode: string;
  category: string;
  rawData: any;
}

export interface DetectionMethodResult {
  method: string;
  growthRate: number;   // Annualized
  variance: number;     // Variance of the growthRate estimate — used for inverse-variance weighting
  confidence: number;   // 0–1 based on statistical significance
  direction: 'up' | 'down' | 'flat';
  pValue: number;
  rSquared: number;
  sampleSize: number;
  metadata: Record<string, number>;
}

/**
 * Six-tier opportunity taxonomy classifying EU market trends by YoY growth rate
 * and data quality. Drives differentiated NCL engagement strategies.
 *
 * breakthrough  — >50% YoY: emerging category, first-mover advantage; immediate outreach + pitch generation
 * accelerating  — 25–50%:   proven demand, brands actively scaling; competitive entry window
 * sustained     — 10–25%:   established market; NI routing efficiency is key value proposition
 * mature        —  5–10%:   requires distinct positioning or niche targeting
 * disrupted     — <0%:      structural shift (supplier exit, tariff change) creates vacuum US brands can fill
 * watch         — volatile/noisy: monitor until clearer pattern emerges; no resource allocation yet
 */
export type OpportunityTier =
  | 'breakthrough'
  | 'accelerating'
  | 'sustained'
  | 'mature'
  | 'disrupted'
  | 'watch';

export interface CompositeTrend {
  id: string;
  category: string;
  countryCode: string;
  growthRate: number;
  opportunityTier: OpportunityTier;
  timePeriod: { start: Date; end: Date };
  confidence: number;
  direction: 'up' | 'down' | 'flat';
  detectionMethods: DetectionMethodResult[];
  supportingSignalIds: string[];
  volatilityIndex: number;
  seasonalityStrength: number;
  isAccelerating: boolean;
  statisticalSignificance: boolean;
  // False-positive guards
  hasRecencyBias: boolean;   // CUSUM change point fired in final 30% of series
  sparseBaseline: boolean;   // First third of window had <5 non-zero data points
}

export class StatisticalTrendDetectionAgent {
  private readonly MIN_DATA_POINTS = 8;
  private readonly CONFIDENCE_THRESHOLD = 0.85;
  // Opportunity tier growth-rate boundaries (annualized YoY)
  private readonly TIER_BREAKTHROUGH  = 0.50;   // >50%  → breakthrough
  private readonly TIER_ACCELERATING  = 0.25;   // 25–50% → accelerating
  private readonly TIER_SUSTAINED     = 0.10;   // 10–25% → sustained
  private readonly TIER_MATURE        = 0.05;   //  5–10% → mature; floor for positive tiers
  // Volatile patterns (volatilityIndex above this) are classified as watch tier
  private readonly TIER_WATCH_VOLATILITY = 0.45;
  private readonly SIGNIFICANCE_LEVEL = 0.05;
  private readonly MIN_SPAN_DAYS = 60;
  private readonly MIN_NONZERO_RATIO = 0.5;
  private readonly MAX_GROWTH_RATE = 5.0;         // 500% annualized cap — zero-start artifact guard
  private readonly BASELINE_MIN_POINTS = 5;
  private readonly RECENCY_BIAS_THRESHOLD = 0.7;

  async detectTrends(
    countryCode?: string,
    category?: string,
    lookbackDays: number = 90,
    options: { skipPersist?: boolean } = {}
  ): Promise<CompositeTrend[]> {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    const signals = await this.fetchSignals(startDate, endDate, countryCode, category);
    const grouped = this.groupSignals(signals);
    const detectedTrends: CompositeTrend[] = [];

    for (const [key, series] of grouped.entries()) {
      if (series.length < this.MIN_DATA_POINTS) continue;

      const trend = this.analyzeTimeSeries(key, series, startDate, endDate);
      if (trend && this.validateTrend(trend)) {
        detectedTrends.push(trend);
        if (!options.skipPersist) {
          await this.persistTrend(trend);
        }
      }
    }

    return detectedTrends;
  }

  private async fetchSignals(
    start: Date,
    end: Date,
    countryCode?: string,
    category?: string
  ): Promise<TimeSeriesPoint[]> {
    const conditions = [
      gte(euMarketSignals.capturedAt, start),
      lte(euMarketSignals.capturedAt, end)
    ];

    if (countryCode) conditions.push(eq(euMarketSignals.countryCode, countryCode));
    if (category) conditions.push(eq(euMarketSignals.category, category));

    const results = await db.query.euMarketSignals.findMany({
      where: and(...conditions),
      orderBy: (signals, { asc }) => [asc(signals.capturedAt)]
    });

    return results.map(r => ({
      id: r.id,
      date: r.capturedAt,
      value: r.signalValue,
      source: r.source,
      countryCode: r.countryCode,
      category: r.category,
      rawData: r.rawData
    }));
  }

  private groupSignals(signals: TimeSeriesPoint[]): Map<string, TimeSeriesPoint[]> {
    const grouped = new Map<string, TimeSeriesPoint[]>();

    for (const signal of signals) {
      const key = `${signal.countryCode}|${signal.category}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(signal);
    }

    return grouped;
  }

  private analyzeTimeSeries(
    key: string,
    series: TimeSeriesPoint[],
    periodStart: Date,
    periodEnd: Date
  ): CompositeTrend | null {
    const [countryCode, category] = key.split('|');

    const cleanSeries = this.preprocessSeries(series);
    if (cleanSeries.length < this.MIN_DATA_POINTS) return null;

    // Guard: signals must span at least MIN_SPAN_DAYS
    const spanDays = (cleanSeries[cleanSeries.length - 1].date.getTime() - cleanSeries[0].date.getTime())
      / (1000 * 60 * 60 * 24);
    if (spanDays < this.MIN_SPAN_DAYS) return null;

    // Guard: first third of window must have a real baseline
    const firstThirdCutoff = Math.floor(cleanSeries.length / 3);
    const baselineNonZero = cleanSeries.slice(0, firstThirdCutoff).filter(s => s.value > 0).length;
    const sparseBaseline = baselineNonZero < this.BASELINE_MIN_POINTS;

    const methodResults: DetectionMethodResult[] = [
      this.linearRegressionMethod(cleanSeries),
      this.movingAverageConvergence(cleanSeries),
      this.seasonalDecompositionMethod(cleanSeries),
      this.changePointDetection(cleanSeries),
      this.volatilityAdjustedGrowth(cleanSeries),
      this.statisticalProcessControl(cleanSeries)
    ].filter((r): r is DetectionMethodResult => r !== null);

    if (methodResults.length === 0) return null;

    const composite = this.calculateEnsembleConsensus(methodResults);

    // Guard: cap extreme growth rates
    if (Math.abs(composite.growthRate) > this.MAX_GROWTH_RATE) return null;

    // Recency bias: CUSUM fired in final 30% of series
    const cusumResult = methodResults.find(m => m.method === 'change_point_cusum');
    const hasRecencyBias = cusumResult !== undefined
      && cusumResult.metadata.changePointIndex > cleanSeries.length * this.RECENCY_BIAS_THRESHOLD;

    const isAccelerating = this.detectAcceleration(cleanSeries);
    const volatilityIndex = this.calculateVolatility(cleanSeries);

    return {
      id: crypto.randomUUID(),
      category,
      countryCode,
      growthRate: composite.growthRate,
      opportunityTier: this.classifyOpportunityTier(composite.growthRate, volatilityIndex, composite.confidence),
      timePeriod: { start: periodStart, end: periodEnd },
      confidence: composite.confidence,
      direction: composite.direction,
      detectionMethods: methodResults,
      supportingSignalIds: series.map(s => s.id).filter(id => id !== ''),
      volatilityIndex,
      seasonalityStrength: this.measureSeasonality(cleanSeries),
      isAccelerating,
      statisticalSignificance: composite.pValue < this.SIGNIFICANCE_LEVEL,
      hasRecencyBias,
      sparseBaseline
    };
  }

  // ==================== DETECTION METHOD 1: LINEAR REGRESSION ====================

  private linearRegressionMethod(series: TimeSeriesPoint[]): DetectionMethodResult | null {
    const x = series.map((_, i) => i);
    const y = series.map(s => s.value);

    // Fall back to raw linear if >30% zeros (log transform produces explosive slopes on sparse series)
    const zeroRatio = y.filter(v => v === 0).length / y.length;
    const useLogTransform = zeroRatio <= 0.3;

    const minValue = Math.min(...y);
    const adjustedY = y.map(v => v - minValue + 1);
    const fitY = useLogTransform ? adjustedY.map(v => Math.log(v)) : y;

    const points: [number, number][] = x.map((xi, i) => [xi, fitY[i]]);
    const mb = linearRegression(points);
    const predict = linearRegressionLine(mb);
    const predictions = x.map(xi => predict(xi));

    const rSquared = this.calculateRSquared(fitY, predictions);

    // Standard error of slope
    const residuals = fitY.map((yi, i) => yi - predictions[i]);
    const mse = residuals.reduce((sum, r) => sum + r * r, 0) / Math.max(residuals.length - 2, 1);
    const xMean = mean(x);
    const ssX = x.reduce((sum, xi) => sum + Math.pow(xi - xMean, 2), 0);
    const slopeStdError = ssX > 0 ? Math.sqrt(mse / ssX) : Infinity;

    // Annualized growth rate
    const seriesMean = mean(y);
    const annualizedGrowth = useLogTransform
      ? Math.exp(mb.m * 365) - 1
      : seriesMean > 0 ? (mb.m * 365) / seriesMean : 0;

    // Variance of growth rate estimate via delta method
    //   Log case: g = exp(slope * 365) - 1, so dg/dslope = 365 * exp(slope * 365)
    //   Linear case: g = slope * 365 / mean, so dg/dslope = 365 / mean
    const dgDslope = useLogTransform
      ? 365 * Math.exp(mb.m * 365)
      : seriesMean > 0 ? 365 / seriesMean : 0;
    const variance = Math.pow(dgDslope * slopeStdError, 2);

    // Two-tailed t-test p-value using exact t-distribution (jStat)
    const df = x.length - 2;
    const tStatistic = slopeStdError > 0 ? mb.m / slopeStdError : 0;
    const pValue = this.tTestPValue(tStatistic, df);

    const confidence = Math.min(Math.max(rSquared * (1 - pValue), 0), 1);

    return {
      method: 'linear_regression_log',
      growthRate: annualizedGrowth,
      variance,
      confidence,
      direction: annualizedGrowth > 0.02 ? 'up' : annualizedGrowth < -0.02 ? 'down' : 'flat',
      pValue,
      rSquared,
      sampleSize: series.length,
      metadata: {
        slope: mb.m,
        intercept: mb.b,
        standardError: slopeStdError,
        usedLogTransform: useLogTransform ? 1 : 0
      }
    };
  }

  // ==================== DETECTION METHOD 2: MOVING AVERAGE CONVERGENCE ====================

  private movingAverageConvergence(series: TimeSeriesPoint[]): DetectionMethodResult | null {
    const values = series.map(s => s.value);

    const ema7 = this.calculateEMA(values, 7);
    const ema14 = this.calculateEMA(values, 14);
    const ema30 = this.calculateEMA(values, 30);

    if (ema7.length < 5 || ema30.length < 5) return null;

    const shortTerm = ema7.slice(-5);
    const mediumTerm = ema14.slice(-5);
    const longTerm = ema30.slice(-5);

    const shortGrowth = shortTerm[0] !== 0 ? (shortTerm[4] - shortTerm[0]) / Math.abs(shortTerm[0]) : 0;
    const mediumGrowth = mediumTerm[0] !== 0 ? (mediumTerm[4] - mediumTerm[0]) / Math.abs(mediumTerm[0]) : 0;
    const longGrowth = longTerm[0] !== 0 ? (longTerm[4] - longTerm[0]) / Math.abs(longTerm[0]) : 0;

    const growthRates = [shortGrowth, mediumGrowth, longGrowth];
    const avgGrowth = mean(growthRates);

    // Variance of the three constituent growth rates — higher disagreement → higher variance → lower weight
    const emaVariance = sampleVariance(growthRates);

    const agreement = growthRates.every(g => g > 0) || growthRates.every(g => g < 0);
    const confidence = Math.min(Math.max(agreement ? 0.9 - Math.min(emaVariance * 10, 0.4) : 0.5, 0), 1);

    const periodsPerYear = 365 / 14;
    const annualizedGrowth = Math.pow(1 + mediumGrowth, periodsPerYear) - 1;

    return {
      method: 'ema_convergence',
      growthRate: annualizedGrowth,
      variance: emaVariance,
      confidence,
      direction: avgGrowth > 0.01 ? 'up' : avgGrowth < -0.01 ? 'down' : 'flat',
      pValue: Math.min(1 - confidence, 1),
      rSquared: Math.max(1 - emaVariance, 0),
      sampleSize: series.length,
      metadata: {
        shortTermGrowth: shortGrowth,
        mediumTermGrowth: mediumGrowth,
        longTermGrowth: longGrowth,
        emaVariance
      }
    };
  }

  // ==================== DETECTION METHOD 3: SEASONAL DECOMPOSITION ====================

  private seasonalDecompositionMethod(series: TimeSeriesPoint[]): DetectionMethodResult | null {
    const weeklyData = this.aggregateToWeekly(series);
    if (weeklyData.length < 4) return null;

    const values = weeklyData.map(w => w.value);
    const trend = this.centeredMovingAverage(values, 4);
    const detrended = values.map((v, i) => trend[i] != null ? v - trend[i]! : 0).filter(v => !isNaN(v));

    if (detrended.length < 4) return null;

    const totalVariance = this.populationVariance(values);
    const seasonalStrength = totalVariance > 0
      ? this.populationVariance(detrended) / totalVariance
      : 0;

    const validTrend = trend.filter((v): v is number => v != null && !isNaN(v) && v !== 0);
    if (validTrend.length < 2) return null;

    const trendGrowth = (validTrend[validTrend.length - 1] - validTrend[0]) / Math.abs(validTrend[0]);
    const periodsPerYear = 52 / validTrend.length;
    const annualizedGrowth = Math.pow(1 + trendGrowth, periodsPerYear) - 1;

    // Variance: higher seasonal noise and fewer trend points → more uncertain estimate
    const variance = (seasonalStrength + 0.01) * (1 / validTrend.length);

    const confidence = Math.min(Math.max(1 - seasonalStrength, 0.6), 1);

    return {
      method: 'seasonal_decomposition',
      growthRate: annualizedGrowth,
      variance,
      confidence,
      direction: annualizedGrowth > 0.02 ? 'up' : annualizedGrowth < -0.02 ? 'down' : 'flat',
      pValue: Math.min(seasonalStrength, 1),
      rSquared: Math.max(1 - seasonalStrength, 0),
      sampleSize: weeklyData.length,
      metadata: {
        seasonalStrength,
        trendPoints: validTrend.length,
        weeklyVariance: totalVariance
      }
    };
  }

  // ==================== DETECTION METHOD 4: CHANGE POINT DETECTION (CUSUM) ====================

  private changePointDetection(series: TimeSeriesPoint[]): DetectionMethodResult | null {
    const values = series.map(s => s.value);
    const seriesMean = mean(values);
    const stdDev = Math.sqrt(this.populationVariance(values));

    if (stdDev === 0) return null;

    const standardized = values.map(v => (v - seriesMean) / stdDev);

    let cusumPos = 0;
    let cusumNeg = 0;
    const k = 0.5;
    const h = 4;

    let changePointIndex = -1;
    let maxDeviation = 0;

    for (let i = 0; i < standardized.length; i++) {
      cusumPos = Math.max(0, cusumPos + standardized[i] - k);
      cusumNeg = Math.max(0, cusumNeg - standardized[i] - k);

      if (cusumPos > h || cusumNeg > h) {
        changePointIndex = i;
        maxDeviation = Math.max(cusumPos, cusumNeg);
        break;
      }
    }

    if (changePointIndex === -1 || changePointIndex < 5) return null;

    const before = values.slice(0, changePointIndex);
    const after = values.slice(changePointIndex);

    const beforeTrend = this.calculateSimpleTrend(before);
    const afterTrend = this.calculateSimpleTrend(after);
    const acceleration = afterTrend - beforeTrend;

    const afterLen = Math.max(after.length, 1);
    const annualizedGrowth = afterTrend * (365 / afterLen);

    // Variance: uncertainty of the post-change mean
    const postChangeVariance = this.populationVariance(after);
    const variance = postChangeVariance / afterLen;

    const meanSq = seriesMean !== 0 ? Math.pow(seriesMean, 2) : 1;
    const confidence = Math.min(0.95, Math.max(
      maxDeviation / h * (1 - postChangeVariance / meanSq),
      0
    ));

    return {
      method: 'change_point_cusum',
      growthRate: annualizedGrowth,
      variance,
      confidence,
      direction: annualizedGrowth > 0.02 ? 'up' : annualizedGrowth < -0.02 ? 'down' : 'flat',
      pValue: Math.min(1 / Math.max(maxDeviation, 1e-10), 1),
      rSquared: 0.7, // CUSUM doesn't produce R²
      sampleSize: series.length,
      metadata: {
        changePointIndex,
        beforeTrend,
        afterTrend,
        acceleration,
        maxCusumDeviation: maxDeviation
      }
    };
  }

  // ==================== DETECTION METHOD 5: VOLATILITY-ADJUSTED GROWTH ====================

  private volatilityAdjustedGrowth(series: TimeSeriesPoint[]): DetectionMethodResult | null {
    const values = series.map(s => s.value);

    const returns: number[] = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] !== 0) {
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
      }
    }

    if (returns.length < 10) return null;

    const meanReturn = mean(returns);
    const dailyVariance = sampleVariance(returns);   // sample variance (n-1 denominator)
    const volatility = Math.sqrt(dailyVariance);

    const riskAdjustedReturn = volatility > 0 ? meanReturn / volatility : 0;

    const annualizedGrowth = meanReturn * 365;
    const annualizedVolatility = volatility * Math.sqrt(365);

    // Variance of the annualized mean return: Var(365 * mean_return) = 365² * (dailyVariance / n)
    const variance = Math.pow(365, 2) * (dailyVariance / returns.length);

    const tStat = meanReturn / (volatility / Math.sqrt(returns.length));
    const confidence = Math.min(Math.max(Math.abs(tStat) / 3, 0), 0.95);

    return {
      method: 'volatility_adjusted',
      growthRate: annualizedGrowth,
      variance,
      confidence,
      direction: riskAdjustedReturn > 0.1 ? 'up' : riskAdjustedReturn < -0.1 ? 'down' : 'flat',
      pValue: Math.min(1 / (Math.abs(tStat) + 1), 1),
      rSquared: Math.max(1 - volatility / Math.abs(meanReturn + volatility + 1e-10), 0),
      sampleSize: series.length,
      metadata: {
        dailyVolatility: volatility,
        annualizedVolatility,
        sharpeRatio: riskAdjustedReturn,
        tStatistic: tStat
      }
    };
  }

  // ==================== DETECTION METHOD 6: STATISTICAL PROCESS CONTROL ====================

  private statisticalProcessControl(series: TimeSeriesPoint[]): DetectionMethodResult | null {
    const values = series.map(s => s.value);
    const splitPoint = Math.floor(values.length * 0.3);

    const baseline = values.slice(0, splitPoint);
    const observation = values.slice(splitPoint);

    if (baseline.length < 5 || observation.length < 5) return null;

    const baselineMean = mean(baseline);
    const baselineVariance = sampleVariance(baseline);
    const baselineStd = Math.sqrt(baselineVariance);

    const ucl = baselineMean + 3 * baselineStd;
    const lcl = Math.max(0, baselineMean - 3 * baselineStd);

    const breaches = observation.filter(v => v > ucl || v < lcl).length;
    const breachRate = breaches / observation.length;

    const obsTrend = this.calculateSimpleTrend(observation);
    const annualizedGrowth = obsTrend * (365 / Math.max(observation.length, 1));

    // Variance: uncertainty of the baseline mean determines sensitivity of control limits
    const variance = baselineVariance / baseline.length;

    const confidence = Math.min(Math.max(breachRate * 2, 0), 0.9);

    return {
      method: 'statistical_process_control',
      growthRate: annualizedGrowth,
      variance,
      confidence,
      direction: annualizedGrowth > 0.02 ? 'up' : annualizedGrowth < -0.02 ? 'down' : 'flat',
      pValue: Math.max(1 - breachRate, 0),
      rSquared: 0.6, // SPC doesn't produce R²
      sampleSize: series.length,
      metadata: {
        baselineMean,
        baselineStd,
        controlLimitUpper: ucl,
        controlLimitLower: lcl,
        breachRate,
        sustainedShift: breachRate > 0.3 ? 1 : 0
      }
    };
  }

  // ==================== ENSEMBLE: INVERSE VARIANCE WEIGHTING ====================

  private calculateEnsembleConsensus(methods: DetectionMethodResult[]): {
    growthRate: number;
    confidence: number;
    direction: 'up' | 'down' | 'flat';
    pValue: number;
  } {
    // Inverse variance weighting: methods with lower variance (more precise) contribute more.
    // This is strictly based on estimate precision, not R² — a high-R² method with high variance
    // (e.g., volatile_adjusted in a noisy series) is down-weighted relative to a lower-R² method
    // with tighter bounds (e.g., OLS on a clean series).
    const weights = methods.map(m => m.variance > 0 ? 1 / m.variance : 0);
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    if (totalWeight === 0) {
      // Fallback: equal weights if all variances are zero or undefined
      const n = methods.length;
      return {
        growthRate: mean(methods.map(m => m.growthRate)),
        confidence: mean(methods.map(m => m.confidence)),
        direction: 'flat',
        pValue: 1
      };
    }

    // Inverse-variance weighted growth rate
    const weightedGrowth = methods.reduce((sum, m, i) => sum + m.growthRate * weights[i], 0) / totalWeight;

    // Inverse-variance weighted confidence (precision-weighted average)
    const weightedConfidence = methods.reduce((sum, m, i) => sum + m.confidence * weights[i], 0) / totalWeight;

    // Direction by plurality vote among all methods
    const upVotes = methods.filter(m => m.direction === 'up').length;
    const downVotes = methods.filter(m => m.direction === 'down').length;
    const direction: 'up' | 'down' | 'flat' = upVotes > downVotes ? 'up'
      : downVotes > upVotes ? 'down' : 'flat';

    // Fisher's combined p-value for testing H0: no trend across all methods
    // χ² = -2 * Σ ln(p_i), df = 2k
    const chiSquare = -2 * methods.reduce((sum, m) => sum + Math.log(Math.max(m.pValue, 1e-10)), 0);
    const df = 2 * methods.length;
    const combinedPValue = this.chiSquarePValue(chiSquare, df);

    return {
      growthRate: weightedGrowth,
      confidence: Math.min(weightedConfidence, 1),
      direction,
      pValue: combinedPValue
    };
  }

  // ==================== VALIDATION ====================

  private validateTrend(trend: CompositeTrend): boolean {
    // Watch tier: volatile/noisy patterns are persisted for monitoring.
    // Only require a minimal method count — no growth floor or significance check.
    if (trend.opportunityTier === 'watch') {
      return trend.detectionMethods.length >= 3;
    }

    // Disrupted tier: negative growth driven by structural shifts.
    // Significance and consensus required, but no positive growth floor.
    if (trend.opportunityTier === 'disrupted') {
      if (!trend.statisticalSignificance) return false;
      if (trend.confidence < this.CONFIDENCE_THRESHOLD) return false;
      const agreeingMethods = trend.detectionMethods.filter(m => m.direction === trend.direction).length;
      return agreeingMethods >= 3;
    }

    // Positive tiers (mature → breakthrough): 5% growth floor, full statistical checks.
    if (trend.growthRate < this.TIER_MATURE) return false;
    if (!trend.statisticalSignificance) return false;
    if (trend.confidence < this.CONFIDENCE_THRESHOLD) return false;
    const agreeingMethods = trend.detectionMethods.filter(m => m.direction === trend.direction).length;
    return agreeingMethods >= 3;
  }

  /**
   * Classifies a detected trend into the six-tier opportunity taxonomy.
   * Watch tier takes precedence: volatile or low-confidence patterns are flagged
   * for monitoring regardless of growth magnitude to prevent false-positive
   * resource allocation.
   */
  private classifyOpportunityTier(
    growthRate: number,
    volatilityIndex: number,
    confidence: number
  ): OpportunityTier {
    // Volatile or low-confidence patterns cannot be reliably acted upon yet
    if (volatilityIndex > this.TIER_WATCH_VOLATILITY || confidence < this.CONFIDENCE_THRESHOLD) {
      return 'watch';
    }
    if (growthRate >= this.TIER_BREAKTHROUGH) return 'breakthrough';
    if (growthRate >= this.TIER_ACCELERATING) return 'accelerating';
    if (growthRate >= this.TIER_SUSTAINED)    return 'sustained';
    if (growthRate >= this.TIER_MATURE)       return 'mature';
    if (growthRate < 0)                       return 'disrupted';
    // 0–5% positive with stable signal: too weak to act on, monitor
    return 'watch';
  }

  // ==================== PREPROCESSING ====================

  private preprocessSeries(series: TimeSeriesPoint[]): TimeSeriesPoint[] {
    series.sort((a, b) => a.date.getTime() - b.date.getTime());

    const values = series.map(s => s.value);
    const q1 = this.quantile(values, 0.25);
    const q3 = this.quantile(values, 0.75);
    const iqr = q3 - q1;
    const lowerBound = q1 - 3 * iqr;
    const upperBound = q3 + 3 * iqr;

    const filtered = series.filter(s => s.value >= lowerBound && s.value <= upperBound);

    const nonZeroCount = filtered.filter(s => s.value > 0).length;
    if (nonZeroCount < filtered.length * this.MIN_NONZERO_RATIO) return [];

    return this.interpolateGaps(filtered);
  }

  private interpolateGaps(series: TimeSeriesPoint[]): TimeSeriesPoint[] {
    if (series.length < 2) return series;

    const result: TimeSeriesPoint[] = [series[0]];

    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const curr = series[i];
      const daysDiff = (curr.date.getTime() - prev.date.getTime()) / (1000 * 60 * 60 * 24);

      if (daysDiff > 2) {
        const stepValue = (curr.value - prev.value) / daysDiff;
        for (let d = 1; d < daysDiff; d++) {
          result.push({
            id: '',
            date: new Date(prev.date.getTime() + d * 24 * 60 * 60 * 1000),
            value: prev.value + stepValue * d,
            source: 'interpolated',
            countryCode: prev.countryCode,
            category: prev.category,
            rawData: null
          });
        }
      }

      result.push(curr);
    }

    return result;
  }

  private detectAcceleration(series: TimeSeriesPoint[]): boolean {
    const mid = Math.floor(series.length / 2);
    const firstHalf = series.slice(0, mid);
    const secondHalf = series.slice(mid);

    const firstGrowth = this.calculateSimpleTrend(firstHalf.map(s => s.value));
    const secondGrowth = this.calculateSimpleTrend(secondHalf.map(s => s.value));

    return secondGrowth > firstGrowth * 1.5;
  }

  private calculateVolatility(series: TimeSeriesPoint[]): number {
    const values = series.map(s => s.value);
    const logReturns: number[] = [];

    for (let i = 1; i < values.length; i++) {
      if (values[i] > 0 && values[i - 1] > 0) {
        logReturns.push(Math.log(values[i] / values[i - 1]));
      }
    }

    if (logReturns.length < 2) return 0;
    return Math.sqrt(sampleVariance(logReturns)) * Math.sqrt(252); // Annualized
  }

  private measureSeasonality(series: TimeSeriesPoint[]): number {
    const byDayOfWeek = new Map<number, number[]>();

    for (const point of series) {
      const day = point.date.getDay();
      if (!byDayOfWeek.has(day)) byDayOfWeek.set(day, []);
      byDayOfWeek.get(day)!.push(point.value);
    }

    if (byDayOfWeek.size < 2) return 0;

    const dayMeans = Array.from(byDayOfWeek.values()).map(vals =>
      vals.reduce((a, b) => a + b, 0) / vals.length
    );

    const allVariance = this.populationVariance(series.map(s => s.value));
    return allVariance > 0 ? this.populationVariance(dayMeans) / allVariance : 0;
  }

  // ==================== DISTRIBUTION FUNCTIONS (jStat — exact, not approximations) ====================

  /**
   * Two-tailed p-value from t-distribution.
   * Uses jStat.studentt.cdf which implements the exact t-distribution CDF via
   * regularized incomplete beta function — accurate for all df, including small samples
   * where the normal approximation (df > 30 threshold) fails materially.
   */
  private tTestPValue(t: number, df: number): number {
    if (df < 1) return 1;
    const cdf = jStat.studentt.cdf(Math.abs(t), df);
    return Math.min(2 * (1 - cdf), 1);
  }

  /**
   * Right-tail p-value from chi-square distribution (Fisher's combined test).
   * Uses jStat.chisquare.cdf — exact CDF via regularized incomplete gamma function.
   * P(X > chiSquare | df) = 1 - CDF(chiSquare, df)
   */
  private chiSquarePValue(chiSquare: number, df: number): number {
    if (chiSquare <= 0 || df < 1) return 1;
    const cdf = jStat.chisquare.cdf(chiSquare, df);
    return Math.max(1 - cdf, 0);
  }

  // ==================== MATHEMATICAL UTILITIES ====================

  private calculateEMA(values: number[], period: number): number[] {
    if (values.length === 0) return [];
    const k = 2 / (period + 1);
    const ema: number[] = [values[0]];

    for (let i = 1; i < values.length; i++) {
      ema.push(values[i] * k + ema[i - 1] * (1 - k));
    }

    return ema;
  }

  private centeredMovingAverage(values: number[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    const halfPeriod = Math.floor(period / 2);

    for (let i = halfPeriod; i < values.length - halfPeriod; i++) {
      const window = values.slice(i - halfPeriod, i + halfPeriod + 1);
      result[i] = mean(window);
    }

    return result;
  }

  private calculateSimpleTrend(values: number[]): number {
    if (values.length < 2) return 0;
    const first = values[0];
    if (first === 0) return 0;
    return (values[values.length - 1] - first) / Math.abs(first) / values.length;
  }

  private calculateRSquared(actual: number[], predicted: number[]): number {
    const mu = mean(actual);
    const ssTotal = actual.reduce((sum, y) => sum + Math.pow(y - mu, 2), 0);
    if (ssTotal === 0) return 1;
    const ssResidual = actual.reduce((sum, y, i) => sum + Math.pow(y - predicted[i], 2), 0);
    return Math.max(1 - ssResidual / ssTotal, 0);
  }

  /** Population variance (divide by n) — for internal signal analysis. */
  private populationVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mu = mean(values);
    return values.reduce((sum, v) => sum + Math.pow(v - mu, 2), 0) / values.length;
  }

  private quantile(values: number[], q: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;

    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  }

  private aggregateToWeekly(series: TimeSeriesPoint[]): Array<{ week: number; value: number }> {
    const byWeek = new Map<number, number[]>();

    for (const point of series) {
      const week = this.getWeekNumber(point.date);
      if (!byWeek.has(week)) byWeek.set(week, []);
      byWeek.get(week)!.push(point.value);
    }

    return Array.from(byWeek.entries())
      .map(([week, values]) => ({ week, value: mean(values) }))
      .sort((a, b) => a.week - b.week);
  }

  private getWeekNumber(date: Date): number {
    const start = new Date(date.getFullYear(), 0, 1);
    return Math.floor((date.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
  }

  async persistTrend(trend: CompositeTrend): Promise<void> {
    await db.insert(trends).values({
      id: trend.id,
      category: trend.category,
      countryCode: trend.countryCode,
      growthRate: trend.growthRate,
      opportunityTier: trend.opportunityTier,
      periodStart: trend.timePeriod.start,
      periodEnd: trend.timePeriod.end,
      confidence: trend.confidence,
      signalIds: trend.supportingSignalIds,
      detectionMethods: trend.detectionMethods.map(m => m.method),
      isAccelerating: trend.isAccelerating,
      volatilityIndex: trend.volatilityIndex,
      metadata: {
        methodDetails: trend.detectionMethods,
        seasonalityStrength: trend.seasonalityStrength,
        statisticalSignificance: trend.statisticalSignificance,
      },
      status: 'detected',
      createdAt: new Date()
    });
  }
}
