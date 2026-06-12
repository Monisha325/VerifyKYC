'use client';

/**
 * ScoreGauge — semicircular arc gauge with risk-band zones.
 *
 * Band definitions (from spec):
 *   0–40   High Risk          (rose)
 *   41–65  Review Required    (amber)
 *   66–85  Low Risk           (brand blue)
 *   86–100 Clear              (emerald)
 */

const CX  = 100;  // SVG centre X
const CY  = 96;   // SVG centre Y (pushed down so text fits above)
const R   = 68;   // arc radius
const SW  = 14;   // stroke width of arc track

// Band table: [start%, end%, stroke-color, label, label-color]
const BANDS: [number, number, string, string, string][] = [
  [0,  40,  '#f43f5e', 'High Risk',        '#f43f5e'],
  [40, 65,  '#f59e0b', 'Review Required',  '#d97706'],
  [65, 85,  '#2874A6', 'Low Risk',         '#2874A6'],
  [85, 100, '#10b981', 'Clear',            '#059669'],
];

// Boundary tick marks
const TICKS = [0, 40, 65, 85, 100];

function toXY(score: number, r = R): { x: number; y: number } {
  const a = Math.PI * (1 - score / 100);
  return {
    x: +(CX + r * Math.cos(a)).toFixed(2),
    y: +(CY - r * Math.sin(a)).toFixed(2),
  };
}

function arcPath(s1: number, s2: number, r = R): string {
  const p1 = toXY(s1, r);
  const p2 = toXY(s2, r);
  const large = s2 - s1 > 50 ? 1 : 0;
  return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${large} 1 ${p2.x} ${p2.y}`;
}

function bandColor(score: number | null): string {
  if (score == null) return '#9ca3af';
  if (score >= 86) return '#10b981';
  if (score >= 66) return '#2874A6';
  if (score >= 41) return '#f59e0b';
  return '#f43f5e';
}

function bandLabel(score: number | null): string {
  if (score == null) return '—';
  if (score >= 86) return 'Clear';
  if (score >= 66) return 'Low Risk';
  if (score >= 41) return 'Review Required';
  return 'High Risk';
}

interface ScoreGaugeProps {
  score:     number | null;
  className?: string;
}

export default function ScoreGauge({ score, className }: ScoreGaugeProps) {
  const safeScore = score ?? 0;
  const color     = bandColor(score);
  const label     = bandLabel(score);

  // Needle tip and base
  const tip  = toXY(safeScore, R - 4);
  const base = toXY(safeScore, 20);

  // Perpendicular offsets for needle width at base
  const a   = Math.PI * (1 - safeScore / 100);
  const nx  = +( Math.sin(a) * 3).toFixed(2);
  const ny  = +( Math.cos(a) * 3).toFixed(2);

  return (
    <div className={className}>
      <svg viewBox="0 0 200 112" className="w-full max-w-[200px] mx-auto" aria-label={`Score ${score ?? 'unknown'}`}>

        {/* ── Grey background arc ── */}
        <path
          d={arcPath(0, 100)}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={SW}
          strokeLinecap="round"
        />

        {/* ── Coloured band arcs ── */}
        {BANDS.map(([s1, s2, color]) => (
          <path
            key={s1}
            d={arcPath(s1, s2)}
            fill="none"
            stroke={color}
            strokeWidth={SW}
            opacity={0.22}
          />
        ))}

        {/* ── Filled arc up to current score ── */}
        {score != null && score > 0 && (
          <path
            d={arcPath(0, Math.max(0, Math.min(100, safeScore)))}
            fill="none"
            stroke={color}
            strokeWidth={SW}
            strokeLinecap="round"
          />
        )}

        {/* ── Tick marks at band boundaries ── */}
        {TICKS.map(s => {
          const outer = toXY(s, R + 6);
          const inner = toXY(s, R - SW / 2 - 1);
          return (
            <line
              key={s}
              x1={inner.x} y1={inner.y}
              x2={outer.x} y2={outer.y}
              stroke="#d1d5db"
              strokeWidth={1.5}
            />
          );
        })}

        {/* ── Tick labels ── */}
        {TICKS.map(s => {
          const p = toXY(s, R + 14);
          return (
            <text key={s}
              x={p.x} y={p.y}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={6} fill="#9ca3af" fontFamily="Inter,system-ui,sans-serif"
            >
              {s}
            </text>
          );
        })}

        {/* ── Needle ── */}
        {score != null && (
          <>
            {/* needle body */}
            <polygon
              points={`${tip.x},${tip.y} ${base.x - nx},${base.y - ny} ${base.x + nx},${base.y + ny}`}
              fill={color}
            />
            {/* hub */}
            <circle cx={CX} cy={CY} r={5} fill={color} />
            <circle cx={CX} cy={CY} r={3} fill="white" />
          </>
        )}

        {/* ── Score value ── */}
        <text
          x={CX} y={CY - 16}
          textAnchor="middle" dominantBaseline="middle"
          fontSize={26} fontWeight={700} fill={color}
          fontFamily='"IBM Plex Mono",ui-monospace,monospace'
        >
          {score ?? '—'}
        </text>

        {/* ── Band label ── */}
        <text
          x={CX} y={CY + 4}
          textAnchor="middle" dominantBaseline="middle"
          fontSize={7.5} fill={color}
          fontFamily="Inter,system-ui,sans-serif"
          fontWeight={600}
          letterSpacing={0.5}
        >
          {label.toUpperCase()}
        </text>

      </svg>
    </div>
  );
}
