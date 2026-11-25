import { CircleAlert, LogOut } from 'lucide-react';
import { useRef } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage, toApiError } from '@/lib/api';

import { liveSessions } from './deviceSessions';
import { DeviceSessionsView } from './DeviceSessionList';
import { useMySessions, useRevokeMySession } from './queries';

/** A failed sign-out, said in terms of the device rather than the request. */
function revokeError(error: unknown): string {
  const apiError = toApiError(error);
  if (apiError.kind === 'not_found') return 'That device was already signed out.';
  return getErrorMessage(apiError);
}

interface MyDevicesProps {
  /** False holds the request back, e.g. while the dialog showing it is closed. */
  enabled?: boolean;
}

/**
 * Where the signed-in user's account is signed in (`GET /auth/sessions`), with
 * a way to sign any other device out (`DELETE /auth/sessions/:id`). This
 * device is signed out from the account menu instead. Used by the devices
 * dialog and the profile page.
 */
export function MyDevices({ enabled = true }: MyDevicesProps) {
  const sessions = useMySessions(enabled);
  const revoke = useRevokeMySession();
  const listRef = useRef<HTMLUListElement>(null);
  const live = sessions.data ? liveSessions(sessions.data) : undefined;
  const others = live?.filter((session) => !session.current).length ?? 0;

  return (
    <>
      {revoke.isError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Could not sign that device out</AlertTitle>
          <AlertDescription>{revokeError(revoke.error)}</AlertDescription>
        </Alert>
      ) : null}

      <DeviceSessionsView
        ref={listRef}
        label="Your signed-in devices"
        sessions={live}
        isPending={sessions.isPending}
        error={sessions.error}
        onRetry={() => void sessions.refetch()}
        isRetrying={sessions.isRefetching}
        emptyDescription="Your account has no active sessions."
        action={(session, device) => {
          if (session.current) return null;
          const isRevoking = revoke.isPending && revoke.variables.id === session.id;
          return (
            <Button
              variant="outline"
              size="sm"
              disabled={revoke.isPending}
              onClick={() => {
                revoke.mutate(session, {
                  onSuccess: () => {
                    listRef.current?.focus();
                  },
                });
              }}
            >
              {isRevoking ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : (
                <LogOut data-icon="inline-start" aria-hidden="true" />
              )}
              {isRevoking ? 'Signing out…' : 'Sign out'}
              {/* Leads with a comma so no name algorithm runs the words together. */}
              <span className="sr-only">{`, ${device}`}</span>
            </Button>
          );
        }}
      />

      {live && live.length > 0 && others === 0 ? (
        <p className="text-muted-foreground text-sm">
          This is the only device signed in to your account.
        </p>
      ) : null}
    </>
  );
}
