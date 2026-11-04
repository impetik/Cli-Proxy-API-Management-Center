import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { UsageApiError } from '@/services/api/usage';

interface UsageStatusProps {
  error: Error;
  base: string;
  onRetry: () => void;
}

/** Why the usage API gave no data: unreachable (or CORS), key rejected, or another HTTP error. */
export function UsageStatus({ error, base, onRetry }: UsageStatusProps) {
  const { t } = useTranslation();
  const status = error instanceof UsageApiError ? error.status : null;
  const [title, description] =
    status === null
      ? [t('usage.error_unreachable_title'), t('usage.error_unreachable', { base })]
      : status === 401 || status === 403
        ? [t('usage.error_unauthorized_title'), t('usage.error_unauthorized')]
        : [t('usage.error_http_title'), t('usage.error_http', { status, message: error.message })];

  return (
    <EmptyState
      title={title}
      description={description}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('usage.retry')}
        </Button>
      }
    />
  );
}
