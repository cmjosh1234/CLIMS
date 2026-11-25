import { LogOut, MonitorSmartphone, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCurrentUser, useSignOut } from '@/features/auth/hooks';
import { SignedInDevicesDialog } from '@/features/auth/SignedInDevicesDialog';
import { initialsOf } from '@/lib/format';
import { PROFILE_PATH } from '@/navigation/paths';

/** The signed-in user's identity, their profile, where they are signed in, and the way to sign out. */
export function UserMenu() {
  const user = useCurrentUser();
  const signOut = useSignOut();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  if (!user) return null;

  const fullName = [user.firstname, user.lastname].filter(Boolean).join(' ');
  const displayName = fullName || user.username;
  const subtitle = user.role ?? user.username;

  return (
    <>
      <DropdownMenu>
        {/*
         * The accessible name is the visible text ("Sarah Nakato, admin, account menu"), not an
         * aria-label, so it always contains what sighted speech users see (WCAG 2.5.3). Below md the
         * name is visually hidden but still read; the initials repeat it and are hidden from AT.
         */}
        <DropdownMenuTrigger
          ref={triggerRef}
          className="focus-visible:ring-ring hover:bg-accent flex min-w-0 items-center gap-2.5 rounded-lg p-0.5 outline-none focus-visible:ring-2 md:pr-2"
        >
          <span
            aria-hidden="true"
            className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-bold"
          >
            {initialsOf(displayName)}
          </span>
          <span className="sr-only min-w-0 flex-col text-left leading-tight md:not-sr-only md:flex">
            <span className="truncate text-[0.8125rem] font-semibold">{displayName}</span>
            <span className="sr-only">, </span>
            <span className="text-muted-foreground truncate text-xs">{subtitle}</span>
          </span>
          <span className="sr-only">, account menu</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-foreground truncate text-sm font-medium">{displayName}</span>
            <span className="text-muted-foreground truncate text-xs font-normal">
              {[user.username, user.role].filter(Boolean).join(' · ')}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={PROFILE_PATH}>
              <UserRound aria-hidden="true" />
              Your profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setDevicesOpen(true);
            }}
          >
            <MonitorSmartphone aria-hidden="true" />
            Signed-in devices
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={signOut}>
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SignedInDevicesDialog
        open={devicesOpen}
        onOpenChange={setDevicesOpen}
        onCloseAutoFocus={(event) => {
          // The menu item that opened it is gone; return to the menu's button.
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      />
    </>
  );
}
