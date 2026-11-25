'use client';

import type { ReactNode } from 'react';

import { DetailList, type DetailItem } from '@/components/DetailList';
import { ErrorState } from '@/components/states/ErrorState';
import { PageSkeleton } from '@/components/states/PageSkeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MyDevices } from '@/features/auth/MyDevices';
import { roleDescription } from '@/features/users/access';
import { RoleBadge } from '@/features/users/RoleBadge';
import { WebAccessList } from '@/features/users/WebAccessList';
import { EMPTY_VALUE, formatDate, formatNumber, formatSince, formatTimestamp } from '@/lib/format';
import { initialsOf } from '@/lib/format';

import type { Profile } from './api';
import { ChangePasswordCard } from './ChangePasswordCard';
import { ProfileDetailsCard } from './ProfileDetailsCard';
import { useProfile } from './queries';

const displayName = (profile: Profile) =>
  [profile.first_name, profile.last_name].filter(Boolean).join(' ') ||
  profile.username ||
  'Your account';

function Since({ value, never }: { value: string | null; never: string }) {
  if (!value) return <span className="text-muted-foreground font-normal">{never}</span>;
  return <span title={formatTimestamp(value)}>{formatSince(value)}</span>;
}

/** Who is signed in, and how the account has been used. */
function IdentityCard({ profile }: { profile: Profile }) {
  const name = displayName(profile);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-8">
        <div className="flex min-w-0 items-center gap-3 lg:w-80 lg:shrink-0">
          <span
            aria-hidden="true"
            className="bg-primary text-primary-foreground flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-bold"
          >
            {initialsOf(name)}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold" title={name}>
              {name}
            </h2>
            <p className="text-muted-foreground truncate text-sm">
              {profile.username ? `Username ${profile.username}` : 'No username'}
            </p>
          </div>
        </div>
        <DetailList
          variant="grid"
          className="min-w-0 flex-1 lg:border-l lg:pl-8"
          items={[
            {
              label: 'Last signed in',
              value: <Since value={profile.last_login_at} never="Never" />,
            },
            { label: 'Sign-ins', value: formatNumber(profile.login_count ?? 0) },
            {
              label: 'Password changed',
              value: <Since value={profile.password_changed_at} never="Not yet" />,
            },
            {
              label: 'Account created',
              value: profile.created_at ? formatDate(profile.created_at) : EMPTY_VALUE,
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

/** Where the account works, in the words the rest of the app uses. Only what is set is listed. */
export function workplaceItems(profile: Profile): DetailItem[] {
  const items: DetailItem[] = [];
  const line = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');
  const { store, hot_spot: hotSpot, subcounty, organisation_unit: unit } = profile;
  if (store) {
    // As Users & access names stores (`storeLabel`): a district store by its district.
    const value =
      store.store_type === 'district' && store.district_name
        ? `${store.district_name} district store`
        : store.store_type === 'national'
          ? line(store.name ?? 'Unnamed store', 'National warehouse')
          : (store.name ?? 'Unnamed store');
    items.push({ label: 'Store', value });
  }
  if (hotSpot) {
    items.push({
      label: 'Hotspot',
      value: line(hotSpot.name ?? 'Unnamed hotspot', hotSpot.village, hotSpot.district),
    });
  }
  if (subcounty) {
    items.push({
      label: 'Subcounty',
      value: line(subcounty.name ?? 'Unnamed subcounty', subcounty.district_name),
    });
  }
  if (unit) {
    items.push({ label: 'Organisation unit', value: line(unit.name ?? 'Unnamed', unit.district) });
  }
  if (profile.location) items.push({ label: 'Location', value: profile.location });
  return items;
}

/** The person's roles and place of work, which administrators set. */
function WorkCard({ profile }: { profile: Profile }) {
  const workplace = workplaceItems(profile);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your work</CardTitle>
        <CardDescription>
          Your administrator sets these. Ask them if something here is wrong.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Group title="Roles">
          {profile.roles.length === 0 ? (
            <p className="text-muted-foreground text-sm">You have no role yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {profile.roles.map((role) => (
                <li key={role.id} className="flex flex-col items-start gap-1">
                  <RoleBadge role={role} />
                  {roleDescription(role) ? (
                    <span className="text-muted-foreground text-xs">{roleDescription(role)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Group>
        <Group title="Where you work">
          {workplace.length === 0 ? (
            <p className="text-muted-foreground text-sm">No store, hotspot or area is assigned.</p>
          ) : (
            <DetailList items={workplace} />
          )}
        </Group>
        <Group title="What you can open">
          <WebAccessList roleNames={profile.roles.map((role) => role.name ?? '')} />
        </Group>
      </CardContent>
    </Card>
  );
}

function DevicesCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Signed-in devices</CardTitle>
        <CardDescription>
          If you do not recognise a device, sign it out and tell your administrator.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <MyDevices />
      </CardContent>
    </Card>
  );
}

/**
 * The signed-in person's own account: their details and password, which they
 * change here, and their roles, workplace and devices, which they can see.
 */
export default function ProfilePage() {
  const profile = useProfile();
  if (profile.isPending) return <PageSkeleton layout="form" />;
  if (profile.isError) {
    return (
      <Card>
        <ErrorState
          title="Could not load your profile"
          error={profile.error}
          onRetry={() => void profile.refetch()}
          isRetrying={profile.isRefetching}
        />
      </Card>
    );
  }
  const data = profile.data;
  return (
    <>
      <IdentityCard profile={data} />
      <div className="gap-section grid items-start lg:grid-cols-5">
        <div className="gap-section flex min-w-0 flex-col lg:col-span-3">
          <ProfileDetailsCard profile={data} />
          <ChangePasswordCard profile={data} />
        </div>
        <div className="gap-section flex min-w-0 flex-col lg:col-span-2">
          <WorkCard profile={data} />
          <DevicesCard />
        </div>
      </div>
    </>
  );
}
