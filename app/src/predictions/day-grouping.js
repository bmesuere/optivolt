// Compact labels for a predictor's day-grouping choice: which past days are averaged into the
// profile a forecast day uses. Shared by the predictor cards and the strategy-comparison table,
// where the raw values ("same", "all") read as opposites of what they mean.
export const DAY_GROUPING_SHORT = {
  same: 'per weekday',
  'weekday-weekend': 'week/weekend',
  'weekday-sat-sun': 'week/Sat/Sun',
  all: 'all days pooled',
};

/** @param {string} value */
export const dayGroupingLabel = (value) => DAY_GROUPING_SHORT[value] ?? value;
