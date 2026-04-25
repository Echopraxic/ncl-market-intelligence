// src/agents/signals/trend-detection/trend-validator.ts
import { CompositeTrend } from './statistical-trend-engine.js';

export interface ValidationResult {
  trend: CompositeTrend;
  status: 'auto_approved' | 'manual_review' | 'rejected';
  reasons: string[];
  riskFactors: string[];
}

export class TrendValidator {
  private readonly HIGH_VOLATILITY_THRESHOLD = 0.5;   // 50% annualized volatility
  private readonly LOW_SAMPLE_THRESHOLD = 20;         // Less than 20 data points
  private readonly CONFLICTING_SIGNALS_THRESHOLD = 3; // Methods disagreeing
  private readonly EXTREME_GROWTH_THRESHOLD = 2.0;    // 200%+ annualised triggers suspicion flag

  validate(trend: CompositeTrend): ValidationResult {
    const riskFactors: string[] = [];
    const reasons: string[] = [];

    // Check 1: Volatility assessment
    if (trend.volatilityIndex > this.HIGH_VOLATILITY_THRESHOLD) {
      riskFactors.push(`High volatility (${(trend.volatilityIndex * 100).toFixed(1)}%) indicates unstable trend`);
    }

    // Check 2: Sample sufficiency
    const avgSampleSize = trend.detectionMethods.reduce((sum, m) => sum + m.sampleSize, 0) 
      / trend.detectionMethods.length;
    if (avgSampleSize < this.LOW_SAMPLE_THRESHOLD) {
      riskFactors.push(`Insufficient data points (${avgSampleSize.toFixed(0)} < ${this.LOW_SAMPLE_THRESHOLD})`);
    }

    // Check 3: Method consensus
    const directions = trend.detectionMethods.map(m => m.direction);
    const uniqueDirections = new Set(directions);
    if (uniqueDirections.size > 1) {
      const disagreements = trend.detectionMethods.length - Math.max(
        ...Array.from(uniqueDirections).map(d => directions.filter(x => x === d).length)
      );
      if (disagreements > this.CONFLICTING_SIGNALS_THRESHOLD) {
        riskFactors.push(`Significant method disagreement (${disagreements} methods divergent)`);
      }
    }

    // Check 4: Seasonality interference
    if (trend.seasonalityStrength > 0.3) {
      riskFactors.push(`Strong seasonal component (${(trend.seasonalityStrength * 100).toFixed(1)}%) may obscure true trend`);
    }

    // Check 5: Acceleration without foundation
    if (trend.isAccelerating && trend.confidence < 0.9) {
      riskFactors.push('Acceleration detected but confidence insufficient for auto-approval');
    }

    // Check 6: Extreme growth rate — >200% annualised almost always means zero-start normalisation
    // artifact (e.g. Google Trends flat-zero baseline followed by any non-zero signal)
    if (Math.abs(trend.growthRate) > this.EXTREME_GROWTH_THRESHOLD) {
      riskFactors.push(
        `Extreme growth rate (${(trend.growthRate * 100).toFixed(0)}%) likely reflects zero-start normalisation artifact, not real demand`
      );
    }

    // Check 7: Sparse baseline — first third of the window lacked sufficient non-zero data,
    // meaning there is no reliable comparison period to measure growth against
    if (trend.sparseBaseline) {
      riskFactors.push('Baseline period (first 30 days) had insufficient non-zero signal density — growth rate unreliable');
    }

    // Check 8: Recency bias — CUSUM change point fired in the final 30% of the series,
    // meaning the shift is too recent to distinguish a new trend from a transient event
    if (trend.hasRecencyBias) {
      riskFactors.push('Structural shift detected only in final 30% of observation window — too recent to confirm as sustained trend');
    }

    // Determine status
    let status: 'auto_approved' | 'manual_review' | 'rejected';
    
    if (riskFactors.length === 0 && trend.confidence > 0.9 && trend.statisticalSignificance) {
      status = 'auto_approved';
      reasons.push('All statistical checks passed with high confidence');
    } else if (riskFactors.length > 2 || trend.confidence < 0.7) {
      status = 'rejected';
      reasons.push('Too many risk factors or insufficient confidence');
    } else {
      status = 'manual_review';
      reasons.push('Borderline case requiring human judgment');
    }

    return { trend, status, reasons, riskFactors };
  }

  generateReviewPrompt(validation: ValidationResult): string {
    const { trend, riskFactors } = validation;
    
    return `
TREND REQUIRING MANUAL VALIDATION
==================================
Category: ${trend.category}
Country: ${trend.countryCode}
Detected Growth: ${(trend.growthRate * 100).toFixed(2)}% annualized
Confidence: ${(trend.confidence * 100).toFixed(1)}%
Direction: ${trend.direction}
Accelerating: ${trend.isAccelerating ? 'Yes' : 'No'}

Method Breakdown:
${trend.detectionMethods.map(m => 
  `  - ${m.method}: ${(m.growthRate * 100).toFixed(2)}% (R²=${m.rSquared.toFixed(2)}, p=${m.pValue.toFixed(3)})`
).join('\n')}

Risk Factors:
${riskFactors.map(f => `  ⚠️  ${f}`).join('\n')}

Statistical Metrics:
  - Volatility Index: ${(trend.volatilityIndex * 100).toFixed(1)}%
  - Seasonality Strength: ${(trend.seasonalityStrength * 100).toFixed(1)}%
  - Sample Size: ${Math.round(trend.detectionMethods.reduce((a, m) => a + m.sampleSize, 0) / trend.detectionMethods.length)}

False-Positive Flags:
  - Sparse Baseline: ${trend.sparseBaseline ? '⚠️  YES — first 30 days had insufficient data' : '✅ No'}
  - Recency Bias:    ${trend.hasRecencyBias ? '⚠️  YES — structural shift only in final 30% of window' : '✅ No'}

ACTION REQUIRED: Approve, reject, or request additional data?
    `.trim();
  }
}