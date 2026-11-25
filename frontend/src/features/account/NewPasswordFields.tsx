import { Check, Circle } from 'lucide-react';
import { useId } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { TextField } from '@/components/form/TextField';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

import { PASSWORD_RULES } from './passwordForm';

interface NewPasswordFieldsProps {
  newPassword: UseFormRegisterReturn;
  confirmation: UseFormRegisterReturn;
  /** What is typed in each, for the live checklist. */
  values: { newPassword: string; confirmation: string };
  errors: { newPassword?: string; confirmation?: string };
  /** Whether the passwords show as text; shared with a current-password field when there is one. */
  isVisible: boolean;
  onVisibleChange: (visible: boolean) => void;
}

/**
 * A new password typed twice, with the rules ticked off as they are met and a
 * switch to show what was typed. The rules are the server's, so a password
 * that passes here is not refused there for its shape.
 */
export function NewPasswordFields({
  newPassword,
  confirmation,
  values,
  errors,
  isVisible,
  onVisibleChange,
}: NewPasswordFieldsProps) {
  const id = useId();
  const rulesId = `${id}-rules`;
  const type = isVisible ? 'text' : 'password';

  return (
    <>
      <TextField
        label="New password"
        type={type}
        autoComplete="new-password"
        required
        aria-describedby={rulesId}
        error={errors.newPassword}
        {...newPassword}
      />
      <TextField
        label="Confirm new password"
        type={type}
        autoComplete="new-password"
        required
        error={errors.confirmation}
        {...confirmation}
      />
      <ul id={rulesId} aria-label="Password rules" className="flex flex-col gap-1.5 text-sm">
        {PASSWORD_RULES.map((rule) => {
          const isMet = rule.isMet(values.newPassword, values.confirmation);
          const Icon = isMet ? Check : Circle;
          return (
            <li
              key={rule.id}
              data-met={isMet}
              className={cn(
                'flex items-center gap-2',
                isMet ? 'text-success' : 'text-muted-foreground',
              )}
            >
              <Icon aria-hidden="true" className={cn('size-4 shrink-0', !isMet && 'size-3.5')} />
              {/* The state in words, so it is not carried by the icon and colour alone. */}
              <span className="sr-only">{isMet ? 'Done:' : 'Not yet:'}</span>
              {rule.label}
            </li>
          );
        })}
      </ul>
      <label htmlFor={`${id}-show`} className="flex items-center gap-2 self-start text-sm">
        <Checkbox
          id={`${id}-show`}
          checked={isVisible}
          onChange={(event) => {
            onVisibleChange(event.target.checked);
          }}
        />
        Show passwords
      </label>
    </>
  );
}
