import { describe, expect, it } from 'vitest';
import * as charts from '../../app/src/charts.js';
import * as predictions from '../../app/src/predictions.js';

describe('browser module compatibility exports', () => {
  it('keeps the chart barrel exports used by existing UI modules', () => {
    expect(charts).toEqual(expect.objectContaining({
      SOLUTION_COLORS: expect.any(Object),
      aggregateLoadPvBuckets: expect.any(Function),
      buildTimeAxisFromTimestamps: expect.any(Function),
      drawEvPowerChart: expect.any(Function),
      drawEvSocChartTab: expect.any(Function),
      drawFlowsBarStackSigned: expect.any(Function),
      drawLoadPvGrouped: expect.any(Function),
      drawPricesStepLines: expect.any(Function),
      drawSocChart: expect.any(Function),
      fmtHHMM: expect.any(Function),
      getBaseOptions: expect.any(Function),
      getBuyPriceColor: expect.any(Function),
      getChartTheme: expect.any(Function),
      refreshAllChartThemes: expect.any(Function),
      renderChart: expect.any(Function),
      toRGBA: expect.any(Function),
    }));
  });

  it('keeps prediction coordinator and helper exports available', () => {
    expect(predictions).toEqual(expect.objectContaining({
      applyAdjustmentsToForecastSeries: expect.any(Function),
      buildForecastSelectionRange: expect.any(Function),
      forecastSeriesFromCategoryX: expect.any(Function),
      futureForecastSeries: expect.any(Function),
      initPredictionsTab: expect.any(Function),
    }));
  });
});
