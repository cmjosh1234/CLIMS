import { useMutation, useQueryClient } from '@tanstack/react-query';

import { userRefreshed } from '@/features/auth/authSlice';
import { authKeys } from '@/features/auth/queries';
import { useApiQuery, useHttp } from '@/lib/api';
import { useAppDispatch } from '@/store/hooks';

import {
  changePassword,
  getProfile,
  setTemporaryPassword,
  updateProfile,
  type PasswordChange,
  type ProfileInput,
  type SavedAccount,
  type TemporaryPasswordScope,
} from './api';

export const accountKeys = {
  profile: ['auth', 'profile'] as const,
};

/** The signed-in person's whole profile, for the profile page. */
export function useProfile() {
  return useApiQuery(accountKeys.profile, getProfile, { staleTime: 60_000 });
}

/** Keeps the profile page and the signed-in session in step with a change the server confirmed. */
function useSaveAccount() {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  return ({ profile, user }: SavedAccount) => {
    queryClient.setQueryData(accountKeys.profile, profile);
    queryClient.setQueryData(authKeys.me, user);
    dispatch(userRefreshed(user));
  };
}

/** `PATCH /auth/me`. The form shows a failure itself, beside the field it is about. */
export function useUpdateProfile() {
  const http = useHttp();
  const save = useSaveAccount();
  return useMutation({
    mutationFn: (input: ProfileInput) => updateProfile(http, input),
    onSuccess: save,
    meta: { handlesOwnErrors: true },
  });
}

/**
 * `POST /auth/password`. On success the session's user no longer has to change
 * it, which lets the first-sign-in screen give way to the app.
 */
export function useChangePassword() {
  const http = useHttp();
  const queryClient = useQueryClient();
  const save = useSaveAccount();
  return useMutation({
    mutationFn: (input: PasswordChange) => changePassword(http, input),
    onSuccess: async (saved) => {
      save(saved);
      // The other devices were signed out.
      await queryClient.invalidateQueries({ queryKey: authKeys.sessions });
    },
    meta: { handlesOwnErrors: true },
  });
}

/** `PUT /users/:id/password` or `PUT /users/district/:id/password`. The dialog shows a failure. */
export function useSetTemporaryPassword(scope: TemporaryPasswordScope) {
  const http = useHttp();
  return useMutation({
    mutationFn: ({ userId, password }: { userId: string; password: string }) =>
      setTemporaryPassword(http, scope, userId, password),
    meta: { handlesOwnErrors: true },
  });
}
