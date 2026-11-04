/**
 * Usage: who used what, how much, when, from where and at what cost. Reads the read-only usage
 * API (src/services/api/usage.ts); history starts when its collector started (2026-11-04).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usageApi, usageApiBase, type UsageConnection } from '@/services/api/usage';
import { useAuthStore } from '@/stores';
import type { UsageBucket, UsageDimension } from '@/types/usage';
import {
  RANGE_PRESETS,
  autoBucket,
  hourlyAllowed,
  resolveRange,
  type CustomDays,
  type RangePreset,
  type UsageReportData,
} from './logic';
import { RequestsTable, type RequestFilters } from './components/RequestsTable';
import { Segmented } from './components/Segmented';
import { UsageReport } from './components/UsageReport';
import { UsageStatus } from './components/UsageStatus';
import styles from './UsagePage.module.scss';

interface QueryState<T> {
  key: string | null;
  data: T | null;
  error: Error | null;
}

/**
 * Runs `run` whenever `key` changes and aborts the previous run, so a slow answer for an old
 * range or connection never overwrites a newer one. Data is returned only for the current key's
 * connection `scope`, so another connection's numbers never show while the new ones load.
 */
function useQuery<T>(key: string | null, scope: string, run: (signal: AbortSignal) => Promise<T>) {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  const [state, setState] = useState<QueryState<T> & { scope: string }>({
    key: null,
    scope,
    data: null,
    error: null,
  });

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    runRef.current(controller.signal).then(
      (data) => setState({ key, scope, data, error: null }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          key,
          scope,
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    );
    return () => controller.abort();
  }, [key, scope]);

  const sameScope = state.scope === scope;
  return {
    data: sameScope ? state.data : null,
    error: state.key === key ? state.error : null,
    loading: key !== null && state.key !== key,
  };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function UsagePage() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');

  const [preset, setPreset] = useState<RangePreset>('7d');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [custom, setCustom] = useState<CustomDays>(() => ({
    fromDate: isoDay(Date.now() - 6 * 86_400_000),
    toDate: isoDay(Date.now()),
  }));
  const [bucketChoice, setBucketChoice] = useState<UsageBucket | null>(null);
  const [dimension, setDimension] = useState<UsageDimension>('key');
  const [filters, setFilters] = useState<RequestFilters>({ key: '', model: '', client: '' });
  const [reload, setReload] = useState(0);

  const range = useMemo(() => resolveRange(preset, nowMs, custom), [preset, nowMs, custom]);
  const bucket: UsageBucket =
    range && (bucketChoice === 'day' || (bucketChoice === 'hour' && hourlyAllowed(range)))
      ? bucketChoice
      : range
        ? autoBucket(range)
        : 'day';

  const conn: UsageConnection = useMemo(
    () => ({ apiBase, managementKey }),
    [apiBase, managementKey]
  );
  const base = usageApiBase(apiBase);
  const scope = `${apiBase}\n${managementKey}`;
  const ready = connected && Boolean(base) && range !== null;

  const reportKey = ready ? JSON.stringify([range, bucket, dimension, reload]) : null;
  const report = useQuery<UsageReportData>(reportKey, scope, async (signal) => {
    const span = range!;
    const [meta, timeline, byGroup, groupTotals] = await Promise.all([
      usageApi.meta(conn, signal),
      usageApi.aggregate(conn, { ...span, group: 'none', bucket }, signal),
      usageApi.aggregate(conn, { ...span, group: dimension, bucket }, signal),
      usageApi.aggregate(conn, { ...span, group: dimension }, signal),
    ]);
    return {
      range: span,
      bucket,
      dimension,
      meta,
      timeline,
      byGroup,
      groupTotals,
    };
  });

  const requestsKey = ready ? JSON.stringify([range, filters, reload]) : null;
  const requests = useQuery(requestsKey, scope, (signal) =>
    usageApi.requests(conn, { ...range!, limit: 100, ...filters }, signal)
  );

  const refresh = useCallback(() => {
    setNowMs(Date.now());
    setReload((value) => value + 1);
  }, []);
  useHeaderRefresh(refresh, connected);

  const choosePreset = (next: RangePreset) => {
    setPreset(next);
    setBucketChoice(null);
    setNowMs(Date.now());
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('usage.title')}</h1>
          <p className={styles.subtitle}>{t('usage.subtitle')}</p>
        </div>
        <div className={styles.controls}>
          <Segmented
            label={t('usage.range')}
            value={preset}
            options={RANGE_PRESETS.map((value) => ({ value, label: t(`usage.range_${value}`) }))}
            onChange={choosePreset}
          />
          {preset === 'custom' && (
            <div className={styles.customRange}>
              <label className={styles.dateField}>
                <span>{t('usage.custom_from')}</span>
                <input
                  type="date"
                  value={custom.fromDate}
                  max={custom.toDate}
                  onChange={(event) => setCustom({ ...custom, fromDate: event.target.value })}
                />
              </label>
              <label className={styles.dateField}>
                <span>{t('usage.custom_to')}</span>
                <input
                  type="date"
                  value={custom.toDate}
                  min={custom.fromDate}
                  onChange={(event) => setCustom({ ...custom, toDate: event.target.value })}
                />
              </label>
            </div>
          )}
          <Segmented
            label={t('usage.bucket')}
            value={bucket}
            options={[
              {
                value: 'hour' as const,
                label: t('usage.bucket_hour'),
                disabled: range ? !hourlyAllowed(range) : true,
              },
              { value: 'day' as const, label: t('usage.bucket_day') },
            ]}
            onChange={setBucketChoice}
          />
        </div>
      </header>

      {range === null ? (
        <p className={styles.note}>{t('usage.custom_invalid')}</p>
      ) : !base ? (
        <p className={styles.note}>{t('usage.no_connection')}</p>
      ) : report.error ? (
        <UsageStatus error={report.error} base={base} onRetry={refresh} />
      ) : report.data ? (
        <div className={styles.body} aria-busy={report.loading}>
          <UsageReport data={report.data} onDimensionChange={setDimension} />
          <RequestsTable
            rows={requests.data ?? []}
            meta={report.data.meta}
            filters={filters}
            onFiltersChange={setFilters}
            loading={requests.loading}
          />
        </div>
      ) : (
        <Skeleton height={320} />
      )}
    </div>
  );
}
