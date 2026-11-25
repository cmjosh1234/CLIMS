import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { UGANDAN_MOBILE_EXAMPLE } from '@/lib/phone';

import type { Profile } from './api';
import {
  PROFILE_FIELDS,
  profileChanges,
  profileFormSchema,
  profileFormValues,
  type ProfileFormValues,
} from './profileForm';
import { useUpdateProfile } from './queries';

/**
 * The person's name, email address and phone number, edited in place. The
 * current password is asked for only once the email address or phone number
 * changes, since those are what the person signs in with.
 */
export function ProfileDetailsCard({ profile }: { profile: Profile }) {
  const update = useUpdateProfile();
  const initial = useMemo(() => profileFormValues(profile), [profile]);
  const schema = useMemo(() => profileFormSchema(initial), [initial]);
  const [problem, setProblem] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    control,
    formState: { errors },
  } = useForm<ProfileFormValues>({ resolver: zodResolver(schema), values: initial });
  const values = useWatch({ control }) as ProfileFormValues;
  const { changesSignIn, hasChanges } = profileChanges(initial, { ...initial, ...values });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal details</CardTitle>
        <CardDescription>
          How colleagues reach you. You can sign in with your email address or phone number as well
          as your username.
        </CardDescription>
      </CardHeader>
      <form
        noValidate
        className="flex flex-col gap-(--card-gap)"
        onSubmit={handleSubmit((submitted) => {
          setProblem(null);
          const { input } = profileChanges(initial, submitted);
          update.mutate(input, {
            onSuccess: (saved) => {
              reset(profileFormValues(saved.profile));
              toast.success('Your details are saved.');
            },
            onError: (error) => {
              setProblem(formLevelError(error, PROFILE_FIELDS, setError));
            },
          });
        })}
      >
        <CardContent className="flex flex-col gap-3">
          {problem ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Could not save your details</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <TextField
              label="First name"
              autoComplete="given-name"
              required
              error={errors.first_name?.message}
              {...register('first_name')}
            />
            <TextField
              label="Last name"
              autoComplete="family-name"
              required
              error={errors.last_name?.message}
              {...register('last_name')}
            />
            <TextField
              label="Email address"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required={initial.email !== ''}
              error={errors.email?.message}
              {...register('email')}
            />
            <TextField
              label="Phone number"
              type="tel"
              autoComplete="tel"
              description={`A Ugandan mobile number, e.g. ${UGANDAN_MOBILE_EXAMPLE}.`}
              error={errors.phone_number?.message}
              {...register('phone_number')}
            />
            {changesSignIn ? (
              <TextField
                label="Current password"
                type="password"
                autoComplete="current-password"
                required
                description="You sign in with your email address and phone number, so confirm it is you."
                error={errors.current_password?.message}
                {...register('current_password')}
              />
            ) : null}
          </div>
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-2">
          {hasChanges ? (
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending}
              onClick={() => {
                setProblem(null);
                reset(initial);
              }}
            >
              Discard changes
            </Button>
          ) : null}
          <Button type="submit" disabled={!hasChanges || update.isPending}>
            {update.isPending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
