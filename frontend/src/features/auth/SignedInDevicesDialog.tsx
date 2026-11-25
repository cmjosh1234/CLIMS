import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { MyDevices } from './MyDevices';

interface SignedInDevicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes when the dialog closes; the dialog was opened from a menu that is gone by then. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Where the signed-in user's account is signed in, with a way to sign any
 * other device out (`MyDevices`). Closing it forgets a failed sign-out.
 */
export function SignedInDevicesDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: SignedInDevicesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-lg"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Signed-in devices</DialogTitle>
          <DialogDescription>
            Where your account is signed in now. If you do not recognise a device, sign it out and
            tell your administrator.
          </DialogDescription>
        </DialogHeader>
        <MyDevices enabled={open} />
      </DialogContent>
    </Dialog>
  );
}
