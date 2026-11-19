import { useTranslation } from 'react-i18next';
import { Meter } from '@/features/dashboard/components/Meter';
import { formatUsd, type QuotaView } from '../logic';
import styles from '../UsagePage.module.scss';

/** Per-key spend against its rolling 5-hour and 24-hour limits. Renders nothing without limits. */
export function QuotasCard({ view }: { view: QuotaView }) {
  const { t } = useTranslation();
  if (view.rows.length === 0) return null;

  return (
    <section className={styles.card} aria-labelledby="usage-quotas-title">
      <div className={styles.cardHead}>
        <h2 id="usage-quotas-title" className={styles.cardTitle}>
          {t('usage.quotas_title')}
        </h2>
      </div>
      {view.stale && <p className={styles.quotaStale}>{t('usage.quotas_stale')}</p>}
      <ul className={styles.quotaList}>
        {view.rows.map((row) => (
          <li key={row.key} className={styles.quotaRow}>
            <div className={styles.quotaHead}>
              <span className={styles.name}>{row.key}</span>
              {row.blocked && (
                <span className={styles.quotaBlocked}>
                  {t('usage.quotas_blocked', {
                    time: row.blocked.time,
                    window: t(`usage.quotas_limit_${row.blocked.window ?? 'unknown'}`),
                  })}
                </span>
              )}
            </div>
            {row.windows.map((w) => {
              const label = t(`usage.quotas_window_${w.window}`);
              return (
                <div key={w.window} className={styles.quotaWindow}>
                  <span className={styles.quotaText}>
                    {t('usage.quotas_of', {
                      window: label,
                      used: formatUsd(w.used),
                      limit: formatUsd(w.limit),
                      percent: w.percent,
                    })}
                  </span>
                  <Meter
                    value={w.percent}
                    tone={w.percent >= 100 ? 'critical' : w.percent >= 80 ? 'warning' : 'good'}
                    ariaLabel={`${row.key}, ${label}: ${w.percent}%`}
                    className={styles.quotaMeter}
                  />
                </div>
              );
            })}
          </li>
        ))}
      </ul>
      <p className={styles.note}>{t('usage.quotas_hint')}</p>
    </section>
  );
}
