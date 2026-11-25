import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';

import { formLevelError } from '@/components/form/serverErrors';
import { TextField } from '@/components/form/TextField';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { formatSince, formatTimestamp } from '@/lib/format';

import type { Profile } from './api';
import { NewPasswordFields } from './NewPasswordFields';
import { passwordChangeSchema, type PasswordChangeForm } from './passwordForm';
import { useChangePassword } from './queries';

const FIELDS = ['current_password', 'new_password', 'confirmation'] as const;
const EMPTY: PasswordChangeForm = { current_password: '', new_password: '', confirmation: '' };

/** What a successful change did, for the toast. */
export function passwordChangedMessage(sessionsRevoked: number): string {
  if (sessionsRevoked === 0) return 'Password changed.';
  const devices = sessionsRevoked === 1 ? '1 other device' : `${sessionsRevoked} other devices`;
  return `Password changed. ${devices} signed out and will need the new password.`;
}

/** A new password for the signed-in person, proved with the current one. */
export function ChangePasswordCard({ profile }: { profile: Profile }) {
  const change = useChangePassword();
  const [isVisible, setIsVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    control,
    formState: { errors },
  } = useForm<PasswordChangeForm>({
    resolver: zodResolver(passwordChangeSchema),
    defaultValues: EMPTY,
  });
  const [newPassword, confirmation] = useWatch({
    control,
    name: ['new_password', 'confirmation'],
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          {profile.password_changed_at ? (
            <>
              You last changed it{' '}
              <span title={formatTimestamp(profile.password_changed_at)}>
                {formatSince(profile.password_changed_at)}
              </span>
              .{' '}
            </>
          ) : (
            'You have not changed it in CLIMS yet. '
          )}
          Changing it signs you out on your other devices.
        </CardDescription>
      </CardHeader>
      <form
        noValidate
        className="flex flex-col gap-(--card-gap)"
        onSubmit={handleSubmit((values) => {
          setProblem(null);
          change.mutate(
            { current_password: values.current_password, new_password: values.new_password },
            {
              onSuccess: ({ sessionsRevoked }) => {
                reset(EMPTY);
                setIsVisible(false);
                toast.success(passwordChangedMessage(sessionsRevoked));
              },
              onError: (error) => {
                setProblem(formLevelError(error, FIELDS, setError));
              },
            },
          );
        })}
      >
        <CardContent className="flex flex-col gap-3">
          {problem ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Could not change your password</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="sm:col-span-2 sm:max-w-[calc(50%-0.5rem)]">
              <TextField
                label="Current password"
                type={isVisible ? 'text' : 'password'}
                autoComplete="current-password"
                required
                error={errors.current_password?.message}
                {...register('current_password')}
              />
            </div>
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
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={change.isPending}>
            {change.isPending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
            {change.isPending ? 'Changing…' : 'Change password'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
