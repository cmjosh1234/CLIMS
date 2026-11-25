'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';

import { formLevelError } from '@/components/form/serverErrors';
import { Brand } from '@/components/layout/Brand';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { useCurrentUser, useSignOut } from '@/features/auth/hooks';

import { NewPasswordFields } from './NewPasswordFields';
import { requiredPasswordSchema, type RequiredPasswordForm } from './passwordForm';
import { useChangePassword } from './queries';

const FIELDS = ['new_password', 'confirmation'] as const;

/**
 * Shown in place of the app to an account whose password someone else chose:
 * one an administrator or DCFP has just created, or given a temporary
 * password. The API answers nothing else until a new one is set, so there is
 * nothing to open behind this; the way out is to sign out.
 */
export function PasswordChangeRequired() {
  const user = useCurrentUser();
  const signOut = useSignOut();
  const change = useChangePassword();
  const [isVisible, setIsVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<RequiredPasswordForm>({
    resolver: zodResolver(requiredPasswordSchema),
    defaultValues: { new_password: '', confirmation: '' },
  });
  const [newPassword, confirmation] = useWatch({
    control,
    name: ['new_password', 'confirmation'],
  });
  const name = [user?.firstname, user?.lastname].filter(Boolean).join(' ') || user?.username;

  return (
    <main className="flex min-h-svh justify-center p-4 sm:items-center">
      <div className="flex w-full max-w-sm flex-col gap-6 py-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <Brand />
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold text-balance">Choose a new password</h1>
            <p className="text-muted-foreground text-sm text-pretty">
              Your account was given a password by someone else. Choose one only you know before you
              continue.
            </p>
          </div>
        </div>

        <div className="bg-card rounded-card border p-5 sm:p-6">
          <form
            noValidate
            onSubmit={handleSubmit((values) => {
              setProblem(null);
              change.mutate(
                { new_password: values.new_password },
                {
                  onSuccess: () => {
                    toast.success('Password saved. You can continue now.');
                  },
                  onError: (error) => {
                    setProblem(formLevelError(error, FIELDS, setError));
                  },
                },
              );
            })}
          >
            <FieldGroup>
              {name ? (
                <p className="text-muted-foreground min-w-0 text-sm wrap-anywhere">
                  Signed in as <span className="text-foreground font-medium">{name}</span>
                  {user?.username && user.username !== name ? ` (${user.username})` : null}
                </p>
              ) : null}
              {problem ? (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>Could not save the password</AlertTitle>
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              ) : null}
              <NewPasswordFields
                newPassword={register('new_password')}
                confirmation={register('confirmation')}
                values={{ newPassword, confirmation }}
                errors={{
                  newPassword: errors.new_password?.message,
                  confirmation: errors.confirmation?.message,
                }}
                isVisible={isVisible}
                onVisibleChange={setIsVisible}
              />
              <Button type="submit" disabled={change.isPending} className="w-full">
                {change.isPending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
                {change.isPending ? 'Saving…' : 'Save password and continue'}
              </Button>
            </FieldGroup>
          </form>
        </div>

        <div className="flex flex-col items-center gap-1 text-center text-sm">
          <p className="text-muted-foreground">Not you, or not now?</p>
          <Button variant="ghost" size="sm" onClick={signOut} disabled={change.isPending}>
            <LogOut data-icon="inline-start" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}
