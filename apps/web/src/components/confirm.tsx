import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n";

interface Asking {
  action: string;
  message: string;
  answer(yes: boolean): void;
}

/**
 * Asks the person to confirm something that cannot be undone, in the app's own dialog.
 * `confirm(action, message)` resolves to their answer; render `dialog` somewhere in the component.
 */
export function useConfirm(): {
  confirm(action: string, message: string): Promise<boolean>;
  dialog: ReactNode;
} {
  const { t } = useI18n();
  const [asking, setAsking] = useState<Asking | null>(null);
  const confirm = useCallback(
    (action: string, message: string) =>
      new Promise<boolean>((answer) => setAsking({ action, message, answer })),
    [],
  );
  const close = (yes: boolean) => {
    asking?.answer(yes);
    setAsking(null);
  };
  const dialog = asking && (
    <Dialog open onOpenChange={(open) => !open && close(false)}>
      <DialogContent className="glass-thick max-w-sm gap-3 p-5">
        <DialogTitle className="text-sm">{asking.action}</DialogTitle>
        <DialogDescription className="text-[13px]">{asking.message}</DialogDescription>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => close(false)}>
            {t.common.cancel}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => close(true)}>
            {asking.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { confirm, dialog };
}
