// Minimal SVG bar chart for Launch27's [["Day","Sales"],["2026-10-01",123],...] series.
export function BarChart({ series, format = (n) => n.toLocaleString(), height = 160 }: { series?: [string, number | string][]; format?: (n: number) => string; height?: number }) {
  const points = (series || []).slice(1).map(([label, value]) => ({ label: String(label), value: Number(value) || 0 }));
  if (!points.length) return <div className="muted small">No data</div>;
  const max = Math.max(...points.map((p) => p.value), 1);
  const width = 100 / points.length;
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="bar-chart" style={{ height }} role="img">
      {points.map((p, i) => {
        const h = (p.value / max) * (height - 4);
        return (
          <rect key={p.label} x={i * width + width * 0.12} width={width * 0.76} y={height - h} height={h} className="bar">
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
