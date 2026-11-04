/**
 * Stacked bars over time. Built like the dashboard's ThroughputChart (HTML columns sized in
 * percent) rather than with a chart library: it scales to phone width without SVG text
 * distortion and uses the theme tokens directly. Numbers are reachable three ways: tooltip on
 * hover, arrow keys on the focused plot, and the table under "Show numbers".
 */

import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { niceCeil } from '@/features/dashboard/utils';
import type { UsageBucket } from '@/types/usage';
import { formatBucket, type Stack } from '../logic';
import styles from '../UsagePage.module.scss';

export interface ChartSeries {
  label: string;
  color: string;
}

interface StackedBarChartProps {
  title: string;
  stack: Stack;
  series: ChartSeries[];
  bucket: UsageBucket;
  format: (value: number) => string;
}

export function StackedBarChart({ title, stack, series, bucket, format }: StackedBarChartProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<number | null>(null);
  const { columns } = stack;
  const scaleMax = niceCeil(stack.max);
  const grand = columns.reduce((sum, column) => sum + column.total, 0);
  const xTicks = [...new Set([0, Math.floor((columns.length - 1) / 2), columns.length - 1])];
  const activeColumn = active === null ? null : columns[active];

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    setActive((current) =>
      Math.min(
        columns.length - 1,
        Math.max(0, (current ?? (step > 0 ? -1 : columns.length)) + step)
      )
    );
  };

  const summary = t('usage.chart_summary', {
    title,
    total: format(grand),
    count: columns.length,
    from: columns[0] ? formatBucket(columns[0].t, bucket) : '',
    to: columns.length ? formatBucket(columns[columns.length - 1].t, bucket) : '',
  });

  return (
    <figure className={styles.chart}>
      <figcaption className={styles.chartHead}>
        <h3 className={styles.chartTitle}>
          {title} <span className={styles.chartTotal}>{format(grand)}</span>
        </h3>
        <ul className={styles.legend}>
          {series.map((entry) => (
            <li key={entry.label} className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: entry.color }} aria-hidden />
              {entry.label}
            </li>
          ))}
        </ul>
      </figcaption>

      <div className={styles.plotRow}>
        <div className={styles.yAxis} aria-hidden="true">
          {[1, 0.5, 0].map((ratio) => (
            <span key={ratio} className={styles.yTick} style={{ top: `${(1 - ratio) * 100}%` }}>
              {format(scaleMax * ratio)}
            </span>
          ))}
        </div>
        <div className={styles.canvas}>
          {[1, 0.5, 0].map((ratio) => (
            <span
              key={ratio}
              className={styles.gridline}
              style={{ top: `${(1 - ratio) * 100}%` }}
              aria-hidden="true"
            />
          ))}
          <div
            className={styles.columns}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onMouseLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
          >
            {columns.map((column, index) => (
              <div
                key={column.t}
                className={`${styles.column} ${active === index ? styles.columnActive : ''}`}
                onMouseEnter={() => setActive(index)}
              >
                <div className={styles.stack}>
                  {/* Top segment first in the DOM so CSS can round only the data end. */}
                  {column.values
                    .map((value, slot) => ({ value, slot }))
                    .reverse()
                    .filter(({ value }) => value > 0)
                    .map(({ value, slot }) => (
                      <span
                        key={slot}
                        className={styles.segment}
                        style={{
                          height: `${(value / scaleMax) * 100}%`,
                          background: series[slot]?.color,
                        }}
                      />
                    ))}
                  {column.total === 0 && <span className={styles.idleTick} />}
                </div>
              </div>
            ))}
          </div>
          {activeColumn && active !== null && (
            <div
              className={styles.tooltip}
              style={{
                left: `${((active + 0.5) / columns.length) * 100}%`,
                transform: `translateX(${
                  active < columns.length * 0.2 ? -10 : active > columns.length * 0.8 ? -90 : -50
                }%)`,
              }}
              aria-hidden="true"
            >
              <span className={styles.tooltipTime}>{formatBucket(activeColumn.t, bucket)}</span>
              {activeColumn.values.map((value, slot) =>
                value > 0 ? (
                  <span key={slot} className={styles.tooltipRow}>
                    <span
                      className={styles.swatch}
                      style={{ background: series[slot]?.color }}
                      aria-hidden
                    />
                    <span className={styles.tooltipLabel}>{series[slot]?.label}</span>
                    <b>{format(value)}</b>
                  </span>
                ) : null
              )}
              <span className={styles.tooltipRow}>
                <span className={styles.tooltipLabel}>{t('usage.total')}</span>
                <b>{format(activeColumn.total)}</b>
              </span>
            </div>
          )}
        </div>
      </div>
      <div className={styles.xAxis} aria-hidden="true">
        {xTicks.map((index) => (
          <span
            key={index}
            className={styles.xTick}
            style={
              index === 0
                ? { left: 0 }
                : index === columns.length - 1
                  ? { right: 0 }
                  : { left: `${((index + 0.5) / columns.length) * 100}%`, translate: '-50%' }
            }
          >
            {formatBucket(columns[index].t, bucket)}
          </span>
        ))}
      </div>

      <details className={styles.numbers}>
        <summary>{t('usage.show_numbers')}</summary>
        <div className={styles.tableScroll}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th scope="col">{t('usage.time_utc')}</th>
                {series.map((entry) => (
                  <th key={entry.label} scope="col">
                    {entry.label}
                  </th>
                ))}
                <th scope="col">{t('usage.total')}</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column.t}>
                  <th scope="row">{formatBucket(column.t, bucket)}</th>
                  {column.values.map((value, slot) => (
                    <td key={slot}>{format(value)}</td>
                  ))}
                  <td>{format(column.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
