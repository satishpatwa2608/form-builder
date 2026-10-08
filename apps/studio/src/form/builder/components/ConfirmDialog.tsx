import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@ui/alert-dialog';

export interface ConfirmRequest {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  /** An alternative, non-destructive choice shown next to the main action. */
  secondary?: { label: string; onConfirm: () => void };
}

/** One confirm dialog for the builder - open it by setting a request, close by clearing it. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      {request && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{request.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>{request.description}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {request.secondary && (
              <AlertDialogAction
                className="bg-background text-foreground border"
                onClick={() => {
                  request.secondary!.onConfirm();
                  onClose();
                }}
              >
                {request.secondary.label}
              </AlertDialogAction>
            )}
            <AlertDialogAction
              className={request.destructive ? 'bg-destructive text-white' : undefined}
              onClick={() => {
                request.onConfirm();
                onClose();
              }}
            >
              {request.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
