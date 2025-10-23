// Exact solution colors (your spec)
const SOLUTION_COLORS = {
  b2g: "rgb(15, 192, 216)",  // Battery to Grid
  pv2g: "rgb(247, 171, 62)",  // Solar to Grid
  pv2b: "rgb(139, 201, 100)", // Solar to Battery
  pv2l: "rgb(212, 222, 95)",  // Solar to Consumption
  b2l: "rgb(71, 144, 208)",  // Battery to Consumption
  g2l: "rgb(233, 122, 131)", // Grid to Consumption
  g2b: "rgb(225, 142, 233)", // Grid to Battery
  soc: "#334155"             // SoC line (slate-700)
};

const toRGBA = (rgb, alpha = 1) => {
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgb);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : rgb;
};
const dim = (rgb) => toRGBA(rgb, 0.6); // dimmer on hover

// Common legend style: small square patches everywhere
const legendSquare = {
  position: "bottom",
  labels: {
    usePointStyle: true,
    pointStyle: "rect",
    boxWidth: 10,
    padding: 12,
    font: (ctx) => ({ size: 12, family: getComputedStyle(document.documentElement).fontFamily })
  }
};

export function drawFlowsBarStackSigned(canvas, rows, stepSize_m = 15) {
  const labels = rows.map(r => r.t);
  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;
  const neg = (x) => -Math.abs(W2kWh(x));
  const pos = (x) => +Math.abs(W2kWh(x));
  const stackId = "flows";

  const datasets = [
    dsBar("Solar to Consumption", rows.map(r => pos(r.pv2l)), SOLUTION_COLORS.pv2l, stackId),
    dsBar("Solar to Battery", rows.map(r => pos(r.pv2b)), SOLUTION_COLORS.pv2b, stackId),
    dsBar("Solar to Grid", rows.map(r => pos(r.pv2g)), SOLUTION_COLORS.pv2g, stackId),
    dsBar("Battery to Grid", rows.map(r => pos(r.b2g)), SOLUTION_COLORS.b2g, stackId),

    dsBar("Battery to Consumption", rows.map(r => neg(r.b2l)), SOLUTION_COLORS.b2l, stackId),
    dsBar("Grid to Consumption", rows.map(r => neg(r.g2l)), SOLUTION_COLORS.g2l, stackId),
    dsBar("Grid to Battery", rows.map(r => neg(r.g2b)), SOLUTION_COLORS.g2b, stackId),
  ];

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: legendSquare },
      scales: {
        x: { stacked: true, title: { display: true, text: "Time slot" } },
        y: { stacked: true, title: { display: true, text: "kWh" } }
      }
    }
  });
}

export function drawSocChart(canvas, rows, batteryCapacity_Wh = 20480) {
  const labels = rows.map(r => r.t);
  const cap = Math.max(1e-9, Number(batteryCapacity_Wh));
  const socPct = rows.map(r => (r.soc / cap) * 100);

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets: [{ label: "SoC (%)", data: socPct }] },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Time slot" } },
        y: { beginAtZero: true, max: 100, title: { display: true, text: "%" } }
      }
    }
  });
}


// helpers from earlier in the file:
function dsBar(label, data, color, stack) {
  return {
    label, data, stack, type: "bar",
    backgroundColor: color,
    hoverBackgroundColor: toRGBA(color, 0.6), // dim on hover
    borderColor: color, borderWidth: 0.5,
  };
}


// 2) Prices step lines (Buy/Sell) — unchanged from previous patch
export function drawPricesStepLines(canvas, rows) {
  const labels = rows.map(r => r.t);
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Buy price", data: rows.map(r => r.ic), stepped: true, borderColor: "#ef4444", pointRadius: 0, pointHitRadius: 8 },
        { label: "Sell price", data: rows.map(r => r.ec), stepped: true, borderColor: "#22c55e", pointRadius: 0, pointHitRadius: 8 }
      ]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { usePointStyle: true, pointStyle: "rect", boxWidth: 10, padding: 12 } } },
      scales: {
        x: { title: { display: true, text: "Time slot" } },
        y: { beginAtZero: true, title: { display: true, text: "c€/kWh" } }
      }
    }
  });
}


// 3) Forecast grouped bars in kWh with stripes (unchanged except axis label)
export function drawLoadPvGrouped(canvas, rows, stepSize_m = 15) {
  const labels = rows.map(r => r.t);
  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;

  const red = SOLUTION_COLORS.g2l;  // consumption
  const amber = SOLUTION_COLORS.pv2g; // solar
  const stripe = (color) => window.pattern?.draw("diagonal", color) || color;

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Consumption forecast",
          data: rows.map(r => W2kWh(r.load)),
          backgroundColor: stripe(red),
          borderColor: red,
          borderWidth: 1,
          hoverBackgroundColor: stripe(dim(red)),
        },
        {
          label: "Solar forecast",
          data: rows.map(r => W2kWh(r.pv)),
          backgroundColor: stripe(amber),
          borderColor: amber,
          borderWidth: 1,
          hoverBackgroundColor: stripe(dim(amber)),
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: legendSquare },
      scales: {
        x: { stacked: false, title: { display: true, text: "Time slot" } },
        y: { beginAtZero: true, title: { display: true, text: "kWh" } }
      }
    }
  });
}
