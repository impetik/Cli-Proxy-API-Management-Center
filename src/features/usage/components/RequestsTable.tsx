import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import type { UsageMeta, UsageRequestRow } from '@/types/usage';
import { formatTimestamp, formatTokens, formatUsd, shortSessionId } from '../logic';
import styles from '../UsagePage.module.scss';

export interface RequestFilters {
  key: string;
  model: string;
  client: string;
  /** Set by picking a session in the Sessions table; '' for all. */
  session: string;
}

interface RequestsTableProps {
  rows: UsageRequestRow[];
  meta: UsageMeta | null;
  filters: RequestFilters;
  onFiltersChange: (filters: RequestFilters) => void;
  loading: boolean;
}

const FILTERS = [
  { field: 'key', list: 'keys' },
  { field: 'model', list: 'models' },
  { field: 'client', list: 'clients' },
] as const;

export function RequestsTable({
  rows,
  meta,
  filters,
  onFiltersChange,
  loading,
}: RequestsTableProps) {
  const { t } = useTranslation();
  const all = t('usage.filter_all');

  return (
    <section className={styles.card} aria-busy={loading}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t('usage.requests_title')}</h2>
        <div className={styles.filters}>
          {filters.session && (
            <span className={styles.chip} title={filters.session}>
              {t('usage.session_chip', { id: shortSessionId(filters.session) })}
              <button
                type="button"
                className={styles.chipClear}
                aria-label={t('usage.session_clear')}
                onClick={() => onFiltersChange({ ...filters, session: '' })}
              >
                ×
              </button>
            </span>
          )}
          {FILTERS.map(({ field, list }) => (
            <Select
              key={field}
              size="sm"
              ariaLabel={t(`usage.filter_${field}`)}
              value={filters[field]}
              options={[
                { value: '', label: `${t(`usage.filter_${field}`)}: ${all}` },
                ...(meta?.[list] ?? []).map((value) => ({ value, label: value })),
              ]}
              onChange={(value) => onFiltersChange({ ...filters, [field]: value })}
            />
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className={styles.note}>{loading ? t('common.loading') : t('usage.requests_empty')}</p>
      ) : (
        <div className={`${styles.tableScroll} ${styles.requestsScroll}`}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th scope="col">{t('usage.time_utc')}</th>
                <th scope="col">{t('usage.col_session')}</th>
                <th scope="col">{t('usage.dimension_key')}</th>
                <th scope="col">{t('usage.dimension_client')}</th>
                <th scope="col">{t('usage.col_ip')}</th>
                <th scope="col">{t('usage.dimension_agent')}</th>
                <th scope="col">{t('usage.dimension_model')}</th>
                <th scope="col">{t('usage.col_tokens')}</th>
                <th scope="col">{t('usage.col_list_cost')}</th>
                <th scope="col">{t('usage.col_billed_cost')}</th>
                <th scope="col">{t('usage.col_latency')}</th>
                <th scope="col">{t('usage.col_status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={`${row.ts}-${index}`}
                  className={row.failed ? styles.failedRow : undefined}
                >
                  <th scope="row">{formatTimestamp(row.ts)}</th>
                  <td className={styles.mono} title={row.session || undefined}>
                    {row.session ? shortSessionId(row.session) : '—'}
                  </td>
                  <td>{row.key}</td>
                  <td>{row.client || '—'}</td>
                  <td className={styles.mono}>{row.clientIp}</td>
                  <td title={row.userAgent}>{row.agent}</td>
                  <td title={`${row.provider}/${row.authType}`}>{row.model}</td>
                  <td
                    title={t('usage.tokens_tooltip', {
                      input: row.inputTokens,
                      cacheRead: row.cacheReadTokens,
                      cacheWrite: row.cacheWriteTokens,
                      output: row.outputTokens,
                    })}
                  >
                    {formatTokens(row.totalTokens)}
                  </td>
                  <td>{formatUsd(row.listCostUsd)}</td>
                  <td>{formatUsd(row.billedCostUsd)}</td>
                  <td>{t('usage.ms', { value: row.latencyMs.toLocaleString() })}</td>
                  <td>
                    <span className={row.failed ? styles.statusFailed : styles.statusOk}>
                      {row.statusCode ?? (row.failed ? t('usage.status_failed') : '—')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
