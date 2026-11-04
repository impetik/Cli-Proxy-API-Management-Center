import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import type { UsageAggregateRow, UsageDimension } from '@/types/usage';
import { formatPercent } from '@/utils/format';
import {
  DIMENSIONS,
  OTHER_SERIES,
  TOKEN_TYPES,
  bucketStarts,
  failureRate,
  formatTokens,
  formatUsd,
  rankSeries,
  splitProviderGroup,
  stackByGroup,
  stackByTokenType,
  sumTotals,
  type UsageReportData,
} from '../logic';
import { Segmented } from './Segmented';
import { StackedBarChart, type ChartSeries } from './StackedBarChart';
import styles from '../UsagePage.module.scss';

const seriesColor = (slot: number) => `var(--viz-series-${slot + 1})`;
const OTHER_COLOR = 'var(--viz-series-other)';
const DASH = '—';

interface UsageReportProps {
  data: UsageReportData;
  onDimensionChange: (dimension: UsageDimension) => void;
}

export function UsageReport({ data, onDimensionChange }: UsageReportProps) {
  const { t } = useTranslation();
  const { bucket, dimension, meta } = data;

  const totals = useMemo(() => sumTotals(data.timeline), [data.timeline]);
  const starts = useMemo(() => bucketStarts(data.range, bucket), [data.range, bucket]);
  const ranked = useMemo(() => rankSeries(data.groupTotals), [data.groupTotals]);

  const groupLabel = (group: string) =>
    group === OTHER_SERIES ? t('usage.other') : group || t('usage.unknown');
  const groupSeries = (names: string[]): ChartSeries[] =>
    names.map((name, slot) => ({
      label: groupLabel(name),
      color: name === OTHER_SERIES ? OTHER_COLOR : seriesColor(slot),
    }));

  const costStack = useMemo(
    () => stackByGroup(data.byGroup, starts, ranked, (row) => row.listCostUsd),
    [data.byGroup, starts, ranked]
  );
  const tokenStack = useMemo(
    () => stackByGroup(data.byGroup, starts, ranked, (row) => row.totalTokens),
    [data.byGroup, starts, ranked]
  );
  const typeStack = useMemo(() => stackByTokenType(data.timeline, starts), [data.timeline, starts]);

  const rate = failureRate(totals);
  const tiles = [
    {
      key: 'requests',
      value: totals.requests.toLocaleString(),
      hint: t('usage.kpi_requests_hint'),
    },
    { key: 'tokens', value: formatTokens(totals.totalTokens), hint: t('usage.kpi_tokens_hint') },
    { key: 'list_cost', value: formatUsd(totals.listCostUsd), hint: t('usage.kpi_list_cost_hint') },
    {
      key: 'billed_cost',
      value: formatUsd(totals.billedCostUsd),
      hint: t('usage.kpi_billed_hint'),
    },
    {
      key: 'failure_rate',
      value: rate === null ? DASH : formatPercent(rate),
      hint: t('usage.kpi_failure_hint', { count: totals.failed }),
    },
  ];

  const dimensionSwitch = (
    <Segmented
      label={t('usage.stack_by')}
      value={dimension}
      options={DIMENSIONS.map((value) => ({ value, label: t(`usage.dimension_${value}`) }))}
      onChange={onDimensionChange}
    />
  );

  if (totals.requests === 0) {
    return (
      <EmptyState
        title={t('usage.empty_title')}
        description={
          meta?.firstTs
            ? t('usage.empty_history_starts', { date: meta.firstTs.slice(0, 10) })
            : t('usage.empty_no_history')
        }
      />
    );
  }

  const unpriced = meta?.pricing.unpricedModels ?? [];

  return (
    <>
      <section className={styles.kpis} aria-label={t('usage.kpi_section')}>
        {tiles.map((tile) => (
          <div key={tile.key} className={styles.kpi}>
            <span className={styles.kpiLabel}>{t(`usage.kpi_${tile.key}`)}</span>
            <span className={styles.kpiValue}>{tile.value}</span>
            <span className={styles.kpiHint}>{tile.hint}</span>
          </div>
        ))}
      </section>
      {unpriced.length > 0 && (
        <p className={styles.note}>{t('usage.unpriced_note', { models: unpriced.join(', ') })}</p>
      )}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('usage.over_time')}</h2>
          {dimensionSwitch}
        </div>
        <div className={styles.chartGrid}>
          <StackedBarChart
            title={t('usage.chart_cost')}
            stack={costStack}
            series={groupSeries(costStack.series)}
            bucket={bucket}
            format={formatUsd}
          />
          <StackedBarChart
            title={t('usage.chart_tokens')}
            stack={tokenStack}
            series={groupSeries(tokenStack.series)}
            bucket={bucket}
            format={formatTokens}
          />
        </div>
      </section>

      <section className={styles.card}>
        <StackedBarChart
          title={t('usage.chart_token_types')}
          stack={typeStack}
          series={TOKEN_TYPES.map((type, slot) => ({
            label: t(`usage.token_${type}`),
            color: seriesColor(slot),
          }))}
          bucket={bucket}
          format={formatTokens}
        />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            {t('usage.breakdown_title', { dimension: t(`usage.dimension_${dimension}`) })}
          </h2>
          {dimensionSwitch}
        </div>
        <BreakdownTable
          rows={data.groupTotals}
          ranked={ranked}
          dimension={dimension}
          groupLabel={groupLabel}
        />
      </section>
    </>
  );
}

interface BreakdownTableProps {
  rows: UsageAggregateRow[];
  ranked: string[];
  dimension: UsageDimension;
  groupLabel: (group: string) => string;
}

function BreakdownTable({ rows, ranked, dimension, groupLabel }: BreakdownTableProps) {
  const { t } = useTranslation();
  const slot = new Map(ranked.map((name, i) => [name, i]));
  const sorted = [...rows].sort(
    (a, b) => b.listCostUsd - a.listCostUsd || b.totalTokens - a.totalTokens
  );
  const maxCost = Math.max(0, ...sorted.map((row) => row.listCostUsd));

  const authLabel = (authType: string) =>
    authType === 'oauth'
      ? t('usage.auth_subscription')
      : authType === 'apikey'
        ? t('usage.auth_apikey')
        : authType;

  return (
    <div className={styles.tableScroll}>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            <th scope="col">{t(`usage.dimension_${dimension}`)}</th>
            <th scope="col">{t('usage.col_requests')}</th>
            <th scope="col">{t('usage.col_tokens')}</th>
            <th scope="col">{t('usage.col_list_cost')}</th>
            <th scope="col">{t('usage.col_billed_cost')}</th>
            <th scope="col">{t('usage.col_failure_rate')}</th>
            <th scope="col">{t('usage.col_latency')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const group = row.group ?? '';
            const index = slot.get(group);
            const provider = dimension === 'provider' ? splitProviderGroup(group) : null;
            const rate = failureRate(row);
            return (
              <tr key={group}>
                <th scope="row" className={styles.nameCell}>
                  <span
                    className={styles.swatch}
                    style={{ background: index === undefined ? OTHER_COLOR : seriesColor(index) }}
                    aria-hidden
                  />
                  <span className={styles.name}>
                    {provider ? provider.provider : groupLabel(group)}
                  </span>
                  {provider?.authType && (
                    <span className={styles.tag}>{authLabel(provider.authType)}</span>
                  )}
                </th>
                <td>{row.requests.toLocaleString()}</td>
                <td>{formatTokens(row.totalTokens)}</td>
                <td>
                  <span className={styles.barCell}>
                    <span
                      className={styles.bar}
                      style={{
                        width: `calc((100% - 64px) * ${maxCost > 0 ? row.listCostUsd / maxCost : 0})`,
                      }}
                      aria-hidden
                    />
                    {formatUsd(row.listCostUsd)}
                  </span>
                </td>
                <td>{formatUsd(row.billedCostUsd)}</td>
                <td>{rate === null ? DASH : formatPercent(rate)}</td>
                <td>{t('usage.ms', { value: Math.round(row.avgLatencyMs).toLocaleString() })}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
