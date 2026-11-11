"use client";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/app/states";
import { useI18n } from "@/components/i18n-provider";

/** Never shows the raw error: messages could contain database details. */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  return (
    <ErrorState
      title={t.common.errorTitle}
      description={t.common.errorBody}
      action={<Button variant="outline" onClick={reset}>{t.common.retry}</Button>}
    />
  );
}
