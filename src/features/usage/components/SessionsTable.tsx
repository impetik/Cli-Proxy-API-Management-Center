import { useTranslation } from 'react-i18next';
import { CopyButton } from '@/features/oauth/components/CopyButton';
import type { UsageSession } from '@/types/usage';
import {
  formatTimestamp,
  formatTokens,
  formatUsd,
  sessionMinutes,
  shortSessionId,
  type SessionSort,
} from '../logic';
import { Segmented } from './Segmented';
import styles from '../UsagePage.module.scss';

interface SessionsTableProps {
  rows: UsageSession[];
  sort: SessionSort;
  onSortChange: (sort: SessionSort) => void;
  /** Session id that filters Recent requests, or ''. */
  selected: string;
  onSelect: (session: string) => void;
  loading: boolean;
  error: Error | null;
}

export function SessionsTable({
  rows,
  sort,
  onSortChange,
  selected,
  onSelect,
  loading,
  error,
}: SessionsTableProps) {
  const { t } = useTranslation();

  const duration = (session: UsageSession) => {
    const minutes = sessionMinutes(session.firstTs, session.lastTs);
    if (minutes === null) return '—';
    if (minutes < 1) return t('usage.duration_under_minute');
    const hours = Math.floor(minutes / 60);
    return hours > 0
      ? t('usage.duration_hours', { hours, minutes: minutes % 60 })
      : t('usage.duration_minutes', { minutes });
  };

  return (
    <section className={styles.card} aria-busy={loading}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t('usage.sessions_title')}</h2>
        <Segmented
          label={t('usage.sessions_sort')}
          value={sort}
          options={[
            { value: 'recent', label: t('usage.sessions_sort_recent') },
            { value: 'cost', label: t('usage.sessions_sort_cost') },
          ]}
          onChange={onSortChange}
        />
      </div>
      {error ? (
        <p className={styles.note}>{t('usage.sessions_error', { message: error.message })}</p>
      ) : rows.length === 0 ? (
        <p className={styles.note}>{loading ? t('common.loading') : t('usage.sessions_empty')}</p>
      ) : (
        <>
          <p className={styles.note}>{t('usage.sessions_hint')}</p>
          <div className={`${styles.tableScroll} ${styles.requestsScroll}`}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th scope="col">{t('usage.col_session')}</th>
                  <th scope="col">{t('usage.col_last_active')}</th>
                  <th scope="col">{t('usage.col_first_seen')}</th>
                  <th scope="col">{t('usage.col_duration')}</th>
                  <th scope="col">{t('usage.dimension_key')}</th>
                  <th scope="col">{t('usage.dimension_client')}</th>
                  <th scope="col">{t('usage.dimension_agent')}</th>
                  <th scope="col">{t('usage.col_models')}</th>
                  <th scope="col">{t('usage.col_requests')}</th>
                  <th scope="col">{t('usage.col_tokens')}</th>
                  <th scope="col">{t('usage.col_list_cost')}</th>
                  <th scope="col">{t('usage.col_billed_cost')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isSelected = Boolean(row.session) && row.session === selected;
                  return (
                    <tr
                      key={row.session || `${row.key}-${row.firstTs}`}
                      className={isSelected ? styles.selectedRow : undefined}
                    >
                      <th scope="row">
                        {row.session ? (
                          <span className={styles.sessionCell}>
                            <button
                              type="button"
                              className={styles.sessionButton}
                              aria-pressed={isSelected}
                              title={row.session}
                              onClick={() => onSelect(isSelected ? '' : row.session)}
                            >
                              {shortSessionId(row.session)}
                            </button>
                            <CopyButton
                              value={row.session}
                              label={t('usage.session_copy', { id: row.session })}
                            />
                          </span>
                        ) : (
                          t('usage.unknown')
                        )}
                      </th>
                      <td>{formatTimestamp(row.lastTs)}</td>
                      <td>{formatTimestamp(row.firstTs)}</td>
                      <td>{duration(row)}</td>
                      <td>{row.key}</td>
                      <td>{row.client || '—'}</td>
                      <td>{row.agent}</td>
                      <td className={styles.modelsCell} title={row.models.join(', ')}>
                        {row.models.join(', ')}
                      </td>
                      <td>{row.requests.toLocaleString()}</td>
                      <td>{formatTokens(row.totalTokens)}</td>
                      <td>{formatUsd(row.listCostUsd)}</td>
                      <td>{formatUsd(row.billedCostUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
