import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';

import { FormDialog } from '@/components/form/FormDialog';
import { formLevelError } from '@/components/form/serverErrors';
import { TextField } from '@/components/form/TextField';
import { Button } from '@/components/ui/button';

import type { TemporaryPasswordScope } from './api';
import {
  generateTemporaryPassword,
  temporaryPasswordSchema,
  type TemporaryPasswordForm,
} from './passwordForm';
import { useSetTemporaryPassword } from './queries';

const FIELDS = ['password'] as const;

interface TemporaryPasswordDialogProps {
  userId: string;
  /** The account's name, as the list shows it. */
  userName: string;
  scope: TemporaryPasswordScope;
  onClose: () => void;
  /** Where focus goes on close; see `FormDialog`. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Gives someone who has forgotten their password a temporary one. It starts
 * filled with a random one that is easy to read out; the person is signed out
 * everywhere and chooses their own when they next sign in. Mount it to open.
 */
export function TemporaryPasswordDialog({
  userId,
  userName,
  scope,
  onClose,
  onCloseAutoFocus,
}: TemporaryPasswordDialogProps) {
  const save = useSetTemporaryPassword(scope);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    control,
    formState: { errors, isDirty },
  } = useForm<TemporaryPasswordForm>({
    resolver: zodResolver(temporaryPasswordSchema),
    defaultValues: { password: generateTemporaryPassword() },
  });
  const password = useWatch({ control, name: 'password' });
  // The clipboard needs a secure context: it is missing when CLIMS is opened by its LAN address.
  const canCopy = typeof navigator !== 'undefined' && 'clipboard' in navigator;

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      title={`Set a temporary password for ${userName}`}
      description="They are signed out everywhere, and choose their own password the next time they sign in. Tell them this one in person or by phone."
      submitLabel="Set temporary password"
      pendingLabel="Setting…"
      isPending={save.isPending}
      isDirty={isDirty}
      error={formError}
      onSubmit={handleSubmit((values) => {
        setFormError(null);
        save.mutate(
          { userId, password: values.password },
          {
            onSuccess: () => {
              toast.success(
                `Temporary password set for ${userName}. They choose their own when they next sign in.`,
              );
              onClose();
            },
            onError: (error) => {
              setFormError(formLevelError(error, FIELDS, setError));
            },
          },
        );
      })}
    >
      <div className="flex flex-col gap-2 sm:col-span-2">
        <TextField
          label="Temporary password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          description="At least 8 characters with a number."
          error={errors.password?.message}
          className="tracking-wide"
          {...register('password', {
            onChange: () => {
              setCopied(false);
            },
          })}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setValue('password', generateTemporaryPassword(), {
                shouldDirty: true,
                shouldValidate: true,
              });
              setCopied(false);
            }}
          >
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            Generate another
          </Button>
          {canCopy ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(password).then(
                  () => {
                    setCopied(true);
                  },
                  () => {
                    toast.error('Could not copy. Select the password and copy it yourself.');
                  },
                );
              }}
            >
              {copied ? (
                <Check data-icon="inline-start" aria-hidden="true" />
              ) : (
                <Copy data-icon="inline-start" aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          ) : null}
          <span role="status" className="sr-only">
            {copied ? 'Password copied' : ''}
          </span>
        </div>
      </div>
    </FormDialog>
  );
}
