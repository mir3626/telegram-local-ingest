export interface SubFieldCoverage {
  value: string;
  confidence: number;
  deferred: boolean;
}

export interface DimensionCoverage {
  ratio: number;
  subFields: Record<string, SubFieldCoverage>;
}

export interface DimensionSpec {
  id: string;
  label: string;
  weight: number;
  subFields: string[];
  required: boolean;
}

const REQUIRED_SOFT_TERMINATE_RATIO = 0.8;

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

export function subFieldCoverageValue(sf: SubFieldCoverage): number {
  return sf.deferred ? 0 : clampConfidence(sf.confidence);
}

export function dimensionCoverageRatio(spec: DimensionSpec, cov: DimensionCoverage): number {
  if (spec.subFields.length === 0) {
    const freeForm = cov.subFields.free_form;
    if (!freeForm || freeForm.deferred || freeForm.value.trim() === '') {
      return 0;
    }

    return 1;
  }

  const total = spec.subFields.reduce((sum, subFieldId) => {
    const subField = cov.subFields[subFieldId];
    return sum + (subField ? subFieldCoverageValue(subField) : 0);
  }, 0);

  return total / spec.subFields.length;
}

export function computeAmbiguity(
  specs: DimensionSpec[],
  coverage: Record<string, DimensionCoverage>,
): number {
  const totalWeight = specs.reduce((sum, spec) => sum + spec.weight, 0);
  if (totalWeight <= 0) {
    return 1;
  }

  const weightedCoverage = specs.reduce((sum, spec) => {
    const dimensionCoverage = coverage[spec.id] ?? { ratio: 0, subFields: {} };
    return sum + spec.weight * dimensionCoverageRatio(spec, dimensionCoverage);
  }, 0);

  return 1 - weightedCoverage / totalWeight;
}

function sortByCoverageThenWeight(
  specs: DimensionSpec[],
  coverage: Record<string, DimensionCoverage>,
): DimensionSpec[] {
  return [...specs].sort((left, right) => {
    const leftRatio = dimensionCoverageRatio(left, coverage[left.id] ?? { ratio: 0, subFields: {} });
    const rightRatio = dimensionCoverageRatio(right, coverage[right.id] ?? { ratio: 0, subFields: {} });

    if (leftRatio !== rightRatio) {
      return leftRatio - rightRatio;
    }

    if (left.weight !== right.weight) {
      return right.weight - left.weight;
    }

    return left.id.localeCompare(right.id);
  });
}

function sortByWeightThenCoverage(
  specs: DimensionSpec[],
  coverage: Record<string, DimensionCoverage>,
): DimensionSpec[] {
  return [...specs].sort((left, right) => {
    if (left.weight !== right.weight) {
      return right.weight - left.weight;
    }

    const leftRatio = dimensionCoverageRatio(left, coverage[left.id] ?? { ratio: 0, subFields: {} });
    const rightRatio = dimensionCoverageRatio(right, coverage[right.id] ?? { ratio: 0, subFields: {} });
    if (leftRatio !== rightRatio) {
      return leftRatio - rightRatio;
    }

    return left.id.localeCompare(right.id);
  });
}

export function selectNextDimension(
  specs: DimensionSpec[],
  coverage: Record<string, DimensionCoverage>,
  recentDimensionIds: string[],
  options: { thrashWindow?: number } = {},
): string {
  const thrashWindow = options.thrashWindow ?? 3;
  const recent = new Set(recentDimensionIds.slice(-thrashWindow));
  const requiredCandidates = sortByCoverageThenWeight(
    specs.filter((spec) => spec.required),
    coverage,
  );
  const pendingRequired = requiredCandidates.filter((spec) => {
    const ratio = dimensionCoverageRatio(spec, coverage[spec.id] ?? { ratio: 0, subFields: {} });
    return ratio < 0.5;
  });
  const pool =
    pendingRequired.length > 0
      ? pendingRequired
      : sortByWeightThenCoverage(
          specs.filter((spec) => {
            const ratio = dimensionCoverageRatio(spec, coverage[spec.id] ?? { ratio: 0, subFields: {} });
            return ratio < 0.5;
          }),
          coverage,
        );

  if (pool.length === 0) {
    return sortByCoverageThenWeight(specs, coverage)[0]?.id ?? specs[0]?.id ?? '';
  }

  const preferred = pool[0];
  if (preferred && !recent.has(preferred.id)) {
    return preferred.id;
  }

  const nonRecent = pool.find((spec) => !recent.has(spec.id));
  return nonRecent?.id ?? preferred?.id ?? specs[0]?.id ?? '';
}

export function shouldTerminate(
  ambiguity: number,
  round: number,
  maxRounds: number,
  specs: DimensionSpec[],
  coverage: Record<string, DimensionCoverage>,
): { terminate: boolean; reason: 'ambiguity' | 'max-rounds' | 'soft-terminate' | null } {
  if (round > maxRounds) {
    return { terminate: true, reason: 'max-rounds' };
  }

  if (ambiguity <= 0.2) {
    return { terminate: true, reason: 'ambiguity' };
  }

  const allRequiredCovered = specs
    .filter((spec) => spec.required)
    .every((spec) => {
      const ratio = dimensionCoverageRatio(spec, coverage[spec.id] ?? { ratio: 0, subFields: {} });
      return ratio >= REQUIRED_SOFT_TERMINATE_RATIO;
    });

  if (allRequiredCovered && ambiguity <= 0.3) {
    return { terminate: true, reason: 'soft-terminate' };
  }

  return { terminate: false, reason: null };
}
