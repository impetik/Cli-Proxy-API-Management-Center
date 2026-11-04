import styles from '../UsagePage.module.scss';

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}

/** A row of toggle buttons; one is pressed. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.segmentButton}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
